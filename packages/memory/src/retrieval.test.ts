/**
 * Phase 5 — `fusedMemorySearch` unit tests.
 *
 * Uses an in-memory `MemoryStore` stub to verify the scoring, deduplication,
 * and normalisation logic without any real backend.
 */

import { describe, it, expect } from 'vitest';
import { fusedMemorySearch, recencyDecay } from './retrieval.js';
import type { MemoryEntry, MemoryStore, ExecutionContext } from '@weaveintel/core';

function makeCtx(userId?: string): ExecutionContext {
  return { executionId: 'test', metadata: {}, ...(userId ? { userId } : {}) };
}

function makeEntry(overrides: Partial<MemoryEntry> & { id: string; content: string; type: MemoryEntry['type'] }): MemoryEntry {
  return {
    metadata: {},
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Build a simple in-memory MemoryStore that returns pre-set results per type. */
function makeStore(entries: MemoryEntry[]): MemoryStore {
  return {
    async write() { /* noop */ },
    async query(_ctx, opts) {
      let results = [...entries];
      if (opts.type) results = results.filter((e) => e.type === opts.type);
      if (opts.filter?.types) results = results.filter((e) => opts.filter!.types!.includes(e.type));
      if (opts.filter?.userId) results = results.filter((e) => e.userId === opts.filter!.userId);
      if (opts.query) {
        const q = opts.query.toLowerCase();
        results = results.filter((e) => e.content.toLowerCase().includes(q));
      }
      return results.slice(0, opts.topK ?? 10);
    },
    async delete() { /* noop */ },
    async clear() { /* noop */ },
  };
}

describe('fusedMemorySearch — empty store', () => {
  it('returns an empty array when the store has no entries', async () => {
    const store = makeStore([]);
    const ctx = makeCtx();
    const results = await fusedMemorySearch(store, ctx, { query: 'anything' });
    expect(results).toHaveLength(0);
  });
});

describe('fusedMemorySearch — keyword signal', () => {
  it('returns entries that match query keywords', async () => {
    const store = makeStore([
      makeEntry({ id: '1', type: 'semantic', content: 'Alice lives in Paris' }),
      makeEntry({ id: '2', type: 'semantic', content: 'Bob works in London' }),
      makeEntry({ id: '3', type: 'episodic', content: 'User mentioned Paris trip' }),
    ]);
    const ctx = makeCtx();
    const results = await fusedMemorySearch(store, ctx, { query: 'Paris', topK: 5 });
    const ids = results.map((r) => r.entry.id);
    expect(ids).toContain('1');
    expect(ids).toContain('3');
  });

  it('each result has a score > 0 when it matches', async () => {
    const store = makeStore([
      makeEntry({ id: 'a', type: 'semantic', content: 'machine learning research paper' }),
    ]);
    const ctx = makeCtx();
    const results = await fusedMemorySearch(store, ctx, { query: 'machine learning' });
    expect(results[0]?.score).toBeGreaterThan(0);
  });
});

describe('fusedMemorySearch — entity signal', () => {
  it('boosts entity entries whose name tokens match the query', async () => {
    const store = makeStore([
      makeEntry({ id: 'e1', type: 'entity', content: 'Alice', metadata: { entityType: 'person' } }),
      makeEntry({ id: 'e2', type: 'entity', content: 'Bob', metadata: { entityType: 'person' } }),
      makeEntry({ id: 's1', type: 'semantic', content: 'general fact' }),
    ]);
    const ctx = makeCtx();
    const results = await fusedMemorySearch(store, ctx, { query: 'Alice', topK: 5 });
    const e1 = results.find((r) => r.entry.id === 'e1');
    expect(e1).toBeDefined();
    expect(e1?.signals.entity).toBeGreaterThan(0);
  });
});

describe('fusedMemorySearch — deduplication', () => {
  it('does not return duplicate entries when semantic and keyword queries return overlapping ids', async () => {
    const entry = makeEntry({ id: 'dup', type: 'semantic', content: 'Paris is beautiful' });
    const store = makeStore([entry]);
    const ctx = makeCtx();
    const results = await fusedMemorySearch(store, ctx, { query: 'Paris', topK: 10 });
    const ids = results.map((r) => r.entry.id);
    expect(ids.filter((id) => id === 'dup')).toHaveLength(1);
  });
});

describe('fusedMemorySearch — topK capping', () => {
  it('respects the topK limit', async () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      makeEntry({ id: `s${i}`, type: 'semantic', content: `fact about topic ${i} something` }),
    );
    const store = makeStore(many);
    const ctx = makeCtx();
    const results = await fusedMemorySearch(store, ctx, { query: 'topic', topK: 3 });
    expect(results).toHaveLength(3);
  });
});

describe('fusedMemorySearch — userId scoping', () => {
  it('returns only entries matching the userId in the filter', async () => {
    const store = makeStore([
      makeEntry({ id: 'u1-a', type: 'semantic', content: 'alice fact', userId: 'user-1' }),
      makeEntry({ id: 'u2-b', type: 'semantic', content: 'bob fact', userId: 'user-2' }),
    ]);
    const ctx = makeCtx('user-1');
    const results = await fusedMemorySearch(store, ctx, {
      query: 'fact',
      topK: 5,
      userId: 'user-1',
    });
    const ids = results.map((r) => r.entry.id);
    expect(ids).toContain('u1-a');
    expect(ids).not.toContain('u2-b');
  });
});

