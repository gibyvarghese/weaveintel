// SPDX-License-Identifier: MIT
/**
 * Postgres-backed StepLockStore. Phase 4: the query logic is shared with the SQLite adapter via one
 * Drizzle implementation — this file just creates the table and wires in the Drizzle Postgres handle.
 */
import type { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { StepLockStore } from './step-lock-store.js';
import { pgStepLocks } from './drizzle-workflow-schema.js';
import { createDrizzleStepLockStore } from './drizzle-workflow-stores.js';
import { pgExec } from './drizzle-exec.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_step_locks (
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  state TEXT NOT NULL,
  locked_at TEXT NOT NULL,
  done_at TEXT,
  output_json JSONB,
  PRIMARY KEY (run_id, step_id)
);
CREATE INDEX IF NOT EXISTS idx_wf_step_locks_run ON wf_step_locks(run_id);
`;

export interface WeavePostgresStepLockStoreOptions {
  pool: Pool;
  ensureSchema?: boolean;
}

export async function weavePostgresStepLockStore(
  opts: WeavePostgresStepLockStoreOptions,
): Promise<StepLockStore> {
  if (opts.ensureSchema !== false) await opts.pool.query(MIGRATIONS_SQL);
  return createDrizzleStepLockStore({ db: drizzle(opts.pool), table: pgStepLocks, exec: pgExec });
}
