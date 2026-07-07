// SPDX-License-Identifier: MIT
/**
 * SQLite-backed StepLockStore. Phase 4: the query logic is shared with the Postgres adapter via one
 * Drizzle implementation — this file just creates the table and wires in the Drizzle SQLite handle.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { StepLockStore } from './step-lock-store.js';
import { sqliteStepLocks, type PgStepLocks } from './drizzle-workflow-schema.js';
import { createDrizzleStepLockStore } from './drizzle-workflow-stores.js';
import { sqliteExec } from './drizzle-exec.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_step_locks (
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  state TEXT NOT NULL,
  locked_at TEXT NOT NULL,
  done_at TEXT,
  output_json TEXT,
  PRIMARY KEY (run_id, step_id)
);
CREATE INDEX IF NOT EXISTS idx_wf_step_locks_run ON wf_step_locks(run_id);
`;

export interface WeaveSqliteStepLockStoreOptions {
  database?: Database.Database;
  databasePath?: string;
}

export function weaveSqliteStepLockStore(
  opts: WeaveSqliteStepLockStoreOptions = {},
): StepLockStore {
  const sqlite = opts.database ?? new Database(opts.databasePath ?? ':memory:');
  sqlite.exec(MIGRATIONS_SQL);
  return createDrizzleStepLockStore({
    db: drizzle(sqlite) as unknown as NodePgDatabase,
    table: sqliteStepLocks as unknown as PgStepLocks,
    exec: sqliteExec,
  });
}
