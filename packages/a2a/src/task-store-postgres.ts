/**
 * @weaveintel/a2a — the Postgres binding of the scoped task store.
 *
 * The package does not depend on a Postgres driver: the caller passes anything with
 * `query(text, values) → { rows, rowCount }` (a `pg` Pool or Client fits). Table DDL is exported as
 * `a2aTaskPostgresDdl({ table })` for the host's own migrations.
 *
 * Isolation is in the SQL: every statement names the tenant, the principal and the client in its WHERE clause
 * (`IS NOT DISTINCT FROM`, so an absent principal matches only an absent one), and the primary key is
 * (tenant_id, id), so two tenants can hold the same id and neither can reach the other's row. A host that also
 * wants row-level security adds its own policy to the table (the policy depends on how the host sets its tenant
 * on the connection, so this package does not guess).
 *
 * Updates are one statement each (status, artifacts and history replaced, metadata merged with `||`), so two
 * concurrent updates never lose each other's metadata.
 *
 * No `subscribe`: a Postgres-backed SubscribeToTask would need LISTEN/NOTIFY or polling, which the host chooses.
 */

import type { A2ATask } from '@weaveintel/core';
import type { A2AScopedTaskStore, A2ATaskScope } from './task-store-scoped.js';
import {
  checkA2ATaskScope,
  checkA2ATaskId,
  a2aPageSize,
  a2aPageOffset,
  notFound,
} from './task-store-scoped.js';

/** What the binding needs from a Postgres driver (`pg.Pool` and `pg.Client` fit). */
export interface A2APgQueryable {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

export interface A2APostgresTaskStoreOptions {
  /** Table name, optionally schema-qualified (`schema.table`). Default `a2a_task`. */
  readonly table?: string;
}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

function checkTable(table: string | undefined): string {
  const t = table ?? 'a2a_task';
  const parts = typeof t === 'string' ? t.split('.') : [];
  if (parts.length < 1 || parts.length > 2 || !parts.every((p) => IDENT.test(p))) {
    throw new Error(
      `A2A Postgres task store: table name "${String(t)}" must be a lower-case identifier, optionally schema.table`,
    );
  }
  return t;
}

/** The DDL for the task table and its indexes. Idempotent (`IF NOT EXISTS`). */
export function a2aTaskPostgresDdl(opts: A2APostgresTaskStoreOptions = {}): string {
  const table = checkTable(opts.table);
  const base = table.replace('.', '_');
  return `
CREATE TABLE IF NOT EXISTS ${table} (
  tenant_id        text        NOT NULL,
  id               text        NOT NULL,
  principal_id     text,
  client_id        text,
  context_id       text        NOT NULL,
  status_state     text        NOT NULL,
  status_timestamp text COLLATE "C" NOT NULL,
  task             jsonb       NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS ${base}_owner_ts_idx ON ${table} (tenant_id, principal_id, client_id, status_timestamp DESC);
CREATE INDEX IF NOT EXISTS ${base}_ctx_idx ON ${table} (tenant_id, context_id);
`.trim();
}

function hasNul(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('\u0000');
  if (Array.isArray(value)) return value.some(hasNul);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(
      ([k, v]) => k.includes('\u0000') || hasNul(v),
    );
  }
  return false;
}

function checkTask(task: A2ATask): void {
  checkA2ATaskId(task?.id);
  if (typeof task.contextId !== 'string')
    throw new Error('A2A Postgres task store: task.contextId must be a string');
  if (
    !task.status ||
    typeof task.status.state !== 'string' ||
    typeof task.status.timestamp !== 'string'
  ) {
    throw new Error('A2A Postgres task store: task.status needs a state and a timestamp');
  }
  if (hasNul(task))
    throw new Error(
      'A2A Postgres task store: the task holds a NUL character, which Postgres text cannot store',
    );
}

function parseTask(raw: unknown): A2ATask {
  return (typeof raw === 'string' ? JSON.parse(raw) : raw) as A2ATask;
}

