/**
 * Postgres-backed WorkflowAuditLog. Append-only.
 */
import type { Pool } from 'pg';
import type { WorkflowAuditEvent, WorkflowAuditLog } from '@weaveintel/core';
import { newUUIDv7 } from '@weaveintel/core';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_audit_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  type TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  payload_json JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wf_audit_run ON wf_audit_events(run_id, timestamp ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_wf_audit_wf ON wf_audit_events(workflow_id, timestamp ASC, id ASC);
`;

export interface WeavePostgresAuditLogOptions {
  pool: Pool;
  ensureSchema?: boolean;
}

interface Row {
  id: string;
  run_id: string;
  workflow_id: string;
  type: string;
  timestamp: Date | string;
  payload_json: Record<string, unknown>;
}

function toEvent(r: Row): WorkflowAuditEvent {
  return {
    id: r.id,
    runId: r.run_id,
    workflowId: r.workflow_id,
    type: r.type as WorkflowAuditEvent['type'],
    timestamp: typeof r.timestamp === 'string' ? r.timestamp : r.timestamp.toISOString(),
    ...r.payload_json,
  } as WorkflowAuditEvent;
}

export async function weavePostgresAuditLog(
  opts: WeavePostgresAuditLogOptions,
): Promise<WorkflowAuditLog> {
  if (opts.ensureSchema !== false) await opts.pool.query(MIGRATIONS_SQL);
  const pool = opts.pool;
  return {
    async append(event) {
      const id = newUUIDv7();
      const { runId, workflowId, type, timestamp, ...rest } = event as WorkflowAuditEvent;
      await pool.query(
        'INSERT INTO wf_audit_events (id, run_id, workflow_id, type, timestamp, payload_json) VALUES ($1,$2,$3,$4,$5,$6)',
        [id, runId, workflowId, type, timestamp, JSON.stringify(rest)],
      );
    },
    async list(runId) {
      const r = await pool.query<Row>(
        'SELECT * FROM wf_audit_events WHERE run_id = $1 ORDER BY timestamp ASC, id ASC',
        [runId],
      );
      return r.rows.map(toEvent);
    },
    async listAll(o) {
      const r = o?.workflowId
        ? await pool.query<Row>(
            'SELECT * FROM wf_audit_events WHERE workflow_id = $1 ORDER BY timestamp ASC, id ASC',
            [o.workflowId],
          )
        : await pool.query<Row>('SELECT * FROM wf_audit_events ORDER BY timestamp ASC, id ASC');
      const mapped = r.rows.map(toEvent);
      return o?.limit ? mapped.slice(-o.limit) : mapped;
    },
  };
}
