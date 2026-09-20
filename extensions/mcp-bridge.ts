// mcp-bridge — MCP support for pi, as an extension.
//
// pi has no built-in MCP (by design: "build an extension that adds MCP support"). This is that
// extension. It reads ~/.pi/agent/mcp-servers.json (Claude-compatible `mcpServers` shape), connects
// to each streamable-HTTP MCP server, and registers every server tool as a native pi tool named
// `<server>__<tool>` (e.g. `paper__get_screenshot`) so the model calls MCP tools like any other.
//
// Tool results map 1:1 into pi's content blocks: MCP text → text, MCP image (base64 + mimeType)
// → image. An MCP result with `isError: true` throws, which pi records as a failed tool call.
//
// Auth: static `headers` (e.g. a local bearer) or `"auth": "oauth"` for hosted servers that speak
// OAuth 2.1 (RFC 9728 protected-resource discovery → RFC 8414 AS metadata → RFC 7591 dynamic
// client registration → PKCE authorization code in the browser → local 127.0.0.1 callback).
// Tokens live in ~/.pi/agent/mcp-auth.json (mode 0600) and are refreshed on expiry or 401.
// First sign-in is `/mcp login <server>`; later startups connect silently.
//
// Graceful degradation: a server that is down (e.g. Paper.app not running) is skipped with a
// warning instead of killing startup. `/mcp` reports status and retries failed connections.
// Restart pi (or /reload) after editing the config file.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TSchema } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const VERSION = "0.2.0";

// ── Config ──────────────────────────────────────────────────────────────────────────────────

interface HttpServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  /** "oauth" — authenticate with OAuth 2.1 + PKCE (browser sign-in via `/mcp login <name>`). */
  auth?: "oauth";
  /** Extra prompt guideline shown once for this server's tools (optional). */
  instructions?: string;
}

interface BridgeConfig {
  mcpServers: Record<string, HttpServerConfig>;
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "mcp-servers.json");
const AUTH_PATH = join(homedir(), ".pi", "agent", "mcp-auth.json");

function loadConfig(): BridgeConfig {
  if (!existsSync(CONFIG_PATH)) return { mcpServers: {} };
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  const servers: Record<string, HttpServerConfig> = {};
  for (const [name, entry] of Object.entries(raw?.mcpServers ?? {})) {
    const cfg = entry as Partial<HttpServerConfig>;
    if (cfg?.type !== "http" || typeof cfg.url !== "string") {
      console.warn(`[mcp-bridge] server "${name}": only type "http" is supported, skipping`);
      continue;
    }
    servers[name] = {
      type: "http",
      url: cfg.url,
      headers: (cfg.headers as Record<string, string> | undefined) ?? undefined,
      auth: cfg.auth === "oauth" ? "oauth" : undefined,
      instructions: cfg.instructions,
    };
  }
  return { mcpServers: servers };
}

// ── OAuth 2.1 (PKCE, dynamic client registration) ───────────────────────────────────────────

interface StoredAuth {
  clientId?: string;
  accessToken?: string;
  refreshToken?: string;
  /** epoch ms; absent means "unknown, assume valid until a 401" */
  expiresAt?: number;
  tokenEndpoint?: string;
  scope?: string;
}

interface AsMetadata {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopes?: string[];
}

function loadAuthStore(): Record<string, StoredAuth> {
  if (!existsSync(AUTH_PATH)) return {};
  try {
    return JSON.parse(readFileSync(AUTH_PATH, "utf8")) as Record<string, StoredAuth>;
  } catch {
    return {};
  }
}

function saveAuthStore(store: Record<string, StoredAuth>): void {
  mkdirSync(dirname(AUTH_PATH), { recursive: true });
  writeFileSync(AUTH_PATH, JSON.stringify(store, null, 2), { mode: 0o600 });
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function fetchJson(url: string): Promise<any | undefined> {
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  }
}

/** Parse `resource_metadata="..."` out of a WWW-Authenticate header, if present. */
function resourceMetadataFrom(wwwAuthenticate: string | null): string | undefined {
  const m = wwwAuthenticate?.match(/resource_metadata="([^"]+)"/);
  return m?.[1];
}

