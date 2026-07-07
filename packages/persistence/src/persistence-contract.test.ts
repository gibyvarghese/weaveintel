// SPDX-License-Identifier: MIT
// Hermetic run of the persistence conformance harness against the always-available backends:
// a plain in-memory store (the reference) and the SQLite slot. Both MUST pass the full battery.
import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeKvStore } from '@weaveintel/core';
import { runPersistenceContract, contractPassed } from './persistence-contract.js';
import { weaveSqlitePersistence } from './runtime-slot.js';

// A minimal in-memory RuntimeKvStore — the reference backend the contract is written against.
function inMemoryKv(): RuntimeKvStore {
  const map = new Map<string, { v: string; exp: number | null }>();
  const alive = (e: number | null) => e === null || e > Date.now();
  return {
    async get(k) { const r = map.get(k); if (!r) return undefined; if (!alive(r.exp)) { map.delete(k); return undefined; } return r.v; },
    async set(k, v, o) { map.set(k, { v, exp: o?.ttlMs && o.ttlMs > 0 ? Date.now() + o.ttlMs : null }); },
    async delete(k) { return map.delete(k); },
    async list(prefix) {
      const out: { key: string; value: string }[] = [];
      for (const [k, r] of [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (!k.startsWith(prefix)) continue;
        if (!alive(r.exp)) { map.delete(k); continue; }
        out.push({ key: k, value: r.v });
      }
      return out;
    },
  };
}

describe('persistence contract — in-memory (reference backend)', () => {
  it('passes every conformance check', async () => {
    const results = await runPersistenceContract({ makeStore: inMemoryKv, stressSize: 2000 });
    const failed = results.filter((r) => !r.ok).map((r) => `${r.tier}/${r.name}: ${r.detail}`);
    expect(failed, failed.join('\n')).toHaveLength(0);
    expect(contractPassed(results)).toBe(true);
    // sanity: all four tiers actually ran
    expect(new Set(results.map((r) => r.tier))).toEqual(new Set(['positive', 'negative', 'stress', 'security']));
  }, 30_000);
});

describe('persistence contract — SQLite slot', () => {
  it('passes every conformance check (drop-in parity with in-memory)', async () => {
    const path = join(tmpdir(), `weave-ct-${Date.now()}.db`);
    const results = await runPersistenceContract({
      makeStore: () => weaveSqlitePersistence({ path }).kv,
      stressSize: 2000,
    });
    const failed = results.filter((r) => !r.ok).map((r) => `${r.tier}/${r.name}: ${r.detail}`);
    expect(failed, failed.join('\n')).toHaveLength(0);
  }, 30_000);
});

describe('persistence contract — harness self-check', () => {
  it('reports a FAILURE when a backend is broken (a store that never persists)', async () => {
    // A deliberately broken store: get always returns undefined. The harness must catch it, not pass.
    const broken: RuntimeKvStore = {
      async get() { return undefined; },
      async set() { /* drops writes */ },
      async delete() { return false; },
      async list() { return []; },
    };
    const results = await runPersistenceContract({ makeStore: () => broken, stress: false, security: false });
    expect(contractPassed(results)).toBe(false);
    expect(results.some((r) => r.tier === 'positive' && !r.ok)).toBe(true);
  }, 15_000);
});
