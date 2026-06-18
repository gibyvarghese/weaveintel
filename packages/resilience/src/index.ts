// SPDX-License-Identifier: MIT
/**
 * @weaveintel/resilience — Public API
 *
 * Phase 2 of the shared resilience pipeline (see `docs/RESILIENCE_PLAN.md`).
 * Compose token bucket + circuit breaker + concurrency + retry into a single
 * callable per endpoint, emitting normalized signals so apps can react.
 */

export type { ResilienceSignal, SignalKind, CallOverrides } from './types.js';
export {
  type ResilienceSignalBus,
  type SignalListener,
  createResilienceSignalBus,
  getDefaultSignalBus,
  setDefaultSignalBus,
} from './signal-bus.js';
export {
  type TokenBucket,
  type TokenBucketOptions,
  createTokenBucket,
} from './token-bucket.js';
export {
  type CircuitBreaker,
  type CircuitBreakerOptions,
  type CircuitState,
  createCircuitBreaker,
} from './circuit-breaker.js';
export {
  type ConcurrencyLimiter,
  type ConcurrencyLimiterOptions,
  createConcurrencyLimiter,
} from './concurrency.js';
export {
  type RetryPolicy,
  type RetryPolicyOptions,
  createRetryPolicy,
} from './retry-policy.js';
export {
  type EndpointState,
  type EndpointStateOptions,
  getOrCreateEndpointState,
  getEndpointState,
  listEndpointStates,
  _resetEndpointRegistry,
  createDurableEndpointRegistry,
  type DurableEndpointRegistry,
  type DurableEndpointRegistryOptions,
} from './endpoint-registry.js';
export {
  type ResilienceOptions,
  type ResilientCallable,
  createResilientCallable,
  runResilient,
} from './pipeline.js';

/**
 * Canonical provider-level resilience defaults (Phase 5 — consolidation).
 * All three built-in LLM providers (OpenAI, Anthropic, Google) use these
 * values so quota behaviour is consistent across providers. Custom provider
 * packages SHOULD import and reuse this constant rather than hardcoding their
 * own copies.
 *
 * Values:
 *   retry  — 2 auto-retries with 500 ms base, 30 s cap, jitter on.
 *   circuit — opens after 8 consecutive failures, 30 s cooldown.
 */
export const PROVIDER_RESILIENCE_DEFAULTS = {
  retry: { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 30_000, jitter: true },
  circuit: { failureThreshold: 8, cooldownMs: 30_000 },
} as const;
