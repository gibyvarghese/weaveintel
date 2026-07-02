// SPDX-License-Identifier: MIT
/**
 * @weaveintel/notes — MCP (Model Context Protocol) protocol core (weaveNotes Phase 3).
 *
 * MCP is the open standard (originated by Anthropic) that lets an external AI app — Claude Desktop,
 * ChatGPT, Cursor — connect to a server and call its TOOLS. This module is the pure, transport-free
 * heart of a weaveNotes MCP server: it speaks the JSON-RPC 2.0 wire protocol (`initialize`,
 * `tools/list`, `tools/call`, `notifications/initialized`) so the app can expose a user's note vault
 * (search / read / list / create / append) over a single Streamable-HTTP endpoint.
 *
 * It is deliberately tool-only (the most portable MCP primitive) and stateless — each call carries
 * its own bearer auth, resolved by the app to a user; this module never sees credentials. The app
 * supplies a `listTools()` + an async `callTool(name, args)`; everything else (the handshake, error
 * shapes, the content envelope) lives here. Pure + zero-dependency.
 */

/** The MCP protocol revision we advertise (latest stable as of 2026). */
export const MCP_PROTOCOL_VERSION = '2025-11-25';
/** Older revision we still accept on a client `initialize` (we echo whatever it asks if we know it). */
const ACCEPTED_PROTOCOL_VERSIONS = new Set(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

/** A tool the MCP server exposes (name + JSON-Schema input). */
export interface McpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** A `tools/call` result — an array of content blocks + an error flag (tool errors are NOT protocol errors). */
export interface McpToolResult { content: Array<{ type: 'text'; text: string }>; isError?: boolean }

/** A JSON-RPC 2.0 request/notification as received on the wire. */
export interface JsonRpcMessage { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }

/** Build a plain-text tool result (the common case). */
export function mcpText(text: string, isError = false): McpToolResult { return { content: [{ type: 'text', text: String(text ?? '') }], isError }; }

function ok(id: JsonRpcMessage['id'], result: unknown): Record<string, unknown> { return { jsonrpc: '2.0', id: id ?? null, result }; }
function err(id: JsonRpcMessage['id'], code: number, message: string): Record<string, unknown> { return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }; }

export interface McpServerInfo { name: string; version: string; instructions?: string }
export interface McpHandlers { serverInfo: McpServerInfo; listTools: () => McpTool[] | Promise<McpTool[]>; callTool: (name: string, args: Record<string, unknown>) => Promise<McpToolResult> }

/**
 * Handle ONE incoming JSON-RPC message and return the response object to send back — or `null` when
 * the message is a notification (e.g. `notifications/initialized`), which gets an HTTP 202 with no
 * body. Never throws: a thrown tool turns into a `tools/call` result with `isError: true` (so the
 * model can self-correct), and protocol problems return standard JSON-RPC errors.
 */
export async function handleMcpMessage(msg: JsonRpcMessage, h: McpHandlers): Promise<Record<string, unknown> | null> {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return err(msg?.id ?? null, -32600, 'Invalid Request');
  }
  const { method, id } = msg;

  // Notifications (no id) get no response.
  if (method.startsWith('notifications/')) return null;

  switch (method) {
    case 'initialize': {
      const asked = (msg.params?.['protocolVersion'] as string) || MCP_PROTOCOL_VERSION;
      const protocolVersion = ACCEPTED_PROTOCOL_VERSIONS.has(asked) ? asked : MCP_PROTOCOL_VERSION;
      return ok(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: h.serverInfo.name, version: h.serverInfo.version },
        ...(h.serverInfo.instructions ? { instructions: h.serverInfo.instructions } : {}),
      });
    }
    case 'ping': return ok(id, {});
    case 'tools/list': return ok(id, { tools: await h.listTools() });
    case 'tools/call': {
      const name = msg.params?.['name'];
      if (typeof name !== 'string' || !name) return err(id, -32602, 'Invalid params: tool name required');
      const args = (msg.params?.['arguments'] && typeof msg.params['arguments'] === 'object' ? msg.params['arguments'] : {}) as Record<string, unknown>;
      const tools = await h.listTools();
      if (!tools.some((t) => t.name === name)) return err(id, -32602, `Unknown tool: ${name}`);
      try {
        const result = await h.callTool(name, args);
        return ok(id, result);
      } catch (e) {
        // Tool execution errors are returned as a result with isError=true (per MCP), not a protocol error.
        return ok(id, mcpText(`Tool "${name}" failed: ${e instanceof Error ? e.message : 'error'}`, true));
      }
    }
    // Read/list of resources & prompts are intentionally not implemented (tools-only server).
    case 'resources/list': return ok(id, { resources: [] });
    case 'prompts/list': return ok(id, { prompts: [] });
    default: return err(id, -32601, `Method not found: ${method}`);
  }
}
