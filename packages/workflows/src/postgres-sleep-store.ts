// SPDX-License-Identifier: MIT
/**
 * Postgres-backed DurableSleepStore. Phase 4: the query logic is shared with the SQLite adapter via one
 * Drizzle implementation — this file just creates the table and wires in the Postgres handle.
 */
import type { Pool } from 'pg';
import type { DurableSleepStore } from '@weaveintel/core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgSleeps } from './drizzle-workflow-schema.js';
import { createDrizzleSleepStore } from './drizzle-workflow-stores.js';
import { pgExec } from './drizzle-exec.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_sleeps (
  run_id TEXT PRIMARY KEY,
  wake_at BIGINT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wf_sleeps_wake ON wf_sleeps(wake_at);
`;

export interface WeavePostgresSleepStoreOptions {
  pool: Pool;
  ensureSchema?: boolean;
}

export async function weavePostgresSleepStore(
  opts: WeavePostgresSleepStoreOptions,
): Promise<DurableSleepStore> {
  if (opts.ensureSchema !== false) await opts.pool.query(MIGRATIONS_SQL);
  return createDrizzleSleepStore({ db: drizzle(opts.pool), table: pgSleeps, exec: pgExec });
}
