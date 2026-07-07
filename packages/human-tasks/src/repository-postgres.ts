// SPDX-License-Identifier: MIT
/**
 * @weaveintel/human-tasks — the Postgres adapter for the {@link HumanTaskRepository} port.
 *
 * --- For someone new to this ---
 * Human tasks are the "a person needs to approve/review this" items an agent creates and a human works.
 * The package already defines the port (the one doorway to task storage) and ships in-memory and
 * JSON-file versions; this is the real, durable Postgres one. All of them pass the shared contract
 * ({@link humanTaskRepositoryContract}), so an app can move its task storage onto Postgres and trust the
 * behaviour is unchanged. That's Phase 3 of the persistence review — the SQL lives here, behind the port.
 *
 * Storage shape (a common, robust pattern): the full task is kept as one JSONB document (so every field,
 * including nested `data`/`provenance`, round-trips exactly), and the few fields we actually filter on
 * (status, type, assignee, priority, workflow id, created time) are ALSO pulled out into plain columns
 * with an index — fast to query, nothing duplicated by hand.
 *
 * The important part is claiming work. `claimNextPending` uses Postgres' `FOR UPDATE SKIP LOCKED`: it
 * atomically picks the highest-priority, oldest pending task, skips any a colleague is already taking,
 * and marks it assigned — in ONE statement. That's the idiomatic, race-free way to build a work queue on
 * Postgres: two workers can never be handed the same task, and a crashed worker's lock is released
 * automatically. Every value is a bound parameter; tables are created on first use.
 */

import type { Pool } from 'pg';
import type { HumanTask, HumanTaskFilter } from '@weaveintel/core';
import type { HumanTaskRepository } from './repository.js';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface PostgresHumanTaskRepositoryOptions {
  /** A `pg.Pool` (or pool-shaped client). Share one across your app — e.g. from `weaveSharedPostgres`. */
  readonly pool: Pool;
  /** Table to store tasks in. Validated as a plain identifier. Default `human_tasks`. */
  readonly table?: string;
  /** Skip `CREATE TABLE IF NOT EXISTS` on first use (e.g. when you manage the schema yourself). */
  readonly ensureSchema?: boolean;
}

/**
 * Build a Postgres-backed {@link HumanTaskRepository}. Pass a `pg.Pool` (share one across your app).
 *
 * @example
 * ```ts
 * import pg from 'pg';
 * const repo = createPostgresHumanTaskRepository({ pool: new pg.Pool({ connectionString: process.env.DATABASE_URL }) });
 * await repo.save({ id: 't1', type: 'approval', title: 'Approve refund', status: 'pending', priority: 'high', createdAt: new Date().toISOString() });
 * const mine = await repo.claimNextPending('worker-1'); // atomically assigned to me
 * ```
 */
export function createPostgresHumanTaskRepository(opts: PostgresHumanTaskRepositoryOptions): HumanTaskRepository {
  const pool = opts.pool;
  const table = opts.table ?? 'human_tasks';
  if (!IDENTIFIER.test(table)) {
    throw new Error(`createPostgresHumanTaskRepository: invalid table name "${table}" (letters, numbers and underscores only).`);
  }

  let ready: Promise<void> | undefined;
  const ensureSchema = (): Promise<void> => {
    if (opts.ensureSchema === false) return Promise.resolve();
    return (ready ??= pool
      .query(
        `CREATE TABLE IF NOT EXISTS ${table} (
           id TEXT PRIMARY KEY,
           status TEXT NOT NULL,
           type TEXT NOT NULL,
           assignee TEXT,
           priority TEXT NOT NULL,
           workflow_run_id TEXT,
           created_at TEXT NOT NULL,
           doc JSONB NOT NULL
         );
         CREATE INDEX IF NOT EXISTS ${table}_claim_idx ON ${table} (status, priority, created_at);
         CREATE INDEX IF NOT EXISTS ${table}_assignee_idx ON ${table} (assignee);`,
      )
      .then(() => undefined));
  };

  const applyFilter = (filter: HumanTaskFilter | undefined, params: unknown[]): string => {
    const where: string[] = [];
    if (filter?.status?.length) { params.push(filter.status); where.push(`status = ANY($${params.length}::text[])`); }
    if (filter?.type?.length) { params.push(filter.type); where.push(`type = ANY($${params.length}::text[])`); }
    if (filter?.assignee) { params.push(filter.assignee); where.push(`assignee = $${params.length}`); }
    if (filter?.priority?.length) { params.push(filter.priority); where.push(`priority = ANY($${params.length}::text[])`); }
    if (filter?.workflowRunId) { params.push(filter.workflowRunId); where.push(`workflow_run_id = $${params.length}`); }
    return where.length ? ` WHERE ${where.join(' AND ')}` : '';
  };

  return {
    async save(task: HumanTask) {
      await ensureSchema();
      await pool.query(
        `INSERT INTO ${table} (id, status, type, assignee, priority, workflow_run_id, created_at, doc)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           status = EXCLUDED.status, type = EXCLUDED.type, assignee = EXCLUDED.assignee,
           priority = EXCLUDED.priority, workflow_run_id = EXCLUDED.workflow_run_id,
           created_at = EXCLUDED.created_at, doc = EXCLUDED.doc`,
        [
          task.id, task.status, task.type, task.assignee ?? null, task.priority,
          task.workflowRunId ?? null, task.createdAt, JSON.stringify(task),
        ],
      );
    },

    async get(taskId: string) {
      await ensureSchema();
      const { rows } = await pool.query(`SELECT doc FROM ${table} WHERE id = $1`, [taskId]);
      return rows.length ? (rows[0]!['doc'] as HumanTask) : null;
    },

    async list(filter?: HumanTaskFilter) {
      await ensureSchema();
      const params: unknown[] = [];
      const where = applyFilter(filter, params);
      const { rows } = await pool.query(`SELECT doc FROM ${table}${where} ORDER BY created_at ASC, id ASC`, params);
      return rows.map((r) => r['doc'] as HumanTask);
    },

    async delete(taskId: string) {
      await ensureSchema();
      await pool.query(`DELETE FROM ${table} WHERE id = $1`, [taskId]);
    },

    async claimNextPending(assignee: string) {
      await ensureSchema();
      // One atomic statement: pick the highest-priority, oldest PENDING task, skipping any a colleague
      // is already claiming (FOR UPDATE SKIP LOCKED), mark it assigned, and return it. No double-claim.
      const { rows } = await pool.query(
        `UPDATE ${table} SET
           status = 'assigned',
           assignee = $1,
           doc = jsonb_set(jsonb_set(doc, '{status}', '"assigned"'::jsonb, true), '{assignee}', to_jsonb($1::text), true)
         WHERE id = (
           SELECT id FROM ${table}
           WHERE status = 'pending'
           ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
                    created_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         RETURNING doc`,
        [assignee],
      );
      return rows.length ? (rows[0]!['doc'] as HumanTask) : null;
    },

    async listByAssignee(principalId: string, filter?: HumanTaskFilter) {
      return this.list({ ...filter, assignee: principalId });
    },
  };
}
