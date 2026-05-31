/**
 * MongoDB-backed WorkflowRateLimiter (token bucket).
 */
import type { Db } from 'mongodb';
import type { WorkflowRateLimiter } from './rate-limiter.js';

interface Doc { _id: string; tokens: number; lastRefillMs: number; }
interface Bucket { tokens: number; lastRefillMs: number; }

export interface WeaveMongoDbRateLimiterOptions {
  db: Db;
  collection?: string;
}

function refill(bucket: Bucket, maxPerMinute: number, nowMs: number): Bucket {
  const elapsedMinutes = (nowMs - bucket.lastRefillMs) / 60_000;
  const refilled = Math.min(maxPerMinute, bucket.tokens + elapsedMinutes * maxPerMinute);
  return { tokens: refilled, lastRefillMs: nowMs };
}

export async function weaveMongoDbRateLimiter(
  opts: WeaveMongoDbRateLimiterOptions,
): Promise<WorkflowRateLimiter> {
  const col = opts.db.collection<Doc>(opts.collection ?? 'wf_rate_limits');

  async function read(workflowId: string, maxPerMinute: number): Promise<Bucket> {
    const d = await col.findOne({ _id: workflowId });
    return d ? { tokens: d.tokens, lastRefillMs: d.lastRefillMs } : { tokens: maxPerMinute, lastRefillMs: Date.now() };
  }
  async function upsert(workflowId: string, bucket: Bucket): Promise<void> {
    await col.updateOne(
      { _id: workflowId },
      { $set: { tokens: bucket.tokens, lastRefillMs: bucket.lastRefillMs } },
      { upsert: true },
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
      await col.deleteOne({ _id: workflowId });
    },
  };
}
