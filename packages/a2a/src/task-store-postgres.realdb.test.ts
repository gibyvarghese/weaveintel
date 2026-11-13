/**
 * The Postgres binding of the scoped task store, proven against a real Postgres (no mocks).
 *
 * It runs only when `A2A_PG_TEST_DATABASE` names an empty database the caller owns (it is skipped otherwise,
 * so `vitest run` in CI without a database still passes). Connection details come from the usual `PG*`
 * environment variables; the test never builds or prints a connection string. Each contract test gets its
 * own table; every table is dropped at the end.
 *
 *   1. The shared contract (the same battery the in-memory reference passes).
 *   2. Binding specifics: the DDL is idempotent, a hostile table name is refused, the tenant filter is in
 *      the SQL itself (not only in the code that reads rows back), concurrent updates do not lose a write.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import type { A2ATask } from '@weaveintel/core';
import {
  createPostgresA2ATaskStore,
  a2aTaskPostgresDdl,
  type A2APgQueryable,
} from './task-store-postgres.js';
import { a2aScopedTaskStoreContract } from './scoped-task-store-contract.js';
import { newA2ATaskId } from './task-store-scoped.js';

const DATABASE = process.env['A2A_PG_TEST_DATABASE'];

describe.skipIf(!DATABASE)('Postgres A2A task store (real Postgres)', () => {
  let pool: pg.Pool;
  const tables: string[] = [];
  let seq = 0;
  const run = `${process.pid}_${Date.now() % 100000}`;

  async function freshStore(): Promise<ReturnType<typeof createPostgresA2ATaskStore>> {
    const table = `a2a_task_ct_${run}_${++seq}`;
    tables.push(table);
    await pool.query(a2aTaskPostgresDdl({ table }));
    return createPostgresA2ATaskStore(pool, { table });
  }

  beforeAll(async () => {
    pool = new pg.Pool({ database: DATABASE, max: 4 });
    pool.on('error', () => {});
    await pool.query('SELECT 1');
  });

  afterAll(async () => {
    for (const t of tables) await pool.query(`DROP TABLE IF EXISTS ${t}`).catch(() => {});
    await pool?.end().catch(() => {});
  });

  // 1) The same contract the in-memory reference passes.
  a2aScopedTaskStoreContract(() => freshStore(), { describe, it, beforeEach, expect });

  // 2) Binding specifics.
  const scope = { tenantId: 'tenant-a', principalId: 'p1', clientId: 'c1' };
  const task = (over: Partial<A2ATask> = {}): A2ATask => ({
    id: newA2ATaskId(),
    contextId: 'c',
    status: { state: 'TASK_STATE_WORKING', timestamp: '2026-11-14T00:00:00.000Z' },
    artifacts: [],
    history: [],
    ...over,
  });

  it('creates the table idempotently', async () => {
    const table = `a2a_task_idem_${run}`;
    tables.push(table);
    await pool.query(a2aTaskPostgresDdl({ table }));
    await pool.query(a2aTaskPostgresDdl({ table }));
    const store = createPostgresA2ATaskStore(pool, { table });
    const t1 = task();
    await store.save(scope, t1);
    expect(await store.load(scope, t1.id)).toEqual(t1);
  });

  it('refuses a table name that is not a plain identifier', () => {
    for (const table of [
      'x; DROP TABLE y',
      'a-b',
      '1abc',
      '"quoted"',
      '',
      'a.b.c',
      'x'.repeat(64),
    ]) {
      expect(() => a2aTaskPostgresDdl({ table })).toThrow(/table/);
      expect(() => createPostgresA2ATaskStore(pool, { table })).toThrow(/table/);
    }
  });

  it('accepts a schema-qualified table name', () => {
    expect(a2aTaskPostgresDdl({ table: 'public.a2a_task' })).toMatch(/public\.a2a_task/);
  });

  it('puts the tenant, principal and client in every statement it sends', async () => {
    const table = `a2a_task_sql_${run}`;
    tables.push(table);
    await pool.query(a2aTaskPostgresDdl({ table }));
    const seen: { text: string; values: readonly unknown[] }[] = [];
    const spy: A2APgQueryable = {
      query: (text: string, values?: readonly unknown[]) => {
        seen.push({ text, values: values ?? [] });
        return pool.query(text, values as unknown[]) as never;
      },
    };
    const store = createPostgresA2ATaskStore(spy, { table });
    const t1 = task();
    await store.save(scope, t1);
    await store.load(scope, t1.id);
    await store.list(scope);
    await store.update(scope, t1.id, { metadata: { x: 1 } });
    await store.delete(scope, t1.id);
    expect(seen.length).toBeGreaterThanOrEqual(5);
    for (const { text, values } of seen) {
      expect(text).toMatch(/tenant_id/);
      expect(values).toContain('tenant-a');
      expect(values).toContain('p1');
      expect(values).toContain('c1');
    }
  });

  it('loses no metadata key when two updates race', async () => {
    const store = await freshStore();
    const t1 = task({ metadata: {} });
    await store.save(scope, t1);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.update(scope, t1.id, { metadata: { [`k${i}`]: i } }),
      ),
    );
    const loaded = await store.load(scope, t1.id);
    expect(Object.keys(loaded?.metadata ?? {})).toHaveLength(20);
  });

  it('refuses a NUL character (which Postgres text cannot hold) cleanly, and stores nothing', async () => {
    const store = await freshStore();
    await expect(store.save(scope, task({ contextId: 'nul\u0000byte' }))).rejects.toThrow(/NUL/);
    await expect(store.save(scope, task({ metadata: { note: 'nul\u0000byte' } }))).rejects.toThrow(
      /NUL/,
    );
    expect((await store.list(scope)).tasks).toHaveLength(0);
  });
});
