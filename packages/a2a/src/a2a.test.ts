/**
 * A2A Phase 6 — weaveA2AClient + weaveA2ABus unit tests
 *
 * Coverage:
 *   [CLIENT-DISCOVER]   discover(): v1.0 path, legacy fallback, HTTP error, origin check
 *   [CLIENT-SEND]       sendMessage(): success, HTTP error, JSON-RPC error
 *   [CLIENT-STREAM]     streamMessage(): yields events, HTTP error
 *   [CLIENT-TASK]       getTask, listTasks, cancelTask
 *   [CLIENT-PUSH]       push CRUD: create, get, list, delete
 *   [CLIENT-SHIMS]      deprecated sendTask / streamTask / getTaskStatus shims
 *   [BUS]               weaveA2ABus: register, unregister, send, discover, listAgents
 *   [NEG]               negative: missing fields, network errors, not-found
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { weaveA2AClient, weaveA2ABus } from './a2a.js';
import { A2A_METHODS, A2A_ERROR_CODES, makeRpcSuccess, makeRpcError } from './jsonrpc.js';
import type {
  A2AServer,
  AgentCard,
  A2ATask,
  A2ATaskSendParams,
  ExecutionContext,
  A2APushNotificationConfigEntry,
} from '@weaveintel/core';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(): ExecutionContext {
  return { executionId: 'test-exec', signal: AbortSignal.timeout(5000) } as unknown as ExecutionContext;
}

function makeTask(id = 'task-1'): A2ATask {
  return {
    id,
    contextId: `ctx-${id}`,
    status: { state: 'TASK_STATE_COMPLETED', timestamp: new Date().toISOString() },
    artifacts: [{ artifactId: `${id}-out`, name: 'output', parts: [{ text: 'done' }] }],
    history: [],
  };
}

function makeCard(agentUrl = 'http://localhost/api/a2a'): AgentCard {
  return {
    name: 'test-agent',
    description: 'A test agent',
    version: '1.0.0',
    skills: [{ id: 'test', name: 'Test', description: 'Test skill' }],
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extendedAgentCard: false,
      stateTransitionHistory: false,
    },
    supportedInterfaces: [{ url: agentUrl, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    url: agentUrl,
  };
}

/** Build a real Response with a JSON-RPC 2.0 success body. */
function jsonRpcOk<T>(result: T): Response {
  return new Response(JSON.stringify(makeRpcSuccess('req-1', result)), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Build a real Response with a JSON-RPC 2.0 error body. */
function jsonRpcErr(code: number, message: string): Response {
  return new Response(JSON.stringify(makeRpcError('req-1', code, message)), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Build a real Response with a plain HTTP error status. */
function httpErr(status: number): Response {
  return new Response('Not Found', { status });
}

const AGENT_URL = 'http://127.0.0.1:8080/api/a2a';

// ─── [CLIENT-DISCOVER] ────────────────────────────────────────────────────────

describe('[CLIENT-DISCOVER] weaveA2AClient.discover', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('fetches /.well-known/agent-card.json and returns card', async () => {
    const card = makeCard('http://127.0.0.1:8080/api/a2a');
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(card), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));

    const result = await weaveA2AClient().discover('http://127.0.0.1:8080');
    expect(result.name).toBe('test-agent');
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url as string).toContain('/.well-known/agent-card.json');
  });

  it('falls back to /.well-known/agent.json on 404', async () => {
    const card = makeCard('http://127.0.0.1:8080/api/a2a');
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response('Not Found', { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(card), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));

    const result = await weaveA2AClient().discover('http://127.0.0.1:8080');
    expect(result.name).toBe('test-agent');
    expect(vi.mocked(fetch).mock.calls[1]![0] as string).toContain('/.well-known/agent.json');
  });

  it('throws PROTOCOL_ERROR on HTTP 500', async () => {
    vi.mocked(fetch)
      .mockResolvedValue(new Response('Server Error', { status: 500 }));
    await expect(weaveA2AClient().discover('http://127.0.0.1:8080')).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
  });

  it('throws PROTOCOL_ERROR when card has no name field', async () => {
    const badCard = { description: 'no name', version: '1.0.0', skills: [] };
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(badCard), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    await expect(weaveA2AClient().discover('http://127.0.0.1:8080')).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
  });

  it('throws PROTOCOL_ERROR when card has no url/supportedInterfaces', async () => {
    const badCard = { name: 'test', version: '1.0.0', skills: [] };
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(badCard), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    await expect(weaveA2AClient().discover('http://127.0.0.1:8080')).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
  });

  it('throws PROTOCOL_ERROR on origin mismatch', async () => {
    // Card claims endpoint at a different origin
    const card = makeCard('http://evil.example.com/api/a2a');
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(card), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    await expect(weaveA2AClient().discover('http://127.0.0.1:8080')).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
  });

  it('sends A2A-Version: 1.0 header', async () => {
    const card = makeCard('http://127.0.0.1:8080/api/a2a');
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(card), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    await weaveA2AClient().discover('http://127.0.0.1:8080');
    const opts = vi.mocked(fetch).mock.calls[0]![1];
    expect((opts?.headers as Record<string, string>)?.['A2A-Version']).toBe('1.0');
  });
});