describe('fusedMemorySearch — store errors are swallowed', () => {
  it('returns an empty array when the store throws', async () => {
    const errorStore: MemoryStore = {
      async write() { /* noop */ },
      async query() { throw new Error('DB offline'); },
      async delete() { /* noop */ },
      async clear() { /* noop */ },
    };
    const ctx = makeCtx();
    const results = await fusedMemorySearch(errorStore, ctx, { query: 'anything' });
    expect(results).toHaveLength(0);
  });
});

describe('fusedMemorySearch — scores are normalised [0, 1]', () => {
  it('every returned score is between 0 and 1 inclusive', async () => {
    const store = makeStore([
      makeEntry({ id: '1', type: 'semantic', content: 'cats are great pets to own' }),
      makeEntry({ id: '2', type: 'semantic', content: 'dogs are loyal animals to keep' }),
      makeEntry({ id: '3', type: 'entity', content: 'cats', metadata: {} }),
    ]);
    const ctx = makeCtx();
    const results = await fusedMemorySearch(store, ctx, { query: 'cats', topK: 5 });
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1.0001); // floating point tolerance
    }
  });
});

// ─── Phase 5 (weaveNotes second brain): temporal recency + importance + supersede ───
describe('fusedMemorySearch — recency signal (temporal awareness)', () => {
  it('ranks a recent memory above an equally-relevant old one when recencyWeight is set', async () => {
    const NOW = Date.parse('2026-07-01T00:00:00Z');
    const store = makeStore([
      makeEntry({ id: 'old', type: 'semantic', content: 'The project deadline is important', createdAt: '2026-01-01T00:00:00Z' }),
      makeEntry({ id: 'new', type: 'semantic', content: 'The project deadline is important', createdAt: '2026-06-30T00:00:00Z' }),
    ]);
    const results = await fusedMemorySearch(store, makeCtx(), { query: 'project deadline', topK: 2, recencyWeight: 0.5, keywordWeight: 0.5, nowMs: NOW, halfLifeMs: 30 * 24 * 3600 * 1000 });
    expect(results[0]!.entry.id).toBe('new');
    expect(results[0]!.signals.recency).toBeGreaterThan(results[1]!.signals.recency ?? 0);
  });
  it('recencyDecay halves at one half-life', () => {
    const hl = 1000;
    expect(recencyDecay(0, hl)).toBeCloseTo(1, 5);
    expect(recencyDecay(hl, hl)).toBeCloseTo(0.5, 5);
    expect(recencyDecay(2 * hl, hl)).toBeCloseTo(0.25, 5);
  });
});

describe('fusedMemorySearch — importance signal', () => {
  it('ranks a high-importance memory above a low-importance one', async () => {
    const store = makeStore([
      makeEntry({ id: 'low', type: 'semantic', content: 'user likes coffee', importance: 0.1 }),
      makeEntry({ id: 'high', type: 'semantic', content: 'user likes coffee', importance: 0.95 }),
    ]);
    const results = await fusedMemorySearch(store, makeCtx(), { query: 'coffee', topK: 2, importanceWeight: 0.6, keywordWeight: 0.4 });
    expect(results[0]!.entry.id).toBe('high');
    expect(results[0]!.signals.importance).toBeGreaterThan(results[1]!.signals.importance ?? 0);
  });
  it('reads importance from metadata when the field is absent', async () => {
    const store = makeStore([makeEntry({ id: 'm', type: 'semantic', content: 'a fact about launch', metadata: { importance: 0.8 } })]);
    const results = await fusedMemorySearch(store, makeCtx(), { query: 'launch', topK: 1, importanceWeight: 1 });
    expect(results[0]!.signals.importance).toBeCloseTo(0.8, 5);
  });
});

describe('fusedMemorySearch — excludeSuperseded (bi-temporal)', () => {
  it('drops a memory whose invalidAt is in the past', async () => {
    const NOW = Date.parse('2026-07-01T00:00:00Z');
    const store = makeStore([
      makeEntry({ id: 'stale', type: 'semantic', content: 'user works at Acme', invalidAt: '2026-05-01T00:00:00Z' }),
      makeEntry({ id: 'current', type: 'semantic', content: 'user works at Globex' }),
    ]);
    const results = await fusedMemorySearch(store, makeCtx(), { query: 'user works', topK: 5, excludeSuperseded: true, nowMs: NOW });
    expect(results.map((r) => r.entry.id)).toEqual(['current']);
  });
  it('keeps superseded memories when excludeSuperseded is off', async () => {
    const store = makeStore([makeEntry({ id: 'stale', type: 'semantic', content: 'user works at Acme', invalidAt: '2026-05-01T00:00:00Z' })]);
    const results = await fusedMemorySearch(store, makeCtx(), { query: 'user works', topK: 5, nowMs: Date.parse('2026-07-01T00:00:00Z') });
    expect(results).toHaveLength(1);
  });
});
