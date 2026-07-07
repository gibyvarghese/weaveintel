// SPDX-License-Identifier: MIT
/**
 * Postgres-backed TriggerStore. Phase 4: the query logic is shared with the SQLite adapter via one
 * Drizzle implementation — this file just creates the two tables and wires in the Postgres handle.
 */
import type { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { TriggerStore } from './dispatcher.js';
import { pgTriggers, pgInvocations } from './drizzle-trigger-schema.js';
import { createDrizzleTriggerStore } from './drizzle-trigger-store.js';
import { pgExec } from './drizzle-support.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  source_kind TEXT NOT NULL,
  source_config JSONB NOT NULL,
  filter_expr JSONB,
  target_kind TEXT NOT NULL,
  target_config JSONB NOT NULL,
  input_map JSONB,
  rate_limit_per_minute INTEGER,
  metadata JSONB
);
CREATE TABLE IF NOT EXISTS trigger_invocations (
  id TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL,
  fired_at BIGINT NOT NULL,
  source_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  target_ref TEXT,
  error_message TEXT,
  source_event JSONB
);
CREATE INDEX IF NOT EXISTS idx_trigger_invocations_trigger ON trigger_invocations(trigger_id, fired_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_trigger_invocations_status ON trigger_invocations(status, fired_at DESC, id);
`;

export interface WeavePostgresTriggerStoreOptions {
  pool: Pool;
  ensureSchema?: boolean;
}

export async function weavePostgresTriggerStore(
  opts: WeavePostgresTriggerStoreOptions,
): Promise<TriggerStore> {
  if (opts.ensureSchema !== false) await opts.pool.query(MIGRATIONS_SQL);
  return createDrizzleTriggerStore({ db: drizzle(opts.pool), triggers: pgTriggers, invocations: pgInvocations, exec: pgExec });
}
