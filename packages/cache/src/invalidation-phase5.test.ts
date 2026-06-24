/**
 * @weaveintel/cache — Phase 5 invalidation + scoped-key tests.
 * Positive, negative, scope/security, and stress.
 */
import { describe, it, expect } from 'vitest';
import {
  createCacheInvalidator,
  cacheScopeKeyString,
  weaveInMemoryCacheStore,
  weaveCacheKeyBuilder,
  weaveSemanticCache,
  applyInvalidation,
} from '../src/index.js';
import type { CacheInvalidationRule } from '@weaveintel/core';

const kb = weaveCacheKeyBuilder({ namespace: 'gw', hash: 'sha256', salt: 's', version: 'v1' });
// Build a key the way the app does: visible scope prefix + hashed prompt.
const key = (scope: { tenantId?: string; userId?: string }, prompt: string) =>
  cacheScopeKeyString({ ...scope, scope: 'user' }) + '||' + kb.build({ model: 'm', prompt });

describe('cacheScopeKeyString', () => {
  it('produces a readable, scoped prefix', () => {
    expect(cacheScopeKeyString({ tenantId: 'tA', userId: 'u1', scope: 'user' })).toBe('t=tA|u=u1');
    expect(cacheScopeKeyString({ userId: 'u1', scope: 'user' })).toBe('u=u1');
    expect(cacheScopeKeyString({ scope: 'global' })).toBe('');
  });

  it('different tenants / users yield different prefixes (isolation)', () => {
    expect(cacheScopeKeyString({ tenantId: 'tA', userId: 'u1', scope: 'user' }))
      .not.toBe(cacheScopeKeyString({ tenantId: 'tB', userId: 'u1', scope: 'user' }));
    expect(cacheScopeKeyString({ tenantId: 'tA', userId: 'u1', scope: 'user' }))
      .not.toBe(cacheScopeKeyString({ tenantId: 'tA', userId: 'u2', scope: 'user' }));
  });
});

describe('createCacheInvalidator — direct invalidate', () => {
  it('invalidate({all}) wipes the whole store', async () => {
    const store = weaveInMemoryCacheStore();
    await store.set('a', 1, 60_000); await store.set('b', 2, 60_000);
    const inv = createCacheInvalidator({ store });
    await inv.invalidate({ all: true });
    expect(await store.size()).toBe(0);
  });

  it('invalidate({prefix}) erases ONE user without touching others (GDPR)', async () => {
    const store = weaveInMemoryCacheStore();
    await store.set(key({ tenantId: 'tA', userId: 'u1' }, 'what is my balance'), 'U1', 60_000);
    await store.set(key({ tenantId: 'tA', userId: 'u1' }, 'another question'), 'U1b', 60_000);
    await store.set(key({ tenantId: 'tA', userId: 'u2' }, 'what is my balance'), 'U2', 60_000);
    const inv = createCacheInvalidator({ store });
    const removed = await inv.invalidate({ prefix: 't=tA|u=u1||' });
    expect(removed).toBe(2);
    expect(await store.has(key({ tenantId: 'tA', userId: 'u2' }, 'what is my balance'))).toBe(true);
  });

  it('invalidate({prefix}) for a tenant clears all that tenant\'s users', async () => {
    const store = weaveInMemoryCacheStore();
    await store.set(key({ tenantId: 'tA', userId: 'u1' }, 'q'), 1, 60_000);
    await store.set(key({ tenantId: 'tA', userId: 'u2' }, 'q'), 2, 60_000);
    await store.set(key({ tenantId: 'tB', userId: 'u1' }, 'q'), 3, 60_000);
    const inv = createCacheInvalidator({ store });
    const removed = await inv.invalidate({ prefix: 't=tA|' });
    expect(removed).toBe(2);
    expect(await store.has(key({ tenantId: 'tB', userId: 'u1' }, 'q'))).toBe(true);
  });

  it('invalidate({semantic, semanticScope}) clears only that semantic partition', async () => {
    const sc = weaveSemanticCache({ embed: async (t) => [t.length, 1], defaultThreshold: 0.1 });
    await sc.store('q', { content: 'A' }, { scope: 't=A|u=1' });
    await sc.store('q', { content: 'B' }, { scope: 't=A|u=2' });
    const inv = createCacheInvalidator({ store: weaveInMemoryCacheStore(), semanticCache: sc });
    await inv.invalidate({ semantic: true, semanticScope: 't=A|u=1' });
    expect(await sc.find('q', { scope: 't=A|u=1' })).toBeNull();
    expect(await sc.find('q', { scope: 't=A|u=2' })).toBeTruthy();
  });
});

