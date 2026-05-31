/**
 * SQLite-backed StepLockStore.
 * Single table `wf_step_locks` keyed by (runId, stepId).
 */
import Database from 'better-sqlite3';
import type { StepLockStore } from './step-lock-store.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_step_locks (
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  state TEXT NOT NULL,
  locked_at TEXT NOT NULL,
  done_at TEXT,
  output_json TEXT,
  PRIMARY KEY (run_id, step_id)
);
CREATE INDEX IF NOT EXISTS idx_wf_step_locks_run ON wf_step_locks(run_id);
`;

export interface WeaveSqliteStepLockStoreOptions {
  database?: Database.Database;
  databasePath?: string;
}

function now(): string {
  return new Date().toISOString();
}

export function weaveSqliteStepLockStore(
  opts: WeaveSqliteStepLockStoreOptions = {},
): StepLockStore {
  const db = opts.database ?? new Database(opts.databasePath ?? ':memory:');
  db.exec(MIGRATIONS_SQL);

  const insertLock = db.prepare(
    'INSERT OR IGNORE INTO wf_step_locks (run_id, step_id, state, locked_at) VALUES (?, ?, ?, ?)',
  );
  const upsertDone = db.prepare(
    `INSERT INTO wf_step_locks (run_id, step_id, state, locked_at, done_at, output_json)
     VALUES (?, ?, 'done', ?, ?, ?)
     ON CONFLICT(run_id, step_id) DO UPDATE SET state = 'done', done_at = excluded.done_at, output_json = excluded.output_json`,
  );
  const select = db.prepare('SELECT state, output_json FROM wf_step_locks WHERE run_id = ? AND step_id = ?');
  const clear = db.prepare('DELETE FROM wf_step_locks WHERE run_id = ?');

  return {
    async lock(runId, stepId) {
      insertLock.run(runId, stepId, 'locked', now());
    },
    async markDone(runId, stepId, output) {
      const ts = now();
      upsertDone.run(runId, stepId, ts, ts, JSON.stringify(output ?? null));
    },
    async isDone(runId, stepId) {
      const row = select.get(runId, stepId) as { state: string; output_json: string | null } | undefined;
      if (row?.state === 'done') {
        return { done: true, output: row.output_json ? (JSON.parse(row.output_json) as unknown) : undefined };
      }
      return { done: false };
    },
    async isLocked(runId, stepId) {
      return !!select.get(runId, stepId);
    },
    async clear(runId) {
      clear.run(runId);
    },
  };
}
