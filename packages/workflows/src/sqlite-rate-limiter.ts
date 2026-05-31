/**
 * SQLite-backed WorkflowRateLimiter (token bucket).
 * Single table `wf_rate_limits` keyed by workflowId.
 */
import Database from 'better-sqlite3';
import type { WorkflowRateLimiter } from './rate-limiter.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS wf_rate_limits (
  workflow_id TEXT PRIMARY KEY,
  tokens REAL NOT NULL,
  last_refill_ms INTEGER NOT NULL
);
`;

export interface WeaveSqliteRateLimiterOptions {
  database?: Database.Database;
  databasePath?: string;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

function refill(bucket: Bucket, maxPerMinute: number, nowMs: number): Bucket {
  const elapsedMinutes = (nowMs - bucket.lastRefillMs) / 60_000;
  const refilled = Math.min(maxPerMinute, bucket.tokens + elapsedMinutes * maxPerMinute);
  return { tokens: refilled, lastRefillMs: nowMs };
}

export function weaveSqliteRateLimiter(
  opts: WeaveSqliteRateLimiterOptions = {},
): WorkflowRateLimiter {
  const db = opts.database ?? new Database(opts.databasePath ?? ':memory:');
  db.exec(MIGRATIONS_SQL);

  const select = db.prepare('SELECT tokens, last_refill_ms FROM wf_rate_limits WHERE workflow_id = ?');
  const upsert = db.prepare(
    'INSERT INTO wf_rate_limits (workflow_id, tokens, last_refill_ms) VALUES (?, ?, ?) ON CONFLICT(workflow_id) DO UPDATE SET tokens = excluded.tokens, last_refill_ms = excluded.last_refill_ms',
  );
  const del = db.prepare('DELETE FROM wf_rate_limits WHERE workflow_id = ?');

  function read(workflowId: string, maxPerMinute: number): Bucket {
    const row = select.get(workflowId) as { tokens: number; last_refill_ms: number } | undefined;
    return row
      ? { tokens: row.tokens, lastRefillMs: row.last_refill_ms }
      : { tokens: maxPerMinute, lastRefillMs: Date.now() };
  }

  return {
    async allow(workflowId, maxRunsPerMinute) {
      const now = Date.now();
      const bucket = refill(read(workflowId, maxRunsPerMinute), maxRunsPerMinute, now);
      if (bucket.tokens < 1) {
        upsert.run(workflowId, bucket.tokens, bucket.lastRefillMs);
        return false;
      }
      upsert.run(workflowId, bucket.tokens - 1, bucket.lastRefillMs);
      return true;
    },
    async remaining(workflowId, maxRunsPerMinute) {
      const now = Date.now();
      return Math.floor(refill(read(workflowId, maxRunsPerMinute), maxRunsPerMinute, now).tokens);
    },
    async reset(workflowId) {
      del.run(workflowId);
    },
  };
}
