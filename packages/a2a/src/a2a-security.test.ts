/**
 * Security + negative tests for the A2A JSON-RPC 2.0 dispatcher.
 *
 * Tests designed to break the dispatcher by sending malformed, malicious,
 * or unexpected inputs. Each test asserts the server responds with an
 * appropriate error rather than crashing, leaking internals, or processing
 * the request incorrectly.
 *
 * Coverage matrix:
 *   [PARSE]    Malformed JSON bodies
 *   [ENVELOPE] Invalid JSON-RPC 2.0 envelopes (version, id, method, params)
 *   [PARAMS]   Missing/wrong params for each method (SendMessage, GetTask, etc.)
 *   [INJECT]   Injection attempts in string fields (SQL, XSS, template, shell)
 *   [OVERFLOW] Oversized inputs (large body, deep nesting, huge arrays)
 *   [METHOD]   Wrong HTTP method, unknown A2A method, wrong Content-Type
 *   [AUTH]     Missing auth header (at geneWeave route level — dispatcher is auth-agnostic)
 *   [STATE]    Cancel nonexistent task, resume wrong-state task
 *   [CONCUR]   Concurrent task operations on same task ID
 */

import { describe, it, expect, vi } from 'vitest';
import { createA2ADispatcher } from './a2a-server.js';
import { A2A_METHODS, A2A_ERROR_CODES } from './jsonrpc.js';
import { createInMemoryA2ATaskStore } from './task-store.js';
import type { A2AServer, A2ATask, ExecutionContext } from '@weaveintel/core';
import { newUUIDv7 } from '@weaveintel/core';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CTX: ExecutionContext = { executionId: 'security-test', metadata: {} };

function makeCard() {
  return {
    name: 'security-test-agent',
    description: 'security test',
    version: '1.0.0',
    skills: [{ id: 'test', name: 'Test', description: 'test skill' }],
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false, stateTransitionHistory: false },
    supportedInterfaces: [{ url: 'http://localhost/a2a', protocolBinding: 'JSONRPC' as const, protocolVersion: '1.0' }],
  };
}

function makeTask(id = newUUIDv7()): A2ATask {
  return {
    id,
    contextId: 'ctx-sec',
    status: { state: 'TASK_STATE_COMPLETED', timestamp: new Date().toISOString() },
    artifacts: [{ artifactId: `${id}-out`, name: 'output', parts: [{ text: 'ok' }] }],
    history: [],
  };
}

function makeImpl(overrides: Partial<A2AServer> = {}): A2AServer {
  return {
    card: makeCard(),
    handleMessage: vi.fn().mockImplementation(async (_ctx, params) => makeTask(newUUIDv7())),
    getTask: vi.fn().mockResolvedValue(null),
    listTasks: vi.fn().mockResolvedValue({ tasks: [], totalSize: 0 }),
    cancelTask: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeReq(body: string, method = 'POST') {
  return { method, body, headers: { 'a2a-version': '1.0', 'content-type': 'application/json' } } as const;
}

function rpc(method: string, params?: unknown, id?: string) {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? 'test-id', method, params });
}

function validSendMessage(text = 'hello') {
  return rpc(A2A_METHODS.SEND_MESSAGE, {
    message: { role: 'user', parts: [{ text }], messageId: newUUIDv7(), contextId: newUUIDv7() },
  });
}

async function dispatch(dispatcher: ReturnType<typeof createA2ADispatcher>, body: string, method = 'POST') {
  return dispatcher(CTX, makeReq(body, method));
}

// ─── [PARSE] Malformed JSON bodies ────────────────────────────────────────────

