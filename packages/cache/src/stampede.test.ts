/**
 * Phase 7 — singleflight + stampede (SWR / XFetch / negative) + eviction tests.
 * Positive, negative, stress, and security/isolation coverage.
 */
import { describe, it, expect } from 'vitest';
import { createSingleflight } from './singleflight.js';
import { createStampedeCache, shouldServeStale, shouldEarlyRefresh } from './stampede.js';
import { weaveInMemoryCacheStore } from './store.js';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Singleflight ────────────────────────────────────────────

describe('createSingleflight', () => {
  it('coalesces N concurrent identical keys into ONE computation', async () => {
    const sf = createSingleflight();
    let calls = 0;
    const compute = async () => { calls++; await delay(20); return `v${calls}`; };
    const results = await Promise.all(Array.from({ length: 25 }, () => sf.run('k', compute)));
    expect(calls).toBe(1);                                  // one real computation
    expect(results.every(r => r.value === 'v1')).toBe(true); // all got the same value
    expect(results.filter(r => r.coalesced).length).toBe(24); // 24 followers
    expect(sf.stats().flights).toBe(1);
    expect(sf.stats().coalesced).toBe(24);
  });

  it('does NOT coalesce different keys', async () => {
    const sf = createSingleflight();
    let calls = 0;
    await Promise.all(['a', 'b', 'c'].map(k => sf.run(k, async () => { calls++; await delay(5); return k; })));
    expect(calls).toBe(3);
  });

  it('lets a new leader run after the previous flight settles (no permanent dedup)', async () => {
    const sf = createSingleflight();
    let calls = 0;
    const fn = async () => { calls++; return calls; };
    await sf.run('k', fn);
    await sf.run('k', fn); // previous settled → recompute
    expect(calls).toBe(2);
    expect(sf.inFlight()).toBe(0);
  });

  it('propagates a leader error to all followers, then recovers', async () => {
    const sf = createSingleflight();
    let calls = 0;
    const boom = async () => { calls++; await delay(10); throw new Error('fail'); };
    const settled = await Promise.allSettled(Array.from({ length: 5 }, () => sf.run('k', boom)));
    expect(calls).toBe(1);
    expect(settled.every(s => s.status === 'rejected')).toBe(true);
    // key freed → a later call computes again
    const ok = await sf.run('k', async () => { calls++; return 'ok'; });
    expect(ok.value).toBe('ok');
    expect(calls).toBe(2);
  });

  it('beginOrJoin: leader resolves, followers join the same value', async () => {
    const sf = createSingleflight();
    const lead = sf.beginOrJoin<string>('s');
    expect(lead.leader).toBe(true);
    const follow1 = sf.beginOrJoin<string>('s');
    const follow2 = sf.beginOrJoin<string>('s');
    expect(follow1.leader).toBe(false);
    expect(follow2.leader).toBe(false);
    if (lead.leader) lead.resolve('streamed');
    if (!follow1.leader) expect(await follow1.join).toBe('streamed');
    if (!follow2.leader) expect(await follow2.join).toBe('streamed');
    expect(sf.inFlight()).toBe(0);
  });

  it('beginOrJoin: leader reject lets followers fall through', async () => {
    const sf = createSingleflight();
    const lead = sf.beginOrJoin<string>('s');
    const follow = sf.beginOrJoin<string>('s');
    if (lead.leader) lead.reject(new Error('leader died'));
    if (!follow.leader) await expect(follow.join).rejects.toThrow('leader died');
  });
});

// ─── SWR / XFetch decision helpers ───────────────────────────

describe('shouldServeStale', () => {
  it('classifies fresh / stale / expired by age', () => {
    expect(shouldServeStale({ ageMs: 50, ttlMs: 100, swrMs: 100 })).toBe('fresh');
    expect(shouldServeStale({ ageMs: 150, ttlMs: 100, swrMs: 100 })).toBe('stale');
    expect(shouldServeStale({ ageMs: 250, ttlMs: 100, swrMs: 100 })).toBe('expired');
  });
  it('without swr, past-ttl is immediately expired', () => {
    expect(shouldServeStale({ ageMs: 101, ttlMs: 100 })).toBe('expired');
  });
});

