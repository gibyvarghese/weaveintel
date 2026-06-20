import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { a2aOutboundHandler } from './a2a-outbound.js';
import type { HandlerContext } from '../handler-registry.js';
import type { ActionExecutionContext } from '@weaveintel/live-agents';
import type { ExecutionContext } from '@weaveintel/core';
import type { LiveAgent } from '@weaveintel/live-agents';

function makeCtx(config: Record<string, unknown> = {}): HandlerContext {
  return {
    // Use 127.0.0.1 loopback URL to pass the SSRF guard (Phase 5 hardened-fetch)
    binding: { id: 'b1', agentId: 'a1', handlerKind: 'a2a.outbound', config: { targetUrl: 'http://127.0.0.1:8080', ...config } },
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

/** Build a v1.0 A2ATask as the task payload. */
function makeA2ATask(state: 'TASK_STATE_COMPLETED' | 'TASK_STATE_FAILED' = 'TASK_STATE_COMPLETED') {
  return {
    id: 'task-1',
    contextId: 'ctx-1',
    status: { state, timestamp: new Date().toISOString() },
    artifacts: state === 'TASK_STATE_COMPLETED'
      ? [{ artifactId: 'task-1-output', name: 'output', parts: [{ text: 'done' }] }]
      : [],
    history: [],
  };
}

/** Wrap a task in a JSON-RPC 2.0 success response (Phase 4: SendMessage returns JSON-RPC). */
function makeRpcTaskResponse(state: 'TASK_STATE_COMPLETED' | 'TASK_STATE_FAILED' = 'TASK_STATE_COMPLETED') {
  return { jsonrpc: '2.0', id: '1', result: makeA2ATask(state) };
}

describe('a2a.outbound handler', () => {
  it('has the correct kind', () => {
    expect(a2aOutboundHandler.kind).toBe('a2a.outbound');
  });

  it('factory throws when targetUrl is missing', () => {
    const ctx = makeCtx();
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
    const execCtx = makeExecCtx();
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

    it('POSTs to targetUrl/api/a2a (JSON-RPC 2.0 SendMessage) with v1.0 A2ATaskSendParams shape', async () => {
      const mockFetch = vi.mocked(fetch);
      // Return a real Response so hardened-fetch can wrap it with size-cap ReadableStream
      mockFetch.mockResolvedValue(new Response(JSON.stringify(makeRpcTaskResponse()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));

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
      // Phase 4: uses JSON-RPC 2.0 endpoint (/api/a2a), not REST (/api/a2a/tasks)
      expect(url).toBe('http://127.0.0.1:8080/api/a2a');
      expect(opts?.method).toBe('POST');

      // Phase 4: body is JSON-RPC 2.0 SendMessage envelope
      const body = JSON.parse(opts?.body as string);
      expect(body.jsonrpc).toBe('2.0');
      expect(body.method).toBe('SendMessage');
      expect(body.params.message).toBeDefined();
      expect(Array.isArray(body.params.message.parts)).toBe(true);
      expect(body.params.message.parts[0].text).toContain('Do research');
      // No `type` field on v1.0 parts
      expect(body.params.message.parts[0].type).toBeUndefined();

      expect(result?.completed).toBe(true);
    });

    it('sends A2A-Version: 1.0 header', async () => {
      vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(makeRpcTaskResponse()), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));

      const inboxMsg = {
        id: 'msg-1', kind: 'TASK', status: 'PENDING',
        subject: 'Task', body: 'body',
        fromType: 'HUMAN', fromId: 'h1', toType: 'AGENT', toId: 'a1',
      };
      const ctx = makeCtx();
      const handler = a2aOutboundHandler.factory(ctx);
      await handler({ type: 'StartTask' } as Parameters<typeof handler>[0], makeExecCtx(inboxMsg), mockCtx);

      const opts = vi.mocked(fetch).mock.calls[0]![1];
      expect((opts?.headers as Record<string, string>)?.['A2A-Version']).toBe('1.0');
    });

    it('returns completed: false when fetch throws (network error)', async () => {
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

    it('includes skill in metadata when config.skill is set', async () => {
      vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(makeRpcTaskResponse()), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));

      const inboxMsg = {
        id: 'msg-1', kind: 'TASK', status: 'PENDING',
        subject: 'Task', body: 'body',
        fromType: 'HUMAN', fromId: 'h1', toType: 'AGENT', toId: 'a1',
      };
      const ctx = makeCtx({ skill: 'code-review' });
      const handler = a2aOutboundHandler.factory(ctx);
      await handler({ type: 'StartTask' } as Parameters<typeof handler>[0], makeExecCtx(inboxMsg), mockCtx);

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]?.body as string);
      // In v1.0 JSON-RPC 2.0: skill is in params.metadata (not top-level)
      expect(body.params?.metadata?.skill).toBe('code-review');
    });

    it('returns completed: false when remote returns TASK_STATE_FAILED', async () => {
      vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(makeRpcTaskResponse('TASK_STATE_FAILED')), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));

      const inboxMsg = {
        id: 'msg-1', kind: 'TASK', status: 'PENDING',
        subject: 'Task', body: 'body',
        fromType: 'HUMAN', fromId: 'h1', toType: 'AGENT', toId: 'a1',
      };
      const result = await a2aOutboundHandler.factory(makeCtx())(
        { type: 'StartTask' } as Parameters<ReturnType<typeof a2aOutboundHandler.factory>>[0],
        makeExecCtx(inboxMsg),
        mockCtx,
      );
      expect(result?.completed).toBe(false);
    });
  });

  it('has configSchema with targetUrl as required', () => {
    expect(a2aOutboundHandler.configSchema?.['required']).toContain('targetUrl');
  });
});