describe('createCacheInvalidator — event-driven rules', () => {
  const rules: CacheInvalidationRule[] = [
    { id: 'r1', name: 'prompt change', trigger: 'prompt_update', config: { clearAll: true }, enabled: true },
    { id: 'r2', name: 'user logout', trigger: 'session_end', config: { prefixFromPayload: 'scopePrefix' }, enabled: true },
    { id: 'r3', name: 'disabled', trigger: 'prompt_update', config: { clearAll: true }, enabled: false },
  ];

  it('a matching event clears the whole store', async () => {
    const store = weaveInMemoryCacheStore();
    await store.set('a', 1, 60_000);
    const inv = createCacheInvalidator({ store, getRules: () => rules });
    const res = await inv.handleEvent({ type: 'prompt_update' });
    expect(res.matched).toBe(1); // only the enabled rule
    expect(await store.size()).toBe(0);
  });

  it('an unmatched event clears nothing', async () => {
    const store = weaveInMemoryCacheStore();
    await store.set('a', 1, 60_000);
    const inv = createCacheInvalidator({ store, getRules: () => rules });
    const res = await inv.handleEvent({ type: 'unrelated_event' });
    expect(res.matched).toBe(0);
    expect(await store.size()).toBe(1);
  });

  it('a payload-scoped event erases just that scope (session_end → one user)', async () => {
    const store = weaveInMemoryCacheStore();
    await store.set(key({ tenantId: 'tA', userId: 'u1' }, 'q'), 1, 60_000);
    await store.set(key({ tenantId: 'tA', userId: 'u2' }, 'q'), 2, 60_000);
    const inv = createCacheInvalidator({ store, getRules: () => rules });
    const res = await inv.handleEvent({ type: 'session_end', payload: { scopePrefix: 't=tA|u=u1||' } });
    expect(res.matched).toBe(1);
    expect(await store.has(key({ tenantId: 'tA', userId: 'u2' }, 'q'))).toBe(true);
    expect(await store.has(key({ tenantId: 'tA', userId: 'u1' }, 'q'))).toBe(false);
  });
});

describe('applyInvalidation — store enhancements', () => {
  it('honours config.prefix via deleteByPrefix', async () => {
    const store = weaveInMemoryCacheStore();
    await store.set('t=A|u=1||x', 1, 60_000);
    await store.set('t=B|u=1||y', 2, 60_000);
    const n = await applyInvalidation(store, [{ id: 'r', name: 'r', trigger: 'e', config: { prefix: 't=A|' }, enabled: true }]);
    expect(n).toBe(1);
    expect(await store.has('t=B|u=1||y')).toBe(true);
  });

  it('stress: prefix-invalidate one of 5000 scoped entries leaves the rest', async () => {
    const store = weaveInMemoryCacheStore({ maxEntries: 10_000 });
    for (let i = 0; i < 5_000; i++) await store.set(`t=A|u=${i}||k`, i, 60_000);
    const inv = createCacheInvalidator({ store });
    const removed = await inv.invalidate({ prefix: 't=A|u=42||' });
    expect(removed).toBe(1);
    expect(await store.size()).toBe(4_999);
  });
});
