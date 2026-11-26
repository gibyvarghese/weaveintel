/**
 * Push notification configs go through the outbound guard when they are created, and again when a push is
 * delivered. Rule R-A2A3: webhooks only to allow-listed hosts through the outbound guard; private addresses
 * refused.
 *
 * DNS is never asked: every test passes its own `lookup`, so a name resolves to the address the test chooses.
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LookupAddress } from 'node:dns';
import type { A2ATask, ExecutionContext, OutboundLookup } from '@weaveintel/core';
import { validatePushNotificationConfig, A2APushConfigError } from './push-guard.js';
import { deliverToWebhook } from './push-notification-delivery.js';
import { createInMemoryPushNotificationStore } from './push-notification-store.js';
import { createInMemoryA2ATaskStore } from './task-store.js';
import { createA2ADispatcher } from './a2a-server.js';

/** A resolver that answers from a fixed table and refuses every other name. */
function lookupFrom(table: Record<string, string[]>): OutboundLookup {
  return (hostname, callback) => {
    const addrs = table[hostname];
    if (!addrs) {
      const e = Object.assign(new Error(`ENOTFOUND ${hostname}`), {
        code: 'ENOTFOUND',
      }) as NodeJS.ErrnoException;
      callback(e, []);
      return;
    }
    callback(
      null,
      addrs.map((address): LookupAddress => ({ address, family: address.includes(':') ? 6 : 4 })),
    );
  };
}

const lookup = lookupFrom({
  'hooks.partner.example': ['93.184.216.34'],
  'deep.hooks.partner.example': ['93.184.216.35'],
  'rebound.partner.example': ['10.0.0.7'],
  'mixed.partner.example': ['93.184.216.36', '192.168.1.9'],
  'other.example': ['93.184.216.40'],
});

const policy = { allowedHosts: ['hooks.partner.example'], outbound: { lookup } };

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(A2APushConfigError);
    return (err as A2APushConfigError).code;
  }
  throw new Error('expected a refusal');
}

describe('[R-A2A3] validatePushNotificationConfig', () => {
  it('accepts an https webhook on an allow-listed host that resolves to a public address', async () => {
    const cfg = await validatePushNotificationConfig(
      { url: 'https://hooks.partner.example/a2a/push', token: 't' },
      policy,
    );
    expect(cfg.url).toBe('https://hooks.partner.example/a2a/push');
    expect(cfg.token).toBe('t');
  });

  it('accepts a subdomain of an allow-listed host', async () => {
    await expect(
      validatePushNotificationConfig({ url: 'https://deep.hooks.partner.example/p' }, policy),
    ).resolves.toBeDefined();
  });

  it('refuses a host that is not on the allow list', async () => {
    expect(
      await refusal(validatePushNotificationConfig({ url: 'https://other.example/p' }, policy)),
    ).toBe('HOST_NOT_ALLOWED');
  });

  it('refuses every host when the allow list is given and empty', async () => {
    expect(
      await refusal(
        validatePushNotificationConfig(
          { url: 'https://hooks.partner.example/p' },
          { allowedHosts: [], outbound: { lookup } },
        ),
      ),
    ).toBe('HOST_NOT_ALLOWED');
  });

  it('refuses an allow-listed name that resolves to a private address', async () => {
    const p = { allowedHosts: ['partner.example'], outbound: { lookup } };
    expect(
      await refusal(
        validatePushNotificationConfig({ url: 'https://rebound.partner.example/p' }, p),
      ),
    ).toBe('UNSAFE_URL');
    expect(
      await refusal(validatePushNotificationConfig({ url: 'https://mixed.partner.example/p' }, p)),
    ).toBe('UNSAFE_URL');
  });

  it('refuses private, loopback, link-local and metadata literals with no allow list', async () => {
    for (const url of [
      'https://10.0.0.1/hook',
      'https://172.20.0.1/hook',
      'https://192.168.1.100/hook',
      'https://127.0.0.1/hook',
      'https://[::1]/hook',
      'https://169.254.169.254/latest/meta-data',
      'https://metadata.google.internal/x',
      'https://[fd00::1]/hook',
      'https://0.0.0.0/hook',
    ]) {
      expect({
        url,
        code: await refusal(validatePushNotificationConfig({ url }, { outbound: { lookup } })),
      }).toEqual({ url, code: 'UNSAFE_URL' });
    }
  });

  it('refuses http even to a public host', async () => {
    expect(
      await refusal(
        validatePushNotificationConfig({ url: 'http://hooks.partner.example/p' }, policy),
      ),
    ).toBe('UNSAFE_URL');
  });

  it('refuses a name that does not resolve', async () => {
    expect(
      await refusal(
        validatePushNotificationConfig(
          { url: 'https://nowhere.partner.example/p' },
          { outbound: { lookup } },
        ),
      ),
    ).toBe('UNSAFE_URL');
  });

  it('refuses credentials in the URL', async () => {
    expect(
      await refusal(
        validatePushNotificationConfig({ url: 'https://user:pw@hooks.partner.example/p' }, policy),
      ),
    ).toBe('INVALID_CONFIG');
  });

  it('refuses a missing, non-string, malformed or over-long URL', async () => {
    for (const cfg of [
      {},
      { url: 42 },
      { url: 'not a url' },
      { url: `https://hooks.partner.example/${'a'.repeat(2100)}` },
    ]) {
      expect(await refusal(validatePushNotificationConfig(cfg as never, policy))).toBe(
        'INVALID_CONFIG',
      );
    }
  });

  it('refuses a non-https scheme', async () => {
    for (const url of [
      'ftp://hooks.partner.example/p',
      'file:///etc/passwd',
      'javascript:alert(1)',
    ]) {
      const code = await refusal(validatePushNotificationConfig({ url }, policy));
      expect(['INVALID_CONFIG', 'UNSAFE_URL']).toContain(code);
    }
  });

  it('keeps loopback refused unless the caller says so (a local test receiver)', async () => {
    expect(
      await refusal(validatePushNotificationConfig({ url: 'http://127.0.0.1:9/hook' }, {})),
    ).toBe('UNSAFE_URL');
    await expect(
      validatePushNotificationConfig(
        { url: 'http://127.0.0.1:9/hook' },
        { outbound: { allowLoopback: true } },
      ),
    ).resolves.toBeDefined();
  });
});

