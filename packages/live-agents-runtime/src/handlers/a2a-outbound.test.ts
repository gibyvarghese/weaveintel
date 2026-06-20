import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { a2aOutboundHandler } from './a2a-outbound.js';
import type { HandlerContext } from '../handler-registry.js';
import type { ActionExecutionContext } from '@weaveintel/live-agents';
import type { ExecutionContext } from '@weaveintel/core';
import type { LiveAgent } from '@weaveintel/live-agents';

function makeCtx(config: Record<string, unknown> = {}): HandlerContext {
  return {
    binding: { id: 'b1', agentId: 'a1', handlerKind: 'a2a.outbound', config: { targetUrl: 'http://remote.test', ...config } },
    agent: { id: 'a1', meshId: 'm1', roleKey: 'delegator', name: 'Delegator' },
    log: () => {},
  };
}

function makeExecCtx(inboxMessage?: unknown): ActionExecutionContext {
  const messages = inboxMessage ? [inboxMessage] : [];
  return {
    tickId: 'tick-1',
    nowIso: new Date().toISOString(),
    agent: { id: 'a1', role: 'delegator', name: 'Delegator', meshId: 'm1', status: 'ACTIVE' } as unknown as LiveAgent,
    activeBindings: [],
    stateStore: {
      listMessagesForRecipient: vi.fn().mockResolvedValue(messages),
      saveMessage: vi.fn().mockResolvedValue(undefined),
      listBacklogForAgent: vi.fn().mockResolvedValue([]),
    } as unknown as ActionExecutionContext['stateStore'],
  };
}

const mockCtx = {} as unknown as ExecutionContext;

describe('a2a.outbound handler', () => {
  it('has the correct kind', () => {
    expect(a2aOutboundHandler.kind).toBe('a2a.outbound');
  });

  it('factory throws when targetUrl is missing', () => {
    const ctx = makeCtx();
    // Override to remove targetUrl
    ctx.binding.config = {};
    expect(() => a2aOutboundHandler.factory(ctx)).toThrow('config.targetUrl is required');
  });

  it('factory throws when targetUrl is empty string', () => {
    const ctx = makeCtx({ targetUrl: '' });
    ctx.binding.config = { targetUrl: '' };
    expect(() => a2aOutboundHandler.factory(ctx)).toThrow('config.targetUrl is required');
  });

  it('returns completed: true with no-op summary when inbox is empty', async () => {
    const ctx = makeCtx();
    const handler = a2aOutboundHandler.factory(ctx);
    const execCtx = makeExecCtx(); // empty inbox
    const result = await handler({ type: 'StartTask' } as Parameters<typeof handler>[0], execCtx, mockCtx);
    expect(result?.completed).toBe(true);
    expect(result?.summaryProse).toMatch(/no-op/i);
  });

  describe('with inbound message', () => {
    beforeEach(() => {
      vi.stubGlobal('fetch', vi.fn());
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('POSTs to targetUrl/api/a2a/tasks with A2ATask shape', async () => {
      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          id: 'task-1',
          status: 'completed',
          output: { role: 'agent', parts: [{ type: 'text', text: 'done' }] },
        }),
      } as unknown as Response);

      const inboxMsg = {
        id: 'msg-1', kind: 'TASK', status: 'PENDING',
        subject: 'Do research', body: 'Analyse X',
        fromType: 'HUMAN', fromId: 'h1', toType: 'AGENT', toId: 'a1',
      };
      const ctx = makeCtx();
      const handler = a2aOutboundHandler.factory(ctx);
      const execCtx = makeExecCtx(inboxMsg);

      const result = await handler({ type: 'StartTask' } as Parameters<typeof handler>[0], execCtx, mockCtx);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0]!;
      expect(url).toBe('http://remote.test/api/a2a/tasks');
      expect(opts?.method).toBe('POST');
      const body = JSON.parse(opts?.body as string);
      expect(body.input.parts[0].text).toContain('Do research');
      expect(result?.completed).toBe(true);
    });

    it('returns completed: false when fetch throws', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('network error'));
      const inboxMsg = {
        id: 'msg-1', kind: 'TASK', status: 'PENDING',
        subject: 'Task', body: 'body',
        fromType: 'HUMAN', fromId: 'h1', toType: 'AGENT', toId: 'a1',
      };
      const ctx = makeCtx();
      const handler = a2aOutboundHandler.factory(ctx);
      const result = await handler(
        { type: 'StartTask' } as Parameters<typeof handler>[0],
        makeExecCtx(inboxMsg),
        mockCtx,
      );
      expect(result?.completed).toBe(false);
    });

    it('includes skill in the A2ATask when config.skill is set', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ id: 't1', status: 'completed' }),
      } as unknown as Response);

      const inboxMsg = {
        id: 'msg-1', kind: 'TASK', status: 'PENDING',
        subject: 'Task', body: 'body',
        fromType: 'HUMAN', fromId: 'h1', toType: 'AGENT', toId: 'a1',
      };
      const ctx = makeCtx({ skill: 'code-review' });
      const handler = a2aOutboundHandler.factory(ctx);
      await handler({ type: 'StartTask' } as Parameters<typeof handler>[0], makeExecCtx(inboxMsg), mockCtx);

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]?.body as string);
      expect(body.skill).toBe('code-review');
    });
  });

  it('has configSchema with targetUrl as required', () => {
    expect(a2aOutboundHandler.configSchema?.['required']).toContain('targetUrl');
  });
});
