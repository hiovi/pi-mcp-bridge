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
// Graceful degradation: a server that is down (e.g. Paper.app not running) is skipped with a
// warning instead of killing startup. `/mcp` reports status and retries failed connections.
// Restart pi (or /reload) after editing the config file.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TSchema } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Config ──────────────────────────────────────────────────────────────────────────────────

interface HttpServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  /** Extra prompt guideline shown once for this server's tools (optional). */
  instructions?: string;
}

interface BridgeConfig {
  mcpServers: Record<string, HttpServerConfig>;
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "mcp-servers.json");

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
      instructions: cfg.instructions,
    };
  }
  return { mcpServers: servers };
}

// ── Minimal streamable-HTTP MCP client ──────────────────────────────────────────────────────

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

class McpHttpClient {
  private nextId = 1;
  private sessionId: string | null = null;
  private initialized = false;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string> = {},
  ) {}

  /** POST one JSON-RPC message; parse the JSON or SSE response; return the response for our id. */
  private async rpc(
    method: string,
    params: unknown,
    opts: { notification?: boolean; signal?: AbortSignal; timeoutMs?: number } = {},
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
        },
        body: JSON.stringify(body),
        signal,
      });
    } finally {
      // If the caller passed their own signal, only clear our timeout.
      clearTimeout(timer);
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
        clientInfo: { name: "pi-mcp-bridge", version: "0.1.0" },
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
  });

  for (const [serverName, cfg] of Object.entries(config.mcpServers)) {
    const client = new McpHttpClient(cfg.url, cfg.headers);
    const state: ServerState = { client, toolCount: 0, serverInfo: "" };
    servers.set(serverName, state);

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

  // /mcp — status and reconnect for failed servers.
  pi.registerCommand("mcp", {
    description: "MCP bridge: server status and reconnect",
    handler: async (args, ctx) => {
      const lines: string[] = [];
      for (const [name, state] of servers) {
        if (state.error) {
          lines.push(`${name}: DOWN (${state.error})`);
          if (args.trim() === "reconnect") {
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
        lines.push("no servers configured in ~/.pi/agent/mcp-servers.json");
      } else if (args.trim() !== "reconnect") {
        lines.push("(run /mcp reconnect to retry failed servers)");
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
