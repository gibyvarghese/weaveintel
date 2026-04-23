import { describe, expect, it } from 'vitest';
import { weaveMCPClient, weaveMCPTools } from './client.js';
import type { MCPTransport, ExecutionContext } from '@weaveintel/core';
import { weaveContext } from '@weaveintel/core';

describe('weaveMCPClient context propagation', () => {
  it('forwards execution context metadata in tools/call _meta payload', async () => {
    const sent: unknown[] = [];
    let onMessage: ((message: unknown) => void) | null = null;

    const transport: MCPTransport = {
      type: 'http',
      async send(message: unknown): Promise<void> {
        sent.push(message);
        const msg = message as { id?: number; method?: string };
        if (msg.method === 'initialize' && msg.id != null && onMessage) {
          onMessage({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {}, resources: {}, prompts: {} },
              serverInfo: { name: 'fixture', version: '1.0.0' },
            },
          });
          return;
        }
        if (msg.method === 'tools/call' && msg.id != null && onMessage) {
          onMessage({
            jsonrpc: '2.0',
            id: msg.id,
            result: { content: [{ type: 'text', text: 'ok' }] },
          });
        }
      },
      onMessage(handler: (message: unknown) => void): void {
        onMessage = handler;
      },
      async close(): Promise<void> {
        return;
      },
    };

    const client = weaveMCPClient();
    await client.connect(transport);

    const ctx: ExecutionContext = {
      executionId: 'exec_123',
      tenantId: 'tenant_abc',
      userId: 'user_xyz',
      parentSpanId: 'span_1',
      deadline: Date.now() + 10_000,
      metadata: { trace: 't1' },
      budget: { maxSteps: 5, maxCostUsd: 1.25 },
    };

    const response = await client.callTool(ctx, {
      name: 'search.query',
      arguments: { query: 'phase 3f' },
    });

    expect(response.content[0]).toEqual({ type: 'text', text: 'ok' });

    const toolCallReq = sent.find((m) => {
      const msg = m as { method?: string };
      return msg.method === 'tools/call';
    }) as { params?: Record<string, unknown> } | undefined;

    expect(toolCallReq).toBeDefined();
    const meta = (toolCallReq?.params?.['_meta'] as Record<string, unknown> | undefined);
    const executionContext = meta?.['executionContext'] as Record<string, unknown> | undefined;

    expect(executionContext?.['executionId']).toBe('exec_123');
    expect(executionContext?.['tenantId']).toBe('tenant_abc');
    expect(executionContext?.['userId']).toBe('user_xyz');
    expect(executionContext?.['metadata']).toEqual({ trace: 't1' });
  });

  it('prefers streaming output when MCP tools are bridged into weave tools', async () => {
    let callToolCalled = false;
    const registry = weaveMCPTools({
      async connect() {
        return;
      },
      async listTools() {
        return [];
      },
      async callTool() {
        callToolCalled = true;
        return { content: [{ type: 'text', text: 'fallback' }], isError: false };
      },
      async listResources() {
        return [];
      },
      async readResource() {
        throw new Error('not used');
      },
      async listPrompts() {
        return [];
      },
      async getPrompt() {
        return [];
      },
      async *streamToolCall() {
        yield {
          type: 'started',
          timestamp: new Date().toISOString(),
        };
        yield {
          type: 'final_output',
          timestamp: new Date().toISOString(),
          output: { content: [{ type: 'text', text: 'streamed' }], isError: false },
        };
      },
      async disconnect() {
        return;
      },
    }, [
      {
        name: 'stream.demo',
        description: 'demo',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
    ]);

    const tool = registry.get('stream.demo');
    expect(tool).toBeDefined();

    const result = await tool!.invoke(weaveContext(), {
      name: 'stream.demo',
      arguments: {},
    });

    expect(result).toEqual({ content: 'streamed', isError: false });
    expect(callToolCalled).toBe(false);
  });
});
