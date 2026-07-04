/**
 * @weaveintel/cache — metrics tests.
 * Positive, negative, stress, and a security/privacy case.
 */
import { describe, it, expect } from 'vitest';
import {
  createCacheMetrics,
  withMetrics,
  estimatePromptCacheSavingsUsd,
  weaveInMemoryCacheStore,
  weaveRedisCacheStore,
  weaveTieredCacheStore,
  type RedisLikeClient,
} from '../src/index.js';
import { isScannableCacheStore } from '@weaveintel/core';

describe('createCacheMetrics', () => {
  it('counts hits/misses/sets/evictions and computes hit rate', () => {
    const m = createCacheMetrics({ startedAt: '2026-06-24T00:00:00Z' });
    m.onHit(); m.onHit(); m.onMiss(); m.onSet(); m.onEvict();
    const s = m.snapshot();
    expect(s.responseCache.hits).toBe(2);
    expect(s.responseCache.misses).toBe(1);
    expect(s.responseCache.sets).toBe(1);
    expect(s.responseCache.evictions).toBe(1);
    expect(s.responseCache.hitRate).toBeCloseTo(2 / 3, 5);
    expect(s.startedAt).toBe('2026-06-24T00:00:00Z');
  });

  it('hit rate is 0 with no lookups (no divide-by-zero)', () => {
    expect(createCacheMetrics().snapshot().responseCache.hitRate).toBe(0);
  });

  it('accumulates prompt-cache token savings across turns', () => {
    const m = createCacheMetrics();
    m.recordPromptCache({ readTokens: 1000, writeTokens: 200, costSavedUsd: 0.003 });
    m.recordPromptCache({ readTokens: 2000, writeTokens: 0, costSavedUsd: 0.006 });
    const s = m.snapshot();
    expect(s.promptCache.turns).toBe(2);
    expect(s.promptCache.cacheReadTokens).toBe(3000);
    expect(s.promptCache.cacheWriteTokens).toBe(200);
    expect(s.promptCache.estCostSavedUsd).toBeCloseTo(0.009, 6);
  });

  it('negative / NaN deltas are clamped to 0 (never reduce totals)', () => {
    const m = createCacheMetrics();
    m.recordPromptCache({ readTokens: -500, writeTokens: NaN as unknown as number, costSavedUsd: -1 });
    const s = m.snapshot();
    expect(s.promptCache.cacheReadTokens).toBe(0);
    expect(s.promptCache.cacheWriteTokens).toBe(0);
    expect(s.promptCache.estCostSavedUsd).toBe(0);
  });

  it('reset clears all counters', () => {
    const m = createCacheMetrics();
    m.onHit(); m.recordPromptCache({ readTokens: 100, writeTokens: 0 });
    m.reset();
    const s = m.snapshot();
    expect(s.responseCache.hits).toBe(0);
    expect(s.promptCache.cacheReadTokens).toBe(0);
  });

  it('stress: 100k operations stay accurate', () => {
    const m = createCacheMetrics();
    for (let i = 0; i < 100_000; i++) (i % 3 === 0 ? m.onHit() : m.onMiss());
    const s = m.snapshot();
    expect(s.responseCache.hits + s.responseCache.misses).toBe(100_000);
    expect(s.responseCache.hits).toBe(Math.ceil(100_000 / 3));
  });
});

describe('estimatePromptCacheSavingsUsd', () => {
  it('discounts per provider', () => {
    // 1M cached read tokens at $3/M input → anthropic saves 90% = $2.70
    expect(estimatePromptCacheSavingsUsd('anthropic', 1_000_000, 3)).toBeCloseTo(2.7, 5);
    // openai 50% of $2.50/M → $1.25
    expect(estimatePromptCacheSavingsUsd('openai', 1_000_000, 2.5)).toBeCloseTo(1.25, 5);
    // unknown provider → 50% default
    expect(estimatePromptCacheSavingsUsd('mystery', 1_000_000, 2)).toBeCloseTo(1.0, 5);
  });

  it('returns 0 for zero tokens or zero cost', () => {
    expect(estimatePromptCacheSavingsUsd('openai', 0, 5)).toBe(0);
    expect(estimatePromptCacheSavingsUsd('openai', 1000, 0)).toBe(0);
  });
});

describe('withMetrics', () => {
  it('records hits and misses through a wrapped store', async () => {
    const m = createCacheMetrics();
    const store = withMetrics(weaveInMemoryCacheStore(), m);
    expect(await store.get('absent')).toBeNull(); // miss
    await store.set('k', { v: 1 }, 60_000);        // set
    expect(await store.get('k')).toEqual({ v: 1 }); // hit
    const s = m.snapshot();
    expect(s.responseCache.misses).toBe(1);
    expect(s.responseCache.hits).toBe(1);
    expect(s.responseCache.sets).toBe(1);
  });

  it('wires store evictions into the sink via onEvict', async () => {
    const m = createCacheMetrics();
    const store = withMetrics(weaveInMemoryCacheStore({ maxEntries: 1, onEvict: () => m.onEvict() }), m);
    await store.set('a', 1, 60_000);
    await store.set('b', 2, 60_000); // evicts 'a'
    expect(m.snapshot().responseCache.evictions).toBe(1);
  });

  it('preserves scannable capability (tiered/redis stay scannable)', async () => {
    const map = new Map<string, string>();
    const fake: RedisLikeClient = {
      isOpen: true,
      async get(k) { return map.get(k) ?? null; },
      async set(k, v) { map.set(k, v); return 'OK'; },
      async del(keys) { const a = Array.isArray(keys) ? keys : [keys]; let n = 0; for (const k of a) if (map.delete(k)) n++; return n; },
      async exists(keys) { const a = Array.isArray(keys) ? keys : [keys]; let n = 0; for (const k of a) if (map.has(k)) n++; return n; },
      async keys(p) { const re = new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'); return [...map.keys()].filter((k) => re.test(k)); },
    };
    const tiered = weaveTieredCacheStore(weaveInMemoryCacheStore(), weaveRedisCacheStore({ client: fake, keyPrefix: 'gw' }));
    const wrapped = withMetrics(tiered, createCacheMetrics());
    expect(isScannableCacheStore(wrapped)).toBe(true);
    await wrapped.set('t=A:1', 1, 60_000);
    expect((wrapped as any).deleteByPrefix).toBeTypeOf('function');
    expect(await (wrapped as any).deleteByPrefix('t=A')).toBe(1);
  });

  it('security/privacy: the sink stores only counts, never keys or values', async () => {
    const m = createCacheMetrics();
    const store = withMetrics(weaveInMemoryCacheStore(), m);
    await store.set('user:ssn:123-45-6789', { secret: 'sk-livekey' }, 60_000);
    await store.get('user:ssn:123-45-6789');
    const dump = JSON.stringify(m.snapshot());
    expect(dump).not.toContain('123-45-6789');
    expect(dump).not.toContain('sk-livekey');
    expect(dump).not.toContain('ssn');
  });
});