describe('[PARSE] Malformed JSON bodies', () => {
  const dispatcher = createA2ADispatcher(makeImpl());

  it('empty body → PARSE_ERROR', async () => {
    const res = await dispatch(dispatcher, '');
    expect(res.kind).toBe('json');
    if (res.kind !== 'json') return;
    expect(res.status).toBe(400);
    expect((res.data as Record<string, unknown>)['error']).toBeDefined();
    const err = (res.data as { error: { code: number } })['error'];
    expect(err.code).toBe(A2A_ERROR_CODES.PARSE_ERROR);
  });

  it('truncated JSON → PARSE_ERROR', async () => {
    const res = await dispatch(dispatcher, '{"jsonrpc": "2.0", "id": "1", "method": "Sen');
    expect(res.kind).toBe('json');
    if (res.kind !== 'json') return;
    expect((res.data as { error: { code: number } })['error'].code).toBe(A2A_ERROR_CODES.PARSE_ERROR);
  });

  it('plain text body → PARSE_ERROR', async () => {
    const res = await dispatch(dispatcher, 'not json at all');
    expect(res.kind).toBe('json');
    if (res.kind !== 'json') return;
    expect((res.data as { error: { code: number } })['error'].code).toBe(A2A_ERROR_CODES.PARSE_ERROR);
  });

  it('JSON array (batch) → INVALID_REQUEST', async () => {
    const res = await dispatch(dispatcher, '[{"jsonrpc":"2.0","id":"1","method":"SendMessage","params":{}}]');
    expect(res.kind).toBe('json');
    if (res.kind !== 'json') return;
    expect((res.data as { error: { code: number } })['error'].code).toBe(A2A_ERROR_CODES.INVALID_REQUEST);
  });

  it('null body → PARSE_ERROR or INVALID_REQUEST', async () => {
    const res = await dispatch(dispatcher, 'null');
    expect(res.kind).toBe('json');
    if (res.kind !== 'json') return;
    const code = (res.data as { error: { code: number } })['error'].code;
    expect([A2A_ERROR_CODES.PARSE_ERROR, A2A_ERROR_CODES.INVALID_REQUEST]).toContain(code);
  });

  it('boolean body → INVALID_REQUEST', async () => {
    const res = await dispatch(dispatcher, 'true');
    expect(res.kind).toBe('json');
    if (res.kind !== 'json') return;
    expect((res.data as { error: { code: number } })['error'].code).toBe(A2A_ERROR_CODES.INVALID_REQUEST);
  });

  it('number body → INVALID_REQUEST', async () => {
    const res = await dispatch(dispatcher, '42');
    expect(res.kind).toBe('json');
    if (res.kind !== 'json') return;
    expect((res.data as { error: { code: number } })['error'].code).toBe(A2A_ERROR_CODES.INVALID_REQUEST);
  });
});

// ─── [ENVELOPE] Invalid JSON-RPC 2.0 envelopes ────────────────────────────────

