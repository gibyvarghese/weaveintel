/**
 * HTTP rate limiter — fixed-window counter, optional Redis backing.
 *
 * When REDIS_URL is set the limiter shares state across all server instances
 * via Redis INCR+EXPIRE keys (one key per (window-bucket × key)). When Redis
 * is unavailable it falls back to an in-process Map so requests are never
 * blocked due to a Redis outage (fail-open).
 *
 * Usage:
 *   const limiter = await createHttpRateLimiter(process.env['REDIS_URL']);
 *   const { limited, retryAfterMs } = await limiter.check('login:ip:1.2.3.4', 10, 600_000);
 */

export interface HttpRateLimiter {
  check(key: string, limit: number, windowMs: number): Promise<{ limited: boolean; retryAfterMs: number }>;
  /** True when backed by a shared store (Redis); false = in-process only. */
  readonly distributed: boolean;
}

// ── In-process fallback ──────────────────────────────────────────────────────

function createInProcessRateLimiter(): HttpRateLimiter {
  const states = new Map<string, { count: number; windowStart: number }>();

  function cleanup(now: number, windowMs: number) {
    for (const [k, v] of states) {
      if (now - v.windowStart >= windowMs) states.delete(k);
    }
  }

  return {
    distributed: false,
    async check(key, limit, windowMs) {
      const now = Date.now();
      cleanup(now, windowMs);
      const current = states.get(key);
      if (!current || now - current.windowStart >= windowMs) {
        states.set(key, { count: 1, windowStart: now });
        return { limited: false, retryAfterMs: 0 };
      }
      if (current.count >= limit) {
        const retryAfterMs = Math.max(1_000, windowMs - (now - current.windowStart));
        return { limited: true, retryAfterMs };
      }
      current.count += 1;
      return { limited: false, retryAfterMs: 0 };
    },
  };
}

// ── Redis-backed ─────────────────────────────────────────────────────────────

type RedisClient = {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
};

function createRedisRateLimiter(client: RedisClient): HttpRateLimiter {
  return {
    distributed: true,
    async check(key, limit, windowMs) {
      const windowSec = Math.ceil(windowMs / 1_000);
      // Bucket key changes every windowMs — creates a fixed window per bucket.
      const bucket = Math.floor(Date.now() / windowMs);
      const redisKey = `gw:rl:${key}:${bucket}`;

      try {
        const count = await client.incr(redisKey);
        if (count === 1) {
          // First hit in this window — set TTL (slightly longer to handle clock skew).
          await client.expire(redisKey, windowSec + 5);
        }
        if (count > limit) {
          const windowEnd = (bucket + 1) * windowMs;
          return { limited: true, retryAfterMs: Math.max(1_000, windowEnd - Date.now()) };
        }
        return { limited: false, retryAfterMs: 0 };
      } catch {
        // Redis unavailable — fail open so a Redis outage never blocks logins.
        return { limited: false, retryAfterMs: 0 };
      }
    },
  };
}

// ── Factory ──────────────────────────────────────────────────────────────────

export async function createHttpRateLimiter(redisUrl?: string): Promise<HttpRateLimiter> {
  if (!redisUrl) return createInProcessRateLimiter();

  try {
    const { createClient } = await import('redis');
    const client = createClient({ url: redisUrl });
    client.on('error', () => { /* suppress — check() already fails open */ });
    await client.connect();
    return createRedisRateLimiter(client as unknown as RedisClient);
  } catch {
    return createInProcessRateLimiter();
  }
}
