/**
 * SQLite-backed DurableSleepStore.
 * Single table `wf_sleeps` keyed by runId.
 */
import Database from 'better-sqlite3';
import type { SleepRecord, DurableSleepStore } from '@weaveintel/core';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_sleeps (
  run_id TEXT PRIMARY KEY,
  wake_at INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wf_sleeps_wake ON wf_sleeps(wake_at);
`;

export interface WeaveSqliteSleepStoreOptions {
  database?: Database.Database;
  databasePath?: string;
}

interface Row {
  run_id: string;
  wake_at: number;
  created_at: string;
}

function toRecord(r: Row): SleepRecord {
  return { runId: r.run_id, wakeAt: r.wake_at, createdAt: r.created_at };
}

export function weaveSqliteSleepStore(opts: WeaveSqliteSleepStoreOptions = {}): DurableSleepStore {
  const db = opts.database ?? new Database(opts.databasePath ?? ':memory:');
  db.exec(MIGRATIONS_SQL);

  const upsert = db.prepare(
    'INSERT INTO wf_sleeps (run_id, wake_at, created_at) VALUES (?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET wake_at = excluded.wake_at',
  );
  const cancel = db.prepare('DELETE FROM wf_sleeps WHERE run_id = ?');
  const due = db.prepare('SELECT * FROM wf_sleeps WHERE wake_at <= ? ORDER BY wake_at ASC, run_id ASC');
  const all = db.prepare('SELECT * FROM wf_sleeps ORDER BY wake_at ASC, run_id ASC');

  return {
    async schedule(runId, wakeAt) {
      upsert.run(runId, wakeAt, new Date().toISOString());
    },
    async cancel(runId) {
      cancel.run(runId);
    },
    async getDue(now = Date.now()) {
      const rows = due.all(now) as Row[];
      return rows.map(toRecord);
    },
    async list() {
      const rows = all.all() as Row[];
      return rows.map(toRecord);
    },
  };
}