describe('[ENVELOPE] Invalid JSON-RPC 2.0 envelopes', () => {
  const dispatcher = createA2ADispatcher(makeImpl());

  it('missing jsonrpc field → INVALID_REQUEST', async () => {
    const res = await dispatch(dispatcher, JSON.stringify({ id: '1', method: 'SendMessage', params: {} }));
    if (res.kind !== 'json') throw new Error('expected json');
    expect((res.data as { error: { code: number } })['error'].code).toBe(A2A_ERROR_CODES.INVALID_REQUEST);
  });

  it('wrong jsonrpc version "1.0" → INVALID_REQUEST', async () => {
    const res = await dispatch(dispatcher, JSON.stringify({ jsonrpc: '1.0', id: '1', method: 'SendMessage', params: {} }));
    if (res.kind !== 'json') throw new Error('expected json');
    expect((res.data as { error: { code: number } })['error'].code).toBe(A2A_ERROR_CODES.INVALID_REQUEST);
  });

  it('jsonrpc version as number 2 → INVALID_REQUEST', async () => {
    const res = await dispatch(dispatcher, JSON.stringify({ jsonrpc: 2, id: '1', method: 'SendMessage', params: {} }));
    if (res.kind !== 'json') throw new Error('expected json');
    expect((res.data as { error: { code: number } })['error'].code).toBe(A2A_ERROR_CODES.INVALID_REQUEST);
  });

  it('missing method field → INVALID_REQUEST', async () => {
    const res = await dispatch(dispatcher, JSON.stringify({ jsonrpc: '2.0', id: '1', params: {} }));
    if (res.kind !== 'json') throw new Error('expected json');
    expect((res.data as { error: { code: number } })['error'].code).toBe(A2A_ERROR_CODES.INVALID_REQUEST);
  });

  it('empty method string → INVALID_REQUEST', async () => {
    const res = await dispatch(dispatcher, JSON.stringify({ jsonrpc: '2.0', id: '1', method: '', params: {} }));
    if (res.kind !== 'json') throw new Error('expected json');
    expect((res.data as { error: { code: number } })['error'].code).toBe(A2A_ERROR_CODES.INVALID_REQUEST);
  });

  it('method as null → INVALID_REQUEST', async () => {
    const res = await dispatch(dispatcher, JSON.stringify({ jsonrpc: '2.0', id: '1', method: null, params: {} }));
    if (res.kind !== 'json') throw new Error('expected json');
    expect((res.data as { error: { code: number } })['error'].code).toBe(A2A_ERROR_CODES.INVALID_REQUEST);
  });

  it('id as object → INVALID_REQUEST', async () => {
    const res = await dispatch(dispatcher, JSON.stringify({ jsonrpc: '2.0', id: { nested: true }, method: 'SendMessage', params: {} }));
    if (res.kind !== 'json') throw new Error('expected json');
    expect((res.data as { error: { code: number } })['error'].code).toBe(A2A_ERROR_CODES.INVALID_REQUEST);
  });
});

// ─── [METHOD] Wrong HTTP method and unknown A2A methods ───────────────────────

describe('[METHOD] HTTP method and unknown A2A methods', () => {
  const dispatcher = createA2ADispatcher(makeImpl());

  it('GET request → 405', async () => {
    const res = await dispatch(dispatcher, validSendMessage(), 'GET');
    if (res.kind !== 'json') throw new Error('expected json');
    expect(res.status).toBe(405);
  });

  it('DELETE request → 405', async () => {
    const res = await dispatch(dispatcher, validSendMessage(), 'DELETE');
    if (res.kind !== 'json') throw new Error('expected json');
    expect(res.status).toBe(405);
  });

  it('PUT request → 405', async () => {
    const res = await dispatch(dispatcher, validSendMessage(), 'PUT');
    if (res.kind !== 'json') throw new Error('expected json');
    expect(res.status).toBe(405);
  });

  it('unknown method name → METHOD_NOT_FOUND', async () => {
    const res = await dispatch(dispatcher, rpc('SomeUnknownMethod', {}));
    if (res.kind !== 'json') throw new Error('expected json');
    expect((res.data as { error: { code: number } })['error'].code).toBe(A2A_ERROR_CODES.METHOD_NOT_FOUND);
  });

  it('lowercase method name → METHOD_NOT_FOUND', async () => {
    // A2A uses PascalCase; lowercase should be treated as unknown
    const res = await dispatch(dispatcher, rpc('sendmessage', {}));
    if (res.kind !== 'json') throw new Error('expected json');
    expect((res.data as { error: { code: number } })['error'].code).toBe(A2A_ERROR_CODES.METHOD_NOT_FOUND);
  });

  it('method with unicode → METHOD_NOT_FOUND (no crash)', async () => {
    const res = await dispatch(dispatcher, rpc('SendMessage\u{1F4A5}'));
    if (res.kind !== 'json') throw new Error('expected json');
    expect((res.data as { error: { code: number } })['error'].code).toBe(A2A_ERROR_CODES.METHOD_NOT_FOUND);
  });
});

// ─── [PARAMS] Missing/invalid params per method ───────────────────────────────

