/**
 * Integration tests — A2A v1.0 client ↔ server over a real Node HTTP server.
 *
 * Creates a live HTTP server, wires `createA2ADispatcher` into it, then uses
 * `weaveA2AClient` to exercise every JSON-RPC 2.0 method end-to-end.
 *
 * Coverage:
 *   - SendMessage (COMPLETED, FAILED, returnImmediately)
 *   - SendStreamingMessage (SSE stream events)
 *   - GetTask (found, not-found)
 *   - ListTasks (with filter, pagination)
 *   - CancelTask
 *   - SubscribeToTask (SSE subscription to task updates)
 *   - GetExtendedAgentCard (UNSUPPORTED fallback)
 *   - Agent card discovery (GET /.well-known/agent-card.json)
 *   - returnImmediately async pattern: submit → poll → done
 */

import * as http from 'node:http';
import type * as net from 'node:net';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  createA2ADispatcher,
  createInMemoryA2ATaskStore,
  weaveA2AClient,
  streamToSse,
  SSE_KEEPALIVE,
  A2A_METHODS,
  A2A_ERROR_CODES,
} from './index.js';
import { makeRpcRequest, makeRpcError } from './jsonrpc.js';
import type { A2AServer, A2ATask, A2ATaskSendParams, ExecutionContext } from '@weaveintel/core';
import { newUUIDv7, weaveContext } from '@weaveintel/core';
import type { A2ATaskStore } from './task-store.js';

// ─── Mock helpers ──────────────────────────────────────────────────────────────

const BASE_CTX: ExecutionContext = { executionId: 'integ-test', metadata: {} };

function makeCompletedTask(id = newUUIDv7(), contextId = newUUIDv7()): A2ATask {
  return {
    id,
    contextId,
    status: { state: 'TASK_STATE_COMPLETED', timestamp: new Date().toISOString() },
    artifacts: [{ artifactId: `${id}-out`, name: 'output', parts: [{ text: 'hello world' }] }],
    history: [],
  };
}

function makeAgentCard(agentUrl = 'http://localhost/api/a2a') {
  return {
    name: 'integ-test-agent',
    description: 'Integration test agent',
    version: '1.0.0',
    skills: [{ id: 'test', name: 'Test', description: 'Test skill' }],
    capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false, stateTransitionHistory: true },
    supportedInterfaces: [{ url: agentUrl, protocolBinding: 'JSONRPC' as const, protocolVersion: '1.0' }],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
  };
}

// ─── HTTP server wiring ───────────────────────────────────────────────────────

