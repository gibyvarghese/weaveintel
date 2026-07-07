// SPDX-License-Identifier: MIT
/**
 * Postgres-backed CheckpointStore. Caller supplies a `pg.Pool`.
 *
 * Phase 4: the query logic now lives ONCE in `createDrizzleCheckpointStore` (shared with the SQLite
 * adapter) — this file just creates the table and wires the Drizzle Postgres handle in. No more
 * hand-written SQL to drift out of sync with the SQLite version.
 */
import type { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { CheckpointStore } from './checkpoint-store.js';
import { pgCheckpoints } from './drizzle-checkpoint-schema.js';
import { createDrizzleCheckpointStore, pgExec } from './drizzle-checkpoint-store.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_checkpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  workflow_id TEXT,
  step_id TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wf_checkpoints_run ON wf_checkpoints(run_id, created_at, id);
`;

export interface WeavePostgresCheckpointStoreOptions {
  pool: Pool;
  ensureSchema?: boolean;
}

export async function weavePostgresCheckpointStore(
  opts: WeavePostgresCheckpointStoreOptions,
): Promise<CheckpointStore> {
  if (opts.ensureSchema !== false) await opts.pool.query(MIGRATIONS_SQL);
  const db = drizzle(opts.pool);
  return createDrizzleCheckpointStore({ db, table: pgCheckpoints, exec: pgExec });
}
