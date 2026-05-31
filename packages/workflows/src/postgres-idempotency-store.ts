/**
 * Postgres-backed StepIdempotencyStore.
 */
import type { Pool } from 'pg';
import type { StepIdempotencyStore } from './idempotency-store.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_idempotency (
  key TEXT PRIMARY KEY,
  output_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

export interface WeavePostgresIdempotencyStoreOptions {
  pool: Pool;
  ensureSchema?: boolean;
}

export async function weavePostgresIdempotencyStore(
  opts: WeavePostgresIdempotencyStoreOptions,
): Promise<StepIdempotencyStore> {
  if (opts.ensureSchema !== false) await opts.pool.query(MIGRATIONS_SQL);
  const pool = opts.pool;
  return {
    async get(key) {
      const r = await pool.query<{ output_json: unknown }>(
        'SELECT output_json FROM wf_idempotency WHERE key = $1',
        [key],
      );
      return r.rows[0] ? r.rows[0].output_json : undefined;
    },
    async set(key, output) {
      await pool.query(
        'INSERT INTO wf_idempotency (key, output_json) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET output_json = EXCLUDED.output_json',
        [key, JSON.stringify(output ?? null)],
      );
    },
    async delete(key) {
      await pool.query('DELETE FROM wf_idempotency WHERE key = $1', [key]);
    },
    async clearPrefix(prefix) {
      await pool.query('DELETE FROM wf_idempotency WHERE key LIKE $1', [`${prefix}%`]);
    },
  };
}
