/**
 * Built-in handler kind: `external.mcp-tool`.
 *
 * Invokes a single tool on an external MCP (Model Context Protocol) server
 * via JSON-RPC 2.0. Returns the tool result as the agent output. No LLM call.
 *
 * MCP is the open standard for tool servers introduced by Anthropic in 2024
 * and now (mid-2026) widely adopted across the agent ecosystem. Each MCP
 * server exposes a `tools/call` JSON-RPC method accepting a `{ name, arguments }`
 * payload and returning `{ content: [...], isError: boolean }`.
 *
 * --- Config shape ---
 *
 *   {
 *     "mcp_server_url": "https://mcp.example.com/tools",  // REQUIRED
 *     "tool_name":      "search",                          // REQUIRED
 *     "headers":        { "Authorization": "Bearer <token>" },
 *     "timeout_ms":     30000,
 *   }
 *
 * --- Argument resolution ---
 *
 * Tool arguments are sourced from the inbound task body. The handler attempts
 * to parse the body as JSON; if that fails, it wraps the body text in a
 * `{ "input": "<body>" }` object. This lets operators send either structured
 * JSON arguments or plain text instructions to the MCP tool.
 *
 * --- MCP JSON-RPC 2.0 wire format (spec ref: modelcontextprotocol.io) ---
 *
 *   POST <mcp_server_url>
 *   Content-Type: application/json
 *   { "jsonrpc": "2.0", "id": "<uuid>", "method": "tools/call",
 *     "params": { "name": "<tool_name>", "arguments": <args> } }
 *
 * Response:
 *   { "jsonrpc": "2.0", "id": "<uuid>",
 *     "result": { "content": [...], "isError": false } }
 */

import type {
  ActionExecutionContext,
  AttentionAction,
  TaskHandler,
  TaskHandlerResult,
} from '@weaveintel/live-agents';
import { loadLatestInboundTask } from '@weaveintel/live-agents';
import type { ExecutionContext } from '@weaveintel/core';
import type { HandlerContext, HandlerKindRegistration } from '../handler-registry.js';

export interface ExternalMcpToolConfig {
  mcp_server_url: string;
  tool_name: string;
  headers?: Record<string, string>;
  timeout_ms?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function readConfig(raw: Record<string, unknown>): ExternalMcpToolConfig {
  if (typeof raw['mcp_server_url'] !== 'string' || !raw['mcp_server_url']) {
    throw new Error('external.mcp-tool: config.mcp_server_url is required.');
  }
  if (typeof raw['tool_name'] !== 'string' || !raw['tool_name']) {
    throw new Error('external.mcp-tool: config.tool_name is required.');
  }
  const cfg: ExternalMcpToolConfig = {
    mcp_server_url: raw['mcp_server_url'],
    tool_name:      raw['tool_name'],
  };
  if (raw['headers'] && typeof raw['headers'] === 'object') {
    cfg.headers = raw['headers'] as Record<string, string>;
  }
  if (typeof raw['timeout_ms'] === 'number') cfg.timeout_ms = raw['timeout_ms'];
  return cfg;
}

function resolveArguments(body: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // fall through
  }
  return { input: body };
}

interface McpJsonRpcResponse {
  jsonrpc: '2.0';
  id: string;
  result?: {
    content: Array<{ type: string; text?: string; [k: string]: unknown }>;
    isError?: boolean;
  };
  error?: { code: number; message: string; data?: unknown };
}

function makeRpcId(): string {
  return `rpc_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

async function callMcpTool(
  cfg: ExternalMcpToolConfig,
  toolArguments: Record<string, unknown>,
  log: (msg: string) => void,
): Promise<string> {
  const rpcId = makeRpcId();
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id:      rpcId,
    method:  'tools/call',
    params:  { name: cfg.tool_name, arguments: toolArguments },
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeout_ms ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(cfg.mcp_server_url, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.headers ?? {}),
      },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '(no body)');
    throw new Error(
      `external.mcp-tool: HTTP ${response.status} from ${cfg.mcp_server_url}: ${text}`,
    );
  }

  const rpc = (await response.json()) as McpJsonRpcResponse;

  if (rpc.error) {
    throw new Error(
      `external.mcp-tool: MCP JSON-RPC error ${rpc.error.code}: ${rpc.error.message}`,
    );
  }

  if (!rpc.result) {
    throw new Error('external.mcp-tool: MCP response missing result field.');
  }

  if (rpc.result.isError) {
    const errText = rpc.result.content.map((c) => c.text ?? JSON.stringify(c)).join('\n');
    throw new Error(`external.mcp-tool: tool returned isError=true: ${errText}`);
  }

  const output = rpc.result.content.map((c) => c.text ?? JSON.stringify(c)).join('\n');
  log(`external.mcp-tool: ${cfg.tool_name} returned ${output.length} chars`);
  return output;
}

function buildExternalMcpTool(ctx: HandlerContext): TaskHandler {
  const cfg = readConfig(ctx.binding.config);

  return async (
    _action: AttentionAction & { type: 'StartTask' | 'ContinueTask' },
    execCtx: ActionExecutionContext,
    _xCtx: ExecutionContext,
  ): Promise<TaskHandlerResult> => {
    const inbound = await loadLatestInboundTask(execCtx);
    if (!inbound) {
      ctx.log(`external.mcp-tool: empty inbox for ${ctx.agent.id}, no-op.`);
      return { completed: true, summaryProse: 'no-op (empty inbox)' };
    }

    const toolArguments = resolveArguments(inbound.body);
    ctx.log(`external.mcp-tool: calling ${cfg.tool_name} at ${cfg.mcp_server_url}`);

    const result = await callMcpTool(cfg, toolArguments, ctx.log);

    return {
      completed:    true,
      summaryProse: `MCP tool ${cfg.tool_name} completed:\n\n${result}`,
    };
  };
}

export const externalMcpToolHandler: HandlerKindRegistration = {
  kind:        'external.mcp-tool',
  description: 'Invokes a single tool on an external MCP (Model Context Protocol) server via JSON-RPC. Returns the tool result as the agent output without any LLM call.',
  configSchema: {
    type: 'object',
    required: ['mcp_server_url', 'tool_name'],
    properties: {
      mcp_server_url: { type: 'string', format: 'uri', description: 'MCP server endpoint URL.' },
      tool_name:      { type: 'string', description: 'Name of the tool to call.' },
      headers:        { type: 'object', description: 'Extra HTTP headers (e.g. Authorization: Bearer …).' },
      timeout_ms:     { type: 'integer', default: 30000 },
    },
  },
  factory: buildExternalMcpTool,
};