// ─── [CLIENT-SEND] ────────────────────────────────────────────────────────────

describe('[CLIENT-SEND] weaveA2AClient.sendMessage', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('POSTs SendMessage and returns A2ATask', async () => {
    const task = makeTask();
    vi.mocked(fetch).mockResolvedValue(jsonRpcOk(task));

    const ctx = makeCtx();
    const params: A2ATaskSendParams = {
      message: { role: 'user', parts: [{ text: 'hello' }], messageId: 'm1', contextId: 'ctx-1' },
    };
    const result = await weaveA2AClient().sendMessage(ctx, AGENT_URL, params);
    expect(result.id).toBe('task-1');
    expect(result.status.state).toBe('TASK_STATE_COMPLETED');

    const [url, opts] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe(AGENT_URL);
    expect(opts?.method).toBe('POST');
    const body = JSON.parse(opts?.body as string);
    expect(body.jsonrpc).toBe('2.0');
    expect(body.method).toBe('SendMessage');
  });

  it('throws PROTOCOL_ERROR on HTTP 500', async () => {
    vi.mocked(fetch).mockResolvedValue(httpErr(500));
    const ctx = makeCtx();
    const params: A2ATaskSendParams = {
      message: { role: 'user', parts: [{ text: 'hello' }], messageId: 'm1', contextId: 'c1' },
    };
    await expect(weaveA2AClient().sendMessage(ctx, AGENT_URL, params)).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
  });

  it('throws on JSON-RPC error response', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonRpcErr(A2A_ERROR_CODES.INTERNAL_ERROR, 'internal error'));
    const ctx = makeCtx();
    const params: A2ATaskSendParams = {
      message: { role: 'user', parts: [{ text: 'hello' }], messageId: 'm1', contextId: 'c1' },
    };
    await expect(weaveA2AClient().sendMessage(ctx, AGENT_URL, params)).rejects.toThrow();
  });

  it('maps TASK_NOT_FOUND JSON-RPC error to NOT_FOUND WeaveIntelError', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonRpcErr(A2A_ERROR_CODES.TASK_NOT_FOUND, 'not found'));
    const ctx = makeCtx();
    const params: A2ATaskSendParams = {
      message: { role: 'user', parts: [{ text: 'hello' }], messageId: 'm1', contextId: 'c1' },
    };
    await expect(weaveA2AClient().sendMessage(ctx, AGENT_URL, params)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('sends A2A-Version header', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonRpcOk(makeTask()));
    const ctx = makeCtx();
    const params: A2ATaskSendParams = {
      message: { role: 'user', parts: [{ text: 'hi' }], messageId: 'm1', contextId: 'c1' },
    };
    await weaveA2AClient().sendMessage(ctx, AGENT_URL, params);
    const opts = vi.mocked(fetch).mock.calls[0]![1];
    expect((opts?.headers as Record<string, string>)?.['A2A-Version']).toBe('1.0');
  });
});

