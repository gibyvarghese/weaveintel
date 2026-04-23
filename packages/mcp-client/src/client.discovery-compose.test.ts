import { describe, expect, it } from 'vitest';
import { weaveContext, type MCPClient, type MCPTransport } from '@weaveintel/core';
import { weaveMCPClient } from './client.js';

type ExtendedMCPClient = MCPClient & {
  discoverCapabilities?: (query?: {
    namespacePrefix?: string;
    tags?: readonly string[];
    includeDetails?: boolean;
    limit?: number;
  }) => Promise<{
    items: readonly { kind: 'tool' | 'resource' | 'prompt'; name: string }[];
    nextCursor?: string;
  }>;
  composeToolCalls?: (ctx: ReturnType<typeof weaveContext>, plan: {
    id: string;
    steps: readonly {
      id: string;
      toolName: string;
      arguments?: Record<string, unknown>;
      dependsOn?: readonly string[];
      inputFromStepId?: string;
      inputPath?: string;
      mergeInputAs?: string;
    }[];
  }) => Promise<{
    outputsByStepId: Record<string, { content: { type: string; text?: string }[] }>;
  }>;
};

function createMockTransport(): { transport: MCPTransport; sent: unknown[] } {
  let onMessage: ((message: unknown) => void) | null = null;
  const sent: unknown[] = [];

  const transport: MCPTransport = {
    type: 'http',
    async send(message: unknown): Promise<void> {
      sent.push(message);
      const request = message as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
      };
      if (!request.method || request.id == null || !onMessage) return;

      if (request.method === 'initialize') {
        onMessage({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {}, resources: {}, prompts: {} },
            serverInfo: { name: 'mock', version: '1.0.0' },
          },
        });
        return;
      }

      if (request.method === 'tools/list') {
        onMessage({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            tools: [
              {
                name: 'ns.alpha.tool_a',
                description: 'A',
                inputSchema: { type: 'object', properties: {}, required: [] },
                _meta: { tags: ['alpha'] },
              },
              {
                name: 'ns.beta.tool_b',
                description: 'B',
                inputSchema: { type: 'object', properties: {}, required: [] },
                _meta: { tags: ['beta'] },
              },
            ],
            nextCursor: 'cursor-2',
          },
        });
        return;
      }

      if (request.method === 'resources/list') {
        onMessage({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            resources: [
              { uri: 'resource://alpha', name: 'Alpha Resource', description: 'Resource A', _meta: { tags: ['alpha'] } },
            ],
          },
        });
        return;
      }

      if (request.method === 'prompts/list') {
        onMessage({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            prompts: [
              { name: 'ns.alpha.prompt_a', description: 'Prompt A', _meta: { tags: ['alpha'] } },
            ],
          },
        });
        return;
      }

      if (request.method === 'tools/call') {
        const toolName = String(request.params?.['name'] ?? '');
        const args = (request.params?.['arguments'] ?? {}) as Record<string, unknown>;

        if (toolName === 'first') {
          onMessage({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              content: [{ type: 'text', text: 'first-output' }],
            },
          });
          return;
        }

        if (toolName === 'second') {
          onMessage({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              content: [{ type: 'text', text: `second:${String(args['previous'] ?? '')}` }],
            },
          });
          return;
        }

        onMessage({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            content: [{ type: 'text', text: `echo:${toolName}` }],
          },
        });
      }
    },
    onMessage(handler: (message: unknown) => void): void {
      onMessage = handler;
    },
    async close(): Promise<void> {
      onMessage = null;
    },
  };

  return { transport, sent };
}

describe('weaveMCPClient progressive discovery and composition', () => {
  it('discovers capabilities progressively with filtering', async () => {
    const { transport } = createMockTransport();
    const client = weaveMCPClient() as ExtendedMCPClient;
    await client.connect(transport);

    const page = await client.discoverCapabilities?.({
      namespacePrefix: 'ns.alpha',
      tags: ['alpha'],
      includeDetails: true,
      limit: 10,
    });

    expect(page).toBeDefined();
    expect(page?.items.some((item: { kind: 'tool' | 'resource' | 'prompt'; name: string }) => item.kind === 'tool' && item.name === 'ns.alpha.tool_a')).toBe(true);
    expect(page?.items.some((item: { kind: 'tool' | 'resource' | 'prompt'; name: string }) => item.kind === 'prompt' && item.name === 'ns.alpha.prompt_a')).toBe(true);
    expect(page?.nextCursor).toBe('cursor-2');
    expect(page?.details?.['tool:ns.alpha.tool_a']).toMatchObject({
      inputSchema: { type: 'object', properties: {}, required: [] },
      metadata: { cached: true, tags: ['alpha'] },
    });

    await client.disconnect();
  });

  it('composes dependent tool calls with output reuse', async () => {
    const { transport } = createMockTransport();
    const client = weaveMCPClient() as ExtendedMCPClient;
    await client.connect(transport);

    const ctx = weaveContext({ tenantId: 't', userId: 'u' });
    const result = await client.composeToolCalls?.(ctx, {
      id: 'plan-1',
      steps: [
        { id: 'step-1', toolName: 'first' },
        {
          id: 'step-2',
          toolName: 'second',
          inputFromStepId: 'step-1',
          inputPath: 'content.0.text',
          mergeInputAs: 'previous',
          dependsOn: ['step-1'],
        },
      ],
    });

    expect(result).toBeDefined();
    expect(result?.outputsByStepId['step-1']?.content[0]).toEqual({ type: 'text', text: 'first-output' });
    expect(result?.outputsByStepId['step-2']?.content[0]).toEqual({ type: 'text', text: 'second:first-output' });

    await client.disconnect();
  });
});
