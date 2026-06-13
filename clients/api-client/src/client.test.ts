/**
 * client.test.ts — contract tests for createGeneweaveClient.
 *
 * Drives the client through an in-memory fake transport (no network), asserting
 * the verified surface behaviours: auth token capture + refresh-once-on-401,
 * run start → stream → terminal, zero-gap resume after a dropped stream,
 * task-complete idempotency, memory CRUD incl. the managed-by-org read-only
 * path, response-shape validation, and per-tenant outbox isolation.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createGeneweaveClient,
  MemoryTokenStore,
  AuthExpiredError,
  ManagedByOrgError,
  ResponseShapeError,
  type GeneweaveTransport,
  type RawResponse,
  type TransportRequest,
  type StreamHandlers,
} from './index.js';
import { MemoryStorage } from '@weaveintel/client';

// ---------------------------------------------------------------------------
// Fake transport
// ---------------------------------------------------------------------------

type RouteFn = (req: TransportRequest) => RawResponse | Promise<RawResponse>;

interface FakeTransportOptions {
  routes: Record<string, RouteFn>;
  /** Scripted SSE: arrays of envelope batches; each openStream pops one batch. */
  streamBatches?: unknown[][];
  /** If true, each stream closes without a terminal event (to test resume). */
}

function key(req: TransportRequest): string {
  return `${req.method} ${req.path.split('?')[0]}`;
}

function fakeTransport(opts: FakeTransportOptions): GeneweaveTransport & {
  calls: TransportRequest[];
  streamOpens: string[];
} {
  const calls: TransportRequest[] = [];
  const streamOpens: string[] = [];
  const batches = [...(opts.streamBatches ?? [])];
  return {
    calls,
    streamOpens,
    async request(req) {
      calls.push(req);
      const route = opts.routes[key(req)];
      if (!route) return { status: 404, body: { error: 'no route' } };
      return route(req);
    },
    openStream(input, handlers: StreamHandlers) {
      streamOpens.push(input.path);
      const batch = batches.shift() ?? [];
      queueMicrotask(() => {
        for (const ev of batch) handlers.onEvent(ev);
        handlers.onClose?.();
      });
    },
  };
}

function ev(runId: string, sequence: number, kind: string, payload: Record<string, unknown> = {}) {
  return { runId, sequence, kind, payload };
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('auth', () => {
  it('authenticate() stores the bearer + CSRF tokens', async () => {
    const tokenStore = new MemoryTokenStore();
    const transport = fakeTransport({
      routes: {
        'POST /api/auth/token': () => ({
          status: 200,
          body: {
            token: 'jwt-1',
            csrfToken: 'csrf-1',
            expiresAt: '2099-01-01T00:00:00Z',
            user: { id: 'u1', email: 'a@b.co' },
            permissions: ['me:read'],
          },
        }),
      },
    });
    const client = createGeneweaveClient({ host: 'https://x', tokenStore, transport });
    const session = await client.authenticate('a@b.co', 'pw');
    expect(session.user.id).toBe('u1');
    expect(await tokenStore.get()).toEqual({ token: 'jwt-1', csrfToken: 'csrf-1' });
  });

  it('refreshes once on 401 then retries; persists the new token', async () => {
    const tokenStore = new MemoryTokenStore({ token: 'stale', csrfToken: 'c' });
    let attempt = 0;
    const transport = fakeTransport({
      routes: {
        'GET /api/auth/me': () => {
          attempt++;
          if (attempt === 1) return { status: 401, body: { error: 'expired' } };
          return { status: 200, body: { user: { id: 'u9', email: 'z@z.co' } } };
        },
      },
    });
    // Default http transport handles refresh, but with an injected transport we
    // model refresh at the client by routing the 401 there. Here we exercise the
    // *default* transport's refresh instead:
    const refresh = vi.fn(async () => ({ token: 'fresh', csrfToken: 'c2' }));
    const client = createGeneweaveClient({
      host: 'https://x',
      tokenStore,
      refresh,
      // Use the default http transport with an injected fetch that returns 401 then 200.
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        const auth = (init?.headers as Record<string, string>)?.['Authorization'];
        if (auth === 'Bearer fresh') {
          return new Response(JSON.stringify({ user: { id: 'u9', email: 'z@z.co' } }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: 'expired' }), { status: 401 });
      }) as unknown as typeof fetch,
    });
    void transport; // not used in this case
    const user = await client.getCurrentUser();
    expect(user.id).toBe('u9');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await tokenStore.get()).toEqual({ token: 'fresh', csrfToken: 'c2' });
  });

  it('throws AuthExpiredError when refresh is absent and the call is 401', async () => {
    const tokenStore = new MemoryTokenStore({ token: 'stale', csrfToken: 'c' });
    const client = createGeneweaveClient({
      host: 'https://x',
      tokenStore,
      fetchImpl: (async () => new Response(JSON.stringify({ error: 'expired' }), { status: 401 })) as unknown as typeof fetch,
    });
    await expect(client.getCurrentUser()).rejects.toBeInstanceOf(AuthExpiredError);
  });
});

