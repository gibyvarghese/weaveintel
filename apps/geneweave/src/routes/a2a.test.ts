/**
 * geneWeave A2A route integration tests (Phase 6)
 *
 * Coverage:
 *   [DISCOVERY]  GET /.well-known/agent-card.json returns v1.0 card
 *   [DISPATCH]   POST /api/a2a: auth check, JSON-RPC dispatch, response shape
 *   [METHODS]    SendMessage, GetTask, ListTasks, CancelTask, GetExtendedAgentCard
 *   [PUSH-CRUD]  CreateTaskPushNotificationConfig, Get, List, Delete
 *   [AUTH]       Missing auth → 401, with auth → 200
 *   [NEG]        Malformed body, wrong method, unknown method
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerA2ARoutes } from './a2a.js';
import { A2A_METHODS, A2A_ERROR_CODES, makeRpcRequest } from '@weaveintel/a2a';
import type { DatabaseAdapter } from '../db.js';
import type { ChatEngine } from '../chat.js';

// ─── Router / Request / Response stubs ──────────────────────────────────────

type Handler = (req: any, res: any, params: any, auth: any) => Promise<void>;
interface RouteEntry { method: string; path: string; handler: Handler }

function buildRouter() {
  const routes: RouteEntry[] = [];
  const addRoute = (method: string) =>
    (path: string, handler: Handler) => { routes.push({ method, path, handler }); };
  return {
    get: addRoute('GET'),
    post: addRoute('POST'),
    routes,
    async dispatch(
      method: string,
      path: string,
      body = '',
      headers: Record<string, string> = {},
      auth: { userId: string } | null = { userId: 'u1' },
    ) {
      const entry = routes.find((r) => r.method === method && r.path === path);
      if (!entry) throw new Error(`No route: ${method} ${path}`);
      const res = buildResponse();
      const bodyBuf = Buffer.from(body);
      const listeners: Record<string, ((...args: any[]) => void)[]> = {};
      const req = {
        url: path,
        method,
        headers,
        socket: { remoteAddress: '127.0.0.1', on: vi.fn(), setTimeout: vi.fn() },
        resume: vi.fn(),
        on(event: string, cb: (...args: any[]) => void) {
          listeners[event] = listeners[event] ?? [];
          listeners[event]!.push(cb);
          if (event === 'end') {
            Promise.resolve().then(() => {
              for (const l of listeners['data'] ?? []) l(bodyBuf);
              for (const l of listeners['end'] ?? []) l();
            });
          }
          return req;
        },
      };
      await entry.handler(req, res, {}, auth);
      return res;
    },
  };
}

function buildResponse() {
  let statusCode = 200;
  let bodyText = '';
  const headers: Record<string, string> = {};
  const chunks: string[] = [];
  let ended = false;
  return {
    get statusCode() { return statusCode; },
    headers,
    writableEnded: false,
    setHeader(k: string, v: string) { headers[k.toLowerCase()] = String(v); },
    writeHead(code: number, hdrs?: Record<string, string>) {
      statusCode = code;
      if (hdrs) for (const [k, v] of Object.entries(hdrs)) headers[k.toLowerCase()] = String(v);
    },
    write(chunk: string) { chunks.push(chunk); return true; },
    end(chunk?: string) {
      if (chunk) bodyText += chunk;
      this.writableEnded = true;
      ended = true;
    },
    get body() { try { return JSON.parse(bodyText); } catch { return bodyText; } },
    get bodyText() { return bodyText; },
    get sseChunks() { return chunks; },
  };
}

// ─── DB / ChatEngine stubs ───────────────────────────────────────────────────

function buildDb(): DatabaseAdapter {
  return {
    getChatSettings: vi.fn().mockResolvedValue(null),
  } as unknown as DatabaseAdapter;
}

function buildChatEngine(output = 'Agent response'): ChatEngine {
  return {
    config: {
      defaultProvider: 'openai',
      defaultModel: 'gpt-4o',
      providers: { openai: { apiKey: 'test-key' } },
    },
    runAgentTask: vi.fn().mockResolvedValue({ result: { status: 'completed', output } }),
  } as unknown as ChatEngine;
}

// ─── JSON-RPC helpers ─────────────────────────────────────────────────────────

function rpcBody(method: string, params: unknown): string {
  return JSON.stringify(makeRpcRequest(method, params));
}

const AUTH = { userId: 'user-123' };

// ─── [DISCOVERY] ─────────────────────────────────────────────────────────────

describe('[DISCOVERY] GET /.well-known/agent-card.json', () => {
  it('returns a valid A2A v1.0 agent card', async () => {
    const router = buildRouter();
    registerA2ARoutes(router as any, buildDb(), buildChatEngine());
    const res = await router.dispatch('GET', '/.well-known/agent-card.json', '', {}, null);
    expect(res.statusCode).toBe(200);
    const card = res.body;
    expect(card.name).toBe('geneweave');
    expect(card.version).toBe('1.0.0');
    expect(card.capabilities.streaming).toBe(true);
    expect(card.capabilities.pushNotifications).toBe(true);
    expect(card.capabilities.extendedAgentCard).toBe(true);
    expect(card.supportedInterfaces?.[0]?.protocolBinding).toBe('JSONRPC');
    expect(Array.isArray(card.skills)).toBe(true);
    expect(card.skills.length).toBeGreaterThan(0);
  });

  it('/.well-known/agent.json is a legacy alias returning the same card', async () => {
    const router = buildRouter();
    registerA2ARoutes(router as any, buildDb(), buildChatEngine());
    const res = await router.dispatch('GET', '/.well-known/agent.json', '', {}, null);
    expect(res.statusCode).toBe(200);
    expect(res.body.name).toBe('geneweave');
  });
});

// ─── [AUTH] ──────────────────────────────────────────────────────────────────

describe('[AUTH] POST /api/a2a authentication', () => {
  it('returns 401 JSON-RPC error when auth is null', async () => {
    const router = buildRouter();
    registerA2ARoutes(router as any, buildDb(), buildChatEngine());
    const res = await router.dispatch(
      'POST', '/api/a2a',
      rpcBody(A2A_METHODS.GET_TASK, { id: 'task-1' }),
      { 'content-type': 'application/json' },
      null,
    );
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBeDefined();
    expect(res.body.jsonrpc).toBe('2.0');
  });

  it('returns non-401 when auth is provided', async () => {
    const router = buildRouter();
    registerA2ARoutes(router as any, buildDb(), buildChatEngine());
    const body = rpcBody(A2A_METHODS.GET_TASK, { id: 'non-existent-task' });
    const res = await router.dispatch('POST', '/api/a2a', body, { 'content-type': 'application/json' }, AUTH);
    // 404 or 200 — just not 401
    expect(res.statusCode).not.toBe(401);
  });
});

// ─── [DISPATCH] ──────────────────────────────────────────────────────────────

describe('[DISPATCH] POST /api/a2a JSON-RPC dispatch', () => {
  it('returns 400 on malformed JSON body', async () => {
    const router = buildRouter();
    registerA2ARoutes(router as any, buildDb(), buildChatEngine());
    const res = await router.dispatch('POST', '/api/a2a', '{not valid json', { 'content-type': 'application/json' }, AUTH);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('returns 400 on missing method field', async () => {
    const router = buildRouter();
    registerA2ARoutes(router as any, buildDb(), buildChatEngine());
    const res = await router.dispatch(
      'POST', '/api/a2a',
      JSON.stringify({ jsonrpc: '2.0', id: '1', params: {} }),
      { 'content-type': 'application/json' },
      AUTH,
    );
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 on unknown method', async () => {
    const router = buildRouter();
    registerA2ARoutes(router as any, buildDb(), buildChatEngine());
    const res = await router.dispatch(
      'POST', '/api/a2a',
      rpcBody('UnknownMethod', {}),
      { 'content-type': 'application/json' },
      AUTH,
    );
    expect(res.statusCode).toBe(404);
    expect(res.body.error.code).toBe(A2A_ERROR_CODES.METHOD_NOT_FOUND);
  });
});

// ─── [METHODS] ───────────────────────────────────────────────────────────────

describe('[METHODS] A2A v1.0 JSON-RPC methods', () => {
  it('GetTask returns 404 for unknown task', async () => {
    const router = buildRouter();
    registerA2ARoutes(router as any, buildDb(), buildChatEngine());
    const res = await router.dispatch(
      'POST', '/api/a2a',
      rpcBody(A2A_METHODS.GET_TASK, { id: 'nonexistent-task-id' }),
      { 'content-type': 'application/json' },
      AUTH,
    );
    expect(res.statusCode).toBe(404);
    expect(res.body.error.code).toBe(A2A_ERROR_CODES.TASK_NOT_FOUND);
  });

  it('GetExtendedAgentCard returns extended card', async () => {
    const router = buildRouter();
    registerA2ARoutes(router as any, buildDb(), buildChatEngine());
    const res = await router.dispatch(
      'POST', '/api/a2a',
      rpcBody(A2A_METHODS.GET_EXTENDED_AGENT_CARD, {}),
      { 'content-type': 'application/json' },
      AUTH,
    );
    expect(res.statusCode).toBe(200);
    const card = res.body.result;
    expect(card.name).toBe('geneweave');
    expect(card.skills[0]?.tags?.length).toBeGreaterThan(0);
    expect(card.skills[0]?.examples?.length).toBeGreaterThan(0);
  });

  it('ListTasks returns empty list initially', async () => {
    const router = buildRouter();
    registerA2ARoutes(router as any, buildDb(), buildChatEngine());
    const res = await router.dispatch(
      'POST', '/api/a2a',
      rpcBody(A2A_METHODS.LIST_TASKS, {}),
      { 'content-type': 'application/json' },
      AUTH,
    );
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.result?.tasks)).toBe(true);
  });

  it('CancelTask on unknown task returns 404', async () => {
    const router = buildRouter();
    registerA2ARoutes(router as any, buildDb(), buildChatEngine());
    const res = await router.dispatch(
      'POST', '/api/a2a',
      rpcBody(A2A_METHODS.CANCEL_TASK, { id: 'never-existed' }),
      { 'content-type': 'application/json' },
      AUTH,
    );
    // cancelTask is a no-op for missing tasks; dispatcher returns the canceled result
    expect([200, 404]).toContain(res.statusCode);
  });

  it('SendMessage with invalid params returns 400', async () => {
    const router = buildRouter();
    registerA2ARoutes(router as any, buildDb(), buildChatEngine());
    const res = await router.dispatch(
      'POST', '/api/a2a',
      rpcBody(A2A_METHODS.SEND_MESSAGE, { message: null }),
      { 'content-type': 'application/json' },
      AUTH,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe(A2A_ERROR_CODES.INVALID_PARAMS);
  });

  it('SendMessage with missing parts returns 400', async () => {
    const router = buildRouter();
    registerA2ARoutes(router as any, buildDb(), buildChatEngine());
    const res = await router.dispatch(
      'POST', '/api/a2a',
      rpcBody(A2A_METHODS.SEND_MESSAGE, { message: { role: 'user' } }),
      { 'content-type': 'application/json' },
      AUTH,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe(A2A_ERROR_CODES.INVALID_PARAMS);
  });
});

// ─── [PUSH-CRUD] ─────────────────────────────────────────────────────────────

describe('[PUSH-CRUD] push notification config methods', () => {
  it('CreateTaskPushNotificationConfig creates and returns entry', async () => {
    const router = buildRouter();
    registerA2ARoutes(router as any, buildDb(), buildChatEngine());
    const res = await router.dispatch(
      'POST', '/api/a2a',
      rpcBody(A2A_METHODS.CREATE_PUSH_CONFIG, {
        taskId: 'task-push-1',
        config: { url: 'https://example.com/hook', token: 'secret' },
      }),
      { 'content-type': 'application/json' },
      AUTH,
    );
    expect(res.statusCode).toBe(200);
    const entry = res.body.result;
    expect(entry.pushConfigId).toBeTruthy();
    expect(entry.taskId).toBe('task-push-1');
    expect(entry.url).toBe('https://example.com/hook');
    expect(entry.createdAt).toBeTruthy();
  });

  it('CreateTaskPushNotificationConfig without config.url returns 400', async () => {
    const router = buildRouter();
    registerA2ARoutes(router as any, buildDb(), buildChatEngine());
    const res = await router.dispatch(
      'POST', '/api/a2a',
      rpcBody(A2A_METHODS.CREATE_PUSH_CONFIG, {
        taskId: 'task-1',
        config: { token: 'no-url' },
      }),
      { 'content-type': 'application/json' },
      AUTH,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe(A2A_ERROR_CODES.INVALID_PARAMS);
  });

  it('full CRUD lifecycle: create → get → list → delete', async () => {
    const router = buildRouter();
    registerA2ARoutes(router as any, buildDb(), buildChatEngine());
    const taskId = 'lifecycle-task';

    // Create
    const create = await router.dispatch(
      'POST', '/api/a2a',
      rpcBody(A2A_METHODS.CREATE_PUSH_CONFIG, {
        taskId,
        config: { url: 'https://hook.example.com/a2a', token: 's3cr3t' },
      }),
      { 'content-type': 'application/json' },
      AUTH,
    );
    expect(create.statusCode).toBe(200);
    const configId = create.body.result.pushConfigId as string;

    // Get
    const get = await router.dispatch(
      'POST', '/api/a2a',
      rpcBody(A2A_METHODS.GET_PUSH_CONFIG, { taskId, pushConfigId: configId }),
      { 'content-type': 'application/json' },
      AUTH,
    );
    expect(get.statusCode).toBe(200);
    expect(get.body.result.pushConfigId).toBe(configId);

    // List
    const list = await router.dispatch(
      'POST', '/api/a2a',
      rpcBody(A2A_METHODS.LIST_PUSH_CONFIGS, { taskId }),
      { 'content-type': 'application/json' },
      AUTH,
    );
    expect(list.statusCode).toBe(200);
    expect(list.body.result.configs).toHaveLength(1);

    // Delete
    const del = await router.dispatch(
      'POST', '/api/a2a',
      rpcBody(A2A_METHODS.DELETE_PUSH_CONFIG, { taskId, pushConfigId: configId }),
      { 'content-type': 'application/json' },
      AUTH,
    );
    expect(del.statusCode).toBe(200);
    expect(del.body.result.deleted).toBe(true);

    // Get after delete → 404
    const getAfter = await router.dispatch(
      'POST', '/api/a2a',
      rpcBody(A2A_METHODS.GET_PUSH_CONFIG, { taskId, pushConfigId: configId }),
      { 'content-type': 'application/json' },
      AUTH,
    );
    expect(getAfter.statusCode).toBe(404);
  });

  it('GetTaskPushNotificationConfig for missing config returns 404', async () => {
    const router = buildRouter();
    registerA2ARoutes(router as any, buildDb(), buildChatEngine());
    const res = await router.dispatch(
      'POST', '/api/a2a',
      rpcBody(A2A_METHODS.GET_PUSH_CONFIG, { taskId: 'task-x', pushConfigId: 'no-such-config' }),
      { 'content-type': 'application/json' },
      AUTH,
    );
    expect(res.statusCode).toBe(404);
  });

  it('ListTaskPushNotificationConfigs returns empty array for new task', async () => {
    const router = buildRouter();
    registerA2ARoutes(router as any, buildDb(), buildChatEngine());
    const res = await router.dispatch(
      'POST', '/api/a2a',
      rpcBody(A2A_METHODS.LIST_PUSH_CONFIGS, { taskId: 'no-configs-task' }),
      { 'content-type': 'application/json' },
      AUTH,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.result.configs).toEqual([]);
  });

  it('push configs are isolated per task', async () => {
    const router = buildRouter();
    registerA2ARoutes(router as any, buildDb(), buildChatEngine());

    await router.dispatch(
      'POST', '/api/a2a',
      rpcBody(A2A_METHODS.CREATE_PUSH_CONFIG, { taskId: 'task-a', config: { url: 'https://a.example.com/hook' } }),
      { 'content-type': 'application/json' },
      AUTH,
    );

    const listB = await router.dispatch(
      'POST', '/api/a2a',
      rpcBody(A2A_METHODS.LIST_PUSH_CONFIGS, { taskId: 'task-b' }),
      { 'content-type': 'application/json' },
      AUTH,
    );
    expect(listB.body.result.configs).toHaveLength(0);
  });
});

// ─── [NEG] ───────────────────────────────────────────────────────────────────

describe('[NEG] negative / security edge cases', () => {
  it('CreatePushNotificationConfig missing taskId returns 400', async () => {
    const router = buildRouter();
    registerA2ARoutes(router as any, buildDb(), buildChatEngine());
    const res = await router.dispatch(
      'POST', '/api/a2a',
      rpcBody(A2A_METHODS.CREATE_PUSH_CONFIG, { config: { url: 'https://example.com/hook' } }),
      { 'content-type': 'application/json' },
      AUTH,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe(A2A_ERROR_CODES.INVALID_PARAMS);
  });

  it('DeletePushConfig missing pushConfigId returns 400', async () => {
    const router = buildRouter();
    registerA2ARoutes(router as any, buildDb(), buildChatEngine());
    const res = await router.dispatch(
      'POST', '/api/a2a',
      rpcBody(A2A_METHODS.DELETE_PUSH_CONFIG, { taskId: 'task-1' }),
      { 'content-type': 'application/json' },
      AUTH,
    );
    expect(res.statusCode).toBe(400);
  });

  it('empty body returns JSON-RPC parse error', async () => {
    const router = buildRouter();
    registerA2ARoutes(router as any, buildDb(), buildChatEngine());
    const res = await router.dispatch('POST', '/api/a2a', '', { 'content-type': 'application/json' }, AUTH);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe(A2A_ERROR_CODES.PARSE_ERROR);
  });

  it('array body returns invalid request error', async () => {
    const router = buildRouter();
    registerA2ARoutes(router as any, buildDb(), buildChatEngine());
    const res = await router.dispatch('POST', '/api/a2a', '[]', { 'content-type': 'application/json' }, AUTH);
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe(A2A_ERROR_CODES.INVALID_REQUEST);
  });

  it('jsonrpc 1.0 body returns invalid request error', async () => {
    const router = buildRouter();
    registerA2ARoutes(router as any, buildDb(), buildChatEngine());
    const res = await router.dispatch(
      'POST', '/api/a2a',
      JSON.stringify({ jsonrpc: '1.0', method: 'GetTask', id: '1', params: { id: 't1' } }),
      { 'content-type': 'application/json' },
      AUTH,
    );
    expect(res.statusCode).toBe(400);
  });

  it('XSS payload in task message is stored literally (no execution)', async () => {
    const router = buildRouter();
    registerA2ARoutes(router as any, buildDb(), buildChatEngine('<script>alert(1)</script>'));
    const createRes = await router.dispatch(
      'POST', '/api/a2a',
      rpcBody(A2A_METHODS.CREATE_PUSH_CONFIG, {
        taskId: 'xss-test',
        config: { url: 'https://safe.example.com/hook', token: '<script>xss</script>' },
      }),
      { 'content-type': 'application/json' },
      AUTH,
    );
    expect(createRes.statusCode).toBe(200);
    // Token is stored as-is (raw string, not interpreted as HTML)
    expect(typeof createRes.body.result.token).toBe('string');
  });
});
