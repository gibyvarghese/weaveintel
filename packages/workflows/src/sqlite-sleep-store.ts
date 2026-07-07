// SPDX-License-Identifier: MIT
/**
 * SQLite-backed DurableSleepStore. Phase 4: the query logic is shared with the Postgres adapter via one
 * Drizzle implementation — this file just creates the table and wires in the SQLite handle.
 */
import Database from 'better-sqlite3';
import type { DurableSleepStore } from '@weaveintel/core';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sqliteSleeps, type PgSleeps } from './drizzle-workflow-schema.js';
import { createDrizzleSleepStore } from './drizzle-workflow-stores.js';
import { sqliteExec } from './drizzle-exec.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_sleeps (
  run_id TEXT PRIMARY KEY,
  wake_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wf_sleeps_wake ON wf_sleeps(wake_at);
`;

export interface WeaveSqliteSleepStoreOptions {
  database?: Database.Database;
  databasePath?: string;
}

export function weaveSqliteSleepStore(opts: WeaveSqliteSleepStoreOptions = {}): DurableSleepStore {
  const sqlite = opts.database ?? new Database(opts.databasePath ?? ':memory:');
  sqlite.exec(MIGRATIONS_SQL);
  return createDrizzleSleepStore({
    db: drizzle(sqlite) as unknown as NodePgDatabase,
    table: sqliteSleeps as unknown as PgSleeps,
    exec: sqliteExec,
  });
}
