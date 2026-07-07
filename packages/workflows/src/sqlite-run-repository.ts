// SPDX-License-Identifier: MIT
/**
 * SQLite-backed WorkflowRunRepository. Phase 4: the query logic is shared with the Postgres adapter via
 * one Drizzle implementation — this file just creates the table (indexed scalar columns for filtering +
 * a JSON payload for the full run) and wires in the SQLite handle.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { WorkflowRunRepository } from './run-repository.js';
import { sqliteRuns, type PgRuns } from './drizzle-workflow-schema.js';
import { createDrizzleRunRepository } from './drizzle-workflow-stores.js';
import { sqliteExec } from './drizzle-exec.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  parent_run_id TEXT,
  status TEXT NOT NULL,
  tenant_id TEXT,
  started_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wf_runs_wf ON wf_runs(workflow_id, started_at);
CREATE INDEX IF NOT EXISTS idx_wf_runs_parent ON wf_runs(parent_run_id);
CREATE INDEX IF NOT EXISTS idx_wf_runs_status ON wf_runs(status);
CREATE INDEX IF NOT EXISTS idx_wf_runs_tenant ON wf_runs(tenant_id);
`;

export interface WeaveSqliteRunRepositoryOptions {
  database?: Database.Database;
  databasePath?: string;
}

export function weaveSqliteWorkflowRunRepository(
  opts: WeaveSqliteRunRepositoryOptions = {},
): WorkflowRunRepository {
  const sqlite = opts.database ?? new Database(opts.databasePath ?? ':memory:');
  sqlite.exec(MIGRATIONS_SQL);
  return createDrizzleRunRepository({
    db: drizzle(sqlite) as unknown as NodePgDatabase,
    table: sqliteRuns as unknown as PgRuns,
    exec: sqliteExec,
  });
}