// ---------------------------------------------------------------------------
// Runs: start → stream → terminal, and zero-gap resume
// ---------------------------------------------------------------------------

describe('runs', () => {
  it('startRun posts an Idempotency-Key header', async () => {
    const transport = fakeTransport({
      routes: {
        'POST /api/me/runs': (req) => {
          expect(req.idempotencyKey).toBe('idem-1');
          expect(req.csrf).toBe(true);
          return { status: 201, body: { id: 'r1', user_id: 'u1', status: 'running' } };
        },
      },
    });
    const client = createGeneweaveClient({ host: 'https://x', tokenStore: new MemoryTokenStore(), transport });
    const run = await client.startRun({ idempotencyKey: 'idem-1', surface: 'mobile' });
    expect(run.id).toBe('r1');
    expect(run.status).toBe('running');
  });

  it('listRuns unwraps the { runs } envelope into a bare array', async () => {
    const transport = fakeTransport({
      routes: {
        'GET /api/me/runs': () => ({ status: 200, body: { runs: [{ id: 'r1', user_id: 'u1', status: 'completed' }] } }),
      },
    });
    const client = createGeneweaveClient({ host: 'https://x', tokenStore: new MemoryTokenStore(), transport });
    const runs = await client.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe('r1');
  });

  it('getRun returns null on 404', async () => {
    const transport = fakeTransport({ routes: {} });
    const client = createGeneweaveClient({ host: 'https://x', tokenStore: new MemoryTokenStore(), transport });
    expect(await client.getRun('missing')).toBeNull();
  });

  it('attachRun reduces a stream to a terminal view model', async () => {
    const transport = fakeTransport({
      routes: {},
      streamBatches: [
        [
          ev('r1', 0, 'run.started'),
          ev('r1', 1, 'text.delta', { text: 'Hello ' }),
          ev('r1', 2, 'text.delta', { text: 'world' }),
          ev('r1', 3, 'run.completed'),
        ],
      ],
    });
    const client = createGeneweaveClient({ host: 'https://x', tokenStore: new MemoryTokenStore(), transport });
    const seqs: number[] = [];
    const done = new Promise<unknown>((resolve) => {
      client.attachRun('r1', {
        onEvent: (e) => seqs.push(e.sequence),
        onComplete: (vm) => resolve(vm),
      });
    });
    const vm = (await done) as { status: string; items: Array<{ type: string }> };
    expect(seqs).toEqual([0, 1, 2, 3]);
    expect(vm.status).toBe('completed');
  });

  it('resumes after a dropped stream with zero gap and dedupes', async () => {
    // First batch drops after seq 1 (no terminal). Second batch resumes from
    // seq 1 (server replays), and the client must skip the duplicate seq 1.
    const opened: string[] = [];
    const transport: GeneweaveTransport = {
      async request() {
        return { status: 200, body: {} };
      },
      openStream(input, handlers) {
        opened.push(input.path);
        const n = opened.length;
        queueMicrotask(() => {
          if (n === 1) {
            handlers.onEvent(ev('r1', 0, 'run.started'));
            handlers.onEvent(ev('r1', 1, 'text.delta', { text: 'A' }));
            handlers.onClose?.(); // dropped, no terminal
          } else {
            handlers.onEvent(ev('r1', 1, 'text.delta', { text: 'A' })); // duplicate replay
            handlers.onEvent(ev('r1', 2, 'text.delta', { text: 'B' }));
            handlers.onEvent(ev('r1', 3, 'run.completed'));
            handlers.onClose?.();
          }
        });
      },
    };
    const client = createGeneweaveClient({ host: 'https://x', tokenStore: new MemoryTokenStore(), transport });
    const seqs: number[] = [];
    const done = new Promise<void>((resolve) => {
      client.attachRun('r1', {
        maxReconnects: 3,
        onEvent: (e) => seqs.push(e.sequence),
        onComplete: () => resolve(),
      });
    });
    await done;
    // Each sequence appears exactly once despite the replayed duplicate.
    expect(seqs).toEqual([0, 1, 2, 3]);
    // Second open resumes after the last seen sequence (1), not from the start.
    expect(opened[0]).toContain('after=-1');
    expect(opened[1]).toContain('after=1');
  });
});

// ---------------------------------------------------------------------------
// Tasks: idempotent complete
// ---------------------------------------------------------------------------

