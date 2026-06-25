/**
 * @weaveintel/cache — Phase 0 hardening tests
 *
 * Covers bounded store + eviction, salted/hashed keys, scope isolation,
 * determinism gating, and response-side bypass. Includes positive, negative,
 * stress, and security cases.
 */
import { describe, it, expect } from 'vitest';
import {
  weaveInMemoryCacheStore,
  weaveCacheKeyBuilder,
  cacheScopeKey,
  createCachePolicy,
  shouldBypass,
  shouldBypassResponse,
  isCacheableTemperature,
} from '../src/index.js';

// ─── Bounded store: capacity eviction ────────────────────────

describe('weaveInMemoryCacheStore — maxEntries eviction', () => {
  it('never exceeds maxEntries under unique-key flood (LRU)', async () => {
    const store = weaveInMemoryCacheStore({ maxEntries: 100, evictionPolicy: 'lru' });
    for (let i = 0; i < 10_000; i++) {
      await store.set(`k${i}`, { i }, 60_000);
    }
    expect(await store.size()).toBeLessThanOrEqual(100);
    // The most recently written keys survive.
    expect(await store.has('k9999')).toBe(true);
    expect(await store.has('k0')).toBe(false);
  });

  it('LRU keeps recently-read keys and evicts cold ones', async () => {
    const store = weaveInMemoryCacheStore({ maxEntries: 3, evictionPolicy: 'lru' });
    await store.set('a', 1, 60_000);
    await store.set('b', 2, 60_000);
    await store.set('c', 3, 60_000);
    await store.get('a'); // touch a → most recent
    await store.set('d', 4, 60_000); // evicts the LRU which is now 'b'
    expect(await store.has('a')).toBe(true);
    expect(await store.has('b')).toBe(false);
    expect(await store.has('c')).toBe(true);
    expect(await store.has('d')).toBe(true);
  });

  it('FIFO evicts oldest-inserted regardless of reads', async () => {
    const store = weaveInMemoryCacheStore({ maxEntries: 3, evictionPolicy: 'fifo' });
    await store.set('a', 1, 60_000);
    await store.set('b', 2, 60_000);
    await store.set('c', 3, 60_000);
    await store.get('a'); // read does NOT save 'a' under fifo
    await store.set('d', 4, 60_000);
    expect(await store.has('a')).toBe(false);
    expect(await store.has('d')).toBe(true);
  });

  it('LFU evicts the least-frequently accessed', async () => {
    const store = weaveInMemoryCacheStore({ maxEntries: 3, evictionPolicy: 'lfu' });
    await store.set('a', 1, 60_000);
    await store.set('b', 2, 60_000);
    await store.set('c', 3, 60_000);
    await store.get('a'); await store.get('a'); // a freq high
    await store.get('c'); // c freq medium
    // b has the lowest frequency → evicted next
    await store.set('d', 4, 60_000);
    expect(await store.has('b')).toBe(false);
    expect(await store.has('a')).toBe(true);
    expect(await store.has('d')).toBe(true);
  });

  it('fires onEvict with a capacity reason', async () => {
    const evicted: Array<{ key: string; reason: string }> = [];
    const store = weaveInMemoryCacheStore({
      maxEntries: 1,
      onEvict: (key, reason) => evicted.push({ key, reason }),
    });
    await store.set('a', 1, 60_000);
    await store.set('b', 2, 60_000);
    expect(evicted).toContainEqual({ key: 'a', reason: 'capacity' });
  });
});

// ─── Bounded store: byte cap ─────────────────────────────────

describe('weaveInMemoryCacheStore — maxBytes eviction', () => {
  it('stays under the byte cap', async () => {
    const store = weaveInMemoryCacheStore({ maxEntries: 0, maxBytes: 2_000 });
    const big = 'x'.repeat(500);
    for (let i = 0; i < 200; i++) {
      await store.set(`k${i}`, big, 60_000);
    }
    // Each entry ≈ 500+ bytes; cap 2000 ⇒ only a handful survive.
    expect(await store.size()).toBeLessThanOrEqual(5);
  });

  it('overwriting a key does not double-count bytes', async () => {
    const store = weaveInMemoryCacheStore({ maxEntries: 10, maxBytes: 10_000 });
    for (let i = 0; i < 100; i++) {
      await store.set('same', 'y'.repeat(100), 60_000);
    }
    expect(await store.size()).toBe(1);
  });
});

