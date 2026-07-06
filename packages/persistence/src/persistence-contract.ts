// SPDX-License-Identifier: MIT
/**
 * A shared conformance ("contract") test harness for durable key/value slots.
 *
 * Every backend — in-memory, SQLite, Postgres, Redis, or your own — should behave *identically*
 * through the `RuntimeKvStore` interface. This harness runs one battery of checks against whatever
 * store you hand it and reports which passed. Point it at each backend and they must all pass — that's
 * how you prove a new backend (e.g. Postgres) is a safe drop-in for an old one (e.g. SQLite) before
 * you migrate. It's framework-agnostic: it returns results, so you assert on them in vitest/jest/etc.
 *
 * It covers four angles:
 *   • positive — set/get/overwrite/delete/list/TTL all do the obvious thing;
 *   • negative — missing keys, empty lists, deleting what isn't there → graceful, never a crash;
 *   • stress   — thousands of keys and bursts of concurrent writes stay correct;
 *   • security — keys/values full of SQL metacharacters are stored as DATA (proves parameterisation),
 *                and one prefix's keys never leak into another's list (tenant isolation).
 */

import type { RuntimeKvStore } from '@weaveintel/core';

export interface ContractCheck {
  readonly name: string;
  readonly tier: 'positive' | 'negative' | 'stress' | 'security';
  readonly ok: boolean;
  readonly detail?: string;
}

