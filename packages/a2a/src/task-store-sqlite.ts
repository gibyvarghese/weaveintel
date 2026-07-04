/**
 * @weaveintel/a2a — SQLite-backed A2ATaskStore
 *
 * Uses a minimal duck-typed interface for the SQLite DB so that the
 * @weaveintel/a2a package itself does not depend on better-sqlite3.
 * The caller (the host application or any SQLite app) passes in the live db handle.
 *
 * Table: a2a_tasks — DDL exported as A2A_TASKS_DDL for use in migrations.
 *
 * All better-sqlite3 ops are synchronous; we wrap them in Promise.resolve()
 * to satisfy the async A2ATaskStore interface.
 */

import type { A2ATask, A2AListTasksFilter, A2ATaskPage } from '@weaveintel/core';
import type { A2ATaskStore, A2ATaskStorePatch } from './task-store.js';
import { isTerminalA2AState } from './task-store.js';

// ─── Minimal duck-typed DB interface ─────────────────────────────────────────
// Matches the subset of BetterSqlite3.Database used here.
// The caller passes the raw db handle; we never import better-sqlite3 directly.

export interface SqliteStatement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
}

// ─── DDL — exported so host-application migrations can include the same schema ──────

export const A2A_TASKS_DDL = `
CREATE TABLE IF NOT EXISTS a2a_tasks (
  id               TEXT PRIMARY KEY,
  context_id       TEXT NOT NULL,
  status_state     TEXT NOT NULL DEFAULT 'TASK_STATE_SUBMITTED',
  status_timestamp TEXT NOT NULL,
  status_message   TEXT,
  artifacts        TEXT NOT NULL DEFAULT '[]',
  history          TEXT NOT NULL DEFAULT '[]',
  metadata         TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_a2a_tasks_context_id
  ON a2a_tasks(context_id);
CREATE INDEX IF NOT EXISTS idx_a2a_tasks_status_state
  ON a2a_tasks(status_state);
CREATE INDEX IF NOT EXISTS idx_a2a_tasks_status_timestamp
  ON a2a_tasks(status_timestamp DESC);
`.trim();

// ─── Row ──────────────────────────────────────────────────────────────────────

interface TaskRow {
  id: string;
  context_id: string;
  status_state: string;
  status_timestamp: string;
  status_message: string | null;
  artifacts: string;
  history: string;
  metadata: string | null;
}

