/**
 * @weaveintel/workflows — WorkflowRateLimiter
 *
 * Phase W5 — Per-definition token-bucket rate limiter.
 *
 * Before `startRun()` the engine calls `allow(workflowId, maxRunsPerMinute)`.
 * If a token is available it is consumed and `true` is returned. Otherwise
 * `false` is returned and the engine throws `WorkflowRateLimitError`.
 *
 * Tokens refill continuously at a rate of `maxRunsPerMinute / 60` per second.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface WorkflowRateLimiter {
  /**
   * Attempt to consume one token for the given workflow.
   * Returns true if a token was available (request allowed),
   * false if the rate limit is exceeded.
   */
  allow(workflowId: string, maxRunsPerMinute: number): Promise<boolean>;
  /** Peek at remaining tokens without consuming one (useful for monitoring). */
  remaining(workflowId: string, maxRunsPerMinute: number): Promise<number>;
  /** Reset the bucket for a workflow (admin / test use). */
  reset(workflowId: string): Promise<void>;
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

// ─── In-memory ─────────────────────────────────────────────────────────────

export class InMemoryWorkflowRateLimiter implements WorkflowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  async allow(workflowId: string, maxRunsPerMinute: number): Promise<boolean> {
    const now = Date.now();
    const raw = this.buckets.get(workflowId) ?? { tokens: maxRunsPerMinute, lastRefillMs: now };
    const bucket = refill(raw, maxRunsPerMinute, now);
    if (bucket.tokens < 1) {
      this.buckets.set(workflowId, bucket);
      return false;
    }
    this.buckets.set(workflowId, { tokens: bucket.tokens - 1, lastRefillMs: bucket.lastRefillMs });
    return true;
  }

  async remaining(workflowId: string, maxRunsPerMinute: number): Promise<number> {
    const now = Date.now();
    const raw = this.buckets.get(workflowId) ?? { tokens: maxRunsPerMinute, lastRefillMs: now };
    return Math.floor(refill(raw, maxRunsPerMinute, now).tokens);
  }

  async reset(workflowId: string): Promise<void> {
    this.buckets.delete(workflowId);
  }
}

// ─── JSON-file-backed ──────────────────────────────────────────────────────

export class JsonFileWorkflowRateLimiter implements WorkflowRateLimiter {
  private readonly dir: string;

  constructor(baseDir: string) {
    this.dir = join(baseDir, 'rate-limits');
  }

  private filePath(workflowId: string): string {
    return join(this.dir, `${workflowId}.json`);
  }

  private async readBucket(workflowId: string, maxPerMinute: number): Promise<Bucket> {
    try {
      const raw = JSON.parse(await readFile(this.filePath(workflowId), 'utf8')) as Bucket;
      return raw;
    } catch {
      return { tokens: maxPerMinute, lastRefillMs: Date.now() };
    }
  }

  private async writeBucket(workflowId: string, bucket: Bucket): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.filePath(workflowId), JSON.stringify(bucket), 'utf8');
  }

  async allow(workflowId: string, maxRunsPerMinute: number): Promise<boolean> {
    const now = Date.now();
    const bucket = refill(await this.readBucket(workflowId, maxRunsPerMinute), maxRunsPerMinute, now);
    if (bucket.tokens < 1) {
      await this.writeBucket(workflowId, bucket);
      return false;
    }
    await this.writeBucket(workflowId, { tokens: bucket.tokens - 1, lastRefillMs: bucket.lastRefillMs });
    return true;
  }

  async remaining(workflowId: string, maxRunsPerMinute: number): Promise<number> {
    const now = Date.now();
    return Math.floor(refill(await this.readBucket(workflowId, maxRunsPerMinute), maxRunsPerMinute, now).tokens);
  }

  async reset(workflowId: string): Promise<void> {
    const { rm } = await import('node:fs/promises');
    await rm(this.filePath(workflowId), { force: true });
  }
}