describe('tasks', () => {
  it('resolveNotificationAction reports alreadyResolved idempotently', async () => {
    let calls = 0;
    const transport = fakeTransport({
      routes: {
        'POST /api/me/notifications/actions': () => {
          calls++;
          return calls === 1
            ? { status: 200, body: { resolved: true, status: 'completed' } }
            : { status: 200, body: { alreadyResolved: true, status: 'completed' } };
        },
      },
    });
    const client = createGeneweaveClient({ host: 'https://x', tokenStore: new MemoryTokenStore(), transport });
    const first = await client.resolveNotificationAction({ taskId: 't1', actionId: 'approve' });
    const second = await client.resolveNotificationAction({ taskId: 't1', actionId: 'approve' });
    expect(first.resolved).toBe(true);
    expect(second.alreadyResolved).toBe(true);
    expect(second.status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// Theme: per-tenant design tokens
// ---------------------------------------------------------------------------

describe('theme', () => {
  it('getTenantTheme unwraps { theme } into the token object', async () => {
    const transport = fakeTransport({
      routes: {
        'GET /api/me/theme': () => ({
          status: 200,
          body: { theme: { colors: { accent: '#1FB6A5' }, radii: { md: 12 } } },
        }),
      },
    });
    const client = createGeneweaveClient({ host: 'https://x', tokenStore: new MemoryTokenStore(), transport });
    const theme = await client.getTenantTheme();
    expect(theme).toEqual({ colors: { accent: '#1FB6A5' }, radii: { md: 12 } });
  });

  it('getTenantTheme returns null when no override is configured', async () => {
    const transport = fakeTransport({
      routes: { 'GET /api/me/theme': () => ({ status: 200, body: { theme: null } }) },
    });
    const client = createGeneweaveClient({ host: 'https://x', tokenStore: new MemoryTokenStore(), transport });
    expect(await client.getTenantTheme()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Memories: CRUD + managed-by-org
// ---------------------------------------------------------------------------

describe('memories', () => {
  it('creates and lists memories', async () => {
    const transport = fakeTransport({
      routes: {
        'POST /api/me/memories': () => ({ status: 201, body: { id: 'm1', content: 'note', kind: 'user-authored' } }),
        'GET /api/me/memories': () => ({
          status: 200,
          body: {
            memories: {
              semantic: [],
              entity: [],
              'user-authored': [{ id: 'm1', content: 'note', kind: 'user-authored' }],
            },
            counts: { 'user-authored': 1 },
          },
        }),
      },
    });
    const client = createGeneweaveClient({ host: 'https://x', tokenStore: new MemoryTokenStore(), transport });
    const created = await client.createMemory({ content: 'note' });
    expect(created.id).toBe('m1');
    const all = await client.listMemories();
    expect(all.memories['user-authored']).toHaveLength(1);
  });

  it('throws ManagedByOrgError on a 403 managedByOrg write', async () => {
    const transport = fakeTransport({
      routes: {
        'POST /api/me/memories': () => ({ status: 403, body: { managedByOrg: true, error: 'read-only' } }),
      },
    });
    const client = createGeneweaveClient({ host: 'https://x', tokenStore: new MemoryTokenStore(), transport });
    await expect(client.createMemory({ content: 'x' })).rejects.toBeInstanceOf(ManagedByOrgError);
  });
});

// ---------------------------------------------------------------------------
// Response-shape validation
// ---------------------------------------------------------------------------

describe('response validation', () => {
  it('throws ResponseShapeError when the body violates the contract', async () => {
    const transport = fakeTransport({
      routes: {
        'GET /api/me/runs': () => ({ status: 200, body: { runs: [{ id: 'r1' /* missing status */ }] } }),
      },
    });
    const client = createGeneweaveClient({ host: 'https://x', tokenStore: new MemoryTokenStore(), transport });
    await expect(client.listRuns()).rejects.toBeInstanceOf(ResponseShapeError);
  });
});

// ---------------------------------------------------------------------------
// Per-tenant isolation
// ---------------------------------------------------------------------------

describe('per-tenant isolation', () => {
  it('namespaces outbox storage so two tenants never collide on one device', async () => {
    const sharedStorage = new MemoryStorage();
    const transport = fakeTransport({ routes: {} });
    const tenantA = createGeneweaveClient({
      host: 'https://x',
      tokenStore: new MemoryTokenStore(),
      transport,
      outboxStorage: sharedStorage,
      namespace: 'tenant-a',
    });
    const tenantB = createGeneweaveClient({
      host: 'https://x',
      tokenStore: new MemoryTokenStore(),
      transport,
      outboxStorage: sharedStorage,
      namespace: 'tenant-b',
    });
    await tenantA.enqueueRun({ idempotencyKey: 'a-1', surface: 'mobile' });
    await tenantB.enqueueRun({ idempotencyKey: 'b-1', surface: 'mobile' });

    const aPending = await tenantA.outbox.pending();
    const bPending = await tenantB.outbox.pending();
    expect(aPending).toHaveLength(1);
    expect(bPending).toHaveLength(1);
    expect(aPending[0]!.input.idempotencyKey).toBe('a-1');
    expect(bPending[0]!.input.idempotencyKey).toBe('b-1');
    // Raw storage holds both tenants' keys, each under its own namespace prefix.
    const rawKeys = sharedStorage.keys();
    expect(rawKeys.some((k) => k.startsWith('tenant-a::'))).toBe(true);
    expect(rawKeys.some((k) => k.startsWith('tenant-b::'))).toBe(true);
  });
});
