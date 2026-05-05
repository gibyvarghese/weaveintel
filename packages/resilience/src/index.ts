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
} from './endpoint-registry.js';
export {
  type ResilienceOptions,
  type ResilientCallable,
  createResilientCallable,
  runResilient,
} from './pipeline.js';
