/**
 * Postgres-backed WorkflowRunRepository.
 */
import type { Pool } from 'pg';
import type { WorkflowRun } from '@weaveintel/core';
import type { RunFilterOpts, WorkflowRunRepository } from './run-repository.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  parent_run_id TEXT,
  status TEXT NOT NULL,
  tenant_id TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  payload_json JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wf_runs_wf ON wf_runs(workflow_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_wf_runs_parent ON wf_runs(parent_run_id);
CREATE INDEX IF NOT EXISTS idx_wf_runs_status ON wf_runs(status);
CREATE INDEX IF NOT EXISTS idx_wf_runs_tenant ON wf_runs(tenant_id);
`;

export interface WeavePostgresRunRepositoryOptions {
  pool: Pool;
  ensureSchema?: boolean;
}

interface Row { payload_json: WorkflowRun }

export async function weavePostgresWorkflowRunRepository(
  opts: WeavePostgresRunRepositoryOptions,
): Promise<WorkflowRunRepository> {
  if (opts.ensureSchema !== false) await opts.pool.query(MIGRATIONS_SQL);
  const pool = opts.pool;

  return {
    async save(run) {
      await pool.query(
        `INSERT INTO wf_runs (id, workflow_id, parent_run_id, status, tenant_id, started_at, payload_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO UPDATE SET
           workflow_id = EXCLUDED.workflow_id,
           parent_run_id = EXCLUDED.parent_run_id,
           status = EXCLUDED.status,
           tenant_id = EXCLUDED.tenant_id,
           started_at = EXCLUDED.started_at,
           payload_json = EXCLUDED.payload_json`,
        [run.id, run.workflowId, run.parentRunId ?? null, run.status, run.tenantId ?? null, run.startedAt, JSON.stringify(run)],
      );
    },
    async get(runId) {
      const r = await pool.query<Row>('SELECT payload_json FROM wf_runs WHERE id = $1', [runId]);
      return r.rows[0]?.payload_json ?? null;
    },
    async list(workflowId) {
      const sql = workflowId
        ? 'SELECT payload_json FROM wf_runs WHERE workflow_id = $1 ORDER BY started_at DESC'
        : 'SELECT payload_json FROM wf_runs ORDER BY started_at DESC';
      const params = workflowId ? [workflowId] : [];
      const r = await pool.query<Row>(sql, params);
      return r.rows.map((x) => x.payload_json);
    },
    async listByParent(parentRunId) {
      const r = await pool.query<Row>(
        'SELECT payload_json FROM wf_runs WHERE parent_run_id = $1 ORDER BY started_at DESC',
        [parentRunId],
      );
      return r.rows.map((x) => x.payload_json);
    },
    async listFiltered(opts: RunFilterOpts) {
      const conds: string[] = [];
      const params: unknown[] = [];
      const push = (cond: string, val: unknown) => {
        params.push(val);
        conds.push(cond.replace('?', `$${params.length}`));
      };
      if (opts.workflowId) push('workflow_id = ?', opts.workflowId);
      if (opts.status) push('status = ?', opts.status);
      if (opts.tenantId) push('tenant_id = ?', opts.tenantId);
      if (opts.before) push('started_at < ?', opts.before);
      if (opts.after) push('started_at > ?', opts.after);
      let sql = 'SELECT payload_json FROM wf_runs';
      if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
      sql += ' ORDER BY started_at DESC';
      if (opts.limit) {
        params.push(opts.limit);
        sql += ` LIMIT $${params.length}`;
      }
      const r = await pool.query<Row>(sql, params);
      return r.rows.map((x) => x.payload_json);
    },
    async countActive(workflowId) {
      const r = await pool.query<{ n: string }>(
        "SELECT COUNT(*)::text AS n FROM wf_runs WHERE workflow_id = $1 AND status IN ('running','paused')",
        [workflowId],
      );
      return Number(r.rows[0]?.n ?? '0');
    },
    async delete(runId) {
      await pool.query('DELETE FROM wf_runs WHERE id = $1', [runId]);
    },
  };
}
