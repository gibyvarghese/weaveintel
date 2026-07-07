// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  ancestorIds,
  ancestorPaths,
  buildPath,
  depthOf,
  escapeLikePrefix,
  idOf,
  isStrictAncestor,
  parentPathOf,
  rebasePath,
  segmentsOf,
  wouldCreateCycle,
  InvalidTenantIdError,
} from './hierarchy-path.js';
import { createInMemoryTenantHierarchy } from './tenant-hierarchy.js';
import { createSqlTenantHierarchy, type SqlClient } from './tenant-hierarchy-sql.js';
import { runTenantHierarchyContract, contractPassed } from './tenant-hierarchy-contract.js';

// ── pure materialized-path engine ────────────────────────────────────────────────────────────────
describe('hierarchy-path (pure maths)', () => {
  it('builds paths for roots and children', () => {
    expect(buildPath(null, 'acme')).toBe('/acme/');
    expect(buildPath('/acme/', 'emea')).toBe('/acme/emea/');
    expect(buildPath('/acme/emea/', 'uk')).toBe('/acme/emea/uk/');
  });
  it('computes depth, id, parent, segments', () => {
    expect(depthOf('/acme/')).toBe(0);
    expect(depthOf('/acme/emea/uk/')).toBe(2);
    expect(idOf('/acme/emea/uk/')).toBe('uk');
    expect(parentPathOf('/acme/emea/uk/')).toBe('/acme/emea/');
    expect(parentPathOf('/acme/')).toBeNull();
    expect(segmentsOf('/acme/emea/uk/')).toEqual(['acme', 'emea', 'uk']);
  });
  it('derives ancestors root-first, excluding self', () => {
    expect(ancestorPaths('/acme/emea/uk/')).toEqual(['/acme/', '/acme/emea/']);
    expect(ancestorIds('/acme/emea/uk/')).toEqual(['acme', 'emea']);
    expect(ancestorPaths('/acme/')).toEqual([]);
  });
  it('knows strict-ancestor and cycle rules', () => {
    expect(isStrictAncestor('/acme/', '/acme/emea/')).toBe(true);
    expect(isStrictAncestor('/acme/', '/acme/')).toBe(false); // not its own ancestor
    expect(isStrictAncestor('/acme/', '/acme-corp/')).toBe(false); // prefix ambiguity guarded by trailing /
    expect(wouldCreateCycle('/a/b/', '/a/b/c/')).toBe(true); // under own descendant
    expect(wouldCreateCycle('/a/b/', '/a/b/')).toBe(true); // under itself
    expect(wouldCreateCycle('/a/b/', '/x/')).toBe(false); // fine
    expect(wouldCreateCycle('/a/b/', null)).toBe(false); // to root
  });
  it('rebases a path when a subtree moves', () => {
    expect(rebasePath('/acme/emea/', '/globex/emea/', '/acme/emea/uk/')).toBe('/globex/emea/uk/');
    expect(rebasePath('/acme/emea/', '/emea/', '/acme/emea/')).toBe('/emea/');
  });
  it('rejects ids that break the path invariant', () => {
    expect(() => buildPath(null, 'a/b')).toThrow(InvalidTenantIdError);
    expect(() => buildPath(null, '')).toThrow(InvalidTenantIdError);
  });
  it('escapes LIKE wildcards in a prefix', () => {
    expect(escapeLikePrefix('/a_x/')).toBe('/a\\_x/');
    expect(escapeLikePrefix('/50%/')).toBe('/50\\%/');
    expect(escapeLikePrefix('/a\\b/')).toBe('/a\\\\b/');
  });
});

// ── a ~6-line better-sqlite3 → SqlClient wrapper (this is exactly what an adopter writes) ──────────
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

// ── the conformance contract, run against three interchangeable stores ────────────────────────────
describe('TenantHierarchyStore conformance', () => {
  it('in-memory reference passes the full contract', async () => {
    const results = await runTenantHierarchyContract({ makeStore: () => createInMemoryTenantHierarchy() });
    const failed = results.filter((r) => !r.ok);
    expect(failed, failed.map((f) => `${f.name}: ${f.error}`).join('\n')).toHaveLength(0);
    expect(contractPassed(results)).toBe(true);
  });

  it('SQL store on real SQLite passes the SAME contract (byte-for-byte parity)', async () => {
    const results = await runTenantHierarchyContract({
      makeStore: () => {
        const db = new Database(':memory:');
        return createSqlTenantHierarchy({ client: sqliteClient(db), dialect: 'sqlite' });
      },
    });
    const failed = results.filter((r) => !r.ok);
    expect(failed, failed.map((f) => `${f.name}: ${f.error}`).join('\n')).toHaveLength(0);
  });
});

// ── a realistic single-org (community edition) smoke: the tree collapses to one node ─────────────
describe('single-org (community) degradation', () => {
  it('ensureDefault + no children behaves like a flat, unaware install', async () => {
    const db = new Database(':memory:');
    const org = createSqlTenantHierarchy({ client: sqliteClient(db), dialect: 'sqlite' });
    const def = await org.ensureDefault({ name: 'My Company' });
    expect(def.id).toBe('default');
    expect(def.depth).toBe(0);
    expect(await org.ancestors('default')).toEqual([]);
    expect(await org.descendants('default')).toEqual([]);
    expect(await org.count()).toBe(1);
  });
});
