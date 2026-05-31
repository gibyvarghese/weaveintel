/**
 * SQLite-backed PayloadStore.
 * Single table `wf_payloads` keyed by `${runId}:${stepId}`.
 */
import Database from 'better-sqlite3';
import type { PayloadStore } from './payload-store.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_payloads (
  key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_wf_payloads_run ON wf_payloads(run_id);
`;

export interface WeaveSqlitePayloadStoreOptions {
  database?: Database.Database;
  databasePath?: string;
}

function extractRunId(key: string): string {
  const idx = key.indexOf(':');
  return idx >= 0 ? key.slice(0, idx) : key;
}

export function weaveSqlitePayloadStore(opts: WeaveSqlitePayloadStoreOptions = {}): PayloadStore {
  const db = opts.database ?? new Database(opts.databasePath ?? ':memory:');
  db.exec(MIGRATIONS_SQL);

  const upsert = db.prepare(
    'INSERT INTO wf_payloads (key, run_id, data_json) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data_json = excluded.data_json',
  );
  const get = db.prepare('SELECT data_json FROM wf_payloads WHERE key = ?');
  const del = db.prepare('DELETE FROM wf_payloads WHERE key = ?');
  const delRun = db.prepare('DELETE FROM wf_payloads WHERE run_id = ?');

  return {
    async put(key, data) {
      upsert.run(key, extractRunId(key), JSON.stringify(data ?? null));
    },
    async get(key) {
      const row = get.get(key) as { data_json: string } | undefined;
      return row ? (JSON.parse(row.data_json) as unknown) : undefined;
    },
    async delete(key) {
      del.run(key);
    },
    async deleteRun(runId) {
      delRun.run(runId);
    },
  };
}
