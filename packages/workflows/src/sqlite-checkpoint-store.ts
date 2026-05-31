/**
 * SQLite-backed CheckpointStore.
 *
 * Single table `wf_checkpoints` keyed by checkpoint UUID, with secondary index
 * on `run_id` for `latest()`/`list()`/`delete()`. Payload (the full
 * `WorkflowState` snapshot) is stored as JSON text.
 */
import Database from 'better-sqlite3';
import type { WorkflowCheckpoint, WorkflowState } from '@weaveintel/core';
import { newUUIDv7 } from '@weaveintel/core';
import type { CheckpointStore } from './checkpoint-store.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_checkpoints (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  workflow_id TEXT,
  step_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_wf_checkpoints_run ON wf_checkpoints(run_id, created_at, id);
`;

export interface WeaveSqliteCheckpointStoreOptions {
  database?: Database.Database;
  databasePath?: string;
}

interface Row {
  id: string;
  run_id: string;
  workflow_id: string | null;
  step_id: string;
  payload_json: string;
  created_at: string;
}

function rowToCheckpoint(row: Row): WorkflowCheckpoint {
  const wf = row.workflow_id;
  const cp: WorkflowCheckpoint = {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    state: JSON.parse(row.payload_json) as WorkflowState,
    createdAt: row.created_at,
    ...(wf ? { workflowId: wf } : {}),
  };
  return cp;
}

export function weaveSqliteCheckpointStore(opts: WeaveSqliteCheckpointStoreOptions = {}): CheckpointStore {
  const db = opts.database ?? new Database(opts.databasePath ?? ':memory:');
  db.exec(MIGRATIONS_SQL);

  const insertStmt = db.prepare(
    'INSERT INTO wf_checkpoints (id, run_id, workflow_id, step_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const selectByIdStmt = db.prepare('SELECT * FROM wf_checkpoints WHERE id = ?');
  const selectLatestStmt = db.prepare(
    'SELECT * FROM wf_checkpoints WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
  );
  const selectListStmt = db.prepare(
    'SELECT * FROM wf_checkpoints WHERE run_id = ? ORDER BY created_at ASC, rowid ASC',
  );
  const deleteStmt = db.prepare('DELETE FROM wf_checkpoints WHERE run_id = ?');

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
      insertStmt.run(cp.id, cp.runId, cp.workflowId ?? null, cp.stepId, JSON.stringify(cp.state), cp.createdAt);
      return cp;
    },
    async load(checkpointId) {
      const row = selectByIdStmt.get(checkpointId) as Row | undefined;
      return row ? rowToCheckpoint(row) : null;
    },
    async latest(runId) {
      const row = selectLatestStmt.get(runId) as Row | undefined;
      return row ? rowToCheckpoint(row) : null;
    },
    async list(runId) {
      const rows = selectListStmt.all(runId) as Row[];
      return rows.map(rowToCheckpoint);
    },
    async delete(runId) {
      deleteStmt.run(runId);
    },
  };
}