// ─── [CLIENT-STREAM] ──────────────────────────────────────────────────────────

describe('[CLIENT-STREAM] weaveA2AClient.streamMessage', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('yields A2AStreamEvents from SSE response', async () => {
    const events = [
      { statusUpdate: { taskId: 't1', contextId: 'c1', status: { state: 'TASK_STATE_WORKING', timestamp: '' } } },
      { task: makeTask('t1') },
    ];
    const encoder = new TextEncoder();
    const sse = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
    const body = new ReadableStream({
      start(c) { c.enqueue(encoder.encode(sse)); c.close(); },
    });
    vi.mocked(fetch).mockResolvedValue(new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));

    const ctx = makeCtx();
    const params: A2ATaskSendParams = {
      message: { role: 'user', parts: [{ text: 'hi' }], messageId: 'm1', contextId: 'c1' },
    };
    const received = [];
    for await (const e of weaveA2AClient().streamMessage(ctx, AGENT_URL, params)) {
      received.push(e);
    }
    expect(received).toHaveLength(2);
    expect(received[0]).toHaveProperty('statusUpdate');
    expect(received[1]).toHaveProperty('task');
  });

  it('throws PROTOCOL_ERROR on HTTP error', async () => {
    vi.mocked(fetch).mockResolvedValue(httpErr(401));
    const ctx = makeCtx();
    const params: A2ATaskSendParams = {
      message: { role: 'user', parts: [{ text: 'hi' }], messageId: 'm1', contextId: 'c1' },
    };
    await expect(async () => {
      for await (const _ of weaveA2AClient().streamMessage(ctx, AGENT_URL, params)) { /* noop */ }
    }).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
  });

  it('sends Accept: text/event-stream header', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream({ start(c) { c.close(); } });
    vi.mocked(fetch).mockResolvedValue(new Response(body, {
      status: 200, headers: { 'Content-Type': 'text/event-stream' },
    }));
    const ctx = makeCtx();
    const params: A2ATaskSendParams = {
      message: { role: 'user', parts: [{ text: 'hi' }], messageId: 'm1', contextId: 'c1' },
    };
    for await (const _ of weaveA2AClient().streamMessage(ctx, AGENT_URL, params)) { /* drain */ }
    const opts = vi.mocked(fetch).mock.calls[0]![1];
    expect((opts?.headers as Record<string, string>)?.['Accept']).toBe('text/event-stream');
  });
});

// ─── [CLIENT-TASK] ────────────────────────────────────────────────────────────

describe('[CLIENT-TASK] weaveA2AClient task methods', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('getTask: POSTs GetTask and returns task', async () => {
    const task = makeTask('t42');
    vi.mocked(fetch).mockResolvedValue(jsonRpcOk(task));
    const result = await weaveA2AClient().getTask(makeCtx(), AGENT_URL, 't42');
    expect(result.id).toBe('t42');
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]?.body as string);
    expect(body.method).toBe('GetTask');
    expect(body.params.id).toBe('t42');
  });

  it('getTask: passes historyLength when provided', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonRpcOk(makeTask()));
    await weaveA2AClient().getTask(makeCtx(), AGENT_URL, 't1', 5);
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]?.body as string);
    expect(body.params.historyLength).toBe(5);
  });

  it('listTasks: POSTs ListTasks and returns page', async () => {
    const page = { tasks: [makeTask()], nextPageToken: null };
    vi.mocked(fetch).mockResolvedValue(jsonRpcOk(page));
    const result = await weaveA2AClient().listTasks(makeCtx(), AGENT_URL);
    expect(result.tasks).toHaveLength(1);
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]?.body as string);
    expect(body.method).toBe('ListTasks');
  });

  it('listTasks: passes filter params', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonRpcOk({ tasks: [], nextPageToken: null }));
    await weaveA2AClient().listTasks(makeCtx(), AGENT_URL, {
      contextId: 'ctx-1',
      state: 'TASK_STATE_COMPLETED',
      pageSize: 10,
      pageToken: 'tok',
    });
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]?.body as string);
    expect(body.params.contextId).toBe('ctx-1');
    expect(body.params.status).toBe('TASK_STATE_COMPLETED');
    expect(body.params.pageSize).toBe(10);
    expect(body.params.pageToken).toBe('tok');
  });

  it('cancelTask: POSTs CancelTask with task id', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonRpcOk({ canceled: true, id: 't1' }));
    await weaveA2AClient().cancelTask(makeCtx(), AGENT_URL, 't1');
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]?.body as string);
    expect(body.method).toBe('CancelTask');
    expect(body.params.id).toBe('t1');
  });

  it('subscribeToTask: yields stream events', async () => {
    const event = { task: makeTask('t1') };
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        c.close();
      },
    });
    vi.mocked(fetch).mockResolvedValue(new Response(body, {
      status: 200, headers: { 'Content-Type': 'text/event-stream' },
    }));

    const received = [];
    for await (const e of weaveA2AClient().subscribeToTask(makeCtx(), AGENT_URL, 't1')) {
      received.push(e);
    }
    expect(received).toHaveLength(1);
    expect(received[0]).toHaveProperty('task');
  });
});

