/**
 * Phase 2 — `weaveRuntime` unit tests.
 *
 * Proves the four invariants the doc commits to:
 *   1. Zero-arg construction yields a working runtime with all baseline
 *      capabilities (egress, observability, secrets, audit).
 *   2. Optional slots (persistence, resilience) are advertised via
 *      `has(...)` only when configured.
 *   3. `require(...)` throws with a single readable message naming every
 *      missing capability.
 *   4. A runtime propagates to `weaveContext` and `weaveChildContext` and
 *      its tracer becomes the context's default tracer when none was
 *      supplied explicitly.
 */

import { describe, it, expect } from 'vitest';
import {
  RuntimeCapabilities,
  assertRuntimeRequires,
  weaveInMemoryPersistence,
  weaveRuntime,
} from './runtime.js';
import { createExecutionContext as weaveContext, childContext as weaveChildContext } from './context.js';

describe('weaveRuntime — defaults & baseline capabilities', () => {
  it('zero-arg construction advertises baseline capabilities', () => {
    const rt = weaveRuntime({ installDefaultTracer: false });
    expect(rt.has(RuntimeCapabilities.NetEgress)).toBe(true);
    expect(rt.has(RuntimeCapabilities.Observability)).toBe(true);
    expect(rt.has(RuntimeCapabilities.Secrets)).toBe(true);
    expect(rt.has(RuntimeCapabilities.Audit)).toBe(true);
    // Optional slots not configured → not advertised
    expect(rt.has(RuntimeCapabilities.Persistence)).toBe(false);
    expect(rt.has(RuntimeCapabilities.Resilience)).toBe(false);
  });

  it('exposes a hardened egress with createFetch factory', () => {
    const rt = weaveRuntime({ installDefaultTracer: false });
    expect(typeof rt.egress.fetch).toBe('function');
    expect(typeof rt.egress.createFetch).toBe('function');
    const bound = rt.egress.createFetch({ errorTag: 'unit-test' });
    expect(typeof bound.fetch).toBe('function');
    expect(typeof bound.fetchStream).toBe('function');
  });

  it('persistence and resilience slots flip on when configured', () => {
    const rt = weaveRuntime({
      installDefaultTracer: false,
      persistence: weaveInMemoryPersistence(),
      resilience: { emit() { /* noop */ } },
    });
    expect(rt.has(RuntimeCapabilities.Persistence)).toBe(true);
    expect(rt.has(RuntimeCapabilities.Resilience)).toBe(true);
    expect(rt.persistence?.kind).toBe('in-memory');
  });

  it('extraCapabilities are merged into the runtime capability set', () => {
    const rt = weaveRuntime({
      installDefaultTracer: false,
      extraCapabilities: [RuntimeCapabilities.Encryption],
    });
    expect(rt.has(RuntimeCapabilities.Encryption)).toBe(true);
  });
});

describe('weaveRuntime.require — capability assertions', () => {
  it('require() returns silently when all caps present', () => {
    const rt = weaveRuntime({ installDefaultTracer: false });
    expect(() => rt.require(RuntimeCapabilities.NetEgress, RuntimeCapabilities.Secrets)).not.toThrow();
  });

  it('require() throws naming every missing capability in one message', () => {
    const rt = weaveRuntime({ installDefaultTracer: false });
    expect(() => rt.require(RuntimeCapabilities.Persistence, RuntimeCapabilities.Resilience))
      .toThrow(/missing required capability\(ies\): runtime\.persistence, runtime\.resilience/);
  });

  it('assertRuntimeRequires() prefixes the feature name and accepts plain strings', () => {
    const rt = weaveRuntime({ installDefaultTracer: false });
    expect(() => assertRuntimeRequires(rt, ['runtime.persistence'], 'tool:dlq-writer'))
      .toThrow(/tool:dlq-writer: runtime does not satisfy.*runtime\.persistence/);
  });

  it('assertRuntimeRequires() returns the runtime on success for chaining', () => {
    const rt = weaveRuntime({ installDefaultTracer: false });
    const out = assertRuntimeRequires(rt, ['runtime.net.egress', 'runtime.audit']);
    expect(out).toBe(rt);
  });
});

describe('weaveRuntime — propagation through ExecutionContext', () => {
  it('weaveContext({ runtime }) carries the runtime and adopts its tracer', () => {
    const rt = weaveRuntime({ installDefaultTracer: false });
    const ctx = weaveContext({ runtime: rt });
    expect(ctx.runtime).toBe(rt);
    expect(ctx.tracer).toBe(rt.tracer);
  });

  it('explicit tracer override wins over runtime tracer', () => {
    const rt = weaveRuntime({ installDefaultTracer: false });
    const override = rt.tracer; // any Tracer instance; reuse for identity check
    const ctx = weaveContext({ runtime: rt, tracer: override });
    expect(ctx.tracer).toBe(override);
  });

  it('weaveChildContext inherits the runtime by default', () => {
    const rt = weaveRuntime({ installDefaultTracer: false });
    const parent = weaveContext({ runtime: rt });
    const child = weaveChildContext(parent, {});
    expect(child.runtime).toBe(rt);
  });
});

