// SPDX-License-Identifier: MIT
/**
 * Shared conformance test for the durable memory store (the `write` / `query` / `delete` / `clear` port).
 * After Phase 4 the SAME Drizzle implementation backs both Postgres and SQLite, so we run this one
 * battery against both and prove they behave identically. Framework-agnostic — it just calls the
 * `describe`/`it`/`expect` you hand it.
 */
import { weaveContext, type MemoryEntry, type MemoryStore } from '@weaveintel/core';

export interface MemoryContractTestApi {
  describe: (name: string, fn: () => void) => void;
  it: (name: string, fn: () => void | Promise<void>) => void;
  beforeEach: (fn: () => void | Promise<void>) => void;
  expect: (actual: unknown) => {
    toBe(v: unknown): void;
    toEqual(v: unknown): void;
    toHaveLength(n: number): void;
    [k: string]: unknown;
  };
}

let n = 0;
const uid = (p: string) => `${p}-${++n}`;
const ctx = weaveContext({ tenantId: 'acme', userId: 'u-1' });

function entry(over: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: uid('mem'),
    type: 'semantic',
    content: 'the sky is blue',
    metadata: {},
    createdAt: new Date().toISOString(),
    tenantId: 'acme',
    userId: 'u-1',
    ...over,
  } as MemoryEntry;
}

export function memoryStoreContract(make: () => Promise<MemoryStore & { close?(): Promise<void> }> | (MemoryStore & { close?(): Promise<void> }), t: MemoryContractTestApi): void {
  const { describe, it, beforeEach, expect } = t;
  describe('MemoryStore contract', () => {
    let store: MemoryStore & { close?(): Promise<void> };
    beforeEach(async () => { store = await make(); });

    it('write then query round-trips the entries', async () => {
      const a = entry({ content: 'apples are red' });
      const b = entry({ content: 'grass is green' });
      await store.write(ctx, [a, b]);
      const rows = await store.query(ctx, {});
      const ids = rows.map((r) => r.id);
      expect(ids.includes(a.id) && ids.includes(b.id)).toBe(true);
      expect(rows.find((r) => r.id === a.id)?.content).toBe('apples are red');
    });

    it('query filters by type and by user', async () => {
      const sem = entry({ type: 'semantic', userId: 'alice' });
      const epi = entry({ type: 'episodic', userId: 'alice' });
      const other = entry({ type: 'semantic', userId: 'bob' });
      await store.write(ctx, [sem, epi, other]);
      const semantic = await store.query(ctx, { type: 'semantic', filter: { userId: 'alice' } });
      expect(semantic.map((r) => r.id)).toEqual([sem.id]);
    });

    it('write is an upsert on id (same id overwrites)', async () => {
      const e = entry({ content: 'v1' });
      await store.write(ctx, [e]);
      await store.write(ctx, [{ ...e, content: 'v2' }]);
      const rows = await store.query(ctx, {});
      const mine = rows.filter((r) => r.id === e.id);
      expect(mine).toHaveLength(1);
      expect(mine[0]?.content).toBe('v2');
    });

    it('delete removes the given ids only', async () => {
      const a = entry(); const b = entry();
      await store.write(ctx, [a, b]);
      await store.delete(ctx, [a.id]);
      const ids = (await store.query(ctx, {})).map((r) => r.id);
      expect(ids.includes(a.id)).toBe(false);
      expect(ids.includes(b.id)).toBe(true);
    });

    it('clear(filter) removes only matching entries; clear() removes everything', async () => {
      const alice = entry({ userId: 'alice' });
      const bob = entry({ userId: 'bob' });
      await store.write(ctx, [alice, bob]);
      await store.clear(ctx, { userId: 'alice' });
      const afterFilter = (await store.query(ctx, {})).map((r) => r.id);
      expect(afterFilter.includes(alice.id)).toBe(false);
      expect(afterFilter.includes(bob.id)).toBe(true);
      await store.clear(ctx);
      expect(await store.query(ctx, {})).toHaveLength(0);
    });
  });
}