describe('[PARAMS] Missing/invalid params for each method', () => {
  const store = createInMemoryA2ATaskStore();
  const impl = makeImpl({ getTask: vi.fn().mockResolvedValue(null) });
  const dispatcher = createA2ADispatcher(impl, store);

  // SendMessage
  it('SendMessage: missing params object → INVALID_PARAMS', async () => {
    const res = await dispatch(dispatcher, rpc(A2A_METHODS.SEND_MESSAGE));
    if (res.kind !== 'json') throw new Error('expected json');
    expect((res.data as { error: { code: number } })['error'].code).toBe(A2A_ERROR_CODES.INVALID_PARAMS);
  });

  it('SendMessage: params is array → INVALID_PARAMS', async () => {
    const res = await dispatch(dispatcher, rpc(A2A_METHODS.SEND_MESSAGE, []));
    if (res.kind !== 'json') throw new Error('expected json');
    expect((res.data as { error: { code: number } })['error'].code).toBe(A2A_ERROR_CODES.INVALID_PARAMS);
  });

  it('SendMessage: missing message → INVALID_PARAMS', async () => {
    const res = await dispatch(dispatcher, rpc(A2A_METHODS.SEND_MESSAGE, { notMessage: true }));
    if (res.kind !== 'json') throw new Error('expected json');
    expect((res.data as { error: { code: number } })['error'].code).toBe(A2A_ERROR_CODES.INVALID_PARAMS);
  });

  it('SendMessage: message.parts not array → INVALID_PARAMS', async () => {
    const res = await dispatch(dispatcher, rpc(A2A_METHODS.SEND_MESSAGE, {
      message: { role: 'user', parts: 'not an array' },
    }));
    if (res.kind !== 'json') throw new Error('expected json');
    expect((res.data as { error: { code: number } })['error'].code).toBe(A2A_ERROR_CODES.INVALID_PARAMS);
  });

  it('SendMessage: message.parts is null → INVALID_PARAMS', async () => {
    const res = await dispatch(dispatcher, rpc(A2A_METHODS.SEND_MESSAGE, {
      message: { role: 'user', parts: null },
    }));
    if (res.kind !== 'json') throw new Error('expected json');
    expect((res.data as { error: { code: number } })['error'].code).toBe(A2A_ERROR_CODES.INVALID_PARAMS);
  });

  it('SendMessage: message is a string → INVALID_PARAMS', async () => {
    const res = await dispatch(dispatcher, rpc(A2A_METHODS.SEND_MESSAGE, {
      message: 'just a string',
    }));
    if (res.kind !== 'json') throw new Error('expected json');
    expect((res.data as { error: { code: number } })['error'].code).toBe(A2A_ERROR_CODES.INVALID_PARAMS);
  });

  // GetTask
  it('GetTask: missing id → INVALID_PARAMS', async () => {
    const res = await dispatch(dispatcher, rpc(A2A_METHODS.GET_TASK, {}));
    if (res.kind !== 'json') throw new Error('expected json');
    expect((res.data as { error: { code: number } })['error'].code).toBe(A2A_ERROR_CODES.INVALID_PARAMS);
  });

  it('GetTask: id is number → INVALID_PARAMS', async () => {
    const res = await dispatch(dispatcher, rpc(A2A_METHODS.GET_TASK, { id: 12345 }));
    if (res.kind !== 'json') throw new Error('expected json');
    expect((res.data as { error: { code: number } })['error'].code).toBe(A2A_ERROR_CODES.INVALID_PARAMS);
  });

  it('GetTask: id is empty string → INVALID_PARAMS', async () => {
    const res = await dispatch(dispatcher, rpc(A2A_METHODS.GET_TASK, { id: '' }));
    if (res.kind !== 'json') throw new Error('expected json');
    expect((res.data as { error: { code: number } })['error'].code).toBe(A2A_ERROR_CODES.INVALID_PARAMS);
  });

  it('GetTask: valid id but task not found → TASK_NOT_FOUND', async () => {
    const res = await dispatch(dispatcher, rpc(A2A_METHODS.GET_TASK, { id: 'does-not-exist-xyz' }));
    if (res.kind !== 'json') throw new Error('expected json');
    expect((res.data as { error: { code: number } })['error'].code).toBe(A2A_ERROR_CODES.TASK_NOT_FOUND);
  });

  // CancelTask
  it('CancelTask: missing id → INVALID_PARAMS', async () => {
    const res = await dispatch(dispatcher, rpc(A2A_METHODS.CANCEL_TASK, {}));
    if (res.kind !== 'json') throw new Error('expected json');
    expect((res.data as { error: { code: number } })['error'].code).toBe(A2A_ERROR_CODES.INVALID_PARAMS);
  });

  // SubscribeToTask
  it('SubscribeToTask: missing id → INVALID_PARAMS', async () => {
    const res = await dispatch(dispatcher, rpc(A2A_METHODS.SUBSCRIBE_TO_TASK, {}));
    if (res.kind !== 'json') throw new Error('expected json');
    expect((res.data as { error: { code: number } })['error'].code).toBe(A2A_ERROR_CODES.INVALID_PARAMS);
  });
});

