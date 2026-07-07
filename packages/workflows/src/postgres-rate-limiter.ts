// SPDX-License-Identifier: MIT
/**
 * Postgres-backed WorkflowRateLimiter (token bucket). Phase 4: the query logic is shared with the
 * SQLite adapter via one Drizzle implementation — this file creates the table and wires the handle.
 */
import type { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { WorkflowRateLimiter } from './rate-limiter.js';
import { pgRateLimits } from './drizzle-workflow-schema.js';
import { createDrizzleRateLimiter } from './drizzle-workflow-stores.js';
import { pgExec } from './drizzle-exec.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_rate_limits (
  workflow_id TEXT PRIMARY KEY,
  tokens DOUBLE PRECISION NOT NULL,
  last_refill_ms BIGINT NOT NULL
);
`;

export interface WeavePostgresRateLimiterOptions {
  pool: Pool;
  ensureSchema?: boolean;
}

export async function weavePostgresRateLimiter(
  opts: WeavePostgresRateLimiterOptions,
): Promise<WorkflowRateLimiter> {
  if (opts.ensureSchema !== false) await opts.pool.query(MIGRATIONS_SQL);
  return createDrizzleRateLimiter({ db: drizzle(opts.pool), table: pgRateLimits, exec: pgExec });
}
