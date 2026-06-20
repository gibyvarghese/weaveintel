/**
 * Unit tests for the A2A JSON-RPC 2.0 server dispatcher (a2a-server.ts)
 */

import { describe, it, expect, vi } from 'vitest';
import { createA2ADispatcher, weaveA2AServer } from './a2a-server.js';
import { A2A_METHODS, A2A_ERROR_CODES } from './jsonrpc.js';
import type { A2AServer, A2ATask, ExecutionContext } from '@weaveintel/core';
import { newUUIDv7 } from '@weaveintel/core';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const mockCtx: ExecutionContext = {
  executionId: 'test-execution-id',
  metadata: {},
};

function makeTask(state: 'TASK_STATE_COMPLETED' | 'TASK_STATE_FAILED' = 'TASK_STATE_COMPLETED'): A2ATask {
  const id = newUUIDv7();
  return {
    id,
    contextId: 'ctx-1',
    status: { state, timestamp: new Date().toISOString() },
    artifacts: state === 'TASK_STATE_COMPLETED'
      ? [{ artifactId: `${id}-out`, name: 'output', parts: [{ text: 'result text' }] }]
      : [],
    history: [],
  };
}

function makeImpl(overrides: Partial<A2AServer> = {}): A2AServer {
  return {
    card: {
      name: 'test-agent',
      description: 'Test agent',
      version: '1.0.0',
      skills: [{ id: 'test', name: 'Test', description: 'A test skill' }],
      capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false, stateTransitionHistory: false },
      supportedInterfaces: [{ url: 'http://localhost/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    },
    handleMessage: vi.fn().mockResolvedValue(makeTask()),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeRpc(method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 'test-id', method, params: params ?? {} });
}

function makeReq(body: string, method = 'POST'): Parameters<ReturnType<typeof createA2ADispatcher>>[1] {
  return { method, body, headers: { 'a2a-version': '1.0' } };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createA2ADispatcher / weaveA2AServer', () => {
  it('is the same function exported under two names', () => {
    expect(createA2ADispatcher).toBe(weaveA2AServer);
  });

  it('returns 405 for non-POST requests', async () => {
    const dispatch = createA2ADispatcher(makeImpl());
    const result = await dispatch(mockCtx, { method: 'GET', body: '', headers: {} });
    expect(result.kind).toBe('json');
    if (result.kind === 'json') {
      expect(result.status).toBe(405);
    }
  });

  it('returns PARSE_ERROR for invalid JSON body', async () => {
    const dispatch = createA2ADispatcher(makeImpl());
    const result = await dispatch(mockCtx, makeReq('{not json'));
    expect(result.kind).toBe('json');
    if (result.kind === 'json') {
      expect(result.status).toBe(400);
      const data = result.data as { error: { code: number } };
      expect(data.error.code).toBe(A2A_ERROR_CODES.PARSE_ERROR);
    }
  });

  it('returns INVALID_REQUEST when jsonrpc is wrong', async () => {
    const dispatch = createA2ADispatcher(makeImpl());
    const body = JSON.stringify({ jsonrpc: '1.0', id: '1', method: 'SendMessage', params: {} });
    const result = await dispatch(mockCtx, makeReq(body));
    if (result.kind === 'json') {
      expect(result.status).toBe(400);
    }
  });

  it('returns METHOD_NOT_FOUND for unknown method', async () => {
    const dispatch = createA2ADispatcher(makeImpl());
    const result = await dispatch(mockCtx, makeReq(makeRpc('DoSomethingWeird', {})));
    expect(result.kind).toBe('json');
    if (result.kind === 'json') {
      expect(result.status).toBe(404);
      const data = result.data as { error: { code: number } };
      expect(data.error.code).toBe(A2A_ERROR_CODES.METHOD_NOT_FOUND);
    }
  });

  describe('SendMessage', () => {
    it('calls handleMessage and returns task in result', async () => {
      const impl = makeImpl();
      const dispatch = createA2ADispatcher(impl);
      const params = {
        message: { role: 'user', parts: [{ text: 'hello' }], contextId: 'ctx-1' },
      };
      const result = await dispatch(mockCtx, makeReq(makeRpc(A2A_METHODS.SEND_MESSAGE, params)));

      expect(result.kind).toBe('json');
      if (result.kind === 'json') {
        expect(result.status).toBe(200);
        const data = result.data as { jsonrpc: string; id: string; result: A2ATask };
        expect(data.jsonrpc).toBe('2.0');
        expect(data.result.status.state).toBe('TASK_STATE_COMPLETED');
      }
      expect(impl.handleMessage).toHaveBeenCalledOnce();
    });

    it('returns INVALID_PARAMS when message is missing', async () => {
      const dispatch = createA2ADispatcher(makeImpl());
      const result = await dispatch(mockCtx, makeReq(makeRpc(A2A_METHODS.SEND_MESSAGE, { wrong: 'field' })));
      if (result.kind === 'json') {
        const data = result.data as { error: { code: number } };
        expect(data.error.code).toBe(A2A_ERROR_CODES.INVALID_PARAMS);
      }
    });

    it('returns INVALID_PARAMS when message.parts is not array', async () => {
      const dispatch = createA2ADispatcher(makeImpl());
      const params = { message: { role: 'user', parts: 'not-array' } };
      const result = await dispatch(mockCtx, makeReq(makeRpc(A2A_METHODS.SEND_MESSAGE, params)));
      if (result.kind === 'json') {
        const data = result.data as { error: { code: number } };
        expect(data.error.code).toBe(A2A_ERROR_CODES.INVALID_PARAMS);
      }
    });

    it('returns INTERNAL_ERROR when handleMessage throws', async () => {
      const impl = makeImpl({ handleMessage: vi.fn().mockRejectedValue(new Error('boom')) });
      const dispatch = createA2ADispatcher(impl);
      const params = { message: { role: 'user', parts: [{ text: 'hi' }] } };
      const result = await dispatch(mockCtx, makeReq(makeRpc(A2A_METHODS.SEND_MESSAGE, params)));
      if (result.kind === 'json') {
        const data = result.data as { error: { code: number } };
        expect(data.error.code).toBe(A2A_ERROR_CODES.INTERNAL_ERROR);
      }
    });
  });

  describe('SendStreamingMessage', () => {
    it('returns stream kind when handleStreamMessage is available', async () => {
      async function* mockStream() {
        yield { statusUpdate: { taskId: 't1', contextId: 'c1', status: { state: 'TASK_STATE_WORKING' as const, timestamp: '' } } };
        yield { task: makeTask() };
      }
      const impl = makeImpl({ handleStreamMessage: vi.fn().mockReturnValue(mockStream()) });
      const dispatch = createA2ADispatcher(impl);
      const params = { message: { role: 'user', parts: [{ text: 'stream me' }], contextId: 'ctx-1' } };
      const result = await dispatch(mockCtx, makeReq(makeRpc(A2A_METHODS.SEND_STREAMING_MESSAGE, params)));
      expect(result.kind).toBe('stream');
    });

    it('falls back to single-task stream when handleStreamMessage is absent', async () => {
      const task = makeTask();
      const impl = makeImpl({ handleMessage: vi.fn().mockResolvedValue(task), handleStreamMessage: undefined });
      const dispatch = createA2ADispatcher(impl);
      const params = { message: { role: 'user', parts: [{ text: 'hi' }], contextId: 'ctx-1' } };
      const result = await dispatch(mockCtx, makeReq(makeRpc(A2A_METHODS.SEND_STREAMING_MESSAGE, params)));
      expect(result.kind).toBe('stream');
      if (result.kind === 'stream') {
        const events = [];
        for await (const e of result.events) events.push(e);
        expect(events.length).toBe(1);
        expect('task' in events[0]!).toBe(true);
      }
    });
  });

  describe('GetTask', () => {
    it('returns UNSUPPORTED_OPERATION when getTask is not implemented', async () => {
      const dispatch = createA2ADispatcher(makeImpl({ getTask: undefined }));
      const result = await dispatch(mockCtx, makeReq(makeRpc(A2A_METHODS.GET_TASK, { id: 'task-1' })));
      if (result.kind === 'json') {
        const data = result.data as { error: { code: number } };
        expect(data.error.code).toBe(A2A_ERROR_CODES.UNSUPPORTED_OPERATION);
      }
    });

    it('returns TASK_NOT_FOUND when getTask returns null', async () => {
      const impl = makeImpl({ getTask: vi.fn().mockResolvedValue(null) });
      const dispatch = createA2ADispatcher(impl);
      const result = await dispatch(mockCtx, makeReq(makeRpc(A2A_METHODS.GET_TASK, { id: 'missing-task' })));
      if (result.kind === 'json') {
        expect(result.status).toBe(404);
        const data = result.data as { error: { code: number } };
        expect(data.error.code).toBe(A2A_ERROR_CODES.TASK_NOT_FOUND);
      }
    });

    it('returns task when found', async () => {
      const task = makeTask();
      const impl = makeImpl({ getTask: vi.fn().mockResolvedValue(task) });
      const dispatch = createA2ADispatcher(impl);
      const result = await dispatch(mockCtx, makeReq(makeRpc(A2A_METHODS.GET_TASK, { id: task.id })));
      if (result.kind === 'json') {
        expect(result.status).toBe(200);
        const data = result.data as { result: A2ATask };
        expect(data.result.id).toBe(task.id);
      }
    });

    it('returns INVALID_PARAMS when id is missing', async () => {
      const impl = makeImpl({ getTask: vi.fn().mockResolvedValue(null) });
      const dispatch = createA2ADispatcher(impl);
      const result = await dispatch(mockCtx, makeReq(makeRpc(A2A_METHODS.GET_TASK, {})));
      if (result.kind === 'json') {
        const data = result.data as { error: { code: number } };
        expect(data.error.code).toBe(A2A_ERROR_CODES.INVALID_PARAMS);
      }
    });
  });

  describe('ListTasks', () => {
    it('returns UNSUPPORTED_OPERATION when listTasks is not implemented', async () => {
      const dispatch = createA2ADispatcher(makeImpl({ listTasks: undefined }));
      const result = await dispatch(mockCtx, makeReq(makeRpc(A2A_METHODS.LIST_TASKS, {})));
      if (result.kind === 'json') {
        const data = result.data as { error: { code: number } };
        expect(data.error.code).toBe(A2A_ERROR_CODES.UNSUPPORTED_OPERATION);
      }
    });

    it('calls listTasks and returns page', async () => {
      const page = { tasks: [makeTask()], nextPageToken: undefined };
      const impl = makeImpl({ listTasks: vi.fn().mockResolvedValue(page) });
      const dispatch = createA2ADispatcher(impl);
      const result = await dispatch(mockCtx, makeReq(makeRpc(A2A_METHODS.LIST_TASKS, { contextId: 'ctx-1', pageSize: 10 })));
      if (result.kind === 'json') {
        expect(result.status).toBe(200);
        const data = result.data as { result: typeof page };
        expect(data.result.tasks.length).toBe(1);
      }
    });
  });

  describe('CancelTask', () => {
    it('returns TASK_NOT_CANCELABLE when cancelTask is not implemented', async () => {
      const dispatch = createA2ADispatcher(makeImpl({ cancelTask: undefined }));
      const result = await dispatch(mockCtx, makeReq(makeRpc(A2A_METHODS.CANCEL_TASK, { id: 'task-1' })));
      if (result.kind === 'json') {
        const data = result.data as { error: { code: number } };
        expect(data.error.code).toBe(A2A_ERROR_CODES.TASK_NOT_CANCELABLE);
      }
    });

    it('calls cancelTask and returns success', async () => {
      const impl = makeImpl({ cancelTask: vi.fn().mockResolvedValue(undefined) });
      const dispatch = createA2ADispatcher(impl);
      const result = await dispatch(mockCtx, makeReq(makeRpc(A2A_METHODS.CANCEL_TASK, { id: 'task-1' })));
      if (result.kind === 'json') {
        expect(result.status).toBe(200);
        expect(impl.cancelTask).toHaveBeenCalledWith(mockCtx, 'task-1');
      }
    });
  });

  describe('Push notification methods', () => {
    const pushMethods = [
      A2A_METHODS.CREATE_PUSH_CONFIG,
      A2A_METHODS.GET_PUSH_CONFIG,
      A2A_METHODS.LIST_PUSH_CONFIGS,
      A2A_METHODS.DELETE_PUSH_CONFIG,
    ];

    for (const method of pushMethods) {
      it(`returns PUSH_NOTIFICATION_NOT_SUPPORTED for ${method}`, async () => {
        const dispatch = createA2ADispatcher(makeImpl());
        const result = await dispatch(mockCtx, makeReq(makeRpc(method, {})));
        if (result.kind === 'json') {
          const data = result.data as { error: { code: number } };
          expect(data.error.code).toBe(A2A_ERROR_CODES.PUSH_NOTIFICATION_NOT_SUPPORTED);
        }
      });
    }
  });

  describe('JSON-RPC envelope', () => {
    it('success response contains jsonrpc: 2.0 and id', async () => {
      const dispatch = createA2ADispatcher(makeImpl());
      const body = JSON.stringify({ jsonrpc: '2.0', id: 'my-request-id', method: 'SendMessage', params: { message: { role: 'user', parts: [{ text: 'hi' }] } } });
      const result = await dispatch(mockCtx, makeReq(body));
      if (result.kind === 'json') {
        const data = result.data as { jsonrpc: string; id: string };
        expect(data.jsonrpc).toBe('2.0');
        expect(data.id).toBe('my-request-id');
      }
    });

    it('error response reflects the request id', async () => {
      const dispatch = createA2ADispatcher(makeImpl());
      const body = JSON.stringify({ jsonrpc: '2.0', id: 'err-req', method: 'UnknownMethod', params: {} });
      const result = await dispatch(mockCtx, makeReq(body));
      if (result.kind === 'json') {
        const data = result.data as { id: string };
        expect(data.id).toBe('err-req');
      }
    });
  });
});