// ─── [CLIENT-PUSH] ────────────────────────────────────────────────────────────

describe('[CLIENT-PUSH] weaveA2AClient push config methods', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  const pushEntry: A2APushNotificationConfigEntry = {
    pushConfigId: 'cfg-1',
    taskId: 'task-1',
    url: 'https://example.com/hook',
    token: 'secret',
    createdAt: new Date().toISOString(),
  };

  it('createPushConfig: POSTs CreateTaskPushNotificationConfig', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonRpcOk(pushEntry));
    const result = await weaveA2AClient().createPushConfig(
      makeCtx(), AGENT_URL, 'task-1', { url: 'https://example.com/hook', token: 'secret' },
    );
    expect(result.pushConfigId).toBe('cfg-1');
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]?.body as string);
    expect(body.method).toBe(A2A_METHODS.CREATE_PUSH_CONFIG);
    expect(body.params.taskId).toBe('task-1');
    expect(body.params.config.url).toBe('https://example.com/hook');
  });

  it('getPushConfig: POSTs GetTaskPushNotificationConfig', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonRpcOk(pushEntry));
    const result = await weaveA2AClient().getPushConfig(makeCtx(), AGENT_URL, 'task-1', 'cfg-1');
    expect(result.pushConfigId).toBe('cfg-1');
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]?.body as string);
    expect(body.method).toBe(A2A_METHODS.GET_PUSH_CONFIG);
    expect(body.params.pushConfigId).toBe('cfg-1');
  });

  it('listPushConfigs: returns array from configs field', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonRpcOk({ configs: [pushEntry] }));
    const result = await weaveA2AClient().listPushConfigs(makeCtx(), AGENT_URL, 'task-1');
    expect(result).toHaveLength(1);
    expect(result[0]?.pushConfigId).toBe('cfg-1');
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]?.body as string);
    expect(body.method).toBe(A2A_METHODS.LIST_PUSH_CONFIGS);
  });

  it('listPushConfigs: returns empty array when configs is absent', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonRpcOk({ configs: undefined }));
    const result = await weaveA2AClient().listPushConfigs(makeCtx(), AGENT_URL, 'task-1');
    expect(result).toEqual([]);
  });

  it('deletePushConfig: POSTs DeleteTaskPushNotificationConfig and returns true', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonRpcOk({ deleted: true }));
    const result = await weaveA2AClient().deletePushConfig(makeCtx(), AGENT_URL, 'task-1', 'cfg-1');
    expect(result).toBe(true);
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]?.body as string);
    expect(body.method).toBe(A2A_METHODS.DELETE_PUSH_CONFIG);
    expect(body.params.pushConfigId).toBe('cfg-1');
  });
});

// ─── [CLIENT-SHIMS] ───────────────────────────────────────────────────────────