describe('shouldEarlyRefresh (XFetch)', () => {
  it('is disabled when beta<=0 or computeMs<=0', () => {
    expect(shouldEarlyRefresh({ ageMs: 99, ttlMs: 100, computeMs: 10, beta: 0 })).toBe(false);
    expect(shouldEarlyRefresh({ ageMs: 99, ttlMs: 100, computeMs: 0, beta: 5 })).toBe(false);
  });
  it('fires near expiry with a high beta, never long before', () => {
    // rand→1 ⇒ ln(rand)=0 ⇒ gap 0 ⇒ only true once age≥ttl
    expect(shouldEarlyRefresh({ ageMs: 100, ttlMs: 100, computeMs: 10, beta: 5, rand: () => 1 })).toBe(true);
    // very fresh + small rand can still trigger early (probabilistic) but very fresh + rand→1 won't
    expect(shouldEarlyRefresh({ ageMs: 10, ttlMs: 100, computeMs: 10, beta: 5, rand: () => 1 })).toBe(false);
  });
});

// ─── Stampede cache (turnkey) ────────────────────────────────

describe('createStampedeCache.getOrCompute', () => {
  it('caches a positive value and serves it as a hit', async () => {
    const sc = createStampedeCache(weaveInMemoryCacheStore());
    let calls = 0;
    const compute = async () => { calls++; return { n: calls }; };
    const a = await sc.getOrCompute('k', compute, { ttlMs: 60_000 });
    const b = await sc.getOrCompute('k', compute, { ttlMs: 60_000 });
    expect(a.hit).toBe(false);
    expect(b.hit).toBe(true);
    expect(calls).toBe(1);
    expect(b.value).toEqual({ n: 1 });
  });

  it('coalesces concurrent misses (one compute)', async () => {
    const sc = createStampedeCache(weaveInMemoryCacheStore());
    let calls = 0;
    const compute = async () => { calls++; await delay(20); return calls; };
    const rs = await Promise.all(Array.from({ length: 10 }, () => sc.getOrCompute('k', compute, { ttlMs: 60_000 })));
    expect(calls).toBe(1);
    expect(rs.filter(r => r.coalesced).length).toBe(9);
  });

  it('SWR: serves stale past ttl and refreshes in the background', async () => {
    let t = 1000;
    const now = () => t;
    const sc = createStampedeCache(weaveInMemoryCacheStore(), { now });
    let calls = 0;
    const compute = async () => { calls++; return `v${calls}`; };
    await sc.getOrCompute('k', compute, { ttlMs: 100, swrMs: 1000 }); // calls=1
    t = 1200; // age 200 → past ttl(100), within swr(1000) → stale
    const stale = await sc.getOrCompute('k', compute, { ttlMs: 100, swrMs: 1000 });
    expect(stale.hit).toBe(true);
    expect(stale.stale).toBe(true);
    expect(stale.value).toBe('v1');           // served stale immediately
    await delay(5);                            // let the background refresh run
    expect(calls).toBe(2);                     // refreshed in the background
  });

  it('expires past ttl+swr and recomputes', async () => {
    let t = 0;
    const sc = createStampedeCache(weaveInMemoryCacheStore(), { now: () => t });
    let calls = 0;
    const compute = async () => { calls++; return calls; };
    await sc.getOrCompute('k', compute, { ttlMs: 100, swrMs: 100 });
    t = 1000; // way past ttl+swr → store may still hold it but logic treats expired
    const r = await sc.getOrCompute('k', compute, { ttlMs: 100, swrMs: 100 });
    expect(r.hit).toBe(false);
    expect(calls).toBe(2);
  });

  it('negative caching: remembers an error for negativeTtlMs (no re-call)', async () => {
    let t = 0;
    const sc = createStampedeCache(weaveInMemoryCacheStore(), { now: () => t });
    let calls = 0;
    const boom = async () => { calls++; throw new Error('backend down'); };
    const first = await sc.getOrCompute('k', boom, { ttlMs: 60_000, negativeTtlMs: 500 });
    expect(first.negative).toBe(true);
    expect(first.error).toBeDefined();
    const second = await sc.getOrCompute('k', boom, { ttlMs: 60_000, negativeTtlMs: 500 });
    expect(second.negative).toBe(true);
    expect(second.hit).toBe(true);     // served from the negative cache
    expect(calls).toBe(1);             // backend shielded
    t = 600;                           // negative entry expired
    const third = await sc.getOrCompute('k', boom, { ttlMs: 60_000, negativeTtlMs: 500 });
    expect(calls).toBe(2);             // recomputed after the short negative TTL
    expect(third.negative).toBe(true);
  });

  it('negativeTtlMs=0 rethrows compute errors (no negative cache)', async () => {
    const sc = createStampedeCache(weaveInMemoryCacheStore());
    await expect(sc.getOrCompute('k', async () => { throw new Error('x'); }, { ttlMs: 1000 })).rejects.toThrow('x');
  });

  it('isNegative classifies an empty value as negative', async () => {
    let t = 0;
    const sc = createStampedeCache(weaveInMemoryCacheStore(), { now: () => t });
    let calls = 0;
    const compute = async () => { calls++; return ''; };
    const r = await sc.getOrCompute('k', compute, { ttlMs: 60_000, negativeTtlMs: 1000, isNegative: (v) => v === '' });
    expect(r.negative).toBe(true);
    const r2 = await sc.getOrCompute('k', compute, { ttlMs: 60_000, negativeTtlMs: 1000, isNegative: (v) => v === '' });
    expect(r2.hit).toBe(true);
    expect(calls).toBe(1);
  });
});

