// SPDX-License-Identifier: MIT
/**
 * Phase 3 — the per-tenant state overlay (enable/disable/priority/pin without forking), hermetic.
 * Per-field nearest-wins down a tenant tree, on the in-memory reference + real SQLite.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  resolveState, resolveStateFor, createInMemoryStateStore, type RealmStateStore,
} from './realm-state.js';
import { createSqlStateStore } from './realm-state-sql.js';
import type { SqlClient } from './realm-store-sql.js';
import type { RealmContext } from './context.js';

// A 3-level org: acme (root) → emea → uk. lineage runs root → self.
const ctxFor = (chain: string[]): RealmContext => ({
  tenantId: chain[chain.length - 1]!, depth: chain.length - 1,
  lineage: chain.map((tenantId, i) => ({ tenantId, depth: i })),
});
const ACME = ctxFor(['acme']);
const EMEA = ctxFor(['acme', 'emea']);
const UK = ctxFor(['acme', 'emea', 'uk']);
const FAMILY = 'skills';
const KEY = 'skill.web-search';

function sqliteClient(db: Database.Database): SqlClient {
  return {
    async query(text, params = []) {
      const stmt = db.prepare(text);
      if (/^\s*(SELECT|PRAGMA|WITH)/i.test(text)) return { rows: stmt.all(...(params as unknown[])) as Array<Record<string, unknown>> };
      stmt.run(...(params as unknown[]));
      return { rows: [] };
    },
  };
}

describe('resolveState (pure) — per-field nearest-wins', () => {
  it('nearest tenant wins each field; unset fields inherit up the lineage', () => {
    // acme (root) disables + sets priority 5; uk re-enables; emea has nothing.
    const overlays = new Map([
      ['acme', { enabled: false, priority: 5, pinnedVersion: null }],
      ['uk', { enabled: true, priority: null, pinnedVersion: 2 }],
    ]);
    const forUk = resolveState(UK, overlays);
    expect(forUk.enabled).toBe(true);          // uk overrides acme's disable
    expect(forUk.priority).toBe(5);            // uk didn't set it → inherits acme's
    expect(forUk.pinnedVersion).toBe(2);       // uk's own
    expect(forUk.sources).toEqual({ enabled: 'uk', priority: 'acme', pinnedVersion: 'uk' });
    expect(forUk.active).toBe(true);

    const forEmea = resolveState(EMEA, overlays);
    expect(forEmea.enabled).toBe(false);       // inherits acme's disable (uk not on emea's lineage)
    expect(forEmea.active).toBe(false);
    expect(forEmea.priority).toBe(5);
  });

  it('active is false only on an explicit disable; null/true keep it on', () => {
    expect(resolveState(ACME, new Map()).active).toBe(true);                                   // nothing set
    expect(resolveState(ACME, new Map([['acme', { enabled: null, priority: 9, pinnedVersion: null }]])).active).toBe(true);
    expect(resolveState(ACME, new Map([['acme', { enabled: false, priority: null, pinnedVersion: null }]])).active).toBe(false);
  });
});

describe.each([
  ['in-memory', (): RealmStateStore => createInMemoryStateStore()],
  ['sqlite', (): RealmStateStore => createSqlStateStore({ client: sqliteClient(new Database(':memory:')), dialect: 'sqlite' })],
])('RealmStateStore on %s', (_label, make) => {
  it('setState merges partials, resolves down the tree, clears on all-null', async () => {
    const store = make();

    // Parent org disables the skill for its whole subtree.
    await store.setState(FAMILY, KEY, 'acme', { enabled: false });
    expect((await resolveStateFor(store, FAMILY, KEY, UK)).active).toBe(false);   // uk inherits
    expect((await resolveStateFor(store, FAMILY, KEY, EMEA)).active).toBe(false);

    // uk re-enables just for itself, and pins a version — a sparse override.
    await store.setState(FAMILY, KEY, 'uk', { enabled: true });
    await store.setState(FAMILY, KEY, 'uk', { pinnedVersion: 3 }); // partial merge, keeps enabled
    const uk = await resolveStateFor(store, FAMILY, KEY, UK);
    expect(uk.active).toBe(true);
    expect(uk.pinnedVersion).toBe(3);
    expect(uk.sources.enabled).toBe('uk');
    // emea still inherits acme's disable.
    expect((await resolveStateFor(store, FAMILY, KEY, EMEA)).active).toBe(false);

    // uk's own row reflects the merge.
    const own = await store.getOwn(FAMILY, KEY, 'uk');
    expect([own?.enabled, own?.pinnedVersion]).toEqual([true, 3]);

    // Clearing uk's overlay drops it back to inheriting acme's disable.
    await store.clearState(FAMILY, KEY, 'uk');
    expect(await store.getOwn(FAMILY, KEY, 'uk')).toBeNull();
    expect((await resolveStateFor(store, FAMILY, KEY, UK)).active).toBe(false);

    // Setting an overlay back to all-null removes it (no dangling empty rows).
    await store.setState(FAMILY, KEY, 'acme', { enabled: null });
    expect(await store.getOwn(FAMILY, KEY, 'acme')).toBeNull();
    expect((await resolveStateFor(store, FAMILY, KEY, UK)).active).toBe(true); // nothing disables it now

    // listForTenant surfaces a tenant's overlays.
    await store.setState(FAMILY, 'skill.a', 'acme', { priority: 1 });
    await store.setState(FAMILY, 'skill.b', 'acme', { enabled: false });
    expect((await store.listForTenant(FAMILY, 'acme')).map((r) => r.logicalKey).sort()).toEqual(['skill.a', 'skill.b']);
  });
});