function rowToTask(row: TaskRow): A2ATask {
  return {
    id: row.id,
    contextId: row.context_id,
    status: {
      state: row.status_state as A2ATask['status']['state'],
      timestamp: row.status_timestamp,
      ...(row.status_message ? { message: JSON.parse(row.status_message) } : {}),
    },
    artifacts: JSON.parse(row.artifacts),
    history: JSON.parse(row.history),
    ...(row.metadata ? { metadata: JSON.parse(row.metadata) } : {}),
  };
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a SQLite-backed A2ATaskStore.
 *
 * The DDL is idempotent (CREATE TABLE IF NOT EXISTS), so it is safe to call
 * this on every server startup — it will only create the table on first run.
 *
 * @param db  A live better-sqlite3 (or compatible synchronous SQLite) database handle.
 */
export function createSqliteA2ATaskStore(db: SqliteDb): A2ATaskStore {
  // Ensure schema exists on first call
  db.exec(A2A_TASKS_DDL);

  const stmts = {
    insert: db.prepare(`
      INSERT INTO a2a_tasks
        (id, context_id, status_state, status_timestamp, status_message, artifacts, history, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    replace: db.prepare(`
      INSERT OR REPLACE INTO a2a_tasks
        (id, context_id, status_state, status_timestamp, status_message, artifacts, history, metadata,
         created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?,
        COALESCE((SELECT created_at FROM a2a_tasks WHERE id = ?), datetime('now')),
        datetime('now'))
    `),
    loadById: db.prepare(`SELECT * FROM a2a_tasks WHERE id = ?`),
    update: db.prepare(`
      UPDATE a2a_tasks
      SET status_state     = ?,
          status_timestamp = ?,
          status_message   = ?,
          artifacts        = ?,
          history          = ?,
          metadata         = ?,
          updated_at       = datetime('now')
      WHERE id = ?
    `),
    deleteById: db.prepare(`DELETE FROM a2a_tasks WHERE id = ?`),
    listAll: db.prepare(`
      SELECT * FROM a2a_tasks
      ORDER BY status_timestamp DESC
      LIMIT ? OFFSET ?
    `),
    listByContext: db.prepare(`
      SELECT * FROM a2a_tasks
      WHERE context_id = ?
      ORDER BY status_timestamp DESC
      LIMIT ? OFFSET ?
    `),
    countAll: db.prepare(`SELECT COUNT(*) as n FROM a2a_tasks`),
    countByContext: db.prepare(`SELECT COUNT(*) as n FROM a2a_tasks WHERE context_id = ?`),
    listByState: db.prepare(`
      SELECT * FROM a2a_tasks
      WHERE status_state = ?
      ORDER BY status_timestamp DESC
      LIMIT ? OFFSET ?
    `),
    listByContextAndState: db.prepare(`
      SELECT * FROM a2a_tasks
      WHERE context_id = ? AND status_state = ?
      ORDER BY status_timestamp DESC
      LIMIT ? OFFSET ?
    `),
    countByState: db.prepare(`SELECT COUNT(*) as n FROM a2a_tasks WHERE status_state = ?`),
    countByContextAndState: db.prepare(`
      SELECT COUNT(*) as n FROM a2a_tasks WHERE context_id = ? AND status_state = ?
    `),
  };

  return {
    async save(task: A2ATask): Promise<void> {
      stmts.replace.run(
        task.id,
        task.contextId,
        task.status.state,
        task.status.timestamp,
        task.status.message ? JSON.stringify(task.status.message) : null,
        JSON.stringify(task.artifacts),
        JSON.stringify(task.history),
        task.metadata ? JSON.stringify(task.metadata) : null,
        task.id, // COALESCE lookup
      );
    },

    async load(taskId: string): Promise<A2ATask | null> {
      const row = stmts.loadById.get(taskId) as TaskRow | undefined;
      return row ? rowToTask(row) : null;
    },

    async list(filter?: A2AListTasksFilter): Promise<A2ATaskPage> {
      const pageSize = filter?.pageSize ?? 50;
      const offset = filter?.pageToken ? parseInt(filter.pageToken, 10) : 0;

      let rows: TaskRow[];
      let total: number;

      if (filter?.contextId && filter?.state) {
        rows = stmts.listByContextAndState.all(filter.contextId, filter.state, pageSize, offset) as TaskRow[];
        total = (stmts.countByContextAndState.get(filter.contextId, filter.state) as { n: number }).n;
      } else if (filter?.contextId) {
        rows = stmts.listByContext.all(filter.contextId, pageSize, offset) as TaskRow[];
        total = (stmts.countByContext.get(filter.contextId) as { n: number }).n;
      } else if (filter?.state) {
        rows = stmts.listByState.all(filter.state, pageSize, offset) as TaskRow[];
        total = (stmts.countByState.get(filter.state) as { n: number }).n;
      } else {
        rows = stmts.listAll.all(pageSize, offset) as TaskRow[];
        total = (stmts.countAll.get() as { n: number }).n;
      }

      // statusTimestampAfter filter applied in-memory (infrequent use case)
      let tasks = rows.map(rowToTask);
      if (filter?.statusTimestampAfter) {
        tasks = tasks.filter((t) => t.status.timestamp > filter.statusTimestampAfter!);
        total = tasks.length;
      }

      const nextOffset = offset + rows.length;
      const nextPageToken = nextOffset < total ? String(nextOffset) : undefined;
      return { tasks, nextPageToken, totalSize: total };
    },

    async update(taskId: string, patch: A2ATaskStorePatch): Promise<A2ATask> {
      const existing = stmts.loadById.get(taskId) as TaskRow | undefined;
      if (!existing) throw new Error(`A2ATaskStore: task not found for update: ${taskId}`);

      const current = rowToTask(existing);
      const updated: A2ATask = {
        ...current,
        ...(patch.status !== undefined && { status: patch.status }),
        ...(patch.artifacts !== undefined && { artifacts: patch.artifacts }),
        ...(patch.history !== undefined && { history: patch.history }),
        ...(patch.metadata !== undefined && {
          metadata: { ...current.metadata, ...patch.metadata },
        }),
      };

      stmts.update.run(
        updated.status.state,
        updated.status.timestamp,
        updated.status.message ? JSON.stringify(updated.status.message) : null,
        JSON.stringify(updated.artifacts),
        JSON.stringify(updated.history),
        updated.metadata ? JSON.stringify(updated.metadata) : null,
        taskId,
      );

      return updated;
    },

    async delete(taskId: string): Promise<boolean> {
      const result = stmts.deleteById.run(taskId);
      return result.changes > 0;
    },

    // subscribe() is intentionally omitted — SQLite has no pub/sub.
    // In-memory store supports it for local use; Redis store for distributed.
    // Callers that need subscribe should use createInMemoryA2ATaskStore() or
    // a Redis-backed store. The A2ATaskStore interface makes subscribe optional.
  };
}

export { isTerminalA2AState };
