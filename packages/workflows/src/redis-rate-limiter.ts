/**
 * Redis-backed WorkflowRateLimiter (token bucket).
 *
 * Layout: wf_rl:<workflowId>  HASH { tokens, lastRefillMs }
 */
import type { RedisClientType } from 'redis';
import type { WorkflowRateLimiter } from './rate-limiter.js';

export interface WeaveRedisRateLimiterOptions {
  client: RedisClientType;
  prefix?: string;
}

interface Bucket { tokens: number; lastRefillMs: number; }

function refill(bucket: Bucket, maxPerMinute: number, nowMs: number): Bucket {
  const elapsedMinutes = (nowMs - bucket.lastRefillMs) / 60_000;
  const refilled = Math.min(maxPerMinute, bucket.tokens + elapsedMinutes * maxPerMinute);
  return { tokens: refilled, lastRefillMs: nowMs };
}

export function weaveRedisRateLimiter(opts: WeaveRedisRateLimiterOptions): WorkflowRateLimiter {
  const c = opts.client;
  const prefix = opts.prefix ?? 'wf_rl';
  const k = (workflowId: string) => `${prefix}:${workflowId}`;

  async function read(workflowId: string, maxPerMinute: number): Promise<Bucket> {
    const h = await c.hGetAll(k(workflowId));
    if (!h || !h['tokens']) return { tokens: maxPerMinute, lastRefillMs: Date.now() };
    return { tokens: Number(h['tokens']), lastRefillMs: Number(h['lastRefillMs']) };
  }
  async function write(workflowId: string, bucket: Bucket): Promise<void> {
    await c.hSet(k(workflowId), { tokens: String(bucket.tokens), lastRefillMs: String(bucket.lastRefillMs) });
  }

  return {
    async allow(workflowId, maxRunsPerMinute) {
      const now = Date.now();
      const bucket = refill(await read(workflowId, maxRunsPerMinute), maxRunsPerMinute, now);
      if (bucket.tokens < 1) {
        await write(workflowId, bucket);
        return false;
      }
      await write(workflowId, { tokens: bucket.tokens - 1, lastRefillMs: bucket.lastRefillMs });
      return true;
    },
    async remaining(workflowId, maxRunsPerMinute) {
      const now = Date.now();
      return Math.floor(refill(await read(workflowId, maxRunsPerMinute), maxRunsPerMinute, now).tokens);
    },
    async reset(workflowId) {
      await c.del(k(workflowId));
    },
  };
}
