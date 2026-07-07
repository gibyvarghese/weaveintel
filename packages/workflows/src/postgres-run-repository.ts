// SPDX-License-Identifier: MIT
/**
 * Postgres-backed WorkflowRunRepository. Phase 4: the query logic is shared with the SQLite adapter via
 * one Drizzle implementation — this file just creates the table and wires in the Postgres handle.
 */
import type { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { WorkflowRunRepository } from './run-repository.js';
import { pgRuns } from './drizzle-workflow-schema.js';
import { createDrizzleRunRepository } from './drizzle-workflow-stores.js';
import { pgExec } from './drizzle-exec.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  parent_run_id TEXT,
  status TEXT NOT NULL,
  tenant_id TEXT,
  started_at TEXT NOT NULL,
  payload_json JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wf_runs_wf ON wf_runs(workflow_id, started_at);
CREATE INDEX IF NOT EXISTS idx_wf_runs_parent ON wf_runs(parent_run_id);
CREATE INDEX IF NOT EXISTS idx_wf_runs_status ON wf_runs(status);
CREATE INDEX IF NOT EXISTS idx_wf_runs_tenant ON wf_runs(tenant_id);
`;

export interface WeavePostgresRunRepositoryOptions {
  pool: Pool;
  ensureSchema?: boolean;
}

export async function weavePostgresWorkflowRunRepository(
  opts: WeavePostgresRunRepositoryOptions,
): Promise<WorkflowRunRepository> {
  if (opts.ensureSchema !== false) await opts.pool.query(MIGRATIONS_SQL);
  return createDrizzleRunRepository({ db: drizzle(opts.pool), table: pgRuns, exec: pgExec });
}
