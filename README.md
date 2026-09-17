# pi-mcp-bridge

MCP support for the [pi coding agent](https://github.com/badlogic/pi-mono), as an extension.

pi has no built-in MCP (by design: "build an extension that adds MCP support"). This is that extension. It reads `~/.pi/agent/mcp-servers.json` (Claude-compatible `mcpServers` shape), connects to each **streamable-HTTP** MCP server, and registers every server tool as a native pi tool named `<server>__<tool>` (e.g. `paper__get_screenshot`) so the model calls MCP tools like any other.

## Features

- **Native tools** — each MCP tool becomes a real pi tool with a TypeBox schema converted from the server's JSON Schema, so validation and optional-argument handling work.
- **Rich results** — MCP text → text blocks, MCP images (base64 + mimeType) → image blocks. An MCP result with `isError: true` throws, recorded as a failed tool call.
- **Graceful degradation** — a server that is down (e.g. Paper.app not running) is skipped with a warning instead of killing startup.
- **Session recovery** — a dropped MCP session (server restart) is silently re-initialized once per call.
- **Server instructions** — an optional per-server `instructions` string is attached to the prompt once (e.g. "call get_guide first").
- **`/mcp` command** — reports each server's status; `/mcp reconnect` retries failed connections.

## Install

```bash
pi install git:github.com/hiovi/pi-mcp-bridge
```

## Configure

Create `~/.pi/agent/mcp-servers.json` with a Claude-compatible shape. Only `type: "http"` (streamable HTTP transport) is supported; stdio servers are not.

```json
{
  "mcpServers": {
    "paper": {
      "type": "http",
      "url": "http://127.0.0.1:29979/mcp",
      "headers": { "Authorization": "Bearer paper-local" },
      "instructions": "Call paper__get_guide first."
    }
  }
}
```

Restart pi (or run `/reload`) after editing the config file.

## Note

The extension does not launch servers — it connects to already-running HTTP endpoints. Point it at whatever serves your MCP server (a desktop app, a local dev server, etc.) and make sure it is running before you start pi.

## License

MIT
