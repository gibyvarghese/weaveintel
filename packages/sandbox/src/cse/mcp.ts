import type { ExecutionContext } from '@weaveintel/core';
import { weaveContext } from '@weaveintel/core';
import { weaveMCPServer } from '@weaveintel/mcp-server';
import type { ComputeSandboxEngine } from './executor.js';
import { CSE_TOOL_DEFINITIONS, handleCSETool } from './tools.js';

export interface CSEMCPServerOptions {
  cse: ComputeSandboxEngine;
  name?: string;
  version?: string;
  description?: string;
}

function resolveChatId(ctx: ExecutionContext): string | undefined {
  const fromMetadata = ctx.metadata?.['chatId'];
  return typeof fromMetadata === 'string' ? fromMetadata : undefined;
}

/**
 * Expose CSE capabilities as MCP tools so any MCP-capable runtime
 * (agents, live-agents account sessions, external MCP clients) can call them.
 */
export function createCSEMCPServer(opts: CSEMCPServerOptions) {
  const server = weaveMCPServer(
    {
      name: opts.name ?? 'cse',
      version: opts.version ?? '0.1.0',
      description: opts.description ?? 'Compute Sandbox Engine tools exposed over MCP',
    },
    {
      contextFactory: (params) => {
        const executionContext = (params['_meta'] as { executionContext?: Partial<ExecutionContext> } | undefined)
          ?.executionContext;
        return weaveContext(executionContext ?? {});
      },
    },
  );

  for (const def of CSE_TOOL_DEFINITIONS) {
    server.addTool(
      {
        name: def.name,
        description: def.description,
        inputSchema: def.parameters,
      },
      async (ctx, args) => {
        const result = await handleCSETool(def.name, args, {
          cse: opts.cse,
          userId: ctx.userId,
          chatId: resolveChatId(ctx),
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      },
    );
  }

  return server;
}
