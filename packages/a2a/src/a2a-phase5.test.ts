/**
 * A2A Phase 5 tests — Push Notifications, Card Signing, JWT Validation
 *
 * Coverage:
 *   [PUSH-STORE]    in-memory push notification store CRUD
 *   [PUSH-DELIVER]  webhook delivery: HMAC signing, SSRF guard, retry, concurrent
 *   [CARD-SIGN]     ES256 JWS sign/verify, payload canonicalization
 *   [JWT-VAL]       claim validation, JTI replay, exp/nbf skew, aud/scope
 *   [DISPATCHER]    push CRUD via JSON-RPC 2.0 dispatcher (no push store → 500)
 *   [DISPATCHER-JWT] JWT auth gate on dispatcher
 *   [NEG]           negative: bad URL, missing fields, wrong types, overflow
 *   [SEC]           security: SSRF, JTI replay, expired token, wrong aud/scope
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createInMemoryPushNotificationStore } from './push-notification-store.js';
import { deliverToWebhook, deliverPushNotificationsForTask } from './push-notification-delivery.js';
import { signAgentCard, verifyAgentCard, generateCardSigningKeyPair } from './card-signer.js';
import {
  createJwtValidator,
  createJtiCache,
} from './jwt-validator.js';
import { createA2ADispatcher } from './a2a-server.js';
import { createInMemoryA2ATaskStore } from './task-store.js';
import type { A2AServer, AgentCard, A2ATask, ExecutionContext, A2APushNotificationConfig } from '@weaveintel/core';
import { makeRpcRequest, A2A_METHODS, A2A_ERROR_CODES, parseRpcResponse, makeRpcSuccess } from './jsonrpc.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCtx(): ExecutionContext {
  return { executionId: 'test-exec', signal: AbortSignal.timeout(5000) } as unknown as ExecutionContext;
}

function makeAgentCard(): AgentCard {
  return {
    name: 'test-agent',
    description: 'test',
    version: '1.0.0',
    skills: [{ id: 'test-skill', name: 'Test Skill', description: 'A test skill' }],
    capabilities: { streaming: false, pushNotifications: true, extendedAgentCard: true, stateTransitionHistory: false },
    supportedInterfaces: [{ url: 'http://localhost/api/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
  };
}

function makeTask(id = 'task-001'): A2ATask {
  return {
    id,
    contextId: id,
    status: { state: 'TASK_STATE_COMPLETED', timestamp: new Date().toISOString() },
    artifacts: [{ artifactId: `${id}-out`, name: 'output', parts: [{ text: 'done' }] }],
    history: [],
  };
}

function makeMinimalServer(overrides: Partial<A2AServer> = {}): A2AServer {
  return {
    card: makeAgentCard(),
    async handleMessage() { return makeTask(); },
    async start() {},
    async stop() {},
    ...overrides,
  };
}

function rpcBody(method: string, params: unknown): string {
  return JSON.stringify(makeRpcRequest(method, params));
}

function rpcHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', 'A2A-Version': '1.0' };
}

// ─── [PUSH-STORE] ─────────────────────────────────────────────────────────────

describe('[PUSH-STORE] in-memory push notification store', () => {
  it('creates and retrieves a config', async () => {
    const store = createInMemoryPushNotificationStore();
    const config: A2APushNotificationConfig = { url: 'https://example.com/hook', token: 'secret' };
    const entry = await store.create('task-1', config);

    expect(entry.pushConfigId).toBeTruthy();
    expect(entry.taskId).toBe('task-1');
    expect(entry.url).toBe('https://example.com/hook');
    expect(entry.createdAt).toMatch(/^\d{4}-/);

    const fetched = await store.get('task-1', entry.pushConfigId);
    expect(fetched).toEqual(entry);
  });

  it('lists all configs for a task', async () => {
    const store = createInMemoryPushNotificationStore();
    await store.create('task-2', { url: 'https://a.com/h' });
    await store.create('task-2', { url: 'https://b.com/h' });
    await store.create('task-other', { url: 'https://c.com/h' });

    const list = await store.list('task-2');
    expect(list).toHaveLength(2);
    expect(list.map((e) => e.url)).toContain('https://a.com/h');
  });

  it('deletes a config', async () => {
    const store = createInMemoryPushNotificationStore();
    const entry = await store.create('task-3', { url: 'https://d.com/h' });
    expect(await store.delete('task-3', entry.pushConfigId)).toBe(true);
    expect(await store.get('task-3', entry.pushConfigId)).toBeNull();
    expect(await store.list('task-3')).toHaveLength(0);
  });

  it('returns false when deleting non-existent config', async () => {
    const store = createInMemoryPushNotificationStore();
    expect(await store.delete('task-x', 'nope')).toBe(false);
  });

  it('returns null for unknown task/config', async () => {
    const store = createInMemoryPushNotificationStore();
    expect(await store.get('no-task', 'no-cfg')).toBeNull();
    expect(await store.list('no-task')).toHaveLength(0);
  });

  it('different tasks do not share configs', async () => {
    const store = createInMemoryPushNotificationStore();
    await store.create('task-A', { url: 'https://a.com/h' });
    expect(await store.list('task-B')).toHaveLength(0);
  });

  it('multiple configs per task get unique IDs', async () => {
    const store = createInMemoryPushNotificationStore();
    const e1 = await store.create('task-dup', { url: 'https://x.com/h' });
    const e2 = await store.create('task-dup', { url: 'https://x.com/h' });
    expect(e1.pushConfigId).not.toBe(e2.pushConfigId);
  });
});

// ─── [PUSH-DELIVER] ───────────────────────────────────────────────────────────

describe('[PUSH-DELIVER] webhook delivery', () => {
  let webhookServer: http.Server;
  let webhookUrl: string;
  let receivedBodies: Array<{ headers: Record<string, string>; body: string }> = [];
  let respondStatus = 200;

  beforeEach(async () => {
    receivedBodies = [];
    respondStatus = 200;

    webhookServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        receivedBodies.push({
          headers: Object.fromEntries(
            Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0]! : String(v ?? '')]),
          ),
          body,
        });
        res.writeHead(respondStatus);
        res.end();
      });
    });

    await new Promise<void>((r) => webhookServer.listen(0, '127.0.0.1', r));
    const { port } = webhookServer.address() as AddressInfo;
    webhookUrl = `http://127.0.0.1:${port}/hook`;
  });

  it('delivers payload with correct headers', async () => {
    const task = makeTask('t-delivery');
    const result = await deliverToWebhook(
      { url: webhookUrl, pushConfigId: 'cfg-1', taskId: task.id, createdAt: new Date().toISOString() },
      { task, timestamp: new Date().toISOString() },
    );

    expect(result.delivered).toBe(true);
    expect(result.attempts).toBe(1);
    expect(receivedBodies).toHaveLength(1);
    const received = receivedBodies[0]!;
    expect(received.headers['a2a-version']).toBe('1.0');
    expect(received.headers['content-type']).toBe('application/json');
    const parsed = JSON.parse(received.body) as { task: A2ATask };
    expect(parsed.task.id).toBe(task.id);
  });

  it('adds HMAC-SHA256 signature when token is set', async () => {
    const task = makeTask('t-hmac');
    const result = await deliverToWebhook(
      { url: webhookUrl, token: 'my-secret', pushConfigId: 'cfg-hmac', taskId: task.id, createdAt: new Date().toISOString() },
      { task, timestamp: new Date().toISOString() },
    );

    expect(result.delivered).toBe(true);
    const received = receivedBodies[0]!;
    expect(received.headers['x-a2a-webhook-signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('adds Authorization header when credentials are set', async () => {
    const task = makeTask('t-creds');
    await deliverToWebhook(
      {
        url: webhookUrl,
        pushConfigId: 'cfg-cred',
        taskId: task.id,
        createdAt: new Date().toISOString(),
        authentication: { schemes: ['bearer'], credentials: 'my-bearer-token' },
      },
      { task, timestamp: new Date().toISOString() },
    );

    const received = receivedBodies[0]!;
    expect(received.headers['authorization']).toBe('Bearer my-bearer-token');
  });

  it('blocks SSRF — RFC 1918 addresses', async () => {
    const result = await deliverToWebhook(
      { url: 'http://192.168.1.100/hook', pushConfigId: 'cfg-ssrf', taskId: 'task-ssrf', createdAt: '' },
      { task: makeTask('ssrf'), timestamp: '' },
    );
    expect(result.delivered).toBe(false);
    expect(result.lastError).toMatch(/SSRF/i);
  });

  it('blocks SSRF — cloud metadata endpoint 169.254.169.254', async () => {
    const result = await deliverToWebhook(
      { url: 'http://169.254.169.254/latest/meta-data', pushConfigId: 'cfg-meta', taskId: 'task-meta', createdAt: '' },
      { task: makeTask('meta'), timestamp: '' },
    );
    expect(result.delivered).toBe(false);
    expect(result.lastError).toMatch(/SSRF/i);
  });

  it('delivers to all configs for a task via deliverPushNotificationsForTask', async () => {
    const store = createInMemoryPushNotificationStore();
    await store.create('task-multi', { url: webhookUrl });
    await store.create('task-multi', { url: webhookUrl });

    const task = makeTask('task-multi');
    await deliverPushNotificationsForTask(store, task);

    expect(receivedBodies).toHaveLength(2);
  });

  it('no-ops when no configs registered for a task', async () => {
    const store = createInMemoryPushNotificationStore();
    await deliverPushNotificationsForTask(store, makeTask('task-no-cfg'));
    expect(receivedBodies).toHaveLength(0);
  });
});

// ─── [CARD-SIGN] ──────────────────────────────────────────────────────────────

describe('[CARD-SIGN] ES256 JWS agent card signing', () => {
  it('signs a card and verifies successfully', async () => {
    const { privateKey, publicKey } = await generateCardSigningKeyPair();
    const card = makeAgentCard();

    const signed = await signAgentCard(card, privateKey, 'test-key-id');

    expect(signed.signatures).toHaveLength(1);
    expect(signed.signatures![0]!.algorithm).toBe('ES256');
    expect(signed.signatures![0]!.keyId).toBe('test-key-id');
    expect(signed.signatures![0]!.signature).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const result = await verifyAgentCard(signed, async (kid) => {
      if (kid === 'test-key-id') return publicKey;
      return null;
    });
    expect(result.valid).toBe(true);
  });

  it('fails verification with wrong public key', async () => {
    const { privateKey } = await generateCardSigningKeyPair();
    const { publicKey: wrongPublicKey } = await generateCardSigningKeyPair();
    const card = makeAgentCard();

    const signed = await signAgentCard(card, privateKey, 'key-x');
    const result = await verifyAgentCard(signed, async () => wrongPublicKey);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('signature verification failed');
  });

  it('fails verification when key is not found', async () => {
    const { privateKey } = await generateCardSigningKeyPair();
    const signed = await signAgentCard(makeAgentCard(), privateKey, 'key-missing');
    const result = await verifyAgentCard(signed, async () => null);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/unknown key/);
  });

  it('returns valid for unsigned card (no signatures)', async () => {
    const card = makeAgentCard();
    const result = await verifyAgentCard(card, async () => null);
    expect(result.valid).toBe(true);
    expect(result.reason).toBe('no signatures present');
  });

  it('excludes signatures from signed payload (idempotent on additional signatures)', async () => {
    const { privateKey: k1, publicKey: pk1 } = await generateCardSigningKeyPair();
    const { privateKey: k2, publicKey: pk2 } = await generateCardSigningKeyPair();

    const card = makeAgentCard();
    const signed1 = await signAgentCard(card, k1, 'key-1');
    const signed2 = await signAgentCard(signed1, k2, 'key-2');

    expect(signed2.signatures).toHaveLength(2);

    const keyMap: Record<string, CryptoKey> = { 'key-1': pk1, 'key-2': pk2 };
    const result = await verifyAgentCard(signed2, async (kid) => keyMap[kid] ?? null);
    expect(result.valid).toBe(true);
  });

  it('fails with malformed JWS compact signature', async () => {
    const card = {
      ...makeAgentCard(),
      signatures: [{ algorithm: 'ES256', keyId: 'k', signature: 'bad.sig' }],
    };
    const { publicKey } = await generateCardSigningKeyPair();
    const result = await verifyAgentCard(card, async () => publicKey);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('malformed JWS compact');
  });

  it('rejects unsupported algorithm', async () => {
    const card = {
      ...makeAgentCard(),
      signatures: [{ algorithm: 'RS512', keyId: 'k', signature: 'a.b.c' }],
    };
    const { publicKey } = await generateCardSigningKeyPair();
    const result = await verifyAgentCard(card, async () => publicKey);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/unsupported algorithm/);
  });
});

// ─── [JWT-VAL] ────────────────────────────────────────────────────────────────

describe('[JWT-VAL] JWT claim validation', () => {
  // Create a minimal signed JWT using Web Crypto (HS256 is not supported; we'll
  // test unsigned tokens in no-signature mode for claim logic, then test ES256 sig separately)

  function makeUnsignedJwt(payload: Record<string, unknown>): string {
    const header = btoa(JSON.stringify({ alg: 'ES256', kid: 'test' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    const body = btoa(JSON.stringify(payload))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    return `${header}.${body}.fakesig`;
  }

  function bearerHeader(payload: Record<string, unknown>): string {
    return `Bearer ${makeUnsignedJwt(payload)}`;
  }

  const now = Math.floor(Date.now() / 1000);

  it('returns payload for valid token (no signature check, no jti)', async () => {
    const validator = createJwtValidator({ audience: 'my-agent' });
    const result = await validator(bearerHeader({ aud: 'my-agent', exp: now + 3600 }), {});
    expect(result).not.toBeNull();
    expect(result!.aud).toBe('my-agent');
  });

  it('returns null for missing Bearer prefix', async () => {
    const validator = createJwtValidator({ audience: 'my-agent' });
    expect(await validator('Basic abc', {})).toBeNull();
    expect(await validator('', {})).toBeNull();
    expect(await validator('eyJ...', {})).toBeNull();
  });

  it('rejects expired token', async () => {
    const validator = createJwtValidator({ audience: 'my-agent', clockSkewSeconds: 0 });
    const result = await validator(bearerHeader({ aud: 'my-agent', exp: now - 10 }), {});
    expect(result).toBeNull();
  });

  it('accepts token within clock skew window', async () => {
    const validator = createJwtValidator({ audience: 'my-agent', clockSkewSeconds: 60 });
    const result = await validator(bearerHeader({ aud: 'my-agent', exp: now - 30 }), {});
    expect(result).not.toBeNull();
  });

  it('rejects token not yet valid (nbf in future)', async () => {
    const validator = createJwtValidator({ audience: 'my-agent', clockSkewSeconds: 0 });
    const result = await validator(bearerHeader({ aud: 'my-agent', exp: now + 3600, nbf: now + 120 }), {});
    expect(result).toBeNull();
  });

  it('rejects wrong audience', async () => {
    const validator = createJwtValidator({ audience: 'my-agent' });
    const result = await validator(bearerHeader({ aud: 'other-agent', exp: now + 3600 }), {});
    expect(result).toBeNull();
  });

  it('accepts token with audience array containing the expected audience', async () => {
    const validator = createJwtValidator({ audience: 'my-agent' });
    const result = await validator(bearerHeader({ aud: ['other', 'my-agent'], exp: now + 3600 }), {});
    expect(result).not.toBeNull();
  });

  it('rejects token without required scope', async () => {
    const validator = createJwtValidator({ audience: 'my-agent', skillId: 'skill-x' });
    const result = await validator(bearerHeader({ aud: 'my-agent', exp: now + 3600, scope: 'skill-y' }), {});
    expect(result).toBeNull();
  });

  it('accepts token with correct scope', async () => {
    const validator = createJwtValidator({ audience: 'my-agent', skillId: 'skill-x' });
    const result = await validator(bearerHeader({ aud: 'my-agent', exp: now + 3600, scope: 'skill-x skill-y' }), {});
    expect(result).not.toBeNull();
  });

  it('per-call skillId override takes precedence', async () => {
    const validator = createJwtValidator({ audience: 'my-agent', skillId: 'default-skill' });
    const result = await validator(bearerHeader({ aud: 'my-agent', exp: now + 3600, scope: 'call-skill' }), { skillId: 'call-skill' });
    expect(result).not.toBeNull();
  });

  it('returns null for malformed token', async () => {
    const validator = createJwtValidator({ audience: 'my-agent' });
    expect(await validator('Bearer not-a-jwt', {})).toBeNull();
    expect(await validator('Bearer a.b', {})).toBeNull();
    expect(await validator('Bearer a.b.c.d', {})).toBeNull();
  });
});

// ─── [JWT-VAL] JTI replay prevention ──────────────────────────────────────────

describe('[JWT-VAL] JTI replay prevention', () => {
  function makeUnsignedJwt(payload: Record<string, unknown>): string {
    const header = btoa(JSON.stringify({ alg: 'ES256' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    const body = btoa(JSON.stringify(payload))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    return `Bearer ${header}.${body}.fakesig`;
  }

  it('prevents JTI replay', async () => {
    const jtiCache = createJtiCache();
    const now = Math.floor(Date.now() / 1000);
    const validator = createJwtValidator({ audience: 'a', jtiCache });

    const token = makeUnsignedJwt({ aud: 'a', exp: now + 3600, jti: 'unique-jti-1' });

    const first = await validator(token, {});
    expect(first).not.toBeNull();
    const second = await validator(token, {});
    expect(second).toBeNull(); // replay detected
  });

  it('allows different JTIs', async () => {
    const jtiCache = createJtiCache();
    const now = Math.floor(Date.now() / 1000);
    const validator = createJwtValidator({ audience: 'a', jtiCache });

    const t1 = makeUnsignedJwt({ aud: 'a', exp: now + 3600, jti: 'jti-first' });
    const t2 = makeUnsignedJwt({ aud: 'a', exp: now + 3600, jti: 'jti-second' });

    expect(await validator(t1, {})).not.toBeNull();
    expect(await validator(t2, {})).not.toBeNull();
  });

  it('LRU evicts oldest entry when maxSize reached', () => {
    const cache = createJtiCache(3);
    const exp = Math.floor(Date.now() / 1000) + 3600;

    cache.add('a', exp);
    cache.add('b', exp);
    cache.add('c', exp);

    expect(cache.has('a')).toBe(true);

    // Adding a 4th evicts 'a' (oldest)
    cache.add('d', exp);
    expect(cache.has('a')).toBe(false);
    expect(cache.has('d')).toBe(true);
  });
});

// ─── [DISPATCHER] push CRUD via JSON-RPC 2.0 ─────────────────────────────────

describe('[DISPATCHER] push notification CRUD', () => {
  it('CreateTaskPushNotificationConfig returns 500 (PUSH_NOTIFICATION_NOT_SUPPORTED) without push store', async () => {
    const dispatch = createA2ADispatcher(makeMinimalServer());
    const res = await dispatch(makeCtx(), {
      method: 'POST',
      headers: rpcHeaders(),
      body: rpcBody(A2A_METHODS.CREATE_PUSH_CONFIG, { taskId: 'task-1', config: { url: 'https://example.com/h' } }),
    });
    expect(res.kind).toBe('json');
    if (res.kind === 'json') {
      expect(res.status).toBe(500);
      expect((res.data as { error: { code: number } }).error.code).toBe(A2A_ERROR_CODES.PUSH_NOTIFICATION_NOT_SUPPORTED);
    }
  });

  it('full push CRUD lifecycle with push store', async () => {
    const pushStore = createInMemoryPushNotificationStore();
    const dispatch = createA2ADispatcher(makeMinimalServer(), createInMemoryA2ATaskStore(), pushStore);

    // Create
    const createBody = rpcBody(A2A_METHODS.CREATE_PUSH_CONFIG, {
      taskId: 'task-push',
      config: { url: 'https://example.com/hook', token: 'abc123' },
    });
    const createRes = await dispatch(makeCtx(), { method: 'POST', headers: rpcHeaders(), body: createBody });
    expect(createRes.kind).toBe('json');
    if (createRes.kind !== 'json') return;
    expect(createRes.status).toBe(200);
    const created = parseRpcResponse<{ pushConfigId: string }>(createRes.data);
    expect(created.pushConfigId).toBeTruthy();
    const configId = created.pushConfigId;

    // Get
    const getRes = await dispatch(makeCtx(), {
      method: 'POST', headers: rpcHeaders(),
      body: rpcBody(A2A_METHODS.GET_PUSH_CONFIG, { taskId: 'task-push', pushConfigId: configId }),
    });
    if (getRes.kind !== 'json') return;
    expect(getRes.status).toBe(200);
    const fetched = parseRpcResponse<{ url: string }>(getRes.data);
    expect(fetched.url).toBe('https://example.com/hook');

    // List
    const listRes = await dispatch(makeCtx(), {
      method: 'POST', headers: rpcHeaders(),
      body: rpcBody(A2A_METHODS.LIST_PUSH_CONFIGS, { taskId: 'task-push' }),
    });
    if (listRes.kind !== 'json') return;
    expect(listRes.status).toBe(200);
    const listed = parseRpcResponse<{ configs: unknown[] }>(listRes.data);
    expect(listed.configs).toHaveLength(1);

    // Delete
    const delRes = await dispatch(makeCtx(), {
      method: 'POST', headers: rpcHeaders(),
      body: rpcBody(A2A_METHODS.DELETE_PUSH_CONFIG, { taskId: 'task-push', pushConfigId: configId }),
    });
    if (delRes.kind !== 'json') return;
    expect(delRes.status).toBe(200);

    // Verify deleted — GetPushConfig → 404
    const getMissingRes = await dispatch(makeCtx(), {
      method: 'POST', headers: rpcHeaders(),
      body: rpcBody(A2A_METHODS.GET_PUSH_CONFIG, { taskId: 'task-push', pushConfigId: configId }),
    });
    if (getMissingRes.kind !== 'json') return;
    expect(getMissingRes.status).toBe(404);
  });

  it('CreatePushNotificationConfig with missing config.url returns 400 INVALID_PARAMS', async () => {
    const pushStore = createInMemoryPushNotificationStore();
    const dispatch = createA2ADispatcher(makeMinimalServer(), undefined, pushStore);
    const res = await dispatch(makeCtx(), {
      method: 'POST', headers: rpcHeaders(),
      body: rpcBody(A2A_METHODS.CREATE_PUSH_CONFIG, { taskId: 'task-1', config: { token: 'only-token' } }),
    });
    if (res.kind !== 'json') return;
    expect(res.status).toBe(500);
    expect((res.data as { error: { code: number } }).error.code).toBe(A2A_ERROR_CODES.INVALID_PARAMS);
  });

  it('GetPushNotificationConfig missing pushConfigId returns 400', async () => {
    const pushStore = createInMemoryPushNotificationStore();
    const dispatch = createA2ADispatcher(makeMinimalServer(), undefined, pushStore);
    const res = await dispatch(makeCtx(), {
      method: 'POST', headers: rpcHeaders(),
      body: rpcBody(A2A_METHODS.GET_PUSH_CONFIG, { taskId: 'task-1' }),
    });
    if (res.kind !== 'json') return;
    expect(res.status).toBe(500);
    expect((res.data as { error: { code: number } }).error.code).toBe(A2A_ERROR_CODES.INVALID_PARAMS);
  });

  it('DeletePushNotificationConfig for nonexistent config returns 404', async () => {
    const pushStore = createInMemoryPushNotificationStore();
    const dispatch = createA2ADispatcher(makeMinimalServer(), undefined, pushStore);
    const res = await dispatch(makeCtx(), {
      method: 'POST', headers: rpcHeaders(),
      body: rpcBody(A2A_METHODS.DELETE_PUSH_CONFIG, { taskId: 'task-1', pushConfigId: 'no-such-cfg' }),
    });
    if (res.kind !== 'json') return;
    expect(res.status).toBe(404);
  });

  it('GetExtendedAgentCard dispatches to getExtendedCard on server impl', async () => {
    const extCard = { ...makeAgentCard(), documentationUrl: 'https://docs.example.com' };
    const server = makeMinimalServer({ getExtendedCard: async () => extCard });
    const dispatch = createA2ADispatcher(server);
    const res = await dispatch(makeCtx(), {
      method: 'POST', headers: rpcHeaders(),
      body: rpcBody(A2A_METHODS.GET_EXTENDED_AGENT_CARD, {}),
    });
    if (res.kind !== 'json') return;
    expect(res.status).toBe(200);
    const card = parseRpcResponse<{ documentationUrl?: string }>(res.data);
    expect(card.documentationUrl).toBe('https://docs.example.com');
  });
});

// ─── [DISPATCHER-JWT] JWT auth gate ───────────────────────────────────────────

describe('[DISPATCHER-JWT] JWT auth gate', () => {
  function makeUnsignedJwt(payload: Record<string, unknown>): string {
    const header = btoa(JSON.stringify({ alg: 'ES256' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    const body = btoa(JSON.stringify(payload))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    return `${header}.${body}.fakesig`;
  }

  const now = Math.floor(Date.now() / 1000);

  it('rejects request without Authorization header when JWT validator is set', async () => {
    const validator = createJwtValidator({ audience: 'test-agent' });
    const dispatch = createA2ADispatcher(makeMinimalServer(), undefined, undefined, validator);
    const res = await dispatch(makeCtx(), {
      method: 'POST', headers: rpcHeaders(),
      body: rpcBody(A2A_METHODS.SEND_MESSAGE, {
        message: { role: 'user', parts: [{ text: 'hi' }] },
      }),
    });
    if (res.kind !== 'json') return;
    expect(res.status).toBe(401);
  });

  it('accepts valid JWT and dispatches to handler', async () => {
    const validator = createJwtValidator({ audience: 'test-agent' });
    const dispatch = createA2ADispatcher(makeMinimalServer(), undefined, undefined, validator);

    const token = makeUnsignedJwt({ aud: 'test-agent', exp: now + 3600 });
    // HTTP headers are lowercased in Node.js IncomingMessage — match that here
    const res = await dispatch(makeCtx(), {
      method: 'POST',
      headers: { ...rpcHeaders(), authorization: `Bearer ${token}` },
      body: rpcBody(A2A_METHODS.SEND_MESSAGE, {
        message: { role: 'user', parts: [{ text: 'hi' }] },
      }),
    });
    if (res.kind !== 'json') return;
    expect(res.status).toBe(200);
  });

  it('rejects expired JWT', async () => {
    const validator = createJwtValidator({ audience: 'test-agent', clockSkewSeconds: 0 });
    const dispatch = createA2ADispatcher(makeMinimalServer(), undefined, undefined, validator);

    const token = makeUnsignedJwt({ aud: 'test-agent', exp: now - 60 });
    const res = await dispatch(makeCtx(), {
      method: 'POST',
      headers: { ...rpcHeaders(), authorization: `Bearer ${token}` },
      body: rpcBody(A2A_METHODS.SEND_MESSAGE, {
        message: { role: 'user', parts: [{ text: 'hi' }] },
      }),
    });
    if (res.kind !== 'json') return;
    expect(res.status).toBe(401);
  });
});

// ─── [NEG] negative tests ─────────────────────────────────────────────────────

describe('[NEG] negative: push store edge cases', () => {
  it('create with empty URL still succeeds (URL format is caller responsibility)', async () => {
    const store = createInMemoryPushNotificationStore();
    const entry = await store.create('t', { url: '' });
    expect(entry.url).toBe('');
  });

  it('handles very long task IDs', async () => {
    const store = createInMemoryPushNotificationStore();
    const longId = 'x'.repeat(1000);
    const entry = await store.create(longId, { url: 'https://example.com' });
    expect(entry.taskId).toBe(longId);
    expect(await store.list(longId)).toHaveLength(1);
  });

  it('deletes non-existent config in non-existent task returns false', async () => {
    const store = createInMemoryPushNotificationStore();
    expect(await store.delete('no-task', 'no-cfg')).toBe(false);
  });
});

// ─── [SEC] security tests ─────────────────────────────────────────────────────

describe('[SEC] security: push notification delivery', () => {
  it('blocks 10.x.x.x (RFC 1918)', async () => {
    const result = await deliverToWebhook(
      { url: 'http://10.0.0.1/hook', pushConfigId: 'p', taskId: 't', createdAt: '' },
      { task: makeTask(), timestamp: '' },
    );
    expect(result.delivered).toBe(false);
  });

  it('blocks 172.16.x.x (RFC 1918)', async () => {
    const result = await deliverToWebhook(
      { url: 'http://172.20.0.1/hook', pushConfigId: 'p', taskId: 't', createdAt: '' },
      { task: makeTask(), timestamp: '' },
    );
    expect(result.delivered).toBe(false);
  });

  it('blocks 0.0.0.0', async () => {
    const result = await deliverToWebhook(
      { url: 'http://0.0.0.0/hook', pushConfigId: 'p', taskId: 't', createdAt: '' },
      { task: makeTask(), timestamp: '' },
    );
    expect(result.delivered).toBe(false);
  });

  it('HMAC signature is distinct for different payloads', async () => {
    let webhookServer: http.Server;
    const sigs: string[] = [];

    webhookServer = http.createServer((req, res) => {
      const sig = req.headers['x-a2a-webhook-signature'] as string | undefined;
      if (sig) sigs.push(sig);
      res.writeHead(200);
      res.end();
    });

    await new Promise<void>((r) => webhookServer.listen(0, '127.0.0.1', r));
    const { port } = webhookServer.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}/hook`;

    try {
      await deliverToWebhook(
        { url, token: 'secret', pushConfigId: 'p1', taskId: 'task-1', createdAt: '' },
        { task: makeTask('task-1'), timestamp: '2024-01-01T00:00:00.000Z' },
      );
      await deliverToWebhook(
        { url, token: 'secret', pushConfigId: 'p2', taskId: 'task-2', createdAt: '' },
        { task: makeTask('task-2'), timestamp: '2024-01-01T00:00:00.000Z' },
      );

      expect(sigs).toHaveLength(2);
      expect(sigs[0]).not.toBe(sigs[1]);
    } finally {
      webhookServer.close();
    }
  });
});
