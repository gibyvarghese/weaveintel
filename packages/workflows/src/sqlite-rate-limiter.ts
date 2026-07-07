// SPDX-License-Identifier: MIT
/**
 * SQLite-backed WorkflowRateLimiter (token bucket). Phase 4: the query logic is shared with the
 * Postgres adapter via one Drizzle implementation — this file creates the table and wires the handle.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { WorkflowRateLimiter } from './rate-limiter.js';
import { sqliteRateLimits, type PgRateLimits } from './drizzle-workflow-schema.js';
import { createDrizzleRateLimiter } from './drizzle-workflow-stores.js';
import { sqliteExec } from './drizzle-exec.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_rate_limits (
  workflow_id TEXT PRIMARY KEY,
  tokens REAL NOT NULL,
  last_refill_ms INTEGER NOT NULL
);
`;

export interface WeaveSqliteRateLimiterOptions {
  database?: Database.Database;
  databasePath?: string;
}

export function weaveSqliteRateLimiter(opts: WeaveSqliteRateLimiterOptions = {}): WorkflowRateLimiter {
  const sqlite = opts.database ?? new Database(opts.databasePath ?? ':memory:');
  sqlite.exec(MIGRATIONS_SQL);
  return createDrizzleRateLimiter({
    db: drizzle(sqlite) as unknown as NodePgDatabase,
    table: sqliteRateLimits as unknown as PgRateLimits,
    exec: sqliteExec,
  });
}
