/**
 * Postgres-backed WorkflowRateLimiter (token bucket).
 */
import type { Pool } from 'pg';
import type { WorkflowRateLimiter } from './rate-limiter.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_rate_limits (
  workflow_id TEXT PRIMARY KEY,
  tokens DOUBLE PRECISION NOT NULL,
  last_refill_ms BIGINT NOT NULL
);
`;

export interface WeavePostgresRateLimiterOptions {
  pool: Pool;
  ensureSchema?: boolean;
}

interface Bucket { tokens: number; lastRefillMs: number; }

function refill(bucket: Bucket, maxPerMinute: number, nowMs: number): Bucket {
  const elapsedMinutes = (nowMs - bucket.lastRefillMs) / 60_000;
  const refilled = Math.min(maxPerMinute, bucket.tokens + elapsedMinutes * maxPerMinute);
  return { tokens: refilled, lastRefillMs: nowMs };
}

export async function weavePostgresRateLimiter(
  opts: WeavePostgresRateLimiterOptions,
): Promise<WorkflowRateLimiter> {
  if (opts.ensureSchema !== false) await opts.pool.query(MIGRATIONS_SQL);
  const pool = opts.pool;

  async function read(workflowId: string, maxPerMinute: number): Promise<Bucket> {
    const r = await pool.query<{ tokens: string | number; last_refill_ms: string | number }>(
      'SELECT tokens, last_refill_ms FROM wf_rate_limits WHERE workflow_id = $1',
      [workflowId],
    );
    const row = r.rows[0];
    return row
      ? { tokens: Number(row.tokens), lastRefillMs: Number(row.last_refill_ms) }
      : { tokens: maxPerMinute, lastRefillMs: Date.now() };
  }

  async function upsert(workflowId: string, bucket: Bucket): Promise<void> {
    await pool.query(
      'INSERT INTO wf_rate_limits (workflow_id, tokens, last_refill_ms) VALUES ($1,$2,$3) ON CONFLICT (workflow_id) DO UPDATE SET tokens = EXCLUDED.tokens, last_refill_ms = EXCLUDED.last_refill_ms',
      [workflowId, bucket.tokens, bucket.lastRefillMs],
    );
  }

  return {
    async allow(workflowId, maxRunsPerMinute) {
      const now = Date.now();
      const bucket = refill(await read(workflowId, maxRunsPerMinute), maxRunsPerMinute, now);
      if (bucket.tokens < 1) {
        await upsert(workflowId, bucket);
        return false;
      }
      await upsert(workflowId, { tokens: bucket.tokens - 1, lastRefillMs: bucket.lastRefillMs });
      return true;
    },
    async remaining(workflowId, maxRunsPerMinute) {
      const now = Date.now();
      return Math.floor(refill(await read(workflowId, maxRunsPerMinute), maxRunsPerMinute, now).tokens);
    },
    async reset(workflowId) {
      await pool.query('DELETE FROM wf_rate_limits WHERE workflow_id = $1', [workflowId]);
    },
  };
}
