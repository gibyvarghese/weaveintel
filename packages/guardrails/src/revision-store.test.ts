/**
 * @weaveintel/guardrails — revision-store.test.ts  (W7)
 */
import { describe, it, expect } from 'vitest';
import type { Guardrail } from '@weaveintel/core';
import { weaveContext, weaveRuntime } from '@weaveintel/core';
import { createRevisionStore, trackGuardrailChange } from './revision-store.js';

const guardrail = (id = 'g1'): Guardrail => ({
  id,
  name: 'Test guardrail',
  type: 'blocklist',
  stage: 'pre-execution',
  enabled: true,
  config: { words: ['test'] },
});

describe('InMemoryRevisionStore', () => {
  it('records and lists revisions for a guardrail', async () => {
    const store = createRevisionStore();
    await store.record({
      id: 'rev-1',
      guardrailId: 'g1',
      version: 1,
      snapshot: guardrail(),
      actor: 'admin',
      reason: 'Initial creation',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    const history = await store.list('g1');
    expect(history).toHaveLength(1);
    expect(history[0]?.version).toBe(1);
  });

  it('returns empty list for unknown guardrail', async () => {
    const store = createRevisionStore();
    expect(await store.list('nonexistent')).toHaveLength(0);
  });

  it('atTime returns the latest revision at or before the timestamp', async () => {
    const store = createRevisionStore();
    await store.record({ id: 'r1', guardrailId: 'g2', version: 1, snapshot: guardrail('g2'), actor: 'a', reason: 'v1', timestamp: '2026-01-01T00:00:00.000Z' });
    await store.record({ id: 'r2', guardrailId: 'g2', version: 2, snapshot: guardrail('g2'), actor: 'a', reason: 'v2', timestamp: '2026-03-01T00:00:00.000Z' });

    const rev = await store.atTime('g2', '2026-02-01T00:00:00.000Z');
    expect(rev?.version).toBe(1);

    const latest = await store.atTime('g2', '2026-12-01T00:00:00.000Z');
    expect(latest?.version).toBe(2);
  });

  it('returns undefined when no revision exists before the timestamp', async () => {
    const store = createRevisionStore();
    await store.record({ id: 'r1', guardrailId: 'g3', version: 1, snapshot: guardrail('g3'), actor: 'a', reason: 'v1', timestamp: '2026-06-01T00:00:00.000Z' });
    const rev = await store.atTime('g3', '2026-01-01T00:00:00.000Z');
    expect(rev).toBeUndefined();
  });
});

describe('trackGuardrailChange', () => {
  it('creates a revision with auto-incremented version', async () => {
    const store = createRevisionStore();
    const ctx = weaveContext({ runtime: weaveRuntime() });
    const snap = guardrail('g4');

    const rev1 = await trackGuardrailChange(store, ctx, { guardrailId: 'g4', actor: 'admin', reason: 'Created', snapshot: snap });
    expect(rev1.version).toBe(1);

    const rev2 = await trackGuardrailChange(store, ctx, { guardrailId: 'g4', actor: 'admin', reason: 'Updated', snapshot: snap, before: snap });
    expect(rev2.version).toBe(2);
  });

  it('stores the before snapshot for diff purposes', async () => {
    const store = createRevisionStore();
    const ctx = weaveContext({ runtime: weaveRuntime() });
    const before = guardrail('g5');
    const after = { ...guardrail('g5'), name: 'Updated name' };

    const rev = await trackGuardrailChange(store, ctx, { guardrailId: 'g5', actor: 'editor', reason: 'Rename', snapshot: after, before });
    expect(rev.before?.name).toBe('Test guardrail');
    expect(rev.snapshot.name).toBe('Updated name');
  });

  it('lists the revision after tracking', async () => {
    const store = createRevisionStore();
    const ctx = weaveContext({ runtime: weaveRuntime() });
    await trackGuardrailChange(store, ctx, { guardrailId: 'g6', actor: 'admin', reason: 'Test', snapshot: guardrail('g6') });
    const history = await store.list('g6');
    expect(history).toHaveLength(1);
  });
});