describe('[CLIENT-SHIMS] deprecated compat shims', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('sendTask delegates to sendMessage and returns A2ATaskResult', async () => {
    const task = makeTask();
    vi.mocked(fetch).mockResolvedValue(jsonRpcOk(task));
    const result = await weaveA2AClient().sendTask!(makeCtx(), AGENT_URL, {
      id: 'old-1',
      input: { role: 'user', parts: [{ text: 'hello' }], messageId: 'm1', contextId: 'c1' },
    });
    expect(result.status).toBe('completed');
    expect(result.output?.parts[0]?.text).toBe('done');
  });

  it('sendTask returns failed status on TASK_STATE_FAILED', async () => {
    const failedTask: A2ATask = {
      id: 't2',
      contextId: 'c2',
      status: { state: 'TASK_STATE_FAILED', timestamp: '' },
      artifacts: [],
      history: [],
    };
    vi.mocked(fetch).mockResolvedValue(jsonRpcOk(failedTask));
    const result = await weaveA2AClient().sendTask!(makeCtx(), AGENT_URL, {
      id: 'old-2',
      input: { role: 'user', parts: [{ text: 'hi' }], messageId: 'm1', contextId: 'c1' },
    });
    expect(result.status).toBe('failed');
  });

  it('getTaskStatus delegates to getTask', async () => {
    const task = makeTask('t99');
    vi.mocked(fetch).mockResolvedValue(jsonRpcOk(task));
    const result = await weaveA2AClient().getTaskStatus!(makeCtx(), AGENT_URL, 't99');
    expect(result.status).toBe('completed');
    expect(result.id).toBe('t99');
  });

  it('getTaskStatus returns working for TASK_STATE_WORKING', async () => {
    const workingTask: A2ATask = {
      id: 't3',
      contextId: 'c3',
      status: { state: 'TASK_STATE_WORKING', timestamp: '' },
      artifacts: [],
      history: [],
    };
    vi.mocked(fetch).mockResolvedValue(jsonRpcOk(workingTask));
    const result = await weaveA2AClient().getTaskStatus!(makeCtx(), AGENT_URL, 't3');
    expect(result.status).toBe('working');
  });

  it('streamTask yields A2ATaskResult events from streaming', async () => {
    const taskEvent = { task: makeTask('t4') };
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode(`data: ${JSON.stringify(taskEvent)}\n\n`));
        c.close();
      },
    });
    vi.mocked(fetch).mockResolvedValue(new Response(body, {
      status: 200, headers: { 'Content-Type': 'text/event-stream' },
    }));

    const results = [];
    for await (const r of weaveA2AClient().streamTask!(makeCtx(), AGENT_URL, {
      id: 't4',
      input: { role: 'user', parts: [{ text: 'go' }], messageId: 'm1', contextId: 'c1' },
    })) {
      results.push(r);
    }
    expect(results.some((r) => r.status === 'completed')).toBe(true);
  });
});

// ─── [BUS] ───────────────────────────────────────────────────────────────────

