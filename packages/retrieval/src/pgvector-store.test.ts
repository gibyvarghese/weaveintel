// SPDX-License-Identifier: MIT
/**
 * pgvector VectorStore that needs a verified principal (GAPS G-WI-18).
 * Before this there was no pgvector VectorStore: the only pgvector code was a memory store whose
 * tenant filter was optional and supplied by the caller.
 *
 * Unit tests use a recording pool. The real-database suite runs when WEAVEINTEL_PGVECTOR_URL
 * points at a Postgres with the pgvector extension.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { weaveContext } from '@weaveintel/core';
import * as retrieval from './index.js';
import { createPrincipalSeal, PrincipalRequiredError, weavePgVectorStore, type PgPoolLike, type VerifiedPrincipal } from './pgvector-store.js';

const SECRET = 'x'.repeat(40);

function recordingPool(rows: Record<string, unknown>[] = []) {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const pool: PgPoolLike = {
    async query(sql: string, params: readonly unknown[] = []) {
      calls.push({ sql, params });
      return { rows: rows as never[] };
    },
    async connect() {
      return { query: pool.query, release() {} };
    },
  };
  return { pool, calls };
}

describe('weavePgVectorStore — refuses without a verified principal', () => {
  const seal = createPrincipalSeal(SECRET);
  const ctx = weaveContext({ tenantId: 't1' });
  const store = (pool: PgPoolLike) => weavePgVectorStore({ pool, dimensions: 3, verifyPrincipal: (_c, p) => seal.verify(p) });

  it('is exported by the package', () => {
    expect(typeof (retrieval as Record<string, unknown>)['weavePgVectorStore']).toBe('function');
  });

  it('cannot be built without verifyPrincipal', () => {
    expect(() => weavePgVectorStore({ pool: recordingPool().pool, dimensions: 3 } as never)).toThrow(PrincipalRequiredError);
  });

  it('refuses a search with no principal, a forged one, an expired one, or another tenant', async () => {
    const { pool, calls } = recordingPool();
    const s = store(pool);
    const base = { embedding: [1, 0, 0], topK: 5 };
    await expect(s.search(ctx, base as never)).rejects.toBeInstanceOf(PrincipalRequiredError);
    const forged: VerifiedPrincipal = { tenantId: 't1', subject: 'mallory', groups: ['admins'], clearance: 9, proof: 'nope', expiresAt: '2999-01-01T00:00:00Z' };
    await expect(s.search(ctx, { ...base, principal: forged })).rejects.toThrow(/could not be verified/);
    const tampered = { ...seal.seal({ tenantId: 't1', subject: 'alice', clearance: 1 }), clearance: 9 };
    await expect(s.search(ctx, { ...base, principal: tampered })).rejects.toThrow(/could not be verified/);
    const old = createPrincipalSeal(SECRET, { now: () => new Date('2020-01-01T00:00:00Z') }).seal({ tenantId: 't1', subject: 'alice' });
    await expect(s.search(ctx, { ...base, principal: old })).rejects.toThrow(/could not be verified/);
    const other = seal.seal({ tenantId: 't2', subject: 'alice' });
    await expect(s.search(ctx, { ...base, principal: other })).rejects.toThrow(/tenant does not match/);
    expect(calls).toHaveLength(0);
  });

  it('filters by tenant, ACL and clearance in SQL, with every value parameterised', async () => {
    const { pool, calls } = recordingPool([{ id: 'a', content: 'x', metadata: { k: 1 }, score: '0.9' }]);
    const s = store(pool);
    const principal = seal.seal({ tenantId: 't1', subject: 'alice', groups: ['ops'], clearance: 2 });
    const out = await s.search(ctx, { embedding: [1, 0, 0], topK: 5, principal, filter: { kind: "x'; DROP TABLE wi_vector; --" } });
    expect(out).toEqual([{ id: 'a', content: 'x', metadata: { k: 1 }, score: 0.9 }]);
    const { sql, params } = calls[0]!;
    expect(sql).toMatch(/tenant_id = \$2 AND acl && \$3::text\[\] AND classification <= \$4/);
    expect(sql).not.toContain('DROP TABLE');
    expect(params.slice(1, 4)).toEqual(['t1', ['*', 'alice', 'ops'], 2]);
  });

  it('scopes writes to the context tenant and refuses a record without an ACL', async () => {
    const { pool, calls } = recordingPool();
    const s = store(pool);
    await expect(s.upsert(ctx, [{ id: 'a', embedding: [1, 0, 0], content: 'x', metadata: {} }])).rejects.toThrow(/acl/);
    await expect(s.upsert(weaveContext(), [{ id: 'a', embedding: [1, 0, 0], content: 'x', metadata: { acl: ['*'] } }])).rejects.toBeInstanceOf(PrincipalRequiredError);
    await s.upsert(ctx, [{ id: 'a', embedding: [1, 0, 0], content: 'x', metadata: { acl: ['ops'], classification: 1, tenantId: 'spoofed' } }]);
    expect(calls[0]!.params[0]).toBe('t1');
    await s.delete(ctx, ['a']);
    expect(calls[1]!.sql).toContain('WHERE tenant_id = $1 AND id = ANY($2::text[])');
  });

  it('sets the transaction-local tenant before querying in RLS mode', async () => {
    const { pool, calls } = recordingPool();
    const s = weavePgVectorStore({ pool, dimensions: 3, verifyPrincipal: (_c, p) => seal.verify(p), rlsTenantSetting: 'app.tenant_id' });
    await s.search(ctx, { embedding: [1, 0, 0], topK: 1, principal: seal.seal({ tenantId: 't1', subject: 'alice' }) });
    expect(calls.map((c) => c.sql.split('\n')[0]!.trim())).toEqual(['BEGIN', 'SELECT set_config($1, $2, true)', expect.stringMatching(/^SELECT id/), 'COMMIT']);
    expect(calls[1]!.params).toEqual(['app.tenant_id', 't1']);
  });

  it('rejects unsafe identifiers and wrong-sized embeddings', async () => {
    expect(() => weavePgVectorStore({ pool: recordingPool().pool, dimensions: 3, table: 'x; drop', verifyPrincipal: () => true })).toThrow(/table/);
    const s = store(recordingPool().pool);
    await expect(s.search(ctx, { embedding: [1, 0], topK: 1, principal: seal.seal({ tenantId: 't1', subject: 'a' }) })).rejects.toThrow(/dimensions/);
  });
});

const PG_URL = process.env['WEAVEINTEL_PGVECTOR_URL'];

describe.skipIf(!PG_URL)('weavePgVectorStore on a real Postgres + pgvector', () => {
  const seal = createPrincipalSeal(SECRET);
  const table = `wi_vector_test_${process.pid}`;
  let pool: import('pg').Pool;
  let s: ReturnType<typeof weavePgVectorStore>;

  beforeAll(async () => {
    const pg = await import('pg');
    pool = new pg.default.Pool({ connectionString: PG_URL });
    s = weavePgVectorStore({ pool, dimensions: 3, table, verifyPrincipal: (_c, p) => seal.verify(p) });
    await s.ensureSchema();
    const t1 = weaveContext({ tenantId: 't1' });
    const t2 = weaveContext({ tenantId: 't2' });
    await s.upsert(t1, [
      { id: 'public', embedding: [1, 0, 0], content: 'tenant one, everyone', metadata: { acl: ['*'], kind: 'kb' } },
      { id: 'ops', embedding: [0.9, 0.1, 0], content: 'tenant one, ops only', metadata: { acl: ['ops'], kind: 'kb' } },
      { id: 'secret', embedding: [0.95, 0.05, 0], content: 'tenant one, restricted', metadata: { acl: ['*'], classification: 3, kind: 'kb' } },
    ]);
    await s.upsert(t2, [{ id: 'other', embedding: [1, 0, 0], content: 'tenant two', metadata: { acl: ['*'] } }]);
  });

  afterAll(async () => {
    await pool?.query(`DROP TABLE IF EXISTS ${table}`);
    await pool?.end();
  });

  it('returns only rows in the principal tenant that its ACL and clearance allow', async () => {
    const ctx = weaveContext({ tenantId: 't1' });
    const alice = seal.seal({ tenantId: 't1', subject: 'alice' });
    expect((await s.search(ctx, { embedding: [1, 0, 0], topK: 10, principal: alice })).map((r) => r.id)).toEqual(['public']);
    const opsLead = seal.seal({ tenantId: 't1', subject: 'bob', groups: ['ops'], clearance: 3 });
    const ids = (await s.search(ctx, { embedding: [1, 0, 0], topK: 10, principal: opsLead })).map((r) => r.id);
    expect(ids.sort()).toEqual(['ops', 'public', 'secret']);
    expect(ids).not.toContain('other');
    const filtered = await s.search(ctx, { embedding: [1, 0, 0], topK: 10, principal: opsLead, filter: { kind: 'none' } });
    expect(filtered).toEqual([]);
    expect(await s.count!(ctx)).toBe(3);
  });

  it('a tenant cannot delete another tenant’s rows', async () => {
    await s.delete(weaveContext({ tenantId: 't2' }), ['public']);
    expect(await s.count!(weaveContext({ tenantId: 't1' }))).toBe(3);
  });
});
