import type { MCPServer, MCPTransport } from '@weaveintel/core';
import { weaveContext } from '@weaveintel/core';
import { createMCPStdioServerTransport, weaveMCPServer } from '@weaveintel/mcp-server';
import { statsNzToolMap } from '@weaveintel/tools-http';

export interface StatsNzMCPServerConfig {
  name?: string;
  version?: string;
}

export interface StatsNzMCPServerRuntime {
  server: MCPServer;
  tools: ReturnType<typeof statsNzToolMap>;
}

/**
 * Creates a Stats NZ MCP server and registers all statsnz_* tools.
 */
export function createStatsNzMCPServer(config: StatsNzMCPServerConfig = {}): StatsNzMCPServerRuntime {
  const server = weaveMCPServer({
    name: config.name ?? 'statsnz-ade',
    version: config.version ?? '1.0.0',
  });

  const tools = statsNzToolMap();
  for (const tool of Object.values(tools)) {
    server.addTool(
      {
        name: tool.schema.name,
        description: tool.schema.description,
        inputSchema: tool.schema.parameters as Record<string, unknown>,
      },
      async (_ctx, args) => {
        try {
          const ctx = weaveContext();
          const output = await tool.invoke(ctx, { name: tool.schema.name, arguments: args as Record<string, unknown> });
          const text = typeof output.content === 'string' ? output.content : JSON.stringify(output.content, null, 2);
          return { content: [{ type: 'text', text }] };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: 'text', text: `Error: ${message}` }],
            isError: true,
          };
        }
      },
    );
  }

  return { server, tools };
}

/**
 * Creates a stdio transport for line-delimited JSON-RPC messages.
 */
export function createStdioJsonRpcTransport(): MCPTransport {
  return createMCPStdioServerTransport();
}

/**
 * Convenience helper: creates and starts a Stats NZ MCP server on stdio.
 */
export async function startStatsNzMCPServerOverStdio(
  config: StatsNzMCPServerConfig = {},
): Promise<StatsNzMCPServerRuntime & { transport: MCPTransport }> {
  const runtime = createStatsNzMCPServer(config);
  const transport = createStdioJsonRpcTransport();
  await runtime.server.start(transport);
  return { ...runtime, transport };
}