describe('[BUS] weaveA2ABus', () => {
  function makeServer(name: string): A2AServer {
    return {
      card: makeCard(`http://localhost/${name}/api/a2a`),
      async handleMessage(_ctx, params) {
        return {
          id: 'task-bus-1',
          contextId: params.message.contextId ?? 'ctx-bus',
          status: { state: 'TASK_STATE_COMPLETED', timestamp: '' },
          artifacts: [{ artifactId: 'out', name: 'out', parts: [{ text: `${name} handled` }] }],
          history: [params.message],
        };
      },
      async start() {},
      async stop() {},
    };
  }

  it('register + discover returns the agent card', () => {
    const bus = weaveA2ABus();
    bus.register('summarizer', makeServer('summarizer'));
    const card = bus.discover('summarizer');
    expect(card?.name).toBe('test-agent');
  });

  it('discover returns undefined for unknown agent', () => {
    const bus = weaveA2ABus();
    expect(bus.discover('nobody')).toBeUndefined();
  });

  it('unregister removes the agent', () => {
    const bus = weaveA2ABus();
    bus.register('agent-a', makeServer('agent-a'));
    bus.unregister('agent-a');
    expect(bus.discover('agent-a')).toBeUndefined();
  });

  it('listAgents returns all registered cards', () => {
    const bus = weaveA2ABus();
    bus.register('agent-x', makeServer('agent-x'));
    bus.register('agent-y', makeServer('agent-y'));
    const cards = bus.listAgents();
    expect(cards).toHaveLength(2);
  });

  it('listAgents returns empty array when no agents registered', () => {
    const bus = weaveA2ABus();
    expect(bus.listAgents()).toEqual([]);
  });

  it('send routes to registered agent via handleMessage', async () => {
    const bus = weaveA2ABus();
    bus.register('helper', makeServer('helper'));
    const ctx = makeCtx();
    const task = await bus.send(ctx, 'helper', {
      message: { role: 'user', parts: [{ text: 'do it' }], messageId: 'm1', contextId: 'ctx-1' },
    });
    expect(task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(task.artifacts[0]?.parts[0]?.text).toBe('helper handled');
  });

  it('send throws NOT_FOUND for unknown target', async () => {
    const bus = weaveA2ABus();
    await expect(
      bus.send(makeCtx(), 'ghost', {
        message: { role: 'user', parts: [{ text: 'hello' }], messageId: 'm1', contextId: 'ctx-1' },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('send falls back to handleTask for legacy agents', async () => {
    // Cast via unknown to test the runtime fallback path even though A2AServer type requires handleMessage
    const legacyServer = {
      card: makeCard(),
      async handleTask(_ctx: unknown, task: { id: string }) {
        return {
          id: task.id,
          status: 'completed' as const,
          output: { role: 'agent' as const, parts: [{ text: 'legacy done' }] },
        };
      },
      async start() {},
      async stop() {},
    } as unknown as A2AServer;
    const bus = weaveA2ABus();
    bus.register('legacy', legacyServer);
    const task = await bus.send(makeCtx(), 'legacy', {
      message: { role: 'user', parts: [{ text: 'go' }], messageId: 'm1', contextId: 'ctx-1' },
    });
    expect(task.status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('send throws PROTOCOL_ERROR when agent has neither handleMessage nor handleTask', async () => {
    const brokenServer = {
      card: makeCard(),
      async start() {},
      async stop() {},
    } as unknown as A2AServer;
    const bus = weaveA2ABus();
    bus.register('broken', brokenServer);
    await expect(
      bus.send(makeCtx(), 'broken', {
        message: { role: 'user', parts: [{ text: 'hi' }], messageId: 'm1', contextId: 'ctx-1' },
      }),
    ).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
  });

  it('multiple buses are independent', async () => {
    const bus1 = weaveA2ABus();
    const bus2 = weaveA2ABus();
    bus1.register('agent-1', makeServer('agent-1'));
    expect(bus2.discover('agent-1')).toBeUndefined();
    expect(bus1.discover('agent-1')).toBeDefined();
  });
});

// ─── [NEG] ───────────────────────────────────────────────────────────────────

describe('[NEG] negative and edge cases', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('sendMessage throws on network error', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network failure'));
    await expect(
      weaveA2AClient().sendMessage(makeCtx(), AGENT_URL, {
        message: { role: 'user', parts: [{ text: 'hi' }], messageId: 'm1', contextId: 'c1' },
      }),
    ).rejects.toThrow();
  });

  it('discover throws on invalid JSON response', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('not json', {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    await expect(weaveA2AClient().discover('http://127.0.0.1:8080')).rejects.toThrow();
  });

  it('getTask throws NOT_FOUND for missing task', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonRpcErr(A2A_ERROR_CODES.TASK_NOT_FOUND, 'task not found'));
    await expect(weaveA2AClient().getTask(makeCtx(), AGENT_URL, 'missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('subscribeToTask throws PROTOCOL_ERROR on HTTP error', async () => {
    vi.mocked(fetch).mockResolvedValue(httpErr(503));
    await expect(async () => {
      for await (const _ of weaveA2AClient().subscribeToTask(makeCtx(), AGENT_URL, 't1')) { /* noop */ }
    }).rejects.toMatchObject({ code: 'PROTOCOL_ERROR' });
  });
});
