/**
 * Internal MCP Gateway — Phase 1D
 *
 * Exposes a curated subset of GeneWeave builtin tools (web, social, search,
 * cse, http, enterprise, communication classes by default) over the MCP
 * Streamable HTTP transport so external clients (Claude Desktop, other
 * GeneWeave instances, or arbitrary MCP-aware agents) can use them through
 * a single bearer-token authenticated endpoint.
 *
 * Transport mode: stateless. Per the @modelcontextprotocol/sdk contract,
 * stateless transports must NOT be reused across requests (otherwise
 * message-ID collisions occur — see SDK source comment in
 * webStandardStreamableHttp.js around line 137). We therefore build a fresh
 * MCP server + transport pair per request from a cached set of tool
 * registrations.
 *
 * Why an internal gateway: The platform-level direction is to wrap every
 * external tool as MCP so tools become swappable, credential-managed, and
 * observability-uniform. Surfacing the existing in-process Tool registry as
 * one MCP server avoids a separate process per tool family. Tool selection
 * is driven by the same `inferAllocationClass()` taxonomy that powers
 * `tool_catalog.allocation_class`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  weaveMCPServer,
  createMCPStreamableHttpServerTransport,
  type MCPStreamableHttpServerTransport,
} from '@weaveintel/mcp-server';
import { weaveContext } from '@weaveintel/core';
import type { ExecutionContext, Tool, MCPToolCallResponse, JsonSchema } from '@weaveintel/core';
import { BUILTIN_TOOLS, inferAllocationClass } from './tools.js';

/** Allocation classes considered "external" — these are exposed by default. */
export const DEFAULT_EXPOSED_ALLOCATION_CLASSES: ReadonlySet<string> = new Set([
  'web',
  'social',
  'search',
  'cse',
  'http',
  'enterprise',
  'communication',
]);

export interface MCPGatewayOptions {
  /** Override which tools are exposed. When omitted, BUILTIN_TOOLS is used. */
  tools?: Record<string, Tool>;
  /** Override which allocation classes are exposed. */
  exposedClasses?: ReadonlySet<string>;
  /** Bearer token required on every request. When undefined, the gateway is disabled. */
  token?: string;
  /** Server name reported in the MCP initialize handshake. Defaults to `geneweave-gateway`. */
  serverName?: string;
  /** Server version reported in the MCP initialize handshake. */
  serverVersion?: string;
}

export interface MCPGatewayHandle {
  /** Inspect which tool keys are currently exposed. */
  readonly exposedToolNames: string[];
  /** True iff a token was supplied and the gateway accepts requests. */
  readonly enabled: boolean;
  /** Handle a single HTTP request. */
  handle(req: IncomingMessage, res: ServerResponse, parsedBody?: unknown): Promise<void>;
  /** Tear down (no-op for stateless gateways but keeps the handle symmetric). */
  close(): Promise<void>;
}

interface ExposedToolEntry {
  key: string;
  tool: Tool;
  allocationClass: string;
}

function selectExposedTools(
  tools: Record<string, Tool>,
  classes: ReadonlySet<string>,
): ExposedToolEntry[] {
  const out: ExposedToolEntry[] = [];
  for (const [key, tool] of Object.entries(tools)) {
    const cls = inferAllocationClass(key, tool.schema.tags);
    if (cls && classes.has(cls)) out.push({ key, tool, allocationClass: cls });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

function toMCPResponse(content: string, isError: boolean | undefined): MCPToolCallResponse {
  return { content: [{ type: 'text', text: content }], isError: isError === true };
}

/**
 * Build a Streamable HTTP MCP gateway. Construction is synchronous so it can
 * be wired into the existing sync `createGeneWeaveServer` factory. The MCP
 * server + transport pair is created fresh on every request, as required by
 * the SDK in stateless mode.
 */
export function createMCPGateway(opts: MCPGatewayOptions): MCPGatewayHandle {
  const tools = opts.tools ?? BUILTIN_TOOLS;
  const classes = opts.exposedClasses ?? DEFAULT_EXPOSED_ALLOCATION_CLASSES;
  const exposed = selectExposedTools(tools, classes);
  const token = opts.token;
  const enabled = typeof token === 'string' && token.length > 0;
  const serverName = opts.serverName ?? 'geneweave-gateway';
  const serverVersion = opts.serverVersion ?? '1.0.0';
  const exposedToolNames = exposed.map((e) => e.key);

  function unauthorized(res: ServerResponse): void {
    const body = JSON.stringify({ error: 'Unauthorized' });
    res.writeHead(401, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  function disabledResponse(res: ServerResponse): void {
    const body = JSON.stringify({ error: 'MCP gateway is disabled (set GENEWEAVE_MCP_GATEWAY_TOKEN to enable)' });
    res.writeHead(503, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  function checkAuth(req: IncomingMessage): boolean {
    if (!enabled) return false;
    const header = req.headers['authorization'] ?? req.headers['Authorization' as never];
    const value = Array.isArray(header) ? header[0] : header;
    if (!value || typeof value !== 'string') return false;
    const m = value.match(/^Bearer\s+(.+)$/i);
    if (!m) return false;
    return m[1] === token;
  }

  /**
   * Build a fresh MCP server + transport, register every exposed tool, and
   * connect the pair. Returns both so the caller can route the request and
   * tear them down afterwards.
   */
  async function buildPerRequestServer(): Promise<{ stop: () => Promise<void>; transport: MCPStreamableHttpServerTransport }> {
    const server = weaveMCPServer(
      {
        name: serverName,
        version: serverVersion,
        description:
          'GeneWeave internal MCP gateway exposing external builtin tools (web, social, search, cse, http, enterprise, communication).',
      },
      {
        contextFactory: (): ExecutionContext =>
          weaveContext({
            metadata: { source: 'mcp-gateway', persona: 'agent_supervisor' },
          }),
      },
    );

    for (const { key, tool, allocationClass } of exposed) {
      server.addTool(
        {
          name: key,
          description: `[${allocationClass}] ${tool.schema.description}`,
          inputSchema: tool.schema.parameters as JsonSchema,
        },
        async (ctx, args) => {
          try {
            const result = await tool.invoke(ctx, { name: key, arguments: args });
            return toMCPResponse(result.content, result.isError);
          } catch (err) {
            return toMCPResponse(`Error: ${(err as Error).message}`, true);
          }
        },
      );
    }

    const transport = createMCPStreamableHttpServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.start(transport);
    return {
      transport,
      stop: () => server.stop(),
    };
  }

  return {
    exposedToolNames,
    enabled,
    async handle(req, res, parsedBody) {
      if (!enabled) { disabledResponse(res); return; }
      if (!checkAuth(req)) { unauthorized(res); return; }
      const { transport, stop } = await buildPerRequestServer();
      try {
        await transport.handleRequest(req, res, parsedBody);
      } finally {
        try { await stop(); } catch { /* best-effort */ }
      }
    },
    async close() {
      // No persistent resources held — nothing to clean up.
    },
  };
}