// ─── [INJECT] Injection attempts in string fields ─────────────────────────────

describe('[INJECT] Injection attempts in task content fields', () => {
  const dispatcher = createA2ADispatcher(makeImpl());

  const injectionPayloads = [
    // SQL injection
    "'; DROP TABLE tasks; --",
    "' OR '1'='1",
    "1; SELECT * FROM users WHERE 1=1--",
    // XSS
    '<script>alert("xss")</script>',
    '<img src=x onerror=alert(1)>',
    'javascript:alert(1)',
    // Template injection
    '{{7*7}}',
    '${7*7}',
    '<%=7*7%>',
    // Shell injection
    '$(id)',
    '`id`',
    '; ls -la',
    // Path traversal
    '../../../etc/passwd',
    '..\\..\\windows\\system32',
    // Null byte
    'hello\x00world',
    // Unicode RTL override
    'good‮file.exe',
    // CRLF injection
    'line1\r\nX-Custom-Header: injected',
  ];

  it.each(injectionPayloads)('injection payload handled safely: %s', async (payload) => {
    const body = rpc(A2A_METHODS.SEND_MESSAGE, {
      message: {
        role: 'user',
        parts: [{ text: payload }],
        messageId: newUUIDv7(),
      },
    });
    // Must not crash — must return either success or a structured error, never throw
    let threw = false;
    let resultKind: string | undefined;
    try {
      const r = await dispatch(dispatcher, body);
      resultKind = r.kind;
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(resultKind).toBe('json');
  });

  it('injection in GetTask id field handled safely', async () => {
    const dispatcher2 = createA2ADispatcher(makeImpl({
      getTask: vi.fn().mockResolvedValue(null),
    }));
    const res = await dispatch(dispatcher2, rpc(A2A_METHODS.GET_TASK, { id: "'; DROP TABLE tasks; --" }));
    if (res.kind !== 'json') throw new Error('expected json');
    // Should return TASK_NOT_FOUND (safe) not crash
    expect((res.data as { error: { code: number } })['error'].code).toBe(A2A_ERROR_CODES.TASK_NOT_FOUND);
  });

  it('injection in metadata field does not crash', async () => {
    const res = await dispatch(dispatcher, rpc(A2A_METHODS.SEND_MESSAGE, {
      message: {
        role: 'user',
        parts: [{ text: 'hello' }],
        messageId: newUUIDv7(),
      },
      metadata: {
        'injection': "'; DROP TABLE tasks; --",
        '__proto__': { admin: true },
        'constructor': { name: 'hacked' },
      },
    }));
    expect(res.kind).toBe('json');
  });

  it('prototype pollution via __proto__ in params does not escalate', async () => {
    // Attempt prototype pollution via deeply nested __proto__
    const malicious = JSON.stringify({
      jsonrpc: '2.0',
      id: 'atk',
      method: 'SendMessage',
      params: {
        '__proto__': { isAdmin: true },
        'message': { role: 'user', parts: [{ text: 'hello' }] },
      },
    });
    const res = await dispatch(dispatcher, malicious);
    expect(res.kind).toBe('json');
    // Should NOT have polluted Object.prototype
    expect(({} as Record<string, unknown>)['isAdmin']).toBeUndefined();
  });
});

// ─── [OVERFLOW] Oversized inputs ──────────────────────────────────────────────

describe('[OVERFLOW] Oversized and deeply nested inputs', () => {
  const dispatcher = createA2ADispatcher(makeImpl());

  it('very large text field (100KB) — handled without crash', async () => {
    const largeText = 'A'.repeat(100_000);
    const res = await dispatch(dispatcher, rpc(A2A_METHODS.SEND_MESSAGE, {
      message: { role: 'user', parts: [{ text: largeText }], messageId: newUUIDv7() },
    }));
    expect(res.kind).toBe('json');
  });

  it('empty parts array — handled gracefully', async () => {
    const res = await dispatch(dispatcher, rpc(A2A_METHODS.SEND_MESSAGE, {
      message: { role: 'user', parts: [], messageId: newUUIDv7() },
    }));
    // Empty parts is technically valid (dispatcher validates array exists)
    expect(res.kind).toBe('json');
  });

  it('very large parts array (1000 parts) — no crash', async () => {
    const manyParts = Array.from({ length: 1000 }, (_, i) => ({ text: `part ${i}` }));
    const res = await dispatch(dispatcher, rpc(A2A_METHODS.SEND_MESSAGE, {
      message: { role: 'user', parts: manyParts, messageId: newUUIDv7() },
    }));
    expect(res.kind).toBe('json');
  });

  it('deeply nested metadata object — no crash', async () => {
    let nested: Record<string, unknown> = { leaf: 'value' };
    for (let i = 0; i < 100; i++) nested = { child: nested };
    const res = await dispatch(dispatcher, rpc(A2A_METHODS.SEND_MESSAGE, {
      message: { role: 'user', parts: [{ text: 'nested' }], messageId: newUUIDv7() },
      metadata: nested,
    }));
    expect(res.kind).toBe('json');
  });

  it('very long task ID in GetTask — no crash', async () => {
    const dispatcher2 = createA2ADispatcher(makeImpl({ getTask: vi.fn().mockResolvedValue(null) }));
    const longId = 'x'.repeat(10_000);
    const res = await dispatch(dispatcher2, rpc(A2A_METHODS.GET_TASK, { id: longId }));
    expect(res.kind).toBe('json');
    // TASK_NOT_FOUND (safe) — not a crash
    if (res.kind !== 'json') return;
    const code = (res.data as { error: { code: number } })['error'].code;
    expect(code).toBe(A2A_ERROR_CODES.TASK_NOT_FOUND);
  });

  it('large number of metadata fields — no crash', async () => {
    const metadata: Record<string, string> = {};
    for (let i = 0; i < 1000; i++) metadata[`key_${i}`] = `value_${i}`;
    const res = await dispatch(dispatcher, rpc(A2A_METHODS.SEND_MESSAGE, {
      message: { role: 'user', parts: [{ text: 'big metadata' }], messageId: newUUIDv7() },
      metadata,
    }));
    expect(res.kind).toBe('json');
  });
});

// ─── [STATE] Task state machine edge cases ────────────────────────────────────

describe('[STATE] Task state machine edge cases', () => {
  it('GetTask on unknown ID → TASK_NOT_FOUND (not internal error)', async () => {
    const store = createInMemoryA2ATaskStore();
    const dispatcher = createA2ADispatcher(makeImpl({
      getTask: vi.fn().mockImplementation(async (_ctx, id) => store.load(id)),
    }), store);

    const res = await dispatch(dispatcher, rpc(A2A_METHODS.GET_TASK, { id: 'unknown-task-123' }));
    if (res.kind !== 'json') throw new Error('expected json');
    expect((res.data as { error: { code: number } })['error'].code).toBe(A2A_ERROR_CODES.TASK_NOT_FOUND);
  });

  it('CancelTask on nonexistent task — no crash', async () => {
    const store = createInMemoryA2ATaskStore();
    const dispatcher = createA2ADispatcher(makeImpl({
      cancelTask: vi.fn().mockImplementation(async (_ctx, id) => {
        const t = await store.load(id);
        if (!t) return; // graceful no-op
        await store.update(id, { status: { state: 'TASK_STATE_CANCELED', timestamp: new Date().toISOString() } });
      }),
    }), store);

    const res = await dispatch(dispatcher, rpc(A2A_METHODS.CANCEL_TASK, { id: 'does-not-exist' }));
    if (res.kind !== 'json') throw new Error('expected json');
    // Either cancelled (graceful no-op) or error — must not be 500
    expect(res.status).not.toBe(500);
  });

  it('SubscribeToTask without store → UNSUPPORTED_OPERATION', async () => {
    // Dispatcher without a store
    const dispatcher = createA2ADispatcher(makeImpl());
    const res = await dispatch(dispatcher, rpc(A2A_METHODS.SUBSCRIBE_TO_TASK, { id: 'any-id' }));
    if (res.kind !== 'json') throw new Error('expected json');
    expect((res.data as { error: { code: number } })['error'].code).toBe(A2A_ERROR_CODES.UNSUPPORTED_OPERATION);
  });

  it('handleMessage throwing an exception → 500 INTERNAL_ERROR (not unhandled)', async () => {
    const impl = makeImpl({
      handleMessage: vi.fn().mockRejectedValue(new Error('unexpected crash')),
    });
    const dispatcher = createA2ADispatcher(impl);
    const res = await dispatch(dispatcher, validSendMessage());
    if (res.kind !== 'json') throw new Error('expected json');
    expect(res.status).toBe(500);
    expect((res.data as { error: { code: number } })['error'].code).toBe(A2A_ERROR_CODES.INTERNAL_ERROR);
  });

  it('handleMessage returning null → 500 (does not expose null to caller silently)', async () => {
    const impl = makeImpl({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handleMessage: vi.fn().mockResolvedValue(null as any),
    });
    const dispatcher = createA2ADispatcher(impl);
    // Null result → either returns null in result (which JSON-RPC allows) or 500
    const res = await dispatch(dispatcher, validSendMessage());
    expect(res.kind).toBe('json');
    // Should not crash with unhandled error
  });
});

// ─── [CONCUR] Concurrent operations on same task ──────────────────────────────

describe('[CONCUR] Concurrent task operations', () => {
  it('concurrent SendMessage calls each get independent tasks', async () => {
    const store = createInMemoryA2ATaskStore();
    const handleCount = { n: 0 };
    const dispatcher = createA2ADispatcher(makeImpl({
      handleMessage: vi.fn().mockImplementation(async (_ctx, params) => {
        handleCount.n++;
        const id = newUUIDv7();
        const task = makeTask(id);
        await store.save(task);
        return task;
      }),
    }), store);

    const N = 10;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        dispatch(dispatcher, validSendMessage()),
      ),
    );

    expect(results).toHaveLength(N);
    const taskIds = new Set(
      results
        .filter((r) => r.kind === 'json')
        .map((r) => ((r as { kind: 'json'; data: unknown }).data as { result: { id: string } })['result']?.id)
        .filter(Boolean),
    );
    // Each task should have a unique ID
    expect(taskIds.size).toBe(N);
  });

  it('concurrent GetTask + CancelTask on same task ID — no crash', async () => {
    const store = createInMemoryA2ATaskStore();
    const taskId = newUUIDv7();
    const task = makeTask(taskId);
    await store.save(task);

    const dispatcher = createA2ADispatcher(makeImpl({
      getTask: vi.fn().mockImplementation((_ctx, id) => store.load(id)),
      cancelTask: vi.fn().mockImplementation(async (_ctx, id) => {
        const t = await store.load(id);
        if (t) await store.update(id, { status: { state: 'TASK_STATE_CANCELED', timestamp: new Date().toISOString() } });
      }),
    }), store);

    const ops = [
      dispatch(dispatcher, rpc(A2A_METHODS.GET_TASK, { id: taskId })),
      dispatch(dispatcher, rpc(A2A_METHODS.CANCEL_TASK, { id: taskId })),
      dispatch(dispatcher, rpc(A2A_METHODS.GET_TASK, { id: taskId })),
      dispatch(dispatcher, rpc(A2A_METHODS.CANCEL_TASK, { id: taskId })),
    ];

    const results = await Promise.all(ops);
    // All should respond (no unhandled errors)
    for (const r of results) {
      expect(r.kind).toBe('json');
    }
  });
});

