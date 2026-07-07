// SPDX-License-Identifier: MIT
/**
 * SQLite-backed PayloadStore. Phase 4: the query logic is shared with the Postgres adapter via one
 * Drizzle implementation — this file just creates the table and wires in the Drizzle SQLite handle.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PayloadStore } from './payload-store.js';
import { sqlitePayloads, type PgPayloads } from './drizzle-workflow-schema.js';
import { createDrizzlePayloadStore } from './drizzle-workflow-stores.js';
import { sqliteExec } from './drizzle-exec.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_payloads (
  key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_wf_payloads_run ON wf_payloads(run_id);
`;

export interface WeaveSqlitePayloadStoreOptions {
  database?: Database.Database;
  databasePath?: string;
}

export function weaveSqlitePayloadStore(opts: WeaveSqlitePayloadStoreOptions = {}): PayloadStore {
  const sqlite = opts.database ?? new Database(opts.databasePath ?? ':memory:');
  sqlite.exec(MIGRATIONS_SQL);
  return createDrizzlePayloadStore({
    db: drizzle(sqlite) as unknown as NodePgDatabase,
    table: sqlitePayloads as unknown as PgPayloads,
    exec: sqliteExec,
  });
}