async function discover(resourceUrl: string, wwwAuthenticate: string | null): Promise<AsMetadata> {
  const resource = new URL(resourceUrl);
  const path = resource.pathname.replace(/\/$/, "");

  // RFC 9728: protected resource metadata names the authorization server(s).
  const prmCandidates = [
    resourceMetadataFrom(wwwAuthenticate),
    `${resource.origin}/.well-known/oauth-protected-resource${path}`,
    `${resource.origin}/.well-known/oauth-protected-resource`,
  ].filter((u): u is string => !!u);

  let asUrl = resource.origin;
  let scopes: string[] | undefined;
  for (const candidate of prmCandidates) {
    const prm = await fetchJson(candidate);
    if (prm?.authorization_servers?.[0]) {
      asUrl = prm.authorization_servers[0];
      scopes = prm.scopes_supported;
      break;
    }
  }

  // RFC 8414 / OpenID discovery for the authorization server itself.
  const as = new URL(asUrl);
  const asPath = as.pathname.replace(/\/$/, "");
  const asCandidates = [
    `${as.origin}/.well-known/oauth-authorization-server${asPath}`,
    `${as.origin}/.well-known/oauth-authorization-server`,
    `${as.origin}/.well-known/openid-configuration${asPath}`,
    `${as.origin}/.well-known/openid-configuration`,
  ];
  for (const candidate of asCandidates) {
    const meta = await fetchJson(candidate);
    if (meta?.authorization_endpoint && meta?.token_endpoint) {
      return {
        authorizationEndpoint: meta.authorization_endpoint,
        tokenEndpoint: meta.token_endpoint,
        registrationEndpoint: meta.registration_endpoint,
        scopes: scopes ?? meta.scopes_supported,
      };
    }
  }

  // No metadata: fall back to the conventional endpoints.
  return {
    authorizationEndpoint: `${asUrl.replace(/\/$/, "")}/authorize`,
    tokenEndpoint: `${asUrl.replace(/\/$/, "")}/token`,
    registrationEndpoint: `${asUrl.replace(/\/$/, "")}/register`,
    scopes,
  };
}

function openBrowser(url: string): void {
  const os = platform();
  const [cmd, args] =
    os === "darwin" ? ["open", [url]] : os === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    // Printed URL is the fallback.
  }
}

/** Listen once on 127.0.0.1 for the authorization-code redirect. */
function waitForCallback(
  state: string,
  timeoutMs: number,
): { redirectUri: Promise<string>; code: Promise<string> } {
  let resolveUri!: (u: string) => void;
  let resolveCode!: (c: string) => void;
  let rejectCode!: (e: Error) => void;
  const redirectUri = new Promise<string>((r) => (resolveUri = r));
  const code = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const err = url.searchParams.get("error");
    const gotState = url.searchParams.get("state");
    const gotCode = url.searchParams.get("code");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (err || gotState !== state || !gotCode) {
      res.end("<p>Sign-in failed. You can close this tab.</p>");
      rejectCode(new Error(err ?? "state mismatch or missing code"));
    } else {
      res.end("<p>Signed in. You can close this tab and return to pi.</p>");
      resolveCode(gotCode);
    }
    setTimeout(() => server.close(), 100);
  });

  server.listen(0, "127.0.0.1", () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    resolveUri(`http://127.0.0.1:${port}/callback`);
  });
  setTimeout(() => {
    rejectCode(new Error("timed out waiting for the browser sign-in"));
    server.close();
  }, timeoutMs).unref();

  return { redirectUri, code };
}

class OAuthProvider {
  constructor(
    private readonly serverName: string,
    private readonly resourceUrl: string,
  ) {}

  private get stored(): StoredAuth {
    return loadAuthStore()[this.serverName] ?? {};
  }

  private save(patch: StoredAuth): void {
    const store = loadAuthStore();
    store[this.serverName] = { ...(store[this.serverName] ?? {}), ...patch };
    saveAuthStore(store);
  }

