// SPDX-License-Identifier: MIT
/**
 * The workflow CheckpointStore, implemented ONCE against Drizzle — and reused for both Postgres and
 * SQLite. This is Phase 4 of the persistence review: collapse the two hand-written per-dialect SQL
 * adapters into a single, type-safe query surface, so there is nothing left to drift.
 *
 * --- How one implementation serves two databases ---
 * Drizzle's query builder is the same across dialects (`db.select().from(t).where(eq(...))`, etc.), so
 * the *logic* below is written a single time. There is exactly ONE genuine difference between the two
 * SQL drivers: node-postgres runs a query when you `await` the builder, while better-sqlite3 is
 * synchronous and runs it when you call `.all()` / `.run()`. We hide that one difference behind a tiny
 * `exec` adapter (`pgExec` / `sqliteExec`), so the store methods don't care which database they're on.
 *
 * Nothing here writes raw SQL, so the classic drift bugs simply can't happen: no `$1`-vs-`?`, no
 * hand-rolled JSON parsing, no `NOW()`-vs-`CURRENT_TIMESTAMP`. Values are bound by Drizzle (injection
 * safe), and a strictly-increasing clock means `created_at` never ties, so "latest" and "in order"
 * are deterministic on either database.
 */
import { asc, desc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { newUUIDv7, type WorkflowCheckpoint, type WorkflowState } from '@weaveintel/core';
import type { CheckpointStore } from './checkpoint-store.js';
import { pgCheckpoints, type CheckpointTable } from './drizzle-checkpoint-schema.js';

export type { CheckpointTable };

/** A checkpoint row as Drizzle reads it back (identical column names on both dialects). */
interface CheckpointRow {
  id: string;
  runId: string;
  workflowId: string | null;
  stepId: string;
  payloadJson: WorkflowState;
  createdAt: string | Date;
}

/**
 * The one dialect seam: node-postgres' Drizzle runs on `await`; better-sqlite3's is synchronous and
 * runs on `.all()` / `.run()`. Each driver supplies its own tiny adapter so the store logic is shared.
 */
export interface DrizzleExec {
  all(builder: unknown): Promise<CheckpointRow[]>;
  run(builder: unknown): Promise<void>;
}

/** node-postgres: the query builder is a thenable — awaiting it executes the query. */
export const pgExec: DrizzleExec = {
  all: (builder) => builder as Promise<CheckpointRow[]>,
  run: (builder) => (builder as Promise<unknown>).then(() => undefined),
};

/** better-sqlite3: synchronous — `.all()` returns rows, `.run()` executes. Wrapped to look async. */
export const sqliteExec: DrizzleExec = {
  all: (builder) => Promise.resolve((builder as { all(): CheckpointRow[] }).all()),
  run: (builder) => { (builder as { run(): unknown }).run(); return Promise.resolve(); },
};

/** Strictly-increasing ISO clock so `created_at` never ties → deterministic ordering on any dialect. */
function monotonicIso(): () => string {
  let last = 0;
  return () => {
    const t = Math.max(Date.now(), last + 1);
    last = t;
    return new Date(t).toISOString();
  };
}

function rowToCheckpoint(row: CheckpointRow): WorkflowCheckpoint {
  // `created_at` is ISO text on new tables; tolerate a legacy Date (an old TIMESTAMPTZ column) too.
  const createdAt = row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt);
  const cp: WorkflowCheckpoint = {
    id: row.id,
    runId: row.runId,
    stepId: row.stepId,
    state: row.payloadJson,
    createdAt,
    ...(row.workflowId ? { workflowId: row.workflowId } : {}),
  };
  return cp;
}

export interface DrizzleCheckpointStoreDeps {
  /** A Drizzle database handle. Typed as the Postgres one (the reference); a SQLite handle is passed with a cast. */
  db: NodePgDatabase;
  /** The dialect's checkpoint table (`pgCheckpoints` or `sqliteCheckpoints`). */
  table: CheckpointTable;
  /** The driver's sync/async execution adapter (`pgExec` or `sqliteExec`). */
  exec: DrizzleExec;
  /** Clock for `created_at`. Defaults to a strictly-increasing ISO clock. Injectable for tests. */
  now?: () => string;
}

/**
 * The single, shared CheckpointStore implementation. Both `weavePostgresCheckpointStore` and
 * `weaveSqliteCheckpointStore` are thin wrappers around this.
 */
export function createDrizzleCheckpointStore(deps: DrizzleCheckpointStoreDeps): CheckpointStore {
  const { db, table, exec } = deps;
  const now = deps.now ?? monotonicIso();

  return {
    async save(runId, stepId, state, workflowId) {
      const cp: WorkflowCheckpoint = {
        id: newUUIDv7(),
        runId,
        stepId,
        state: structuredClone(state),
        createdAt: now(),
        ...(workflowId ? { workflowId } : {}),
      };
      await exec.run(
        db.insert(table).values({
          id: cp.id,
          runId,
          workflowId: workflowId ?? null,
          stepId,
          payloadJson: cp.state,
          createdAt: cp.createdAt,
        }),
      );
      return cp;
    },

    async load(checkpointId) {
      const rows = await exec.all(db.select().from(table).where(eq(table.id, checkpointId)).limit(1));
      return rows[0] ? rowToCheckpoint(rows[0]) : null;
    },

    async latest(runId) {
      const rows = await exec.all(
        db.select().from(table).where(eq(table.runId, runId)).orderBy(desc(table.createdAt), desc(table.id)).limit(1),
      );
      return rows[0] ? rowToCheckpoint(rows[0]) : null;
    },

    async list(runId) {
      const rows = await exec.all(
        db.select().from(table).where(eq(table.runId, runId)).orderBy(asc(table.createdAt), asc(table.id)),
      );
      return rows.map(rowToCheckpoint);
    },

    async delete(runId) {
      await exec.run(db.delete(table).where(eq(table.runId, runId)));
    },
  };
}

/** Re-exported so wrappers can reference the reference table type without re-importing the schema. */
export { pgCheckpoints };
