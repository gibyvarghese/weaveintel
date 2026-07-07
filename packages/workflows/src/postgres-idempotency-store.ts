// SPDX-License-Identifier: MIT
/**
 * Postgres-backed StepIdempotencyStore. Phase 4: the query logic is shared with the SQLite adapter via
 * one Drizzle implementation — this file just creates the table and wires in the Drizzle Postgres handle.
 */
import type { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { StepIdempotencyStore } from './idempotency-store.js';
import { pgIdempotency } from './drizzle-workflow-schema.js';
import { createDrizzleIdempotencyStore } from './drizzle-workflow-stores.js';
import { pgExec } from './drizzle-exec.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_idempotency (
  key TEXT PRIMARY KEY,
  output_json JSONB NOT NULL,
  created_at TEXT NOT NULL
);
`;

export interface WeavePostgresIdempotencyStoreOptions {
  pool: Pool;
  ensureSchema?: boolean;
}

export async function weavePostgresIdempotencyStore(
  opts: WeavePostgresIdempotencyStoreOptions,
): Promise<StepIdempotencyStore> {
  if (opts.ensureSchema !== false) await opts.pool.query(MIGRATIONS_SQL);
  return createDrizzleIdempotencyStore({ db: drizzle(opts.pool), table: pgIdempotency, exec: pgExec });
}