// ─── Eviction strategies ─────────────────────────────────────

describe('eviction strategies', () => {
  it('lfu evicts the least-frequently-used', async () => {
    const evicted: string[] = [];
    const s = weaveInMemoryCacheStore({ maxEntries: 2, evictionPolicy: 'lfu', onEvict: (k) => evicted.push(k) });
    await s.set('a', 1); await s.set('b', 1);
    await s.get('a'); await s.get('a'); // a hotter
    await s.set('c', 1);                 // over capacity → evict coldest (b)
    expect(evicted).toContain('b');
    expect(await s.get('a')).toBe(1);
  });

  it('fifo evicts the oldest written regardless of reads', async () => {
    const evicted: string[] = [];
    const s = weaveInMemoryCacheStore({ maxEntries: 2, evictionPolicy: 'fifo', onEvict: (k) => evicted.push(k) });
    await s.set('a', 1); await s.set('b', 1);
    await s.get('a');     // read does not save 'a' under fifo
    await s.set('c', 1);
    expect(evicted).toContain('a');
  });

  it('tinylfu keeps frequently-useful, drops cold among least-frequent', async () => {
    const evicted: string[] = [];
    const s = weaveInMemoryCacheStore({ maxEntries: 3, evictionPolicy: 'tinylfu', onEvict: (k) => evicted.push(k) });
    await s.set('a', 1); await s.set('b', 1); await s.set('c', 1);
    await s.get('a'); await s.get('a'); await s.get('c'); // b is the coldest (freq lowest)
    await s.set('d', 1);
    expect(evicted).toContain('b');
    expect(await s.get('a')).toBe(1);
  });

  it('gdsf (cost-aware) retains expensive entries, evicts cheap ones first', async () => {
    const evicted: string[] = [];
    // cost read from the value's `cost` field.
    const s = weaveInMemoryCacheStore({
      maxEntries: 2, evictionPolicy: 'gdsf',
      costOf: (v) => (v as { cost: number }).cost,
      onEvict: (k) => evicted.push(k),
    });
    await s.set('cheap', { cost: 1 });
    await s.set('expensive', { cost: 1000 });
    await s.set('c', { cost: 1 });   // over capacity → evict the lowest-priority (cheap)
    expect(evicted).toContain('cheap');
    expect(await s.get('expensive')).toEqual({ cost: 1000 });
  });

  it('stress: bounded store never exceeds maxEntries under churn', async () => {
    const s = weaveInMemoryCacheStore({ maxEntries: 100, evictionPolicy: 'gdsf', costOf: () => 1 });
    for (let i = 0; i < 5000; i++) await s.set(`k${i}`, { i });
    expect(await s.size()).toBeLessThanOrEqual(100);
  });
});