// ─── Bounded store: TTL interplay ────────────────────────────

describe('weaveInMemoryCacheStore — TTL + capacity', () => {
  it('prunes expired before evicting live entries', async () => {
    const store = weaveInMemoryCacheStore({ maxEntries: 2 });
    await store.set('expired', 1, 1); // 1ms
    await new Promise((r) => setTimeout(r, 10));
    await store.set('live1', 1, 60_000);
    await store.set('live2', 2, 60_000); // expired pruned, no live eviction needed
    expect(await store.has('live1')).toBe(true);
    expect(await store.has('live2')).toBe(true);
    expect(await store.has('expired')).toBe(false);
  });
});

// ─── Hashed key builder (security) ───────────────────────────

describe('weaveCacheKeyBuilder — sha256 hashing', () => {
  const kb = weaveCacheKeyBuilder({ namespace: 'gw', hash: 'sha256', salt: 's3cr3t', version: 'v1' });

  it('never embeds the raw prompt in the key', () => {
    const secretPrompt = 'my social security number is 123-45-6789';
    const key = kb.build({ model: 'gpt', prompt: secretPrompt });
    expect(key).not.toContain('123-45-6789');
    expect(key).not.toContain('social security');
    expect(key).toMatch(/^gw:v1:[0-9a-f]{64}$/);
  });

  it('is deterministic and order-independent', () => {
    const a = kb.build({ model: 'gpt', prompt: 'hello', userId: 'u1' });
    const b = kb.build({ userId: 'u1', prompt: 'hello', model: 'gpt' });
    expect(a).toBe(b);
  });

  it('distinct inputs produce distinct keys (no delimiter-injection collision)', () => {
    // Legacy k=v joining would collide these; hashing must not.
    const a = kb.build({ a: 'x:b=y', b: '' });
    const b = kb.build({ a: 'x', b: 'y' });
    expect(a).not.toBe(b);
  });

  it('salt changes the digest', () => {
    const other = weaveCacheKeyBuilder({ namespace: 'gw', hash: 'sha256', salt: 'different', version: 'v1' });
    expect(kb.build({ prompt: 'x' })).not.toBe(other.build({ prompt: 'x' }));
  });

  it('version bump busts the key', () => {
    const v2 = weaveCacheKeyBuilder({ namespace: 'gw', hash: 'sha256', salt: 's3cr3t', version: 'v2' });
    expect(kb.build({ prompt: 'x' })).not.toBe(v2.build({ prompt: 'x' }));
  });

  it('parse returns only structural segments, never the prompt', () => {
    const key = kb.build({ prompt: 'super secret prompt' });
    const parsed = kb.parse(key);
    expect(parsed['namespace']).toBe('gw');
    expect(parsed['version']).toBe('v1');
    expect(parsed['hash']).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(parsed)).not.toContain('secret');
  });

  it('legacy mode still works (backward compat)', () => {
    const legacy = weaveCacheKeyBuilder({ namespace: 'test' });
    const key = legacy.build({ a: '1', b: '2' });
    expect(key).toBe('test:a=1:b=2');
    expect(legacy.parse(key)).toEqual({ a: '1', b: '2' });
  });
});

// ─── Scope isolation (security) ──────────────────────────────

describe('cacheScopeKey — tenant & user isolation', () => {
  const kb = weaveCacheKeyBuilder({ namespace: 'gw', hash: 'sha256', salt: 's', version: 'v1' });

  it('two tenants with identical prompts never share a key', () => {
    const a = kb.build({ ...cacheScopeKey({ tenantId: 'tA', userId: 'u1', scope: 'global' }), prompt: 'hi' });
    const b = kb.build({ ...cacheScopeKey({ tenantId: 'tB', userId: 'u1', scope: 'global' }), prompt: 'hi' });
    expect(a).not.toBe(b);
  });

  it('two users in the same tenant never share a key', () => {
    const a = kb.build({ ...cacheScopeKey({ tenantId: 'tA', userId: 'u1', scope: 'global' }), prompt: 'hi' });
    const b = kb.build({ ...cacheScopeKey({ tenantId: 'tA', userId: 'u2', scope: 'global' }), prompt: 'hi' });
    expect(a).not.toBe(b);
  });

  it('same tenant+user+prompt is a cache hit (stable key)', () => {
    const a = kb.build({ ...cacheScopeKey({ tenantId: 'tA', userId: 'u1', scope: 'user' }), prompt: 'hi' });
    const b = kb.build({ ...cacheScopeKey({ tenantId: 'tA', userId: 'u1', scope: 'user' }), prompt: 'hi' });
    expect(a).toBe(b);
  });

  it('session scope adds the session discriminator', () => {
    const s1 = cacheScopeKey({ tenantId: 't', userId: 'u', sessionId: 's1', scope: 'session' });
    const s2 = cacheScopeKey({ tenantId: 't', userId: 'u', sessionId: 's2', scope: 'session' });
    expect(s1['s']).toBe('s1');
    expect(s2['s']).toBe('s2');
  });

  it('tenantIsolation=false drops the tenant segment', () => {
    const parts = cacheScopeKey({ tenantId: 't', userId: 'u', scope: 'global', tenantIsolation: false });
    expect(parts['t']).toBeUndefined();
    expect(parts['u']).toBe('u');
  });
});

