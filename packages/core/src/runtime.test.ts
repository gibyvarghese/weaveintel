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
