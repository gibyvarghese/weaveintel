/**
 * Postgres-backed CheckpointStore. Caller supplies a `pg.Pool`.
 */
import type { Pool } from 'pg';
import type { WorkflowCheckpoint, WorkflowState } from '@weaveintel/core';
import { newUUIDv7 } from '@weaveintel/core';
import type { CheckpointStore } from './checkpoint-store.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_checkpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  workflow_id TEXT,
  step_id TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wf_checkpoints_run ON wf_checkpoints(run_id, created_at, id);
`;

interface Row {
  id: string;
  run_id: string;
  workflow_id: string | null;
  step_id: string;
  payload_json: WorkflowState;
  created_at: Date | string;
}

function rowToCheckpoint(row: Row): WorkflowCheckpoint {
  const wf = row.workflow_id;
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    state: row.payload_json,
    createdAt: typeof row.created_at === 'string' ? row.created_at : row.created_at.toISOString(),
    ...(wf ? { workflowId: wf } : {}),
  };
}

export interface WeavePostgresCheckpointStoreOptions {
  pool: Pool;
  ensureSchema?: boolean;
}

export async function weavePostgresCheckpointStore(
  opts: WeavePostgresCheckpointStoreOptions,
): Promise<CheckpointStore> {
  if (opts.ensureSchema !== false) await opts.pool.query(MIGRATIONS_SQL);
  const pool = opts.pool;

  return {
    async save(runId, stepId, state, workflowId) {
      const cp: WorkflowCheckpoint = {
        id: newUUIDv7(),
        runId,
        stepId,
        state: structuredClone(state),
        createdAt: new Date().toISOString(),
        ...(workflowId ? { workflowId } : {}),
      };
      await pool.query(
        'INSERT INTO wf_checkpoints (id, run_id, workflow_id, step_id, payload_json, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
        [cp.id, cp.runId, cp.workflowId ?? null, cp.stepId, JSON.stringify(cp.state), cp.createdAt],
      );
      return cp;
    },
    async load(checkpointId) {
      const r = await pool.query<Row>('SELECT * FROM wf_checkpoints WHERE id = $1', [checkpointId]);
      return r.rows[0] ? rowToCheckpoint(r.rows[0]) : null;
    },
    async latest(runId) {
      const r = await pool.query<Row>(
        'SELECT * FROM wf_checkpoints WHERE run_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1',
        [runId],
      );
      return r.rows[0] ? rowToCheckpoint(r.rows[0]) : null;
    },
    async list(runId) {
      const r = await pool.query<Row>(
        'SELECT * FROM wf_checkpoints WHERE run_id = $1 ORDER BY created_at ASC, id ASC',
        [runId],
      );
      return r.rows.map(rowToCheckpoint);
    },
    async delete(runId) {
      await pool.query('DELETE FROM wf_checkpoints WHERE run_id = $1', [runId]);
    },
  };
}
