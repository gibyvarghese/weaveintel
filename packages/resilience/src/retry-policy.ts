/**
 * @weaveintel/resilience — Retry policy
 *
 * Decides whether a `ClassifiedError` should be retried and computes the
 * next delay. Honours `classifier.retryAfterMs` (always wins over backoff).
 */

import type { ClassifiedError } from '@weaveintel/core';

export interface RetryPolicy {
  readonly maxAttempts: number; // total attempts including the first
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly factor: number;
  readonly jitter: boolean;
  shouldRetry(err: ClassifiedError, attempt: number): boolean;
  nextDelayMs(err: ClassifiedError, attempt: number): number;
}

export interface RetryPolicyOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly factor?: number;
  readonly jitter?: boolean;
  /**
   * Override the classifier-driven retry decision. Default behaviour:
   * retry iff `err.retryable && err.class !== 'auth' && err.class !== 'invalid_input'`.
   */
  readonly shouldRetry?: (err: ClassifiedError, attempt: number) => boolean;
}

const DEFAULTS = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  factor: 2,
  jitter: true,
};

export function createRetryPolicy(opts: RetryPolicyOptions = {}): RetryPolicy {
  const maxAttempts = opts.maxAttempts ?? DEFAULTS.maxAttempts;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const factor = opts.factor ?? DEFAULTS.factor;
  const jitter = opts.jitter ?? DEFAULTS.jitter;

  const defaultShouldRetry = (err: ClassifiedError): boolean => {
    if (!err.retryable) return false;
    if (err.class === 'auth' || err.class === 'invalid_input' || err.class === 'cancelled') return false;
    return true;
  };
  const shouldRetryFn = opts.shouldRetry ?? defaultShouldRetry;

  return {
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    factor,
    jitter,
    shouldRetry(err, attempt) {
      if (attempt >= maxAttempts) return false;
      return shouldRetryFn(err, attempt);
    },
    nextDelayMs(err, attempt) {
      // attempt is 1-based: first retry is attempt=1
      const exp = baseDelayMs * Math.pow(factor, Math.max(0, attempt - 1));
      let delay = Math.min(maxDelayMs, exp);
      // Apply jitter to the backoff portion only — never wait less than the
      // upstream Retry-After hint.
      if (jitter) delay = Math.floor(Math.random() * delay);
      if (err.retryAfterMs !== undefined) {
        delay = Math.max(delay, err.retryAfterMs);
      }
      return Math.min(maxDelayMs, Math.max(0, delay));
    },
  };
}
