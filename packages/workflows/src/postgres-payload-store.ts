/**
 * Postgres-backed PayloadStore.
 */
import type { Pool } from 'pg';
import type { PayloadStore } from './payload-store.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_payloads (
  key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  data_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wf_payloads_run ON wf_payloads(run_id);
`;

export interface WeavePostgresPayloadStoreOptions {
  pool: Pool;
  ensureSchema?: boolean;
}

function extractRunId(key: string): string {
  const idx = key.indexOf(':');
  return idx >= 0 ? key.slice(0, idx) : key;
}

export async function weavePostgresPayloadStore(
  opts: WeavePostgresPayloadStoreOptions,
): Promise<PayloadStore> {
  if (opts.ensureSchema !== false) await opts.pool.query(MIGRATIONS_SQL);
  const pool = opts.pool;
  return {
    async put(key, data) {
      await pool.query(
        'INSERT INTO wf_payloads (key, run_id, data_json) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET data_json = EXCLUDED.data_json',
        [key, extractRunId(key), JSON.stringify(data ?? null)],
      );
    },
    async get(key) {
      const r = await pool.query<{ data_json: unknown }>(
        'SELECT data_json FROM wf_payloads WHERE key = $1',
        [key],
      );
      return r.rows[0] ? r.rows[0].data_json : undefined;
    },
    async delete(key) {
      await pool.query('DELETE FROM wf_payloads WHERE key = $1', [key]);
    },
    async deleteRun(runId) {
      await pool.query('DELETE FROM wf_payloads WHERE run_id = $1', [runId]);
    },
  };
}