/** Postgres binding of `A2AScopedTaskStore`. Create the table first with `a2aTaskPostgresDdl`. */
export function createPostgresA2ATaskStore(
  db: A2APgQueryable,
  opts: A2APostgresTaskStoreOptions = {},
): A2AScopedTaskStore {
  const table = checkTable(opts.table);
  // $1 tenant, $2 principal, $3 client in every statement.
  const OWNER = `tenant_id = $1 AND principal_id IS NOT DISTINCT FROM $2::text AND client_id IS NOT DISTINCT FROM $3::text`;
  const ownerValues = (scope: A2ATaskScope): [string, string | null, string | null] => {
    const s = checkA2ATaskScope(scope);
    return [s.tenantId, s.principalId, s.clientId];
  };

  return {
    async save(scope, task) {
      const owner = ownerValues(scope);
      checkTask(task);
      const res = await db.query(
        `INSERT INTO ${table} AS t (tenant_id, principal_id, client_id, id, context_id, status_state, status_timestamp, task)
         VALUES ($1, $2::text, $3::text, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (tenant_id, id) DO UPDATE
           SET context_id = EXCLUDED.context_id, status_state = EXCLUDED.status_state,
               status_timestamp = EXCLUDED.status_timestamp, task = EXCLUDED.task, updated_at = now()
           WHERE t.tenant_id = $1 AND t.principal_id IS NOT DISTINCT FROM $2::text AND t.client_id IS NOT DISTINCT FROM $3::text`,
        [
          ...owner,
          task.id,
          task.contextId,
          task.status.state,
          task.status.timestamp,
          JSON.stringify(task),
        ],
      );
      if ((res.rowCount ?? 0) === 0) throw notFound(task.id);
    },

    async load(scope, taskId) {
      const owner = ownerValues(scope);
      const res = await db.query(`SELECT task FROM ${table} WHERE ${OWNER} AND id = $4`, [
        ...owner,
        taskId,
      ]);
      const row = res.rows[0] as { task: unknown } | undefined;
      return row ? parseTask(row.task) : null;
    },

    async list(scope, filter) {
      const owner = ownerValues(scope);
      const size = a2aPageSize(filter);
      const offset = a2aPageOffset(filter);
      const values: unknown[] = [...owner];
      let where = OWNER;
      if (filter?.contextId !== undefined) {
        values.push(filter.contextId);
        where += ` AND context_id = $${values.length}`;
      }
      if (filter?.state !== undefined) {
        values.push(filter.state);
        where += ` AND status_state = $${values.length}`;
      }
      if (filter?.statusTimestampAfter !== undefined) {
        values.push(filter.statusTimestampAfter);
        where += ` AND status_timestamp > $${values.length} COLLATE "C"`;
      }
      values.push(size, offset);
      const res = await db.query(
        `SELECT task, count(*) OVER () AS total FROM ${table} WHERE ${where}
         ORDER BY status_timestamp DESC, id COLLATE "C" DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      );
      const rows = res.rows as { task: unknown; total: string | number }[];
      let total = rows.length > 0 ? Number(rows[0]!.total) : 0;
      if (rows.length === 0 && offset > 0) {
        const c = await db.query(
          `SELECT count(*) AS total FROM ${table} WHERE ${where}`,
          values.slice(0, -2),
        );
        total = Number((c.rows[0] as { total: string | number } | undefined)?.total ?? 0);
      }
      const next = offset + rows.length;
      return {
        tasks: rows.map((r) => parseTask(r.task)),
        ...(next < total ? { nextPageToken: String(next) } : {}),
        totalSize: total,
      };
    },

    async update(scope, taskId, patch) {
      const owner = ownerValues(scope);
      if (hasNul(patch))
        throw new Error(
          'A2A Postgres task store: the patch holds a NUL character, which Postgres text cannot store',
        );
      const replace: Record<string, unknown> = {};
      if (patch.status !== undefined) replace['status'] = patch.status;
      if (patch.artifacts !== undefined) replace['artifacts'] = patch.artifacts;
      if (patch.history !== undefined) replace['history'] = patch.history;
      const meta = patch.metadata !== undefined ? JSON.stringify(patch.metadata) : null;
      const res = await db.query(
        `UPDATE ${table} SET
           task = (task || $5::jsonb)
                  || CASE WHEN $6::jsonb IS NULL THEN '{}'::jsonb
                          ELSE jsonb_build_object('metadata', COALESCE(task->'metadata', '{}'::jsonb) || $6::jsonb) END,
           status_state = COALESCE(($5::jsonb)->'status'->>'state', status_state),
           status_timestamp = COALESCE(($5::jsonb)->'status'->>'timestamp', status_timestamp),
           updated_at = now()
         WHERE ${OWNER} AND id = $4
         RETURNING task`,
        [...owner, taskId, JSON.stringify(replace), meta],
      );
      const row = res.rows[0] as { task: unknown } | undefined;
      if (!row) throw notFound(taskId);
      return parseTask(row.task);
    },

    async delete(scope, taskId) {
      const owner = ownerValues(scope);
      const res = await db.query(`DELETE FROM ${table} WHERE ${OWNER} AND id = $4`, [
        ...owner,
        taskId,
      ]);
      return (res.rowCount ?? 0) > 0;
    },
  };
}