describe('weaveRuntime — secrets default to env resolver', () => {
  it('resolves a key present in process.env', async () => {
    process.env['WEAVE_TEST_KEY_XYZ'] = 'value-123';
    try {
      const rt = weaveRuntime({ installDefaultTracer: false });
      await expect(rt.secrets.resolve('WEAVE_TEST_KEY_XYZ')).resolves.toBe('value-123');
    } finally {
      delete process.env['WEAVE_TEST_KEY_XYZ'];
    }
  });

  it('returns undefined for unknown keys', async () => {
    const rt = weaveRuntime({ installDefaultTracer: false });
    await expect(rt.secrets.resolve('DEFINITELY_NOT_SET_FOR_TEST')).resolves.toBeUndefined();
  });
});

describe('Phase 3 — guardrails slot + ambient audit helpers', () => {
  it('advertises Guardrails capability only when slot provided', () => {
    const without = weaveRuntime({ installDefaultTracer: false });
    expect(without.has(RuntimeCapabilities.Guardrails)).toBe(false);
    const withGuard = weaveRuntime({
      installDefaultTracer: false,
      guardrails: { async checkToolCall() { return { allow: true }; } },
    });
    expect(withGuard.has(RuntimeCapabilities.Guardrails)).toBe(true);
    expect(withGuard.guardrails).toBeDefined();
  });

  it('weaveAudit records an entry through runtime.audit', async () => {
    const { weaveAudit } = await import('./runtime.js');
    const entries: unknown[] = [];
    const rt = weaveRuntime({
      installDefaultTracer: false,
      audit: { async log(e) { entries.push(e); } },
    });
    const ctx = weaveContext({ runtime: rt });
    await weaveAudit(ctx, { action: 'test.action', outcome: 'success', resource: 'r' });
    expect(entries).toHaveLength(1);
    expect((entries[0] as { action: string }).action).toBe('test.action');
  });

  it('weaveAudit is a no-op when no runtime is attached', async () => {
    const { weaveAudit } = await import('./runtime.js');
    const ctx = weaveContext();
    await expect(weaveAudit(ctx, { action: 'noop', outcome: 'success' })).resolves.toBeUndefined();
  });

  it('weaveAudit swallows logger errors (best-effort)', async () => {
    const { weaveAudit } = await import('./runtime.js');
    const rt = weaveRuntime({
      installDefaultTracer: false,
      audit: { async log() { throw new Error('boom'); } },
    });
    const ctx = weaveContext({ runtime: rt });
    await expect(weaveAudit(ctx, { action: 'x', outcome: 'success' })).resolves.toBeUndefined();
  });

  it('weaveLogSafetyDowngrade emits structured downgrade entry', async () => {
    const { weaveLogSafetyDowngrade } = await import('./runtime.js');
    const entries: { action: string; resource?: string; details?: Record<string, unknown> }[] = [];
    const rt = weaveRuntime({
      installDefaultTracer: false,
      audit: { async log(e) { entries.push(e as never); } },
    });
    const ctx = weaveContext({ runtime: rt });
    await weaveLogSafetyDowngrade(ctx, { feature: 'tracer', reason: 'opted-out', component: 'demo' });
    expect(entries[0]?.action).toBe('runtime.safety.downgrade');
    expect(entries[0]?.resource).toBe('tracer');
    expect(entries[0]?.details).toMatchObject({ reason: 'opted-out', component: 'demo' });
  });
});

