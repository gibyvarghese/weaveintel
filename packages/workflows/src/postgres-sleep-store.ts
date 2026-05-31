/**
 * Postgres-backed DurableSleepStore.
 */
import type { Pool } from 'pg';
import type { SleepRecord, DurableSleepStore } from '@weaveintel/core';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_sleeps (
  run_id TEXT PRIMARY KEY,
  wake_at BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wf_sleeps_wake ON wf_sleeps(wake_at);
`;

export interface WeavePostgresSleepStoreOptions {
  pool: Pool;
  ensureSchema?: boolean;
}

interface Row {
  run_id: string;
  wake_at: string | number;
  created_at: Date | string;
}

function toRecord(r: Row): SleepRecord {
  return {
    runId: r.run_id,
    wakeAt: Number(r.wake_at),
    createdAt: typeof r.created_at === 'string' ? r.created_at : r.created_at.toISOString(),
  };
}

export async function weavePostgresSleepStore(
  opts: WeavePostgresSleepStoreOptions,
): Promise<DurableSleepStore> {
  if (opts.ensureSchema !== false) await opts.pool.query(MIGRATIONS_SQL);
  const pool = opts.pool;
  return {
    async schedule(runId, wakeAt) {
      await pool.query(
        'INSERT INTO wf_sleeps (run_id, wake_at) VALUES ($1,$2) ON CONFLICT (run_id) DO UPDATE SET wake_at = EXCLUDED.wake_at',
        [runId, wakeAt],
      );
    },
    async cancel(runId) {
      await pool.query('DELETE FROM wf_sleeps WHERE run_id = $1', [runId]);
    },
    async getDue(now = Date.now()) {
      const r = await pool.query<Row>(
        'SELECT * FROM wf_sleeps WHERE wake_at <= $1 ORDER BY wake_at ASC, run_id ASC',
        [now],
      );
      return r.rows.map(toRecord);
    },
    async list() {
      const r = await pool.query<Row>('SELECT * FROM wf_sleeps ORDER BY wake_at ASC, run_id ASC');
      return r.rows.map(toRecord);
    },
  };
}
