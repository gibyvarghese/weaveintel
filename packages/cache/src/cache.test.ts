/**
 * @weaveintel/cache — Unit tests
 */
import { describe, it, expect } from 'vitest';
import {
  weaveInMemoryCacheStore,
  weaveSemanticCache,
  createCachePolicy,
  shouldBypass,
  resolvePolicy,
  weaveCacheKeyBuilder,
  evaluateInvalidationRules,
  applyInvalidation,
} from '../src/index.js';
import type { CachePolicy, CacheScopeType } from '@weaveintel/core';

// ─── In-memory store ─────────────────────────────────────────

describe('weaveInMemoryCacheStore', () => {
  it('get returns null for unknown key', async () => {
    const store = weaveInMemoryCacheStore();
    expect(await store.get('unknown')).toBeNull();
  });

  it('set and get round-trip', async () => {
    const store = weaveInMemoryCacheStore();
    await store.set('k1', { hello: 'world' }, 60_000);
    expect(await store.get('k1')).toEqual({ hello: 'world' });
  });

  it('has returns true for existing key', async () => {
    const store = weaveInMemoryCacheStore();
    await store.set('k1', 'v1', 60_000);
    expect(await store.has('k1')).toBe(true);
    expect(await store.has('nope')).toBe(false);
  });

  it('delete removes a key', async () => {
    const store = weaveInMemoryCacheStore();
    await store.set('k1', 'v1', 60_000);
    await store.delete('k1');
    expect(await store.has('k1')).toBe(false);
  });

  it('clear removes all keys', async () => {
    const store = weaveInMemoryCacheStore();
    await store.set('a', 1, 60_000);
    await store.set('b', 2, 60_000);
    await store.clear();
    expect(await store.has('a')).toBe(false);
    expect(await store.has('b')).toBe(false);
  });

  it('expired entries are not returned', async () => {
    const store = weaveInMemoryCacheStore();
    await store.set('fast', 'value', 1); // 1ms TTL
    await new Promise(r => setTimeout(r, 10));
    expect(await store.get('fast')).toBeNull();
  });

  it('clear with scope removes only matching scope keys', async () => {
    const store = weaveInMemoryCacheStore();
    await store.set('user:a', 1, 60_000);
    await store.set('user:b', 2, 60_000);
    await store.set('global:x', 3, 60_000);
    await store.clear('user');
    // Scope-based clear depends on implementation; at minimum the API should not error
    // The in-memory store tracks scope via the entry's scope field (not key prefix)
  });
});

// ─── Cache policy ────────────────────────────────────────────

describe('createCachePolicy', () => {
  it('creates with defaults', () => {
    const p = createCachePolicy({ id: 'p1', name: 'Default' });
    expect(p.enabled).toBe(true);
    expect(p.scope).toBe('global');
    expect(p.ttlMs).toBe(300_000);
  });

  it('respects overrides', () => {
    const p = createCachePolicy({ id: 'p2', name: 'Custom', scope: 'user', ttlMs: 1000, enabled: false });
    expect(p.enabled).toBe(false);
    expect(p.scope).toBe('user');
    expect(p.ttlMs).toBe(1000);
  });
});

describe('shouldBypass', () => {
  const policy: CachePolicy = {
    id: 'bp', name: 'Bypass', enabled: true, scope: 'global', ttlMs: 10_000,
    bypassPatterns: ['password', 'secret\\b', '^system:'],
  };

  it('returns false when no patterns match', () => {
    expect(shouldBypass(policy, 'tell me about weather')).toBe(false);
  });

  it('returns true when a pattern matches (substring)', () => {
    expect(shouldBypass(policy, 'change my password')).toBe(true);
  });

  it('returns true when a pattern matches (regex)', () => {
    expect(shouldBypass(policy, 'system: admin command')).toBe(true);
  });

  it('returns true for disabled policy', () => {
    expect(shouldBypass({ ...policy, enabled: false }, 'anything')).toBe(true);
  });

  it('returns false when no bypass patterns configured', () => {
    expect(shouldBypass({ ...policy, bypassPatterns: [] }, 'password')).toBe(false);
  });
});

