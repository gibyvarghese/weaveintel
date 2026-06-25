/**
 * Phase 7 — unit tests for `createRuntimeCacheAdapter`.
 */

import { describe, it, expect } from 'vitest';
import { createRuntimeCacheAdapter } from './runtime-cache-adapter.js';
import { weaveInMemoryCacheStore } from './store.js';

describe('createRuntimeCacheAdapter', () => {
  it('exposes the raw store reference', () => {
    const store = weaveInMemoryCacheStore();
    const slot = createRuntimeCacheAdapter(store);
    expect(slot.store).toBe(store);
  });

  it('get returns null/undefined for missing key', async () => {
    const slot = createRuntimeCacheAdapter(weaveInMemoryCacheStore());
    const result = await slot.get('missing');
    // CacheStore.get returns null for missing keys; the slot passes it through.
    expect(result == null).toBe(true);
  });

  it('set then get round-trips a value', async () => {
    const slot = createRuntimeCacheAdapter(weaveInMemoryCacheStore());
    await slot.set('k1', { hello: 'world' });
    expect(await slot.get('k1')).toEqual({ hello: 'world' });
  });

  it('invalidate removes the entry', async () => {
    const slot = createRuntimeCacheAdapter(weaveInMemoryCacheStore());
    await slot.set('k2', 42);
    await slot.invalidate('k2');
    // CacheStore.get returns null for missing entries after deletion.
    expect(await slot.get('k2')).toBeNull();
  });

  it('semanticGet returns null when no semantic cache is wired', async () => {
    const slot = createRuntimeCacheAdapter(weaveInMemoryCacheStore());
    const result = await slot.semanticGet?.('some query');
    expect(result).toBeNull();
  });

  it('semanticStore is undefined when no semantic cache is passed', () => {
    const slot = createRuntimeCacheAdapter(weaveInMemoryCacheStore());
    expect(slot.semanticStore).toBeUndefined();
  });

  it('multiple keys are independent', async () => {
    const slot = createRuntimeCacheAdapter(weaveInMemoryCacheStore());
    await slot.set('a', 1);
    await slot.set('b', 2);
    expect(await slot.get('a')).toBe(1);
    expect(await slot.get('b')).toBe(2);
  });

  it('overwrites an existing key on set', async () => {
    const slot = createRuntimeCacheAdapter(weaveInMemoryCacheStore());
    await slot.set('dup', 'first');
    await slot.set('dup', 'second');
    expect(await slot.get('dup')).toBe('second');
  });
});
