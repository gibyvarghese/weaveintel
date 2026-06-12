/**
 * token-store.test.ts — pluggable + per-tenant token storage.
 */

import { describe, it, expect } from 'vitest';
import { MemoryTokenStore, namespacedTokenStore, type KeyValueStore } from './index.js';

function fakeKv(): KeyValueStore & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => void store.set(k, v),
    removeItem: (k) => void store.delete(k),
  };
}

describe('MemoryTokenStore', () => {
  it('round-trips and clears', async () => {
    const ts = new MemoryTokenStore();
    expect(await ts.get()).toBeNull();
    await ts.set({ token: 't', csrfToken: 'c' });
    expect(await ts.get()).toEqual({ token: 't', csrfToken: 'c' });
    await ts.clear();
    expect(await ts.get()).toBeNull();
  });

  it('accepts an initial value', async () => {
    const ts = new MemoryTokenStore({ token: 't0', csrfToken: 'c0' });
    expect(await ts.get()).toEqual({ token: 't0', csrfToken: 'c0' });
  });
});

describe('namespacedTokenStore', () => {
  it('isolates two tenants under distinct keys on one KV backend', async () => {
    const kv = fakeKv();
    const a = namespacedTokenStore(kv, 'tenant-a');
    const b = namespacedTokenStore(kv, 'tenant-b');
    await a.set({ token: 'ta', csrfToken: 'ca' });
    await b.set({ token: 'tb', csrfToken: 'cb' });
    expect(await a.get()).toEqual({ token: 'ta', csrfToken: 'ca' });
    expect(await b.get()).toEqual({ token: 'tb', csrfToken: 'cb' });
    expect([...kv.store.keys()]).toEqual([
      '@geneweave/auth:tenant-a',
      '@geneweave/auth:tenant-b',
    ]);
  });

  it('degrades a malformed entry to null instead of throwing (logged-out)', async () => {
    const kv = fakeKv();
    kv.store.set('@geneweave/auth:t', 'not-json');
    const ts = namespacedTokenStore(kv, 't');
    expect(await ts.get()).toBeNull();
  });

  it('degrades a partial entry (missing csrfToken) to null', async () => {
    const kv = fakeKv();
    kv.store.set('@geneweave/auth:t', JSON.stringify({ token: 'x' }));
    const ts = namespacedTokenStore(kv, 't');
    expect(await ts.get()).toBeNull();
  });

  it('clear removes only this namespace', async () => {
    const kv = fakeKv();
    const a = namespacedTokenStore(kv, 'a');
    const b = namespacedTokenStore(kv, 'b');
    await a.set({ token: 'ta', csrfToken: 'ca' });
    await b.set({ token: 'tb', csrfToken: 'cb' });
    await a.clear();
    expect(await a.get()).toBeNull();
    expect(await b.get()).toEqual({ token: 'tb', csrfToken: 'cb' });
  });
});