describe('Phase 5 — RuntimeMemorySlot + Memory capability', () => {
  function makeMemorySlot() {
    const recalled: string[] = [];
    const stored: string[] = [];
    return {
      slot: {
        semantic: {
          async store(_ctx: import('./context.js').ExecutionContext, content: string) { stored.push(content); },
          async recall(_ctx: import('./context.js').ExecutionContext, query: string) { recalled.push(query); return []; },
        },
        working: {
          async patch() { return { id: 'wm-1', agentId: 'a', content: {}, createdAt: new Date().toISOString() }; },
          async checkpoint() { return { id: 'wm-1', agentId: 'a', content: {}, createdAt: new Date().toISOString() }; },
          async restore() { return null; },
          async getCurrent() { return null; },
        },
        store: {
          async write() { /* noop */ },
          async query() { return []; },
          async delete() { /* noop */ },
          async clear() { /* noop */ },
        },
        async consolidate() { /* noop */ },
      } satisfies import('./runtime.js').RuntimeMemorySlot,
      recalled,
      stored,
    };
  }

  it('Memory capability is NOT advertised without a slot', () => {
    const rt = weaveRuntime({ installDefaultTracer: false });
    expect(rt.has(RuntimeCapabilities.Memory)).toBe(false);
    expect(rt.memory).toBeUndefined();
  });

  it('Memory capability IS advertised when a slot is provided', () => {
    const { slot } = makeMemorySlot();
    const rt = weaveRuntime({ installDefaultTracer: false, memory: slot });
    expect(rt.has(RuntimeCapabilities.Memory)).toBe(true);
    expect(rt.memory).toBe(slot);
  });

  it('runtime.memory exposes semantic.store and semantic.recall', async () => {
    const { slot, stored, recalled } = makeMemorySlot();
    const rt = weaveRuntime({ installDefaultTracer: false, memory: slot });
    const ctx = weaveContext({ runtime: rt });
    await rt.memory!.semantic.store(ctx, 'hello world');
    expect(stored).toContain('hello world');
    await rt.memory!.semantic.recall(ctx, 'test query');
    expect(recalled).toContain('test query');
  });

  it('runtime.memory.consolidate is a no-op when no consolidate fn was given', async () => {
    const { slot } = makeMemorySlot();
    const rt = weaveRuntime({ installDefaultTracer: false, memory: slot });
    await expect(rt.memory!.consolidate('user-123')).resolves.toBeUndefined();
  });

  it('require(Memory) throws when slot is absent', () => {
    const rt = weaveRuntime({ installDefaultTracer: false });
    expect(() => rt.require(RuntimeCapabilities.Memory))
      .toThrow(/runtime\.memory/);
  });
});

// ─── Phase 6 — Compliance + Identity capability detection ─────────────────────

function makeComplianceSlot(): import('./runtime.js').RuntimeComplianceSlot {
  return {
    consent: {
      async isGranted() { return false; },
      async grant() { return {}; },
      async revoke() { return false; },
      async listBySubject() { return []; },
    },
    residency: {
      async isAllowed() { return true; },
      async getAllowedRegions() { return []; },
    },
    deletion: {
      async create() { return { id: 'del-1', status: 'pending' }; },
      async process() { return {}; },
      async complete() { return {}; },
      async fail() { return {}; },
    },
    auditExport: {
      async create() { return { id: 'exp-1', status: 'pending', format: 'json' }; },
      async markReady() { return {}; },
      async markFailed() { return {}; },
    },
    async isAllowed() { return true; },
    async canProcess() { return true; },
    async requestErasure() { return { id: 'del-2', status: 'pending', dataCategories: ['all'] }; },
    async requestExport() { return { id: 'exp-2', status: 'pending', format: 'json' }; },
  };
}

function makeIdentitySlot(): import('./runtime.js').RuntimeIdentitySlot {
  return {
    resolve(userId) {
      return { identity: { type: 'user', id: userId, roles: [], scopes: [], metadata: {} }, effectivePermissions: [], sessionId: undefined, delegatedFrom: undefined };
    },
    evaluate() { return { result: 'deny', permission: { resource: 'x', action: 'y' }, identity: { type: 'user', id: 'u', roles: [], scopes: [], metadata: {} }, evaluatedAt: new Date().toISOString() }; },
    validateDelegation() { return { valid: true }; },
  };
}

describe('weaveRuntime — Phase 6 Compliance slot', () => {
  it('Compliance capability is NOT advertised when slot is omitted', () => {
    const rt = weaveRuntime({ installDefaultTracer: false });
    expect(rt.has(RuntimeCapabilities.Compliance)).toBe(false);
  });

  it('Compliance capability IS advertised when slot is provided', () => {
    const slot = makeComplianceSlot();
    const rt = weaveRuntime({ installDefaultTracer: false, compliance: slot });
    expect(rt.has(RuntimeCapabilities.Compliance)).toBe(true);
    expect(rt.compliance).toBe(slot);
  });

  it('compliance slot convenience methods are callable', async () => {
    const slot = makeComplianceSlot();
    const rt = weaveRuntime({ installDefaultTracer: false, compliance: slot });
    await expect(rt.compliance!.isAllowed('u', 'analytics')).resolves.toBe(true);
    await expect(rt.compliance!.canProcess('t', 'pii', 'eu')).resolves.toBe(true);
  });

  it('require(Compliance) throws when slot is absent', () => {
    const rt = weaveRuntime({ installDefaultTracer: false });
    expect(() => rt.require(RuntimeCapabilities.Compliance))
      .toThrow(/runtime\.compliance/);
  });
});

