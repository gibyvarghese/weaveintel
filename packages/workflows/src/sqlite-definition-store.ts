// SPDX-License-Identifier: MIT
/**
 * SQLite-backed WorkflowDefinitionStore. Phase 4: the query logic is shared with the Postgres adapter
 * via one Drizzle implementation — this file just creates the table and wires in the SQLite handle.
 * Lookup by id (PK) or by `name`, matching the in-memory adapter's "id-or-key" resolution.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { WorkflowDefinitionStore } from './definition-store.js';
import { sqliteDefinitions, type PgDefinitions } from './drizzle-workflow-schema.js';
import { createDrizzleDefinitionStore } from './drizzle-workflow-stores.js';
import { sqliteExec } from './drizzle-exec.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wf_definitions_name ON wf_definitions(name);
`;

export interface WeaveSqliteDefinitionStoreOptions {
  database?: Database.Database;
  databasePath?: string;
}

export function weaveSqliteWorkflowDefinitionStore(
  opts: WeaveSqliteDefinitionStoreOptions = {},
): WorkflowDefinitionStore {
  const sqlite = opts.database ?? new Database(opts.databasePath ?? ':memory:');
  sqlite.exec(MIGRATIONS_SQL);
  return createDrizzleDefinitionStore({
    db: drizzle(sqlite) as unknown as NodePgDatabase,
    table: sqliteDefinitions as unknown as PgDefinitions,
    exec: sqliteExec,
  });
}