// ─── Determinism gate ────────────────────────────────────────

describe('isCacheableTemperature', () => {
  const strict = createCachePolicy({ id: 'p', name: 'p', temperatureGate: 0 });
  const lax = createCachePolicy({ id: 'p2', name: 'p2', temperatureGate: 1 });

  it('caches deterministic (temperature 0 / unset) responses by default', () => {
    expect(isCacheableTemperature(strict, 0)).toBe(true);
    expect(isCacheableTemperature(strict, undefined)).toBe(true);
  });

  it('does not cache temperature>0 under a strict gate', () => {
    expect(isCacheableTemperature(strict, 0.7)).toBe(false);
    expect(isCacheableTemperature(strict, 0.01)).toBe(false);
  });

  it('a lax gate caches up to its threshold', () => {
    expect(isCacheableTemperature(lax, 0.9)).toBe(true);
    expect(isCacheableTemperature(lax, 1.5)).toBe(false);
  });
});

// ─── Response-side bypass (security) ─────────────────────────

describe('shouldBypassResponse', () => {
  const policy = createCachePolicy({
    id: 'p',
    name: 'p',
    bypassPatterns: ['password'],
    outputBypassPatterns: ['sk-[a-z0-9]{10,}', 'BEGIN PRIVATE KEY'],
  });

  it('skips caching when the response leaks a secret key', () => {
    expect(shouldBypassResponse(policy, 'here is your token sk-abcdef012345')).toBe(true);
    expect(shouldBypassResponse(policy, '-----BEGIN PRIVATE KEY-----')).toBe(true);
  });

  it('also honours input bypass patterns against the output', () => {
    expect(shouldBypassResponse(policy, 'your password is hunter2')).toBe(true);
  });

  it('allows caching of benign output', () => {
    expect(shouldBypassResponse(policy, 'The capital of France is Paris.')).toBe(false);
  });

  it('a benign prompt with a sensitive response is not cached', () => {
    // Input bypass alone would miss this (prompt is benign).
    expect(shouldBypass(policy, 'what is my api key?')).toBe(false);
    expect(shouldBypassResponse(policy, 'your key is sk-livekey123456')).toBe(true);
  });
});

// ─── ReDoS / bad-pattern resilience (security) ───────────────

describe('pattern matching — resilience', () => {
  it('does not throw on an invalid regex (falls back to substring)', () => {
    const policy = createCachePolicy({ id: 'p', name: 'p', bypassPatterns: ['([a-z'] });
    expect(() => shouldBypass(policy, 'whatever')).not.toThrow();
  });

  it('caps oversized patterns instead of compiling them', () => {
    const huge = 'a'.repeat(10_000);
    const policy = createCachePolicy({ id: 'p', name: 'p', bypassPatterns: [huge] });
    expect(() => shouldBypass(policy, 'short input')).not.toThrow();
  });
});

// ─── createCachePolicy secure defaults ───────────────────────

describe('createCachePolicy — secure defaults', () => {
  it('defaults to sha256 hashing, tenant isolation, and a 0 temperature gate', () => {
    const p = createCachePolicy({ id: 'p', name: 'Default' });
    expect(p.keyHashing).toBe('sha256');
    expect(p.tenantIsolation).toBe(true);
    expect(p.temperatureGate).toBe(0);
  });
});
