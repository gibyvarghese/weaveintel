/**
 * SQLite-backed WorkflowAuditLog. Append-only.
 */
import Database from 'better-sqlite3';
import type { WorkflowAuditEvent, WorkflowAuditLog } from '@weaveintel/core';
import { newUUIDv7 } from '@weaveintel/core';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_audit_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wf_audit_run ON wf_audit_events(run_id, timestamp ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_wf_audit_wf ON wf_audit_events(workflow_id, timestamp ASC, id ASC);
`;

export interface WeaveSqliteAuditLogOptions {
  database?: Database.Database;
  databasePath?: string;
}

interface Row {
  id: string;
  run_id: string;
  workflow_id: string;
  type: string;
  timestamp: string;
  payload_json: string;
}

function toEvent(r: Row): WorkflowAuditEvent {
  const extra = JSON.parse(r.payload_json) as Record<string, unknown>;
  return {
    id: r.id,
    runId: r.run_id,
    workflowId: r.workflow_id,
    type: r.type as WorkflowAuditEvent['type'],
    timestamp: r.timestamp,
    ...extra,
  } as WorkflowAuditEvent;
}

export function weaveSqliteAuditLog(opts: WeaveSqliteAuditLogOptions = {}): WorkflowAuditLog {
  const db = opts.database ?? new Database(opts.databasePath ?? ':memory:');
  db.exec(MIGRATIONS_SQL);

  const insert = db.prepare(
    'INSERT INTO wf_audit_events (id, run_id, workflow_id, type, timestamp, payload_json) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const listRun = db.prepare(
    'SELECT * FROM wf_audit_events WHERE run_id = ? ORDER BY timestamp ASC, id ASC',
  );
  const listWf = db.prepare(
    'SELECT * FROM wf_audit_events WHERE workflow_id = ? ORDER BY timestamp ASC, id ASC',
  );
  const listAllStmt = db.prepare(
    'SELECT * FROM wf_audit_events ORDER BY timestamp ASC, id ASC',
  );

  return {
    async append(event) {
      const id = newUUIDv7();
      const { runId, workflowId, type, timestamp, ...rest } = event as WorkflowAuditEvent;
      insert.run(id, runId, workflowId, type, timestamp, JSON.stringify(rest));
    },
    async list(runId) {
      return (listRun.all(runId) as Row[]).map(toEvent);
    },
    async listAll(o) {
      const rows = (o?.workflowId ? listWf.all(o.workflowId) : listAllStmt.all()) as Row[];
      const mapped = rows.map(toEvent);
      return o?.limit ? mapped.slice(-o.limit) : mapped;
    },
  };
}