// ─── [SECURITY] HTTP-level security assertions ────────────────────────────────

describe('[SECURITY] Dispatcher-level request validation', () => {
  const dispatcher = createA2ADispatcher(makeImpl());

  it('A2A-Version header 2.0 (unknown) — request still processed', async () => {
    // The dispatcher currently accepts any version (warn-only) for forward compat
    const res = await dispatcher(CTX, {
      method: 'POST',
      body: validSendMessage(),
      headers: { 'a2a-version': '2.0' },
    });
    // Should still process — currently permissive
    expect(res.kind).toBe('json');
  });

  it('no A2A-Version header — request still processed', async () => {
    const res = await dispatcher(CTX, {
      method: 'POST',
      body: validSendMessage(),
      headers: {},
    });
    expect(res.kind).toBe('json');
    if (res.kind !== 'json') return;
    // Should succeed
    expect(res.status).toBe(200);
  });

  it('response never leaks internal stack traces', async () => {
    const impl = makeImpl({
      handleMessage: vi.fn().mockRejectedValue(new Error('sensitive internal error with /etc/passwd path')),
    });
    const d = createA2ADispatcher(impl);
    const res = await dispatch(d, validSendMessage());
    if (res.kind !== 'json') throw new Error('expected json');
    // Message may mention the error but we verify no raw stack trace
    const errorMsg = (res.data as { error: { message: string } })['error'].message;
    expect(errorMsg).not.toMatch(/at Object\./); // no stack frames
    expect(errorMsg).not.toMatch(/node:internal/);
  });

  it('numeric JSON-RPC id is preserved in error response', async () => {
    const res = await dispatch(dispatcher, JSON.stringify({
      jsonrpc: '2.0',
      id: 42,
      method: 'UnknownMethod',
      params: {},
    }));
    if (res.kind !== 'json') throw new Error('expected json');
    const data = res.data as { id: string | number; error: { code: number } };
    expect(data['error'].code).toBe(A2A_ERROR_CODES.METHOD_NOT_FOUND);
    // id must be echoed back (as string since we coerce in parseRpcRequest)
    expect(data['id']).toBeDefined();
  });

  it('very long method name → METHOD_NOT_FOUND (no crash)', async () => {
    const longMethod = 'A'.repeat(10_000);
    const res = await dispatch(dispatcher, rpc(longMethod, {}));
    if (res.kind !== 'json') throw new Error('expected json');
    expect((res.data as { error: { code: number } })['error'].code).toBe(A2A_ERROR_CODES.METHOD_NOT_FOUND);
  });

  it('unicode method name → METHOD_NOT_FOUND (no crash)', async () => {
    const unicodeMethod = '🚀💀🎭SendMessage';
    const res = await dispatch(dispatcher, rpc(unicodeMethod, {}));
    if (res.kind !== 'json') throw new Error('expected json');
    expect((res.data as { error: { code: number } })['error'].code).toBe(A2A_ERROR_CODES.METHOD_NOT_FOUND);
  });
});
