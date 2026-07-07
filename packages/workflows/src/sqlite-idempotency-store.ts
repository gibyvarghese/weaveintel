// SPDX-License-Identifier: MIT
/**
 * SQLite-backed StepIdempotencyStore. Phase 4: the query logic is shared with the Postgres adapter via
 * one Drizzle implementation — this file just creates the table and wires in the Drizzle SQLite handle.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { StepIdempotencyStore } from './idempotency-store.js';
import { sqliteIdempotency, type PgIdempotency } from './drizzle-workflow-schema.js';
import { createDrizzleIdempotencyStore } from './drizzle-workflow-stores.js';
import { sqliteExec } from './drizzle-exec.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_idempotency (
  key TEXT PRIMARY KEY,
  output_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

export interface WeaveSqliteIdempotencyStoreOptions {
  database?: Database.Database;
  databasePath?: string;
}

export function weaveSqliteIdempotencyStore(
  opts: WeaveSqliteIdempotencyStoreOptions = {},
): StepIdempotencyStore {
  const sqlite = opts.database ?? new Database(opts.databasePath ?? ':memory:');
  sqlite.exec(MIGRATIONS_SQL);
  return createDrizzleIdempotencyStore({
    db: drizzle(sqlite) as unknown as NodePgDatabase,
    table: sqliteIdempotency as unknown as PgIdempotency,
    exec: sqliteExec,
  });
}
