/**
 * SQLite-backed WorkflowRunRepository.
 *
 * Runs stored in `wf_runs` with secondary indexed columns for filter queries
 * (workflow_id, parent_run_id, status, tenant_id, started_at) and a JSON
 * payload column for the full run record.
 */
import Database from 'better-sqlite3';
import type { WorkflowRun } from '@weaveintel/core';
import type { RunFilterOpts, WorkflowRunRepository } from './run-repository.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  parent_run_id TEXT,
  status TEXT NOT NULL,
  tenant_id TEXT,
  started_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wf_runs_wf ON wf_runs(workflow_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_wf_runs_parent ON wf_runs(parent_run_id);
CREATE INDEX IF NOT EXISTS idx_wf_runs_status ON wf_runs(status);
CREATE INDEX IF NOT EXISTS idx_wf_runs_tenant ON wf_runs(tenant_id);
`;

export interface WeaveSqliteRunRepositoryOptions {
  database?: Database.Database;
  databasePath?: string;
}

interface Row {
  payload_json: string;
}

export function weaveSqliteWorkflowRunRepository(
  opts: WeaveSqliteRunRepositoryOptions = {},
): WorkflowRunRepository {
  const db = opts.database ?? new Database(opts.databasePath ?? ':memory:');
  db.exec(MIGRATIONS_SQL);

  const upsertStmt = db.prepare(`
    INSERT INTO wf_runs (id, workflow_id, parent_run_id, status, tenant_id, started_at, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      workflow_id = excluded.workflow_id,
      parent_run_id = excluded.parent_run_id,
      status = excluded.status,
      tenant_id = excluded.tenant_id,
      started_at = excluded.started_at,
      payload_json = excluded.payload_json
  `);
  const getStmt = db.prepare('SELECT payload_json FROM wf_runs WHERE id = ?');
  const listAllStmt = db.prepare('SELECT payload_json FROM wf_runs ORDER BY started_at DESC');
  const listByWfStmt = db.prepare('SELECT payload_json FROM wf_runs WHERE workflow_id = ? ORDER BY started_at DESC');
  const listByParentStmt = db.prepare('SELECT payload_json FROM wf_runs WHERE parent_run_id = ? ORDER BY started_at DESC');
  const countActiveStmt = db.prepare(
    "SELECT COUNT(*) as n FROM wf_runs WHERE workflow_id = ? AND status IN ('running','paused')",
  );
  const deleteStmt = db.prepare('DELETE FROM wf_runs WHERE id = ?');

  function decode(rows: Row[]): WorkflowRun[] {
    return rows.map((r) => JSON.parse(r.payload_json) as WorkflowRun);
  }

  return {
    async save(run) {
      upsertStmt.run(
        run.id,
        run.workflowId,
        run.parentRunId ?? null,
        run.status,
        run.tenantId ?? null,
        run.startedAt,
        JSON.stringify(run),
      );
    },
    async get(runId) {
      const row = getStmt.get(runId) as Row | undefined;
      return row ? (JSON.parse(row.payload_json) as WorkflowRun) : null;
    },
    async list(workflowId) {
      const rows = workflowId
        ? (listByWfStmt.all(workflowId) as Row[])
        : (listAllStmt.all() as Row[]);
      return decode(rows);
    },
    async listByParent(parentRunId) {
      return decode(listByParentStmt.all(parentRunId) as Row[]);
    },
    async listFiltered(opts: RunFilterOpts) {
      const conds: string[] = [];
      const params: unknown[] = [];
      if (opts.workflowId) { conds.push('workflow_id = ?'); params.push(opts.workflowId); }
      if (opts.status) { conds.push('status = ?'); params.push(opts.status); }
      if (opts.tenantId) { conds.push('tenant_id = ?'); params.push(opts.tenantId); }
      if (opts.before) { conds.push('started_at < ?'); params.push(opts.before); }
      if (opts.after) { conds.push('started_at > ?'); params.push(opts.after); }
      let sql = 'SELECT payload_json FROM wf_runs';
      if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
      sql += ' ORDER BY started_at DESC';
      if (opts.limit) { sql += ' LIMIT ?'; params.push(opts.limit); }
      const rows = db.prepare(sql).all(...params) as Row[];
      return decode(rows);
    },
    async countActive(workflowId) {
      const row = countActiveStmt.get(workflowId) as { n: number };
      return row.n;
    },
    async delete(runId) {
      deleteStmt.run(runId);
    },
  };
}
