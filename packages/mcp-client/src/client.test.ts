import { describe, expect, it } from 'vitest';
import { weaveMCPClient } from './client.js';
import type { MCPTransport, ExecutionContext } from '@weaveintel/core';

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
          onMessage({ jsonrpc: '2.0', id: msg.id, result: { ok: true } });
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
});
