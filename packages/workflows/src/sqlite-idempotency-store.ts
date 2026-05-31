/**
 * SQLite-backed StepIdempotencyStore.
 * Single table `wf_idempotency` keyed by composite (stepId:key).
 */
import Database from 'better-sqlite3';
import type { StepIdempotencyStore } from './idempotency-store.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_idempotency (
  key TEXT PRIMARY KEY,
  output_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

export interface WeaveSqliteIdempotencyStoreOptions {
  database?: Database.Database;
  databasePath?: string;
}

export function weaveSqliteIdempotencyStore(
  opts: WeaveSqliteIdempotencyStoreOptions = {},
): StepIdempotencyStore {
  const db = opts.database ?? new Database(opts.databasePath ?? ':memory:');
  db.exec(MIGRATIONS_SQL);

  const upsert = db.prepare(
    'INSERT INTO wf_idempotency (key, output_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET output_json = excluded.output_json',
  );
  const get = db.prepare('SELECT output_json FROM wf_idempotency WHERE key = ?');
  const del = db.prepare('DELETE FROM wf_idempotency WHERE key = ?');
  const delPrefix = db.prepare("DELETE FROM wf_idempotency WHERE key LIKE ? || '%'");

  return {
    async get(key) {
      const row = get.get(key) as { output_json: string } | undefined;
      return row ? (JSON.parse(row.output_json) as unknown) : undefined;
    },
    async set(key, output) {
      upsert.run(key, JSON.stringify(output ?? null));
    },
    async delete(key) {
      del.run(key);
    },
    async clearPrefix(prefix) {
      delPrefix.run(prefix);
    },
  };
}