// ─── Delivery ────────────────────────────────────────────────────────────────

function task(id = 'task-1'): A2ATask {
  return {
    id,
    contextId: 'ctx',
    status: { state: 'TASK_STATE_COMPLETED', timestamp: new Date().toISOString() },
    artifacts: [],
    history: [],
  };
}

describe('[R-A2A3] deliverToWebhook through the guard', () => {
  let server: http.Server | undefined;
  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
  });

  async function receiver(handler: http.RequestListener): Promise<string> {
    server = http.createServer(handler);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  }

  it('refuses a loopback webhook by default', async () => {
    let hits = 0;
    const url = await receiver((_req, res) => {
      hits++;
      res.end();
    });
    const result = await deliverToWebhook(
      { url, pushConfigId: 'p', taskId: 't', createdAt: '' },
      { task: task(), timestamp: '' },
    );
    expect(result.delivered).toBe(false);
    expect(result.attempts).toBe(0);
    expect(hits).toBe(0);
  });

  it('refuses a host outside the allow list at delivery time too', async () => {
    let hits = 0;
    const url = await receiver((_req, res) => {
      hits++;
      res.end();
    });
    const result = await deliverToWebhook(
      { url, pushConfigId: 'p', taskId: 't', createdAt: '' },
      { task: task(), timestamp: '' },
      { policy: { allowedHosts: ['hooks.partner.example'], outbound: { allowLoopback: true } } },
    );
    expect(result.delivered).toBe(false);
    expect(hits).toBe(0);
  });

  it('does not follow a redirect (a public webhook cannot bounce the push to a private address)', async () => {
    let hits = 0;
    const url = await receiver((_req, res) => {
      hits++;
      res.writeHead(307, { location: 'http://10.0.0.1/steal' });
      res.end();
    });
    const result = await deliverToWebhook(
      { url, pushConfigId: 'p', taskId: 't', createdAt: '' },
      { task: task(), timestamp: '' },
      { policy: { outbound: { allowLoopback: true } }, retryDelaysMs: [] },
    );
    expect(result.delivered).toBe(false);
    expect(result.lastError).toMatch(/redirect/i);
    expect(hits).toBe(1);
  });

  it('delivers to an allowed receiver', async () => {
    const bodies: string[] = [];
    const url = await receiver((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        bodies.push(b);
        res.end();
      });
    });
    const result = await deliverToWebhook(
      { url, pushConfigId: 'p', taskId: 'task-1', createdAt: '' },
      { task: task(), timestamp: 'now' },
      { policy: { outbound: { allowLoopback: true } } },
    );
    expect(result).toEqual({ delivered: true, attempts: 1 });
    expect(JSON.parse(bodies[0]!).task.id).toBe('task-1');
  });
});

