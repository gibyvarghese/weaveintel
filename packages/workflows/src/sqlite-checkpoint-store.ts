// SPDX-License-Identifier: MIT
/**
 * SQLite-backed CheckpointStore.
 *
 * Phase 4: the query logic now lives ONCE in `createDrizzleCheckpointStore` (shared with the Postgres
 * adapter) — this file just creates the table and wires the Drizzle SQLite handle in. The full
 * `WorkflowState` snapshot is stored as JSON text; ordering is deterministic via a strictly-increasing
 * `created_at`.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { CheckpointStore } from './checkpoint-store.js';
import { sqliteCheckpoints, type CheckpointTable } from './drizzle-checkpoint-schema.js';
import { createDrizzleCheckpointStore, sqliteExec } from './drizzle-checkpoint-store.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_checkpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  workflow_id TEXT,
  step_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_wf_checkpoints_run ON wf_checkpoints(run_id, created_at, id);
`;

export interface WeaveSqliteCheckpointStoreOptions {
  database?: Database.Database;
  databasePath?: string;
}

export function weaveSqliteCheckpointStore(opts: WeaveSqliteCheckpointStoreOptions = {}): CheckpointStore {
  const sqlite = opts.database ?? new Database(opts.databasePath ?? ':memory:');
  sqlite.exec(MIGRATIONS_SQL);
  const db = drizzle(sqlite);
  // Drizzle's SQLite and Postgres db/table types are deliberately incompatible; the runtime query API
  // is identical, so we bridge the two at this single, well-understood boundary (see the store module).
  return createDrizzleCheckpointStore({
    db: db as unknown as NodePgDatabase,
    table: sqliteCheckpoints as unknown as CheckpointTable,
    exec: sqliteExec,
  });
}
