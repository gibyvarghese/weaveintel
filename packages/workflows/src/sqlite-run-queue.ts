// SPDX-License-Identifier: MIT
/**
 * SQLite-backed WorkflowRunQueue (priority queue). Phase 4: the query logic is shared with the Postgres
 * adapter via one Drizzle implementation — this file creates the table and wires the SQLite handle.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { WorkflowRunQueue } from './run-queue.js';
import { sqliteRunQueue, type PgRunQueue } from './drizzle-workflow-schema.js';
import { createDrizzleRunQueue } from './drizzle-workflow-stores.js';
import { sqliteExec } from './drizzle-exec.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_run_queue (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  input_json TEXT NOT NULL,
  priority INTEGER NOT NULL,
  queued_at TEXT NOT NULL,
  opts_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wf_run_queue_wf ON wf_run_queue(workflow_id, priority, queued_at, id);
`;

export interface WeaveSqliteRunQueueOptions {
  database?: Database.Database;
  databasePath?: string;
}

export function weaveSqliteRunQueue(opts: WeaveSqliteRunQueueOptions = {}): WorkflowRunQueue {
  const sqlite = opts.database ?? new Database(opts.databasePath ?? ':memory:');
  sqlite.exec(MIGRATIONS_SQL);
  return createDrizzleRunQueue({
    db: drizzle(sqlite) as unknown as NodePgDatabase,
    table: sqliteRunQueue as unknown as PgRunQueue,
    exec: sqliteExec,
  });
}
