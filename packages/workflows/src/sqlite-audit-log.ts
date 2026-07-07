// SPDX-License-Identifier: MIT
/**
 * SQLite-backed WorkflowAuditLog (append-only). Phase 4: the query logic is shared with the Postgres
 * adapter via one Drizzle implementation — this file creates the table and wires the SQLite handle.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { WorkflowAuditLog } from '@weaveintel/core';
import { sqliteAudit, type PgAudit } from './drizzle-workflow-schema.js';
import { createDrizzleAuditLog } from './drizzle-workflow-stores.js';
import { sqliteExec } from './drizzle-exec.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_audit_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wf_audit_run ON wf_audit_events(run_id, timestamp, id);
CREATE INDEX IF NOT EXISTS idx_wf_audit_wf ON wf_audit_events(workflow_id, timestamp, id);
`;

export interface WeaveSqliteAuditLogOptions {
  database?: Database.Database;
  databasePath?: string;
}

export function weaveSqliteAuditLog(opts: WeaveSqliteAuditLogOptions = {}): WorkflowAuditLog {
  const sqlite = opts.database ?? new Database(opts.databasePath ?? ':memory:');
  sqlite.exec(MIGRATIONS_SQL);
  return createDrizzleAuditLog({
    db: drizzle(sqlite) as unknown as NodePgDatabase,
    table: sqliteAudit as unknown as PgAudit,
    exec: sqliteExec,
  });
}
