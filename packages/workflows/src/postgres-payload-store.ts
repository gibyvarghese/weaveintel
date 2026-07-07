// SPDX-License-Identifier: MIT
/**
 * Postgres-backed PayloadStore. Phase 4: the query logic is shared with the SQLite adapter via one
 * Drizzle implementation — this file just creates the table and wires in the Drizzle Postgres handle.
 */
import type { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PayloadStore } from './payload-store.js';
import { pgPayloads } from './drizzle-workflow-schema.js';
import { createDrizzlePayloadStore } from './drizzle-workflow-stores.js';
import { pgExec } from './drizzle-exec.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_payloads (
  key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  data_json JSONB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wf_payloads_run ON wf_payloads(run_id);
`;

export interface WeavePostgresPayloadStoreOptions {
  pool: Pool;
  ensureSchema?: boolean;
}

export async function weavePostgresPayloadStore(
  opts: WeavePostgresPayloadStoreOptions,
): Promise<PayloadStore> {
  if (opts.ensureSchema !== false) await opts.pool.query(MIGRATIONS_SQL);
  return createDrizzlePayloadStore({ db: drizzle(opts.pool), table: pgPayloads, exec: pgExec });
}