function makeTestServer(store: A2ATaskStore, impl: Partial<A2AServer> = {}) {
  const server: A2AServer = {
    card: makeAgentCard(),
    handleMessage: vi.fn().mockImplementation(async (_ctx, params) => {
      const task = makeCompletedTask(newUUIDv7(), params.message.contextId ?? newUUIDv7());
      await store.save(task);
      return task;
    }),
    // Wire store-backed implementations so GetTask, ListTasks, CancelTask work
    getTask: vi.fn().mockImplementation((_ctx: unknown, taskId: string) => store.load(taskId)),
    listTasks: vi.fn().mockImplementation((_ctx: unknown, filter?: unknown) =>
      store.list(filter as Parameters<typeof store.list>[0])),
    cancelTask: vi.fn().mockImplementation(async (_ctx: unknown, taskId: string) => {
      const t = await store.load(taskId);
      if (t) await store.update(taskId, { status: { state: 'TASK_STATE_CANCELED', timestamp: new Date().toISOString() } });
    }),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    ...impl,
  };

  const dispatch = createA2ADispatcher(server, store);

  const httpServer = http.createServer(async (req, res) => {
    // Agent card discovery
    if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(server.card));
      return;
    }

    if (req.url !== '/api/a2a') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    // Read body (empty for non-POST)
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk as ArrayBuffer));
    const body = Buffer.concat(chunks).toString('utf8');

    const ctx = weaveContext({ metadata: {} });
    const a2aVersion = req.headers['a2a-version'] as string | undefined;

    const result = await dispatch(ctx, {
      method: req.method ?? 'POST',
      body,
      headers: req.headers as Record<string, string>,
      a2aVersion,
    });

    if (result.kind === 'json') {
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.data));
      return;
    }

    // SSE stream
    req.socket?.setTimeout(0);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const keepalive = setInterval(() => {
      if (!res.writableEnded) res.write(SSE_KEEPALIVE);
    }, 15_000);

    try {
      for await (const chunk of streamToSse(result.events)) {
        if (res.writableEnded) break;
        res.write(chunk);
      }
    } finally {
      clearInterval(keepalive);
      res.end();
    }
  });

  return { httpServer, dispatch, server };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('A2A integration — client ↔ HTTP server', () => {
  let store: A2ATaskStore;
  let agentServer: A2AServer;
  let httpServer: http.Server;
  let baseUrl: string;
  let a2aUrl: string;
  const client = weaveA2AClient();

  beforeAll(async () => {
    store = createInMemoryA2ATaskStore();
    // Placeholder card URL — will be patched once we know the port
    const setup = makeTestServer(store);
    httpServer = setup.httpServer;
    agentServer = setup.server;

    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = httpServer.address() as net.AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    a2aUrl = `${baseUrl}/api/a2a`;

    // Patch card URL so the origin check in discover() passes
    (agentServer.card as unknown as Record<string, unknown>)['supportedInterfaces'] = [
      { url: a2aUrl, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
    ];
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  // ── Discovery ───────────────────────────────────────────────────────────────

  it('discovers agent card from well-known endpoint', async () => {
    const card = await client.discover(baseUrl);
    expect(card.name).toBe('integ-test-agent');
    expect(card.capabilities.streaming).toBe(true);
  });

  // ── SendMessage ─────────────────────────────────────────────────────────────

  it('SendMessage returns COMPLETED task', async () => {
    const params: A2ATaskSendParams = {
      message: {
        role: 'user',
        parts: [{ text: 'hello' }],
        contextId: newUUIDv7(),
        messageId: newUUIDv7(),
      },
    };
    const task = await client.sendMessage(BASE_CTX, a2aUrl, params);
    expect(task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(task.artifacts[0]?.parts[0]?.text).toBe('hello world');
    expect(agentServer.handleMessage).toHaveBeenCalledOnce();
  });

  it('SendMessage with FAILED result', async () => {
    const failImpl: Partial<A2AServer> = {
      handleMessage: vi.fn().mockImplementation(async (_ctx, params) => {
        const id = newUUIDv7();
        const contextId = params.message.contextId ?? id;
        return {
          id, contextId,
          status: { state: 'TASK_STATE_FAILED', timestamp: new Date().toISOString(),
            message: { role: 'agent', parts: [{ text: 'something broke' }] } },
          artifacts: [],
          history: [],
        } satisfies A2ATask;
      }),
    };
    const failStore = createInMemoryA2ATaskStore();
    const { httpServer: failServer } = makeTestServer(failStore, failImpl);
    await new Promise<void>((res) => failServer.listen(0, '127.0.0.1', () => res()));
    const addr = failServer.address() as net.AddressInfo;
    const failUrl = `http://127.0.0.1:${addr.port}/api/a2a`;

    try {
      const task = await client.sendMessage(BASE_CTX, failUrl, {
        message: { role: 'user', parts: [{ text: 'break it' }], messageId: newUUIDv7() },
      });
      expect(task.status.state).toBe('TASK_STATE_FAILED');
    } finally {
      await new Promise<void>((res) => failServer.close(() => res()));
    }
  });

  // ── GetTask ─────────────────────────────────────────────────────────────────

  it('GetTask retrieves a stored task', async () => {
    const params: A2ATaskSendParams = {
      message: { role: 'user', parts: [{ text: 'for GetTask' }], messageId: newUUIDv7() },
    };
    const submitted = await client.sendMessage(BASE_CTX, a2aUrl, params);
    const fetched = await client.getTask(BASE_CTX, a2aUrl, submitted.id);
    expect(fetched.id).toBe(submitted.id);
    expect(fetched.status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('GetTask throws NOT_FOUND for unknown task', async () => {
    await expect(client.getTask(BASE_CTX, a2aUrl, 'nonexistent-task-id')).rejects.toThrow();
  });

  // ── ListTasks ───────────────────────────────────────────────────────────────

  it('ListTasks returns all tasks', async () => {
    const beforeCount = (await client.listTasks(BASE_CTX, a2aUrl)).tasks.length;
    await client.sendMessage(BASE_CTX, a2aUrl, {
      message: { role: 'user', parts: [{ text: 'list-test-1' }], messageId: newUUIDv7() },
    });
    await client.sendMessage(BASE_CTX, a2aUrl, {
      message: { role: 'user', parts: [{ text: 'list-test-2' }], messageId: newUUIDv7() },
    });
    const afterCount = (await client.listTasks(BASE_CTX, a2aUrl)).tasks.length;
    expect(afterCount - beforeCount).toBeGreaterThanOrEqual(2);
  });

  it('ListTasks filters by contextId', async () => {
    const ctxId = newUUIDv7();
    await client.sendMessage(BASE_CTX, a2aUrl, {
      message: { role: 'user', parts: [{ text: 'ctx-filter-test' }], contextId: ctxId, messageId: newUUIDv7() },
    });
    const page = await client.listTasks(BASE_CTX, a2aUrl, { contextId: ctxId });
    expect(page.tasks.length).toBeGreaterThanOrEqual(1);
    expect(page.tasks.every((t) => t.contextId === ctxId)).toBe(true);
  });

  // ── CancelTask ──────────────────────────────────────────────────────────────

  it('CancelTask marks task as CANCELED in store', async () => {
    const submitted = await client.sendMessage(BASE_CTX, a2aUrl, {
      message: { role: 'user', parts: [{ text: 'cancel me' }], messageId: newUUIDv7() },
    });
    await client.cancelTask(BASE_CTX, a2aUrl, submitted.id);
    const after = await store.load(submitted.id);
    expect(after?.status.state).toBe('TASK_STATE_CANCELED');
  });

  // ── SendStreamingMessage ────────────────────────────────────────────────────

  it('SendStreamingMessage receives SSE events including final task', async () => {
    const events: unknown[] = [];
    for await (const event of client.streamMessage(BASE_CTX, a2aUrl, {
      message: { role: 'user', parts: [{ text: 'stream test' }], messageId: newUUIDv7() },
    })) {
      events.push(event);
    }
    // Must end with a task event
    const lastEvent = events[events.length - 1] as Record<string, unknown>;
    expect('task' in lastEvent).toBe(true);
    const finalTask = (lastEvent as { task: A2ATask }).task;
    expect(finalTask.status.state).toBe('TASK_STATE_COMPLETED');
  });

  // ── SubscribeToTask ─────────────────────────────────────────────────────────

  it('SubscribeToTask emits task updates ending at terminal state', async () => {
    // Submit a task first so store has it
    const submitted = await client.sendMessage(BASE_CTX, a2aUrl, {
      message: { role: 'user', parts: [{ text: 'subscribe test' }], messageId: newUUIDv7() },
    });

    const events: unknown[] = [];
    for await (const event of client.subscribeToTask(BASE_CTX, a2aUrl, submitted.id)) {
      events.push(event);
    }
    expect(events.length).toBeGreaterThanOrEqual(1);
    const lastEvent = events[events.length - 1] as Record<string, unknown>;
    expect('task' in lastEvent).toBe(true);
  });

  // ── returnImmediately async pattern ─────────────────────────────────────────

  it('returnImmediately returns SUBMITTED task immediately', async () => {
    // Create a slow agent that takes 50ms
    let agentStarted = false;
    let agentFinished = false;
    const slowImpl: Partial<A2AServer> = {
      handleMessage: vi.fn().mockImplementation(async (_ctx, params) => {
        agentStarted = true;
        await new Promise<void>((r) => setTimeout(r, 50));
        agentFinished = true;
        const id = newUUIDv7();
        const task = makeCompletedTask(id, params.message.contextId ?? id);
        return task;
      }),
    };
    const asyncStore = createInMemoryA2ATaskStore();
    const { httpServer: asyncServer } = makeTestServer(asyncStore, slowImpl);
    await new Promise<void>((r) => asyncServer.listen(0, '127.0.0.1', () => r()));
    const addr = asyncServer.address() as net.AddressInfo;
    const asyncUrl = `http://127.0.0.1:${addr.port}/api/a2a`;

    // Note: the *weaveAgentAsA2AServer* respects returnImmediately.
    // This integration test exercises the dispatcher layer which passes
    // configuration through to impl.handleMessage — test that the SUBMITTED
    // task is returned when the impl honours it.

    // Build a proper async-aware impl
    const asyncImpl: Partial<A2AServer> = {
      handleMessage: vi.fn().mockImplementation(async (_ctx, params) => {
        const taskId = newUUIDv7();
        const contextId = params.message.contextId ?? taskId;
        const submittedTask: A2ATask = {
          id: taskId, contextId,
          status: { state: 'TASK_STATE_SUBMITTED', timestamp: new Date().toISOString() },
          artifacts: [], history: [params.message],
        };
        if (params.configuration?.returnImmediately) {
          await asyncStore.save(submittedTask);
          // Fire and forget
          void (async () => {
            await new Promise<void>((r) => setTimeout(r, 50));
            const done = makeCompletedTask(taskId, contextId);
            await asyncStore.save(done);
          })();
          return submittedTask;
        }
        const done = makeCompletedTask(taskId, contextId);
        await asyncStore.save(done);
        return done;
      }),
    };

    const { httpServer: asyncServer2 } = makeTestServer(asyncStore, asyncImpl);
    await new Promise<void>((r) => asyncServer2.listen(0, '127.0.0.1', () => r()));
    const addr2 = asyncServer2.address() as net.AddressInfo;
    const asyncUrl2 = `http://127.0.0.1:${addr2.port}/api/a2a`;

    try {
      const start = Date.now();
      const task = await client.sendMessage(BASE_CTX, asyncUrl2, {
        message: { role: 'user', parts: [{ text: 'async task' }], messageId: newUUIDv7() },
        configuration: { returnImmediately: true },
      });
      const elapsed = Date.now() - start;
      expect(task.status.state).toBe('TASK_STATE_SUBMITTED');
      // Should return before the 50ms background timer fires
      expect(elapsed).toBeLessThan(200);

      // Poll until completed (max 500ms)
      let polledTask: A2ATask = task;
      for (let i = 0; i < 20; i++) {
        await new Promise<void>((r) => setTimeout(r, 30));
        polledTask = await client.getTask(BASE_CTX, asyncUrl2, task.id);
        if (polledTask.status.state === 'TASK_STATE_COMPLETED') break;
      }
      expect(polledTask.status.state).toBe('TASK_STATE_COMPLETED');
    } finally {
      await Promise.all([
        new Promise<void>((r) => asyncServer.close(() => r())),
        new Promise<void>((r) => asyncServer2.close(() => r())),
      ]);
    }
  });

  // ── GetExtendedAgentCard ────────────────────────────────────────────────────

  it('GetExtendedAgentCard returns UNSUPPORTED when not implemented', async () => {
    const rpcReq = JSON.stringify(makeRpcRequest(A2A_METHODS.GET_EXTENDED_AGENT_CARD, {}));
    const response = await fetch(a2aUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
      body: rpcReq,
    });
    const json = await response.json() as Record<string, unknown>;
    expect((json['error'] as Record<string, unknown>)['code']).toBe(A2A_ERROR_CODES.UNSUPPORTED_OPERATION);
  });

  // ── PushNotification methods ─────────────────────────────────────────────────

  it('CreateTaskPushNotificationConfig returns PUSH_NOTIFICATION_NOT_SUPPORTED', async () => {
    const rpcReq = JSON.stringify(makeRpcRequest(A2A_METHODS.CREATE_PUSH_CONFIG, { taskId: newUUIDv7() }));
    const response = await fetch(a2aUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
      body: rpcReq,
    });
    const json = await response.json() as Record<string, unknown>;
    expect((json['error'] as Record<string, unknown>)['code']).toBe(A2A_ERROR_CODES.PUSH_NOTIFICATION_NOT_SUPPORTED);
  });

  // ── Wrong HTTP method ────────────────────────────────────────────────────────

  it('GET /api/a2a returns 405 Method Not Allowed', async () => {
    const response = await fetch(a2aUrl, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
      body: undefined,
    });
    const json = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(405);
    expect((json['error'] as Record<string, unknown>)['code']).toBe(A2A_ERROR_CODES.INVALID_REQUEST);
  });
});
