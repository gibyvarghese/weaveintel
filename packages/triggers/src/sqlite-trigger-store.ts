// SPDX-License-Identifier: MIT
/**
 * SQLite-backed TriggerStore. Phase 4: the query logic is shared with the Postgres adapter via one
 * Drizzle implementation — this file just creates the two tables and wires in the SQLite handle.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { TriggerStore } from './dispatcher.js';
import { sqliteTriggers, sqliteInvocations, type PgTriggers, type PgInvocations } from './drizzle-trigger-schema.js';
import { createDrizzleTriggerStore } from './drizzle-trigger-store.js';
import { sqliteExec } from './drizzle-support.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  source_kind TEXT NOT NULL,
  source_config TEXT NOT NULL,
  filter_expr TEXT,
  target_kind TEXT NOT NULL,
  target_config TEXT NOT NULL,
  input_map TEXT,
  rate_limit_per_minute INTEGER,
  metadata TEXT
);
CREATE TABLE IF NOT EXISTS trigger_invocations (
  id TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL,
  fired_at INTEGER NOT NULL,
  source_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  target_ref TEXT,
  error_message TEXT,
  source_event TEXT
);
CREATE INDEX IF NOT EXISTS idx_trigger_invocations_trigger ON trigger_invocations(trigger_id, fired_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_trigger_invocations_status ON trigger_invocations(status, fired_at DESC, id);
`;

export interface WeaveSqliteTriggerStoreOptions {
  database?: Database.Database;
  databasePath?: string;
}

export function weaveSqliteTriggerStore(opts: WeaveSqliteTriggerStoreOptions = {}): TriggerStore {
  const sqlite = opts.database ?? new Database(opts.databasePath ?? ':memory:');
  sqlite.exec(MIGRATIONS_SQL);
  return createDrizzleTriggerStore({
    db: drizzle(sqlite) as unknown as NodePgDatabase,
    triggers: sqliteTriggers as unknown as PgTriggers,
    invocations: sqliteInvocations as unknown as PgInvocations,
    exec: sqliteExec,
  });
}
