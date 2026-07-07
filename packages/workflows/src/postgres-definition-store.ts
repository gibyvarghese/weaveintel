// SPDX-License-Identifier: MIT
/**
 * Postgres-backed WorkflowDefinitionStore. Phase 4: the query logic is shared with the SQLite adapter
 * via one Drizzle implementation — this file just creates the table and wires in the Postgres handle.
 */
import type { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { WorkflowDefinitionStore } from './definition-store.js';
import { pgDefinitions } from './drizzle-workflow-schema.js';
import { createDrizzleDefinitionStore } from './drizzle-workflow-stores.js';
import { pgExec } from './drizzle-exec.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wf_definitions_name ON wf_definitions(name);
`;

export interface WeavePostgresDefinitionStoreOptions {
  pool: Pool;
  ensureSchema?: boolean;
}

export async function weavePostgresWorkflowDefinitionStore(
  opts: WeavePostgresDefinitionStoreOptions,
): Promise<WorkflowDefinitionStore> {
  if (opts.ensureSchema !== false) await opts.pool.query(MIGRATIONS_SQL);
  return createDrizzleDefinitionStore({ db: drizzle(opts.pool), table: pgDefinitions, exec: pgExec });
}