describe('weaveRuntime — Phase 6 Identity slot', () => {
  it('Identity capability is NOT advertised when slot is omitted', () => {
    const rt = weaveRuntime({ installDefaultTracer: false });
    expect(rt.has(RuntimeCapabilities.Identity)).toBe(false);
  });

  it('Identity capability IS advertised when slot is provided', () => {
    const slot = makeIdentitySlot();
    const rt = weaveRuntime({ installDefaultTracer: false, identity: slot });
    expect(rt.has(RuntimeCapabilities.Identity)).toBe(true);
    expect(rt.identity).toBe(slot);
  });

  it('identity.resolve returns a context with the supplied userId', () => {
    const slot = makeIdentitySlot();
    const rt = weaveRuntime({ installDefaultTracer: false, identity: slot });
    const ctx = rt.identity!.resolve('user-42', null);
    expect(ctx.identity.id).toBe('user-42');
  });

  it('require(Identity) throws when slot is absent', () => {
    const rt = weaveRuntime({ installDefaultTracer: false });
    expect(() => rt.require(RuntimeCapabilities.Identity))
      .toThrow(/runtime\.identity/);
  });
});

// ─── Phase 7 — Cache slot + supportsMultiModal ─────────────────────────────

function makeCacheSlot() {
  const map = new Map<string, unknown>();
  const store = {
    async get<T = unknown>(k: string): Promise<T | null> {
      const v = map.get(k);
      return (v === undefined ? null : v) as T | null;
    },
    async set<T = unknown>(k: string, v: T): Promise<void> { map.set(k, v as unknown); },
    async delete(k: string): Promise<void> { map.delete(k); },
    async has(k: string): Promise<boolean> { return map.has(k); },
    async clear(): Promise<void> { map.clear(); },
    async size(): Promise<number> { return map.size; },
  };
  return {
    async get(key: string): Promise<unknown> {
      const v = map.get(key);
      return v === undefined ? undefined : v;
    },
    async set(key: string, value: unknown): Promise<void> { map.set(key, value); },
    async invalidate(key: string): Promise<void> { map.delete(key); },
    store,
  };
}

describe('weaveRuntime — Phase 7 Cache slot', () => {
  it('Cache capability is NOT advertised when slot is omitted', () => {
    const rt = weaveRuntime({ installDefaultTracer: false });
    expect(rt.has(RuntimeCapabilities.Cache)).toBe(false);
  });

  it('Cache capability IS advertised when slot is provided', () => {
    const rt = weaveRuntime({ installDefaultTracer: false, cache: makeCacheSlot() });
    expect(rt.has(RuntimeCapabilities.Cache)).toBe(true);
  });

  it('runtime.cache is undefined when slot is omitted', () => {
    const rt = weaveRuntime({ installDefaultTracer: false });
    expect(rt.cache).toBeUndefined();
  });

  it('runtime.cache exposes get/set/invalidate', async () => {
    const slot = makeCacheSlot();
    const rt = weaveRuntime({ installDefaultTracer: false, cache: slot });
    await rt.cache!.set('hello', 42);
    expect(await rt.cache!.get('hello')).toBe(42);
    await rt.cache!.invalidate('hello');
    expect(await rt.cache!.get('hello')).toBeUndefined();
  });

  it('runtime.cache.store references the raw store', () => {
    const slot = makeCacheSlot();
    const rt = weaveRuntime({ installDefaultTracer: false, cache: slot });
    expect(rt.cache!.store).toBe(slot.store);
  });

  it('require(Cache) throws when slot is absent', () => {
    const rt = weaveRuntime({ installDefaultTracer: false });
    expect(() => rt.require(RuntimeCapabilities.Cache))
      .toThrow(/runtime\.cache/);
  });
});

describe('weaveRuntime — Phase 7 supportsMultiModal on routing slot', () => {
  it('supportsMultiModal() returns false by default on routing slot', () => {
    const routingSlot = {
      recordOutcome: () => {},
      blockProvider: () => {},
      listHealth: () => [],
      getBlockedProviders: () => new Set<string>(),
      // No supportsMultiModal
    };
    const rt = weaveRuntime({ installDefaultTracer: false, routing: routingSlot });
    expect(rt.routing?.supportsMultiModal?.()).toBeUndefined();
  });

  it('supportsMultiModal() returns what the slot provides', () => {
    const routingSlot = {
      recordOutcome: () => {},
      blockProvider: () => {},
      listHealth: () => [],
      getBlockedProviders: () => new Set<string>(),
      supportsMultiModal: () => true,
    };
    const rt = weaveRuntime({ installDefaultTracer: false, routing: routingSlot });
    expect(rt.routing?.supportsMultiModal?.()).toBe(true);
  });
});
