// SPDX-License-Identifier: MIT
/**
 * Phase 2 — version log + package-upgrade reconcile (the "self-upgrade" engine), hermetic.
 * Positive, negative and the full six-way drift matrix on the in-memory reference + real SQLite.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createInMemoryVersionLog } from './realm-version.js';
import { createSqlVersionLog, type SqlVersionLogOptions } from './realm-version-sql.js';
import { createInMemoryRealmStore } from './realm-store.js';
import { createSqlRealmStore, type SqlClient } from './realm-store-sql.js';
import {
  classifyDrift, planReconcile, reconcile, resyncToDesired, publishToRealm,
  type DesiredDefault,
} from './reconcile.js';

const FAMILY = 'prompts';
type P = { template: string };
const def = (logicalKey: string, template: string): DesiredDefault<P> => ({ logicalKey, payload: { template } });

// ── the ~6-line better-sqlite3 → SqlClient wrapper an adopter writes ─────────────────────────────
function sqliteClient(db: Database.Database): SqlClient {
  return {
    async query(text, params = []) {
      const stmt = db.prepare(text);
      if (/^\s*(SELECT|PRAGMA)/i.test(text)) return { rows: stmt.all(...(params as unknown[])) as Array<Record<string, unknown>> };
      stmt.run(...(params as unknown[]));
      return { rows: [] };
    },
  };
}

describe('classifyDrift (pure) — the conffile six-way matrix', () => {
  it('covers new / removed / in_sync / customized / stale / diverged / unmanaged', () => {
    expect(classifyDrift(null, null, 'R')).toBe('new');        // shipped, not in store yet
    expect(classifyDrift('B', 'L', null)).toBe('removed');     // in store, no longer shipped
    expect(classifyDrift('B', 'B', 'B')).toBe('in_sync');      // nobody changed anything
    expect(classifyDrift('B', 'L', 'B')).toBe('customized');   // you edited, we didn't
    expect(classifyDrift('B', 'B', 'R')).toBe('stale');        // we changed, you didn't
    expect(classifyDrift('B', 'L', 'R')).toBe('diverged');     // both changed
    expect(classifyDrift(null, 'L', 'L')).toBe('in_sync');     // unmanaged but identical
    expect(classifyDrift(null, 'L', 'R')).toBe('diverged');    // unmanaged + differs → never auto-overwrite
  });
});

describe('version log (in-memory) — append-only + content-addressed', () => {
  it('dedupes identical content, versions changes, keeps history', async () => {
    const log = createInMemoryVersionLog<P>();
    const v1 = await log.append({ family: FAMILY, logicalKey: 'k', payload: { template: 'A' }, at: '2026-01-01T00:00:00Z' });
    expect(v1.version).toBe(1);
    const again = await log.append({ family: FAMILY, logicalKey: 'k', payload: { template: 'A' } }); // same content
    expect(again.version).toBe(1); // no new version
    const v2 = await log.append({ family: FAMILY, logicalKey: 'k', payload: { template: 'B' } });
    expect(v2.version).toBe(2);
    expect((await log.latest(FAMILY, 'k'))?.version).toBe(2);
    expect((await log.history(FAMILY, 'k')).map((v) => v.version)).toEqual([2, 1]);
    expect((await log.at(FAMILY, 'k', 1))?.payload.template).toBe('A');
    expect([...(await log.latestAll(FAMILY)).keys()]).toEqual(['k']);
  });
});

describe('planReconcile (pure) — a package upgrade over a mixed store', () => {
  it('classifies every key correctly', () => {
    // Base = what we shipped last time; Local = store now; Remote = new release.
    const current = new Map([
      ['same', { contentHash: 'h1', payload: { template: '1' } }],
      ['edited', { contentHash: 'hX', payload: { template: 'X' } }],   // operator edited
      ['untouched', { contentHash: 'h2', payload: { template: '2' } }],
      ['both', { contentHash: 'hY', payload: { template: 'Y' } }],     // operator edited
      ['dropped', { contentHash: 'h3', payload: { template: '3' } }],
    ]);
    const baseline = new Map([
      ['same', { contentHash: 'h1', payload: { template: '1' } }],
      ['edited', { contentHash: 'h1e', payload: { template: '1e' } }],
      ['untouched', { contentHash: 'h2', payload: { template: '2' } }],
      ['both', { contentHash: 'h2b', payload: { template: '2b' } }],
      ['dropped', { contentHash: 'h3', payload: { template: '3' } }],
    ]);
    const desired: DesiredDefault<P>[] = [
      def('same', '1'),        // remote hash == base 'h1'? computeContentHash({template:'1'}) — see below
      def('edited', '1e'),     // package unchanged (== baseline content)
      def('untouched', '2new'),// package changed
      def('both', '2new'),     // package changed
      def('added', 'brand-new'),
      // 'dropped' not in desired
    ];
    // Use real hashes so base/remote comparisons are honest for the keys where content equality matters.
    const report = planReconcile<P>({
      current: new Map([
        ['same', { contentHash: hash('1'), payload: { template: '1' } }],
        ['edited', { contentHash: hash('EDIT'), payload: { template: 'EDIT' } }],
        ['untouched', { contentHash: hash('2'), payload: { template: '2' } }],
        ['both', { contentHash: hash('EDIT2'), payload: { template: 'EDIT2' } }],
        ['dropped', { contentHash: hash('3'), payload: { template: '3' } }],
      ]),
      baseline: new Map([
        ['same', { contentHash: hash('1'), payload: { template: '1' } }],
        ['edited', { contentHash: hash('1e'), payload: { template: '1e' } }],
        ['untouched', { contentHash: hash('2'), payload: { template: '2' } }],
        ['both', { contentHash: hash('2'), payload: { template: '2' } }],
        ['dropped', { contentHash: hash('3'), payload: { template: '3' } }],
      ]),
      desired,
    });
    const byKey = Object.fromEntries(report.entries.map((e) => [e.logicalKey, e.state]));
    expect(byKey['same']).toBe('in_sync');
    expect(byKey['edited']).toBe('customized');   // local != base, remote == base
    expect(byKey['untouched']).toBe('stale');     // local == base, remote != base
    expect(byKey['both']).toBe('diverged');       // local != base, remote != base
    expect(byKey['added']).toBe('new');
    expect(byKey['dropped']).toBe('removed');
    expect(report.summary).toMatchObject({ in_sync: 1, customized: 1, stale: 1, diverged: 1, new: 1, removed: 1 });
  });
});

// helper: real content hash of {template}
import { computeContentHash } from './realm-record.js';
function hash(t: string): string { return computeContentHash({ template: t }); }

describe.each([
  ['in-memory', () => ({ store: createInMemoryRealmStore<P>(), log: createInMemoryVersionLog<P>() })],
  ['sqlite', () => {
    const db = new Database(':memory:');
    const client = sqliteClient(db);
    return {
      store: createSqlRealmStore<P>({ client, dialect: 'sqlite' }),
      log: createSqlVersionLog<P>({ client, dialect: 'sqlite' } as SqlVersionLogOptions),
    };
  }],
])('reconcile (applier) on %s — a real package upgrade', (_label, make) => {
  it('publishes new, adopts stale, keeps customized, flags diverged; resync clears it', async () => {
    const { store, log } = make();

    // ── Release 1: first seed. Everything is 'new' → published. ──
    const v1: DesiredDefault<P>[] = [def('a', 'A1'), def('b', 'B1'), def('c', 'C1'), def('d', 'D1')];
    const r1 = await reconcile(store, log, FAMILY, v1, { at: '2026-01-01T00:00:00Z' });
    expect(r1.applied.filter((x) => x.action === 'published')).toHaveLength(4);
    expect(r1.report.summary.new).toBe(4);

    // Re-running the identical seed is a clean no-op.
    const r1again = await reconcile(store, log, FAMILY, v1, { at: '2026-01-01T00:00:00Z' });
    expect(r1again.applied).toHaveLength(0);
    expect(r1again.report.summary.in_sync).toBe(4);

    // ── The operator edits 'b' and 'd' in place (Local changes, no new version recorded). ──
    await store.publishGlobal('b', { template: 'B1-operator-edit' });
    await store.publishGlobal('d', { template: 'D1-operator-edit' });

    // ── Release 2: package changes 'c' and 'd', adds 'e', leaves 'a'/'b'. ──
    const v2: DesiredDefault<P>[] = [def('a', 'A1'), def('b', 'B1'), def('c', 'C2'), def('d', 'D2'), def('e', 'E1')];
    const r2 = await reconcile(store, log, FAMILY, v2, { at: '2026-02-01T00:00:00Z' });
    const state = Object.fromEntries(r2.report.entries.map((e) => [e.logicalKey, e.state]));
    expect(state['a']).toBe('in_sync');    // nobody touched
    expect(state['b']).toBe('customized'); // operator edited, package same → keep operator's
    expect(state['c']).toBe('stale');      // package changed, operator didn't → adopt
    expect(state['d']).toBe('diverged');   // both changed → review
    expect(state['e']).toBe('new');        // added → publish

    // Applied the safe moves only.
    expect(r2.applied.find((x) => x.logicalKey === 'c')?.action).toBe('adopted');
    expect(r2.applied.find((x) => x.logicalKey === 'e')?.action).toBe('published');
    expect(r2.needsReview.map((x) => x.logicalKey).sort()).toEqual(['b', 'd']);

    // The operator's 'b' edit and 'd' edit are intact — never clobbered.
    const bRow = (await store.listAll(['b'])).find((r) => r.realm === 'global')!;
    const dRow = (await store.listAll(['d'])).find((r) => r.realm === 'global')!;
    expect((bRow as unknown as P).template).toBe('B1-operator-edit');
    expect((dRow as unknown as P).template).toBe('D1-operator-edit');
    // 'c' adopted the new default.
    const cRow = (await store.listAll(['c'])).find((r) => r.realm === 'global')!;
    expect((cRow as unknown as P).template).toBe('C2');

    // ── Operator resolves 'd' by taking the shipped version → back to in_sync. ──
    await resyncToDesired(store, log, FAMILY, 'd', { template: 'D2' }, { at: '2026-02-02T00:00:00Z' });
    const r3 = await reconcile(store, log, FAMILY, v2, { at: '2026-02-03T00:00:00Z' });
    expect(Object.fromEntries(r3.report.entries.map((e) => [e.logicalKey, e.state]))['d']).toBe('in_sync');

    // publishToRealm is idempotent on unchanged content (version log dedupes).
    const before = (await log.history(FAMILY, 'a')).length;
    await publishToRealm(store, log, FAMILY, 'a', { template: 'A1' });
    expect((await log.history(FAMILY, 'a')).length).toBe(before);
  });
});
