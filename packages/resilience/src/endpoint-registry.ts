/**
 * @weaveintel/resilience — Endpoint registry
 *
 * Process-wide map keyed by endpoint id (e.g. `'openai:rest'`,
 * `'openai:chat:gpt-4o'`, `'github:rest'`). The first call to register an
 * endpoint with rate-limit / concurrency / circuit options creates the shared
 * state; subsequent registrations re-use that same state so every caller in
 * the process honours one quota.
 *
 * This is *only* the state container. Composition into a callable lives in
 * `pipeline.ts`.
 */

import { createTokenBucket, type TokenBucket, type TokenBucketOptions } from './token-bucket.js';
import { createCircuitBreaker, type CircuitBreaker, type CircuitBreakerOptions } from './circuit-breaker.js';
import { createConcurrencyLimiter, type ConcurrencyLimiter, type ConcurrencyLimiterOptions } from './concurrency.js';

export interface EndpointStateOptions {
  readonly rateLimit?: TokenBucketOptions;
  readonly concurrency?: ConcurrencyLimiterOptions;
  readonly circuit?: CircuitBreakerOptions;
}

export interface EndpointState {
  readonly endpoint: string;
  readonly rateLimit?: TokenBucket;
  readonly concurrency?: ConcurrencyLimiter;
  readonly circuit?: CircuitBreaker;
}

const states = new Map<string, EndpointState>();

/**
 * Get or create the shared state for `endpoint`. Subsequent calls IGNORE
 * `opts` — first registration wins. This is intentional: providers and apps
 * may both reach for the same endpoint id and we want one bucket, not two.
 */
export function getOrCreateEndpointState(endpoint: string, opts?: EndpointStateOptions): EndpointState {
  const existing = states.get(endpoint);
  if (existing) return existing;

  const state: EndpointState = {
    endpoint,
    ...(opts?.rateLimit ? { rateLimit: createTokenBucket(opts.rateLimit) } : {}),
    ...(opts?.concurrency ? { concurrency: createConcurrencyLimiter(opts.concurrency) } : {}),
    ...(opts?.circuit ? { circuit: createCircuitBreaker(opts.circuit) } : {}),
  };
  states.set(endpoint, state);
  return state;
}

/** Look up an existing endpoint state without creating one. */
export function getEndpointState(endpoint: string): EndpointState | undefined {
  return states.get(endpoint);
}

/** Snapshot of every registered endpoint. Useful for admin/observability. */
export function listEndpointStates(): readonly EndpointState[] {
  return [...states.values()];
}

/** Clear every endpoint. Test-only. */
export function _resetEndpointRegistry(): void {
  states.clear();
}
