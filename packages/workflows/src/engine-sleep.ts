export function now(): string { return new Date().toISOString(); }

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Phase W2 — Compute exponential-backoff retry delay.
 *
 * @param retryAttempt  1-based retry number (1 = first retry after initial failure)
 * @param baseDelayMs   Delay for the first retry (ms)
 * @param multiplier    Growth factor per attempt (default 2)
 * @param maxDelayMs    Hard cap on the computed delay (default 30 000)
 * @param jitter        When true, applies ±25 % random jitter to prevent thundering herd
 * @returns             Computed delay in milliseconds (integer)
 *
 * Sequence with baseDelayMs=100, multiplier=2, maxDelay=30 000:
 *   retry 1 → 100 ms
 *   retry 2 → 200 ms
 *   retry 3 → 400 ms
 *   retry 4 → 800 ms  …
 */
export function computeRetryDelay(
  retryAttempt: number,
  baseDelayMs: number,
  multiplier: number,
  maxDelayMs: number,
  jitter: boolean,
): number {
  const raw = baseDelayMs * Math.pow(multiplier, retryAttempt - 1);
  const clamped = Math.min(raw, maxDelayMs);
  return jitter ? Math.round(clamped * (0.5 + Math.random() * 0.5)) : Math.round(clamped);
}