  hasCredentials(): boolean {
    const s = this.stored;
    return !!(s.accessToken || s.refreshToken);
  }

  clear(): void {
    const store = loadAuthStore();
    delete store[this.serverName];
    saveAuthStore(store);
  }

  /** Bearer header for the next request, refreshing first if the token is known to be expired. */
  async header(): Promise<Record<string, string>> {
    let s = this.stored;
    if (s.accessToken && s.expiresAt && Date.now() > s.expiresAt - 30_000 && s.refreshToken) {
      await this.refresh();
      s = this.stored;
    }
    return s.accessToken ? { Authorization: `Bearer ${s.accessToken}` } : {};
  }

  private async tokenRequest(tokenEndpoint: string, form: Record<string, string>): Promise<boolean> {
    const res = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(form).toString(),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      throw new Error(`token endpoint ${res.status}: ${body.error_description ?? body.error ?? "no access_token"}`);
    }
    this.save({
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? this.stored.refreshToken,
      expiresAt: typeof body.expires_in === "number" ? Date.now() + body.expires_in * 1000 : undefined,
      tokenEndpoint,
      scope: body.scope ?? this.stored.scope,
    });
    return true;
  }

  /** Use the refresh token; returns false when there is none or it was rejected. */
  async refresh(): Promise<boolean> {
    const s = this.stored;
    if (!s.refreshToken || !s.tokenEndpoint || !s.clientId) return false;
    try {
      return await this.tokenRequest(s.tokenEndpoint, {
        grant_type: "refresh_token",
        refresh_token: s.refreshToken,
        client_id: s.clientId,
        resource: this.resourceUrl,
      });
    } catch (err) {
      console.warn(`[mcp-bridge] ${this.serverName}: refresh failed — ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  /** Full interactive sign-in: discovery → registration → PKCE authorize in the browser → tokens. */
  async login(notify: (msg: string) => void, wwwAuthenticate: string | null = null): Promise<void> {
    const meta = await discover(this.resourceUrl, wwwAuthenticate);
    const state = base64url(randomBytes(16));
    const { redirectUri: redirectUriP, code: codeP } = waitForCallback(state, 5 * 60_000);
    const redirectUri = await redirectUriP;

    // RFC 7591 dynamic client registration. Public client, PKCE, no secret.
    let clientId = this.stored.clientId;
    if (meta.registrationEndpoint) {
      const res = await fetch(meta.registrationEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_name: "pi-mcp-bridge",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      });
      const body: any = await res.json().catch(() => ({}));
      if (res.ok && body.client_id) clientId = body.client_id;
      else if (!clientId) throw new Error(`client registration ${res.status}: ${body.error_description ?? body.error ?? "no client_id"}`);
    }
    if (!clientId) throw new Error("no client_id: server offers no registration endpoint and none is stored");
    this.save({ clientId });

    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    const authUrl = new URL(meta.authorizationEndpoint);
    const params: Record<string, string> = {
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      resource: this.resourceUrl,
    };
    if (meta.scopes?.length) params.scope = meta.scopes.join(" ");
    for (const [k, v] of Object.entries(params)) authUrl.searchParams.set(k, v);

    notify(`${this.serverName}: opening the browser to sign in.\nIf it does not open, visit:\n${authUrl.toString()}`);
    openBrowser(authUrl.toString());

    const code = await codeP;
    await this.tokenRequest(meta.tokenEndpoint, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource: this.resourceUrl,
    });
  }
}

// ── Minimal streamable-HTTP MCP client ──────────────────────────────────────────────────────

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

export class UnauthorizedError extends Error {
  constructor(
    public readonly serverName: string,
    public readonly wwwAuthenticate: string | null,
  ) {
    super(`HTTP 401 — run /mcp login ${serverName}`);
  }
}

class McpHttpClient {
  private nextId = 1;
  private sessionId: string | null = null;
  private initialized = false;

  constructor(
    private readonly serverName: string,
    private readonly url: string,
    private readonly headers: Record<string, string> = {},
    readonly auth?: OAuthProvider,
  ) {}

  /** POST one JSON-RPC message; parse the JSON or SSE response; return the response for our id. */
  private async rpc(
    method: string,
    params: unknown,
    opts: { notification?: boolean; signal?: AbortSignal; timeoutMs?: number; retried?: boolean } = {},
  ): Promise<any> {
    const body =
      opts.notification
        ? { jsonrpc: "2.0" as const, method }
        : { jsonrpc: "2.0" as const, id: this.nextId++, method, params };

    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), opts.timeoutMs ?? 120_000);
    const signal = opts.signal ?? timeout.signal;

    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
          ...this.headers,
          ...(this.auth ? await this.auth.header() : {}),
        },
        body: JSON.stringify(body),
        signal,
      });
    } finally {
      // If the caller passed their own signal, only clear our timeout.
      clearTimeout(timer);
    }

    // Expired or revoked token: refresh once and retry, otherwise ask for a login.
    if (res.status === 401 && this.auth) {
      if (!opts.retried && (await this.auth.refresh())) {
        return this.rpc(method, params, { ...opts, retried: true });
      }
      throw new UnauthorizedError(this.serverName, res.headers.get("www-authenticate"));
    }

    const newSession = res.headers.get("Mcp-Session-Id");
    if (newSession) this.sessionId = newSession;

    if (opts.notification) {
      // 202 Accepted, no body — fire and forget.
      return null;
    }

    const contentType = res.headers.get("content-type") ?? "";
    let message: JsonRpcResponse | undefined;
    if (contentType.includes("text/event-stream")) {
      message = this.parseSse(await res.text(), body.id as number);
    } else if (contentType.includes("application/json")) {
      message = (await res.json()) as JsonRpcResponse;
    } else {
      const text = await res.text();
      // Some servers answer plain JSON without a content-type; tolerate that.
      try {
        message = JSON.parse(text) as JsonRpcResponse;
      } catch {
        throw new Error(`MCP ${method}: unexpected response ${res.status} (${contentType || "no content-type"}): ${text.slice(0, 200)}`);
      }
    }

    if (!res.ok && !message) {
      throw new Error(`MCP ${method}: HTTP ${res.status}`);
    }
    if (message?.error) {
      throw new Error(`MCP ${method}: ${message.error.message} (${message.error.code})`);
    }
    return message?.result;
  }

  /** Pull the JSON-RPC response carrying our id out of an SSE body. */
  private parseSse(text: string, id: number | string): JsonRpcResponse | undefined {
    let current: Record<string, any> | undefined;
    for (const line of text.split("\n")) {
      if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          current = JSON.parse(payload);
        } catch {
          continue;
        }
        // Response to our request (or a response without an id, e.g. a server reply on GET).
        if (current?.id === id || (current as JsonRpcResponse)?.result !== undefined) {
          return current as JsonRpcResponse;
        }
      }
    }
    return undefined;
  }

  async initialize(signal?: AbortSignal): Promise<string> {
    const result = await this.rpc(
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "pi-mcp-bridge", version: VERSION },
      },
      { signal, timeoutMs: 10_000 },
    );
    await this.rpc("notifications/initialized", undefined, { notification: true, signal });
    this.initialized = true;
    return `${result?.serverInfo?.name ?? "unknown"} ${result?.serverInfo?.version ?? ""}`.trim();
  }

  /** Re-run the handshake if the server dropped our session (e.g. Paper restarted). */
  private async ensureReady(signal?: AbortSignal): Promise<void> {
    if (this.initialized) return;
    await this.initialize(signal);
  }

  async listTools(signal?: AbortSignal): Promise<McpToolInfo[]> {
    await this.ensureReady(signal);
    const result = await this.rpc("tools/list", {}, { signal, timeoutMs: 30_000 });
    return (result?.tools ?? []) as McpToolInfo[];
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
    await this.ensureReady(signal);
    const result = await this.rpc("tools/call", { name, arguments: args }, { signal });
    return result as McpToolResult;
  }

  get isReady(): boolean {
    return this.initialized;
  }

  /** Drop session state so the next call re-initializes (e.g. after a server restart). */
  forgetSession(): void {
    this.sessionId = null;
    this.initialized = false;
  }
}

// ── MCP shapes ──────────────────────────────────────────────────────────────────────────────

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: { type?: string; properties?: Record<string, any>; required?: string[] };
}

interface McpToolResult {
  content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

// ── JSON Schema → TypeBox ───────────────────────────────────────────────────────────────────
// MCP inputSchemas are plain JSON Schema; pi tools want TypeBox. TypeBox schemas ARE JSON Schema,
// but we build real TypeBox nodes so validation, optional-wrapping and descriptions all work.
// Unknown shapes degrade to Type.Any() — permissive beats wrong; the server validates anyway.

function jsonSchemaToTypebox(schema: any, description?: string): TSchema {
  const opts = description ? { description } : {};
  if (!schema || typeof schema !== "object") return Type.Any(opts);

  if (Array.isArray(schema.enum)) {
    const values = schema.enum.filter((v: unknown) => typeof v === "string") as readonly string[];
    if (values.length === schema.enum.length) return StringEnum(values, opts);
    return Type.Any(opts);
  }

  switch (schema.type) {
    case "string":
      return Type.String(opts);
    case "number":
      return Type.Number(opts);
    case "integer":
      return Type.Integer(opts);
    case "boolean":
      return Type.Boolean(opts);
    case "array":
      return Type.Array(jsonSchemaToTypebox(schema.items, schema.items?.description), opts);
    case "object": {
      const required = new Set(schema.required ?? []);
      const props: Record<string, TSchema> = {};
      for (const [name, raw] of Object.entries(schema.properties ?? {})) {
        const converted = jsonSchemaToTypebox(raw, (raw as any)?.description);
        props[name] = required.has(name) ? converted : Type.Optional(converted);
      }
      return Type.Object(props, opts);
    }
    default:
      return Type.Any(opts);
  }
}

// ── The extension ───────────────────────────────────────────────────────────────────────────

interface ServerState {
  client: McpHttpClient;
  toolCount: number;
  serverInfo: string;
  error?: string;
}

export default async function mcpBridge(pi: ExtensionAPI) {
  const config = loadConfig();
  const servers = new Map<string, ServerState>();

  pi.on("session_start", async (_event, ctx) => {
    const good = [...servers].filter(([, s]) => !s.error);
    if (good.length > 0) {
      ctx.ui.notify(
        `mcp-bridge: ${good.map(([n, s]) => `${n} (${s.toolCount} tools)`).join(", ")}`,
        "info",
      );
    }
    const needLogin = [...servers].filter(([, s]) => s.error?.includes("/mcp login"));
    if (needLogin.length > 0) {
      ctx.ui.notify(
        `mcp-bridge: ${needLogin.map(([n]) => `/mcp login ${n}`).join(", ")} to sign in`,
        "warning",
      );
    }
  });

  for (const [serverName, cfg] of Object.entries(config.mcpServers)) {
    const auth = cfg.auth === "oauth" ? new OAuthProvider(serverName, cfg.url) : undefined;
    const client = new McpHttpClient(serverName, cfg.url, cfg.headers, auth);
    const state: ServerState = { client, toolCount: 0, serverInfo: "" };
    servers.set(serverName, state);

    // Never open a browser at startup: without stored credentials, wait for `/mcp login`.
    if (auth && !auth.hasCredentials()) {
      state.error = `not signed in — run /mcp login ${serverName}`;
      console.warn(`[mcp-bridge] ${serverName}: ${state.error}`);
      continue;
    }

    let tools: McpToolInfo[];
    try {
      state.serverInfo = await client.initialize();
      tools = await client.listTools();
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
      console.warn(`[mcp-bridge] ${serverName}: connection failed, tools unavailable — ${state.error}`);
      continue;
    }

    state.toolCount = tools.length;

    for (const tool of tools) {
      const piName = `${serverName}__${tool.name}`;
      const parameters = jsonSchemaToTypebox(tool.inputSchema);

      // Server-level guidance (e.g. Paper's "call get_guide first") is attached as a
      // promptGuidelines bullet on the FIRST tool of the server, so it enters the prompt once.
      const guidelines =
        cfg.instructions && tool === tools[0] ? [cfg.instructions] : undefined;

      pi.registerTool({
        name: piName,
        label: `${serverName}: ${tool.name}`,
        description: tool.description ?? `${serverName} MCP tool ${tool.name}`,
        promptSnippet: `${serverName} MCP tool: ${tool.name}`,
        promptGuidelines: guidelines,
        parameters,
        async execute(_toolCallId, params, signal) {
          // Session can be lost across Paper restarts; one silent re-init keeps calls working.
          try {
            const result = await client.callTool(tool.name, params as Record<string, unknown>, signal);
            if (signal?.aborted) throw new Error("Cancelled");

            const content = (result.content ?? []).map((block) => {
              if (block.type === "text") return { type: "text" as const, text: block.text ?? "" };
              if (block.type === "image" && block.data) {
                return {
                  type: "image" as const,
                  data: block.data,
                  mimeType: block.mimeType ?? "image/png",
                };
              }
              return { type: "text" as const, text: JSON.stringify(block) };
            });

            const text = content.filter((c) => c.type === "text").map((c) => (c as any).text).join("\n");
            if (result.isError) throw new Error(text || `MCP tool ${tool.name} failed`);

            return { content: content.length > 0 ? content : [{ type: "text" as const, text: "" }], details: {} };
          } catch (err) {
            // A dropped session (Paper restarted) is recoverable exactly once.
            if (err instanceof Error && /session/i.test(err.message)) {
              client.forgetSession();
            }
            throw err;
          }
        },
      });
    }

    console.log(`[mcp-bridge] ${serverName}: ${state.serverInfo} — ${tools.length} tools registered`);
  }

  // /mcp — status, reconnect, login <server>, logout <server>.
  pi.registerCommand("mcp", {
    description: "MCP bridge: status | reconnect | login <server> | logout <server>",
    handler: async (args, ctx) => {
      const [verb, target] = args.trim().split(/\s+/);
      const lines: string[] = [];

      if (verb === "login" || verb === "logout") {
        const state = target ? servers.get(target) : undefined;
        const auth = state?.client.auth;
        if (!state || !auth) {
          ctx.ui.notify(`${target ?? "<server>"}: not an OAuth server (set "auth": "oauth" in ${CONFIG_PATH})`, "error");
          return;
        }
        if (verb === "logout") {
          auth.clear();
          state.client.forgetSession();
          ctx.ui.notify(`${target}: credentials removed`, "info");
          return;
        }
        try {
          await auth.login((msg) => ctx.ui.notify(msg, "info"));
          state.client.forgetSession();
          state.serverInfo = await state.client.initialize();
          state.error = undefined;
          ctx.ui.notify(`${target}: signed in (${state.serverInfo}) — run /reload to register its tools`, "info");
        } catch (err) {
          ctx.ui.notify(`${target}: sign-in failed — ${err instanceof Error ? err.message : err}`, "error");
        }
        return;
      }

      for (const [name, state] of servers) {
        if (state.error) {
          lines.push(`${name}: DOWN (${state.error})`);
          if (verb === "reconnect") {
            try {
              state.serverInfo = await state.client.initialize();
              state.error = undefined;
              lines.push(`${name}: reconnected — restart pi or run /reload to register its tools`);
            } catch (err) {
              state.error = err instanceof Error ? err.message : String(err);
              lines.push(`${name}: reconnect failed — ${state.error}`);
            }
          }
        } else {
          lines.push(`${name}: ${state.serverInfo} — ${state.toolCount} tools`);
        }
      }
      if (servers.size === 0) {
        lines.push(`no servers configured in ${CONFIG_PATH}`);
      } else if (verb !== "reconnect") {
        lines.push("(/mcp reconnect to retry failed servers, /mcp login <server> to sign in)");
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
