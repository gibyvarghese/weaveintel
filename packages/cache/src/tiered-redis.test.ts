/**
 * @weaveintel/cache — Phase 1 tests: distributed L2 (Redis) + tiered store.
 *
 * Uses a faithful in-memory fake of the RedisLikeClient (TTL via PX, glob KEYS)
 * for deterministic positive/negative/stress/security coverage, plus an
 * opt-in real-Redis cross-instance test (skipped when no server is reachable).
 */
import { describe, it, expect } from 'vitest';
import {
  weaveInMemoryCacheStore,
  weaveRedisCacheStore,
  weaveTieredCacheStore,
  type RedisLikeClient,
} from '../src/index.js';
import { isScannableCacheStore } from '@weaveintel/core';

// ─── Faithful in-memory fake of a Redis client ───────────────

function globToRegExp(pattern: string): RegExp {
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '\\') {
      const next = pattern[++i];
      if (next !== undefined) re += next.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (ch === '*') {
      re += '.*';
    } else if (ch === '?') {
      re += '.';
    } else {
      re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(re + '$');
}

interface FakeRedis extends RedisLikeClient {
  _map: Map<string, { v: string; exp: number | null }>;
  _ops: number;
}

function createFakeRedis(): FakeRedis {
  const map = new Map<string, { v: string; exp: number | null }>();
  const alive = (k: string): boolean => {
    const e = map.get(k);
    if (!e) return false;
    if (e.exp !== null && Date.now() > e.exp) { map.delete(k); return false; }
    return true;
  };
  const self: FakeRedis = {
    _map: map,
    _ops: 0,
    isOpen: true,
    async get(k) { self._ops++; return alive(k) ? map.get(k)!.v : null; },
    async set(k, v, o) { self._ops++; map.set(k, { v, exp: o?.PX ? Date.now() + o.PX : null }); return 'OK'; },
    async del(keys) { const arr = Array.isArray(keys) ? keys : [keys]; let n = 0; for (const k of arr) if (map.delete(k)) n++; return n; },
    async exists(keys) { const arr = Array.isArray(keys) ? keys : [keys]; let n = 0; for (const k of arr) if (alive(k)) n++; return n; },
    async keys(pattern) { const re = globToRegExp(pattern); const out: string[] = []; for (const k of [...map.keys()]) if (alive(k) && re.test(k)) out.push(k); return out; },
    async connect() { self.isOpen = true; },
    async quit() { self.isOpen = false; },
  };
  return self;
}

// ─── Redis store (via fake) ──────────────────────────────────

describe('weaveRedisCacheStore', () => {
  it('round-trips values (JSON) and reports has/size', async () => {
    const store = weaveRedisCacheStore({ client: createFakeRedis(), keyPrefix: 'wc' });
    await store.set('k1', { hello: 'world' });
    expect(await store.get('k1')).toEqual({ hello: 'world' });
    expect(await store.has('k1')).toBe(true);
    expect(await store.has('nope')).toBe(false);
    expect(await store.size()).toBe(1);
    await store.delete('k1');
    expect(await store.has('k1')).toBe(false);
  });

  it('namespaces physical keys under keyPrefix', async () => {
    const fake = createFakeRedis();
    const store = weaveRedisCacheStore({ client: fake, keyPrefix: 'weave:cache' });
    await store.set('gw-chat:v1:abc', 1);
    expect([...fake._map.keys()][0]).toBe('weave:cache:gw-chat:v1:abc');
  });

  it('honours TTL via PX (expired entries are gone)', async () => {
    const store = weaveRedisCacheStore({ client: createFakeRedis() });
    await store.set('fast', 'v', 5);
    await new Promise((r) => setTimeout(r, 20));
    expect(await store.get('fast')).toBeNull();
    expect(await store.has('fast')).toBe(false);
  });

  it('keys(prefix) returns logical keys without the namespace', async () => {
    const store = weaveRedisCacheStore({ client: createFakeRedis(), keyPrefix: 'ns' });
    await store.set('t=A:x', 1);
    await store.set('t=B:y', 2);
    const keys = await store.keys('t=A');
    expect(keys).toEqual(['t=A:x']);
  });

  it('deleteByPrefix removes only matching keys', async () => {
    const store = weaveRedisCacheStore({ client: createFakeRedis(), keyPrefix: 'ns' });
    await store.set('t=A:1', 1);
    await store.set('t=A:2', 2);
    await store.set('t=B:1', 3);
    const removed = await store.deleteByPrefix('t=A');
    expect(removed).toBe(2);
    expect(await store.has('t=A:1')).toBe(false);
    expect(await store.has('t=B:1')).toBe(true);
  });

  it('is recognised as a ScannableCacheStore', () => {
    expect(isScannableCacheStore(weaveRedisCacheStore({ client: createFakeRedis() }))).toBe(true);
  });

  it('throws when neither client nor url is given', () => {
    expect(() => weaveRedisCacheStore({})).toThrow(/client.*url/i);
  });

  // ─── Security ──────────────────────────────────────────────

  it('clear(scope) escapes glob metacharacters — a "*" scope cannot wipe everything', async () => {
    const fake = createFakeRedis();
    const store = weaveRedisCacheStore({ client: fake, keyPrefix: 'ns' });
    await store.set('real-key', 1);
    await store.set('*literal', 2); // a key that literally starts with '*'
    // A scope of '*' is treated LITERALLY (not as a wildcard): it removes only
    // keys that literally start with '*', leaving unrelated keys intact.
    await store.clear('*');
    expect(await store.has('real-key')).toBe(true);   // survives — '*' is not a wildcard
    expect(await store.has('*literal')).toBe(false);  // legitimately matches the literal '*' prefix
  });

  it('clear() without scope only clears this namespace, not co-located keys', async () => {
    const fake = createFakeRedis();
    fake._map.set('other:app:key', { v: '"x"', exp: null }); // a different app sharing Redis
    const store = weaveRedisCacheStore({ client: fake, keyPrefix: 'weave:cache' });
    await store.set('mine', 1);
    await store.clear();
    expect(await store.has('mine')).toBe(false);
    expect(fake._map.has('other:app:key')).toBe(true); // untouched
  });
});

// ─── Tiered store (L1 + L2) ──────────────────────────────────

describe('weaveTieredCacheStore', () => {
  it('reads L1 first, falls back to L2 and back-fills L1', async () => {
    const l1 = weaveInMemoryCacheStore();
    const l2 = weaveRedisCacheStore({ client: createFakeRedis() });
    const tiered = weaveTieredCacheStore(l1, l2);

    await l2.set('k', { a: 1 }); // only in L2
    expect(await l1.has('k')).toBe(false);
    expect(await tiered.get('k')).toEqual({ a: 1 }); // served from L2
    expect(await l1.has('k')).toBe(true);            // back-filled into L1
  });

  it('write-through populates both tiers', async () => {
    const l1 = weaveInMemoryCacheStore();
    const l2 = weaveRedisCacheStore({ client: createFakeRedis() });
    const tiered = weaveTieredCacheStore(l1, l2);
    await tiered.set('k', 42, 60_000);
    expect(await l1.get('k')).toBe(42);
    expect(await l2.get('k')).toBe(42);
  });

  it('caps L1 TTL to l1TtlMs while L2 keeps the full TTL', async () => {
    const l1 = weaveInMemoryCacheStore();
    const l2 = weaveRedisCacheStore({ client: createFakeRedis() });
    const tiered = weaveTieredCacheStore(l1, l2, { l1TtlMs: 10 });
    await tiered.set('k', 'v', 60_000);
    await new Promise((r) => setTimeout(r, 25));
    expect(await l1.get('k')).toBeNull();   // L1 expired (10ms cap)
    expect(await l2.get('k')).toBe('v');    // L2 still valid (60s)
    expect(await tiered.get('k')).toBe('v'); // tiered re-serves from L2
  });

  it('cross-instance sharing: two replicas share hits via the same L2', async () => {
    const sharedRedis = createFakeRedis();
    const replicaA = weaveTieredCacheStore(weaveInMemoryCacheStore(), weaveRedisCacheStore({ client: sharedRedis }));
    const replicaB = weaveTieredCacheStore(weaveInMemoryCacheStore(), weaveRedisCacheStore({ client: sharedRedis }));

    await replicaA.set('shared', { answer: 'from-A' }, 60_000);
    // Replica B has a cold L1 but still hits via the shared L2.
    expect(await replicaB.get('shared')).toEqual({ answer: 'from-A' });
  });

  it('delete and clear fan out to both tiers', async () => {
    const l1 = weaveInMemoryCacheStore();
    const l2 = weaveRedisCacheStore({ client: createFakeRedis() });
    const tiered = weaveTieredCacheStore(l1, l2);
    await tiered.set('k', 1, 60_000);
    await tiered.delete('k');
    expect(await l1.has('k')).toBe(false);
    expect(await l2.has('k')).toBe(false);

    await tiered.set('a', 1, 60_000);
    await tiered.clear();
    expect(await tiered.has('a')).toBe(false);
  });

  it('deleteByPrefix invalidates across the cluster (L2) and locally (L1)', async () => {
    const l1 = weaveInMemoryCacheStore();
    const l2 = weaveRedisCacheStore({ client: createFakeRedis() });
    const tiered = weaveTieredCacheStore(l1, l2);
    await tiered.set('t=A:1', 1, 60_000);
    await tiered.set('t=A:2', 2, 60_000);
    await tiered.set('t=B:1', 3, 60_000);
    const removed = await tiered.deleteByPrefix('t=A');
    expect(removed).toBe(2);
    expect(await tiered.has('t=A:1')).toBe(false);
    expect(await tiered.has('t=B:1')).toBe(true);
  });

  it('size reports the authoritative L2 size', async () => {
    const l1 = weaveInMemoryCacheStore();
    const l2 = weaveRedisCacheStore({ client: createFakeRedis() });
    const tiered = weaveTieredCacheStore(l1, l2);
    await tiered.set('a', 1, 60_000);
    await tiered.set('b', 2, 60_000);
    expect(await tiered.size()).toBe(2);
  });

  // ─── Stress ────────────────────────────────────────────────

  it('stress: bounded L1 stays capped while L2 serves all keys', async () => {
    const l1 = weaveInMemoryCacheStore({ maxEntries: 50, evictionPolicy: 'lru' });
    const l2 = weaveRedisCacheStore({ client: createFakeRedis() });
    const tiered = weaveTieredCacheStore(l1, l2);
    for (let i = 0; i < 5_000; i++) await tiered.set(`k${i}`, i, 60_000);
    expect(await l1.size()).toBeLessThanOrEqual(50);   // L1 bounded
    expect(await l2.size()).toBe(5_000);               // L2 holds everything
    // A cold key (evicted from L1) still resolves via L2.
    expect(await tiered.get('k0')).toBe(0);
  });
});

// ─── Optional: real Redis cross-instance sharing ─────────────

const REDIS_URL = process.env['CACHE_TEST_REDIS_URL'] ?? 'redis://127.0.0.1:6379';

async function redisReachable(): Promise<boolean> {
  try {
    const mod = (await import('redis')) as { createClient: (o: { url: string }) => RedisLikeClient };
    const c = mod.createClient({ url: REDIS_URL });
    await c.connect?.();
    await c.set('weave:cache:__probe', '1', { PX: 1000 });
    await c.quit?.();
    return true;
  } catch {
    return false;
  }
}

describe('weaveTieredCacheStore — real Redis (opt-in)', () => {
  it('shares cache hits across two independent store instances via real Redis', async () => {
    if (!(await redisReachable())) {
      console.warn('[skip] no Redis reachable at ' + REDIS_URL);
      return;
    }
    const prefix = 'weave:cache:test:' + Math.abs(hashStr(expect.getState().currentTestName ?? 'x'));
    const a = weaveTieredCacheStore(weaveInMemoryCacheStore(), weaveRedisCacheStore({ url: REDIS_URL, keyPrefix: prefix }));
    const b = weaveTieredCacheStore(weaveInMemoryCacheStore(), weaveRedisCacheStore({ url: REDIS_URL, keyPrefix: prefix }));
    try {
      const key = 'realkey-' + prefix;
      await a.set(key, { answer: 'shared-via-real-redis' }, 30_000);
      // Replica B has a cold L1 but still hits via the shared L2 — the core
      // cross-replica sharing guarantee.
      expect(await b.get(key)).toEqual({ answer: 'shared-via-real-redis' });

      // Cluster-wide prefix invalidation clears the shared L2 immediately. A
      // *fresh* replica (cold L1) therefore misses right away. (Replicas that
      // already warmed their L1 only see the change after the short l1TtlMs
      // window — that staleness bound is the documented tiered-cache trade-off.)
      await a.deleteByPrefix(key);
      const c = weaveTieredCacheStore(weaveInMemoryCacheStore(), weaveRedisCacheStore({ url: REDIS_URL, keyPrefix: prefix }));
      try {
        expect(await c.get(key)).toBeNull();
      } finally {
        await c.close();
      }
    } finally {
      await a.clear();
      await a.close();
      await b.close();
    }
  });
});

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
