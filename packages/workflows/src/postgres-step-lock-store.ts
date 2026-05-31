/**
 * Postgres-backed StepLockStore.
 */
import type { Pool } from 'pg';
import type { StepLockStore } from './step-lock-store.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_step_locks (
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  state TEXT NOT NULL,
  locked_at TIMESTAMPTZ NOT NULL,
  done_at TIMESTAMPTZ,
  output_json JSONB,
  PRIMARY KEY (run_id, step_id)
);
CREATE INDEX IF NOT EXISTS idx_wf_step_locks_run ON wf_step_locks(run_id);
`;

export interface WeavePostgresStepLockStoreOptions {
  pool: Pool;
  ensureSchema?: boolean;
}

export async function weavePostgresStepLockStore(
  opts: WeavePostgresStepLockStoreOptions,
): Promise<StepLockStore> {
  if (opts.ensureSchema !== false) await opts.pool.query(MIGRATIONS_SQL);
  const pool = opts.pool;
  return {
    async lock(runId, stepId) {
      await pool.query(
        "INSERT INTO wf_step_locks (run_id, step_id, state, locked_at) VALUES ($1,$2,'locked',NOW()) ON CONFLICT (run_id, step_id) DO NOTHING",
        [runId, stepId],
      );
    },
    async markDone(runId, stepId, output) {
      await pool.query(
        `INSERT INTO wf_step_locks (run_id, step_id, state, locked_at, done_at, output_json)
         VALUES ($1,$2,'done',NOW(),NOW(),$3)
         ON CONFLICT (run_id, step_id) DO UPDATE SET state='done', done_at = NOW(), output_json = EXCLUDED.output_json`,
        [runId, stepId, JSON.stringify(output ?? null)],
      );
    },
    async isDone(runId, stepId) {
      const r = await pool.query<{ state: string; output_json: unknown }>(
        'SELECT state, output_json FROM wf_step_locks WHERE run_id = $1 AND step_id = $2',
        [runId, stepId],
      );
      const row = r.rows[0];
      if (row?.state === 'done') return { done: true, output: row.output_json ?? undefined };
      return { done: false };
    },
    async isLocked(runId, stepId) {
      const r = await pool.query(
        'SELECT 1 FROM wf_step_locks WHERE run_id = $1 AND step_id = $2',
        [runId, stepId],
      );
      return r.rowCount !== null && r.rowCount > 0;
    },
    async clear(runId) {
      await pool.query('DELETE FROM wf_step_locks WHERE run_id = $1', [runId]);
    },
  };
}