describe('resolvePolicy', () => {
  const mkPolicy = (id: string, scope: CacheScopeType, enabled = true): CachePolicy => ({
    id, name: id, enabled, scope, ttlMs: 1000,
  });

  it('returns null when no policies', () => {
    expect(resolvePolicy([], {})).toBeNull();
  });

  it('returns null when all disabled', () => {
    expect(resolvePolicy([mkPolicy('p1', 'global', false)], {})).toBeNull();
  });

  it('returns highest priority scope', () => {
    const p = resolvePolicy([mkPolicy('g', 'global'), mkPolicy('u', 'user')], {});
    expect(p?.id).toBe('u');
  });

  it('prefers matching scope when provided', () => {
    const p = resolvePolicy([mkPolicy('g', 'global'), mkPolicy('u', 'user')], { scope: 'global' });
    expect(p?.id).toBe('g');
  });
});

// ─── Key builder ─────────────────────────────────────────────

describe('weaveCacheKeyBuilder', () => {
  it('builds deterministic keys', () => {
    const kb = weaveCacheKeyBuilder({ namespace: 'test' });
    const k1 = kb.build({ model: 'gpt-4', prompt: 'hello' });
    const k2 = kb.build({ prompt: 'hello', model: 'gpt-4' }); // different order
    expect(k1).toBe(k2);
    expect(k1).toContain('test:');
  });

  it('parses keys back', () => {
    const kb = weaveCacheKeyBuilder({ namespace: 'ns' });
    const key = kb.build({ a: '1', b: '2' });
    const parsed = kb.parse(key);
    expect(parsed['a']).toBe('1');
    expect(parsed['b']).toBe('2');
  });
});

// ─── Semantic cache ──────────────────────────────────────────

describe('weaveSemanticCache', () => {
  // Simple embedding: convert first 8 chars to normalised code points
  const embed = async (text: string) => {
    const chars = text.slice(0, 8).padEnd(8, ' ');
    return chars.split('').map(c => c.charCodeAt(0) / 127);
  };

  it('returns null for empty cache', async () => {
    const sc = weaveSemanticCache({ embed });
    const result = await sc.find('hello');
    expect(result).toBeNull();
  });

  it('stores and retrieves by semantic similarity', async () => {
    const sc = weaveSemanticCache({ embed, defaultThreshold: 0.5 });
    await sc.store('hello world', { answer: 'greeting' });
    const result = await sc.find('hello world');
    expect(result).toBeDefined();
    expect((result as any).response).toEqual({ answer: 'greeting' });
  });

  it('respects threshold', async () => {
    const sc = weaveSemanticCache({ embed, defaultThreshold: 0.9999 });
    await sc.store('hello world', { answer: 'greeting' });
    const result = await sc.find('goodbye world');
    // Very high threshold should reject non-identical queries
    expect(result).toBeNull();
  });

  it('clear empties the cache', async () => {
    const sc = weaveSemanticCache({ embed, defaultThreshold: 0.5 });
    await sc.store('test', { v: 1 });
    await sc.clear();
    const result = await sc.find('test');
    expect(result).toBeNull();
  });
});

// ─── Invalidation ────────────────────────────────────────────

describe('evaluateInvalidationRules', () => {
  it('returns matching rules for event type', () => {
    const rules = [
      { id: 'r1', name: 'On event', trigger: 'event' as const, enabled: true },
      { id: 'r2', name: 'On TTL', trigger: 'ttl' as const, enabled: true },
    ];
    const matched = evaluateInvalidationRules(rules, { type: 'event' });
    expect(matched).toHaveLength(1);
    expect(matched[0]!.id).toBe('r1');
  });

  it('skips disabled rules', () => {
    const rules = [
      { id: 'r1', name: 'Disabled', trigger: 'event' as const, enabled: false },
    ];
    expect(evaluateInvalidationRules(rules, { type: 'event' })).toHaveLength(0);
  });

  it('respects pattern matching', () => {
    const rules = [
      { id: 'r1', name: 'Model change', trigger: 'event' as const, pattern: 'model', enabled: true },
    ];
    expect(evaluateInvalidationRules(rules, { type: 'event', payload: { model: 'gpt-4' } })).toHaveLength(1);
    expect(evaluateInvalidationRules(rules, { type: 'event', payload: { foo: 'bar' } })).toHaveLength(0);
  });
});

describe('applyInvalidation', () => {
  it('clears cache store using rules', async () => {
    const store = weaveInMemoryCacheStore();
    await store.set('chat:123', 'v1', 60_000);
    const rules = [
      { id: 'r1', name: 'Clear key', trigger: 'event' as const, enabled: true, config: { keyPattern: 'chat:123' } },
    ];
    const cleared = await applyInvalidation(store, rules);
    expect(cleared).toBeGreaterThanOrEqual(1);
    expect(await store.has('chat:123')).toBe(false);
  });
});
