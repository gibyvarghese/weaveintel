// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  archetypeOf,
  canonicalize,
  computeContentHash,
  driftState,
  globalOriginalFields,
} from './realm-record.js';
import { isVisible, provenanceOf, resolveEffective } from './resolve.js';
import { createInMemoryRealmStore } from './realm-store.js';
import { createSqlRealmStore, type SqlClient } from './realm-store-sql.js';
import { runRealmContract, realmContractPassed, CTX } from './realm-contract.js';

describe('realm-record (pure)', () => {
  it('content hash is stable + order-independent', () => {
    expect(computeContentHash({ a: 1, b: 2 })).toBe(computeContentHash({ b: 2, a: 1 }));
    expect(canonicalize({ b: 1, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":1}');
    expect(computeContentHash({ a: 1 })).not.toBe(computeContentHash({ a: 2 }));
    expect(computeContentHash({ a: 1 }).startsWith('sha256:')).toBe(true);
  });
  it('classifies archetypes by (realm, originId)', () => {
    expect(archetypeOf({ realm: 'global', originId: null })).toBe('global_original');
    expect(archetypeOf({ realm: 'tenant', originId: null })).toBe('tenant_native');
    expect(archetypeOf({ realm: 'tenant', originId: 'x' })).toBe('tenant_override');
  });
  it('drift = git 3-way (Base/Local/Remote)', () => {
    expect(driftState('B', 'B', 'B')).toBe('in_sync');
    expect(driftState('B', 'L', 'B')).toBe('customized');
    expect(driftState('B', 'B', 'R')).toBe('stale');
    expect(driftState('B', 'L', 'R')).toBe('diverged');
    expect(driftState(null, 'L', 'R')).toBe('not_a_fork');
  });
  it('globalOriginalFields', () => {
    const f = globalOriginalFields('k', 'sha256:x');
    expect([f.realm, f.ownerTenantId, f.originId, f.shareMode]).toEqual(['global', null, null, 'private']);
  });
});

describe('resolve (pure)', () => {
  const mk = (o: Partial<Parameters<typeof isVisible>[0]> & { id: string; logicalKey: string }) =>
    ({ realm: 'global', ownerTenantId: null, originId: null, originHash: null, contentHash: 'h', trackMode: 'pin', shareMode: 'private', ...o } as Parameters<typeof isVisible>[0] & { id: string; logicalKey: string; contentHash: string });

  it('visibility: global always; own always; parent only if shared; grandparent only if subtree', () => {
    expect(isVisible(mk({ id: '1', logicalKey: 'k' }), CTX.uk)).toBe(true); // global
    expect(isVisible(mk({ id: '2', logicalKey: 'k', realm: 'tenant', ownerTenantId: 'uk' }), CTX.uk)).toBe(true); // own
    expect(isVisible(mk({ id: '3', logicalKey: 'k', realm: 'tenant', ownerTenantId: 'emea', shareMode: 'private' }), CTX.uk)).toBe(false); // parent private
    expect(isVisible(mk({ id: '4', logicalKey: 'k', realm: 'tenant', ownerTenantId: 'emea', shareMode: 'children' }), CTX.uk)).toBe(true); // parent shared
    expect(isVisible(mk({ id: '5', logicalKey: 'k', realm: 'tenant', ownerTenantId: 'acme', shareMode: 'children' }), CTX.uk)).toBe(false); // grandparent children-only
    expect(isVisible(mk({ id: '6', logicalKey: 'k', realm: 'tenant', ownerTenantId: 'acme', shareMode: 'subtree' }), CTX.uk)).toBe(true); // grandparent subtree
  });
});

// ── the ~6-line better-sqlite3 → SqlClient wrapper an adopter writes ──────────────────────────────
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

describe('RealmConfigStore + resolver conformance', () => {
  it('in-memory reference passes the full contract', async () => {
    const results = await runRealmContract({ makeStore: () => createInMemoryRealmStore() });
    const failed = results.filter((r) => !r.ok);
    expect(failed, failed.map((f) => `${f.name}: ${f.error}`).join('\n')).toHaveLength(0);
    expect(realmContractPassed(results)).toBe(true);
  });

  it('SQL store on real SQLite passes the SAME contract (parity)', async () => {
    const results = await runRealmContract({
      makeStore: () => createSqlRealmStore({ client: sqliteClient(new Database(':memory:')), dialect: 'sqlite' }),
    });
    const failed = results.filter((r) => !r.ok);
    expect(failed, failed.map((f) => `${f.name}: ${f.error}`).join('\n')).toHaveLength(0);
  });
});
