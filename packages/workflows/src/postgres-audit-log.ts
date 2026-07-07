// SPDX-License-Identifier: MIT
/**
 * Postgres-backed WorkflowAuditLog (append-only). Phase 4: the query logic is shared with the SQLite
 * adapter via one Drizzle implementation — this file creates the table and wires the Postgres handle.
 */
import type { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { WorkflowAuditLog } from '@weaveintel/core';
import { pgAudit } from './drizzle-workflow-schema.js';
import { createDrizzleAuditLog } from './drizzle-workflow-stores.js';
import { pgExec } from './drizzle-exec.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_audit_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  payload_json JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wf_audit_run ON wf_audit_events(run_id, timestamp, id);
CREATE INDEX IF NOT EXISTS idx_wf_audit_wf ON wf_audit_events(workflow_id, timestamp, id);
`;

export interface WeavePostgresAuditLogOptions {
  pool: Pool;
  ensureSchema?: boolean;
}

export async function weavePostgresAuditLog(
  opts: WeavePostgresAuditLogOptions,
): Promise<WorkflowAuditLog> {
  if (opts.ensureSchema !== false) await opts.pool.query(MIGRATIONS_SQL);
  return createDrizzleAuditLog({ db: drizzle(opts.pool), table: pgAudit, exec: pgExec });
}