// ─── The dispatcher validates before it stores ───────────────────────────────

const ctx = { executionId: 'e1', tenantId: 'tenant-a' } as ExecutionContext;

function rpc(
  method: string,
  params: unknown,
): { method: string; body: string; headers: Record<string, string> } {
  return {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    headers: {},
  };
}

const impl = {
  card: {
    name: 'x',
    description: 'x',
    version: '1',
    skills: [],
    capabilities: {
      streaming: false,
      pushNotifications: true,
      extendedAgentCard: false,
      stateTransitionHistory: false,
    },
    supportedInterfaces: [
      {
        url: 'https://agent.example.com/a2a',
        protocolBinding: 'JSONRPC' as const,
        protocolVersion: '1.0',
      },
    ],
  },
  async handleMessage(): Promise<A2ATask> {
    return task();
  },
  async start(): Promise<void> {},
  async stop(): Promise<void> {},
};

describe('[R-A2A3] CreateTaskPushNotificationConfig in the dispatcher', () => {
  it('refuses a private webhook and stores nothing', async () => {
    const pushStore = createInMemoryPushNotificationStore();
    const store = createInMemoryA2ATaskStore();
    await store.save(task('task-1'));
    const dispatch = createA2ADispatcher(impl, store, pushStore, undefined, {
      pushPolicy: { outbound: { lookup } },
    });
    const res = await dispatch(
      ctx,
      rpc('CreateTaskPushNotificationConfig', {
        taskId: 'task-1',
        config: { url: 'https://10.0.0.1/hook' },
      }),
    );
    expect(res.kind).toBe('json');
    const data = (res as { data: { error?: { code: number; message: string } } }).data;
    expect(data.error?.code).toBe(-32602);
    expect(await pushStore.list('task-1')).toEqual([]);
  });

  it('refuses a webhook off the allow list', async () => {
    const pushStore = createInMemoryPushNotificationStore();
    const store = createInMemoryA2ATaskStore();
    await store.save(task('task-1'));
    const dispatch = createA2ADispatcher(impl, store, pushStore, undefined, { pushPolicy: policy });
    const res = await dispatch(
      ctx,
      rpc('CreateTaskPushNotificationConfig', {
        taskId: 'task-1',
        config: { url: 'https://other.example/p' },
      }),
    );
    expect((res as { data: { error?: unknown } }).data.error).toBeDefined();
    expect(await pushStore.list('task-1')).toEqual([]);
  });

  it('refuses a config for a task the store does not hold', async () => {
    const pushStore = createInMemoryPushNotificationStore();
    const dispatch = createA2ADispatcher(impl, createInMemoryA2ATaskStore(), pushStore, undefined, {
      pushPolicy: policy,
    });
    const res = await dispatch(
      ctx,
      rpc('CreateTaskPushNotificationConfig', {
        taskId: 'someone-elses',
        config: { url: 'https://hooks.partner.example/p' },
      }),
    );
    expect((res as { data: { error?: { code: number } } }).data.error?.code).toBe(-32001);
    expect(await pushStore.list('someone-elses')).toEqual([]);
  });

  it('stores an allowed webhook', async () => {
    const pushStore = createInMemoryPushNotificationStore();
    const store = createInMemoryA2ATaskStore();
    await store.save(task('task-1'));
    const dispatch = createA2ADispatcher(impl, store, pushStore, undefined, { pushPolicy: policy });
    const res = await dispatch(
      ctx,
      rpc('CreateTaskPushNotificationConfig', {
        taskId: 'task-1',
        config: { url: 'https://hooks.partner.example/p' },
      }),
    );
    expect((res as { data: { result?: { url: string } } }).data.result?.url).toBe(
      'https://hooks.partner.example/p',
    );
    expect(await pushStore.list('task-1')).toHaveLength(1);
  });

  it('validates with the guard even when no push policy is given', async () => {
    const pushStore = createInMemoryPushNotificationStore();
    const dispatch = createA2ADispatcher(impl, undefined, pushStore);
    const res = await dispatch(
      ctx,
      rpc('CreateTaskPushNotificationConfig', {
        taskId: 't',
        config: { url: 'https://169.254.169.254/x' },
      }),
    );
    expect((res as { data: { error?: unknown } }).data.error).toBeDefined();
    expect(await pushStore.list('t')).toEqual([]);
  });
});
