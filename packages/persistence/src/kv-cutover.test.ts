// SPDX-License-Identifier: MIT
/**
 * Hermetic tests for the Phase 5 cutover toolkit — backfill, verify, and dual-write — using in-memory
 * KV stores (no Docker). The full SQLite→Postgres cutover on a real database is in
 * kv-cutover.realsandbox.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { weaveInMemoryPersistence, type RuntimeKvStore } from '@weaveintel/core';
import { migrateKv, reconcileKv, weaveDualWriteKv } from './kv-cutover.js';

const kv = () => weaveInMemoryPersistence().kv;
async function seed(store: RuntimeKvStore, entries: Record<string, string>) {
  for (const [k, v] of Object.entries(entries)) await store.set(k, v);
}

describe('cutover toolkit (hermetic)', () => {
  // ── migrateKv (backfill) ────────────────────────────────────────────────────
  it('migrateKv copies every key and the result reconciles clean', async () => {
    const src = kv(); const tgt = kv();
    await seed(src, { 'a': '1', 'b': '2', 'c': '3' });
    const result = await migrateKv(src, tgt);
    expect(result).toEqual({ total: 3, copied: 3, skipped: 0, dryRun: false });
    expect((await reconcileKv(src, tgt)).ok).toBe(true);
  });

  it('migrateKv honours a prefix', async () => {
    const src = kv(); const tgt = kv();
    await seed(src, { 'cost:1': 'x', 'cost:2': 'y', 'dlq:1': 'z' });
    const result = await migrateKv(src, tgt, { prefix: 'cost:' });
    expect(result.total).toBe(2);
    expect(await tgt.get('dlq:1')).toBeUndefined();
    expect(await tgt.get('cost:1')).toBe('x');
  });

  it('migrateKv with overwrite:false skips keys already in the target', async () => {
    const src = kv(); const tgt = kv();
    await seed(src, { 'a': 'new', 'b': 'new' });
    await seed(tgt, { 'a': 'old' });
    const result = await migrateKv(src, tgt, { overwrite: false });
    expect(result).toMatchObject({ total: 2, copied: 1, skipped: 1 });
    expect(await tgt.get('a')).toBe('old'); // not overwritten
    expect(await tgt.get('b')).toBe('new');
  });

  it('migrateKv dryRun counts without writing, and reports progress', async () => {
    const src = kv(); const tgt = kv();
    await seed(src, Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, `v${i}`])));
    const progress: number[] = [];
    const result = await migrateKv(src, tgt, { dryRun: true, batchSize: 5, onProgress: (d) => progress.push(d) });
    expect(result).toMatchObject({ total: 12, copied: 12, dryRun: true });
    expect((await tgt.list('')).length).toBe(0); // nothing written
    expect(progress).toEqual([5, 10, 12]);       // batched progress
  });

  // ── reconcileKv (verify) — the negative cases that keep you from a bad cutover ──
  it('reconcileKv flags missing, extra, and mismatched keys', async () => {
    const src = kv(); const tgt = kv();
    await seed(src, { 'same': '1', 'changed': 'A', 'onlySrc': 'x' });
    await seed(tgt, { 'same': '1', 'changed': 'B', 'onlyTgt': 'y' });
    const r = await reconcileKv(src, tgt);
    expect(r.ok).toBe(false);
    expect(r.missingInTarget).toEqual(['onlySrc']);
    expect(r.extraInTarget).toEqual(['onlyTgt']);
    expect(r.valueMismatches).toEqual(['changed']);
    expect(r).toMatchObject({ sourceCount: 3, targetCount: 3 });
  });

  it('reconcileKv caps samples and marks the report truncated', async () => {
    const src = kv(); const tgt = kv();
    await seed(src, Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`m${i}`, 'v'])));
    const r = await reconcileKv(src, tgt, { maxSamples: 3 });
    expect(r.missingInTarget.length).toBe(3);
    expect(r.truncated).toBe(true);
    expect(r.sourceCount).toBe(10);
  });

  // ── weaveDualWriteKv (expand) ───────────────────────────────────────────────
  it('weaveDualWriteKv writes to both but reads from the primary', async () => {
    const oldStore = kv(); const newStore = kv();
    const dual = weaveDualWriteKv(oldStore, newStore);
    await dual.set('k', 'v');
    expect(await oldStore.get('k')).toBe('v');
    expect(await newStore.get('k')).toBe('v'); // new stays current
    expect(await dual.get('k')).toBe('v');      // reads come from primary (old)
    expect(await dual.delete('k')).toBe(true);
    expect(await oldStore.get('k')).toBeUndefined();
    expect(await newStore.get('k')).toBeUndefined(); // delete propagates
  });

  it('weaveDualWriteKv shadow-reads and reports a divergence', async () => {
    const oldStore = kv(); const newStore = kv();
    await oldStore.set('k', 'OLD');
    await newStore.set('k', 'DRIFTED'); // the two disagree
    const mismatches: string[] = [];
    const dual = weaveDualWriteKv(oldStore, newStore, { shadowReadRatio: 1, onMismatch: (key) => mismatches.push(key) });
    expect(await dual.get('k')).toBe('OLD'); // still serves the primary
    expect(mismatches).toEqual(['k']);       // …but the drift was caught
  });

  it('weaveDualWriteKv treats the secondary as best-effort (unless told otherwise)', async () => {
    const oldStore = kv();
    const faultySecondary: RuntimeKvStore = { ...kv(), set: () => Promise.reject(new Error('new DB down')) };
    const errors: string[] = [];
    const dual = weaveDualWriteKv(oldStore, faultySecondary, { onSecondaryError: (op, key) => errors.push(`${op}:${key}`) });
    await dual.set('k', 'v'); // does NOT throw — the request still succeeds against the primary
    expect(await oldStore.get('k')).toBe('v');
    expect(errors).toEqual(['set:k']);

    const strict = weaveDualWriteKv(oldStore, faultySecondary, { failOnSecondaryError: true });
    await expect(strict.set('k2', 'v')).rejects.toThrow('new DB down');
  });

  // ── The whole flow, in order ────────────────────────────────────────────────
  it('end-to-end: dual-write new traffic, backfill the rest, reconcile, then cut over', async () => {
    const oldStore = kv(); const newStore = kv();
    // History that predates the migration.
    await seed(oldStore, { 'dlq:1': 'a', 'cost:1': 'b' });
    // Turn on dual-writes; live traffic now lands in both.
    const dual = weaveDualWriteKv(oldStore, newStore);
    await dual.set('cost:2', 'c');
    // Backfill the pre-existing history into the new store.
    await migrateKv(oldStore, newStore);
    // Verify — green light to cut over.
    expect((await reconcileKv(oldStore, newStore)).ok).toBe(true);
    // After cutover, reads come straight from the new store and have everything.
    expect((await newStore.list('')).length).toBe(3);
    expect(await newStore.get('cost:2')).toBe('c');
  });
});