export interface PersistenceContractOptions {
  /** Create a store to test. Called once; use a fresh table/namespace so runs don't collide. */
  readonly makeStore: () => Promise<RuntimeKvStore> | RuntimeKvStore;
  /** Optional cleanup after the run (drop the table, close the pool, …). */
  readonly cleanup?: (store: RuntimeKvStore) => Promise<void> | void;
  /** Include the large-scale checks (thousands of keys). Default true. */
  readonly stress?: boolean;
  /** Include the injection / isolation checks. Default true. */
  readonly security?: boolean;
  /** How many keys the stress checks write. Default 5000. */
  readonly stressSize?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run the conformance battery against a store. Returns one result per check (never throws). */
export async function runPersistenceContract(opts: PersistenceContractOptions): Promise<ContractCheck[]> {
  const results: ContractCheck[] = [];
  const store = await opts.makeStore();
  const ns = `ct:${Math.floor(performance.now())}:`; // unique namespace so re-runs don't collide

  const check = async (name: string, tier: ContractCheck['tier'], fn: () => Promise<void>) => {
    try { await fn(); results.push({ name, tier, ok: true }); }
    catch (e) { results.push({ name, tier, ok: false, detail: (e as Error).message }); }
  };
  const assert = (cond: boolean, msg: string) => { if (!cond) throw new Error(msg); };
  const eq = (a: unknown, b: unknown, msg: string) => assert(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

  // ── Positive ──────────────────────────────────────────────────────────────
  await check('set then get round-trips the value', 'positive', async () => {
    await store.set(ns + 'a', 'hello');
    eq(await store.get(ns + 'a'), 'hello', 'get after set');
  });
  await check('overwrite keeps the latest value', 'positive', async () => {
    await store.set(ns + 'b', 'one');
    await store.set(ns + 'b', 'two');
    eq(await store.get(ns + 'b'), 'two', 'get after overwrite');
  });
  await check('delete removes the key and returns true', 'positive', async () => {
    await store.set(ns + 'c', 'x');
    eq(await store.delete(ns + 'c'), true, 'delete returns true');
    eq(await store.get(ns + 'c'), undefined, 'get after delete');
  });
  await check('list by prefix returns matching keys, sorted', 'positive', async () => {
    await store.set(ns + 'list:2', 'b');
    await store.set(ns + 'list:1', 'a');
    await store.set(ns + 'other', 'z');
    const rows = await store.list(ns + 'list:');
    eq(rows.map((r) => r.key), [ns + 'list:1', ns + 'list:2'], 'list keys sorted, prefix-scoped');
    eq(rows.map((r) => r.value), ['a', 'b'], 'list values');
  });
  await check('an empty string value round-trips', 'positive', async () => {
    await store.set(ns + 'empty', '');
    eq(await store.get(ns + 'empty'), '', 'empty value');
  });
  await check('TTL: value is present before expiry and gone after', 'positive', async () => {
    await store.set(ns + 'ttl', 'soon', { ttlMs: 120 });
    eq(await store.get(ns + 'ttl'), 'soon', 'present before expiry');
    await sleep(200);
    eq(await store.get(ns + 'ttl'), undefined, 'gone after expiry');
  });

  // ── Negative ──────────────────────────────────────────────────────────────
  await check('get on a missing key returns undefined', 'negative', async () => {
    eq(await store.get(ns + 'nope'), undefined, 'missing get');
  });
  await check('delete on a missing key returns false (no crash)', 'negative', async () => {
    eq(await store.delete(ns + 'nope'), false, 'missing delete');
  });
  await check('list with no matches returns an empty array', 'negative', async () => {
    eq(await store.list(ns + 'no-such-prefix:'), [], 'empty list');
  });

  // ── Stress ────────────────────────────────────────────────────────────────
  if (opts.stress !== false) {
    const N = opts.stressSize ?? 5000;
    await check(`writes ${N} keys and lists them all correctly`, 'stress', async () => {
      const p = ns + 'bulk:';
      const t0 = performance.now();
      // batches of concurrent writes
      for (let i = 0; i < N; i += 500) {
        await Promise.all(Array.from({ length: Math.min(500, N - i) }, (_, j) => store.set(p + String(i + j).padStart(6, '0'), `v${i + j}`)));
      }
      const rows = await store.list(p);
      eq(rows.length, N, `listed ${N} keys`);
      const probe = Math.floor(N / 2); // a key guaranteed to exist for any N
      eq(await store.get(p + String(probe).padStart(6, '0')), `v${probe}`, 'random key read-back');
      assert(performance.now() - t0 < 60_000, 'bulk write+list within budget');
    });
    await check('a burst of concurrent overwrites converges to a stored value', 'stress', async () => {
      const k = ns + 'race';
      await Promise.all(Array.from({ length: 200 }, (_, i) => store.set(k, `r${i}`)));
      const v = await store.get(k);
      assert(typeof v === 'string' && v.startsWith('r'), 'a value persisted after the race');
    });
  }

  // ── Security ──────────────────────────────────────────────────────────────
  if (opts.security !== false) {
    const payload = `'; DROP TABLE weave_runtime_kv; -- $1 %s \\ "injected" \n ${'x'.repeat(50)}`;
    await check('SQL metacharacters in the VALUE are stored as data (parameterised)', 'security', async () => {
      await store.set(ns + 'inj-v', payload);
      eq(await store.get(ns + 'inj-v'), payload, 'injection payload round-trips unchanged');
    });
    await check('SQL metacharacters in the KEY are stored as data', 'security', async () => {
      const k = ns + `key'; DROP TABLE x; --`;
      await store.set(k, 'safe');
      eq(await store.get(k), 'safe', 'injection key round-trips');
      // and the table still works afterwards
      await store.set(ns + 'still-alive', 'yes');
      eq(await store.get(ns + 'still-alive'), 'yes', 'store still works after injection attempt');
    });
    await check('one prefix does not leak into another (tenant isolation)', 'security', async () => {
      await store.set(ns + 'tenantA:secret', 'A');
      await store.set(ns + 'tenantB:secret', 'B');
      const a = await store.list(ns + 'tenantA:');
      eq(a.map((r) => r.value), ['A'], 'tenantA sees only its own key');
      assert(!a.some((r) => r.value === 'B'), 'tenantB key did not leak into tenantA');
    });
  }

  if (opts.cleanup) { try { await opts.cleanup(store); } catch { /* best effort */ } }
  return results;
}

/** Convenience: true when every check passed. */
export const contractPassed = (results: readonly ContractCheck[]): boolean => results.every((r) => r.ok);
