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
import { createCircuitBreaker, type CircuitBreaker, type CircuitBreakerOptions, type CircuitState } from './circuit-breaker.js';
import { createConcurrencyLimiter, type ConcurrencyLimiter, type ConcurrencyLimiterOptions } from './concurrency.js';
import type { WeaveRuntime } from '@weaveintel/core';
import { weaveInMemoryPersistence } from '@weaveintel/core';

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

// ─── Phase 4: durable endpoint registry ──────────────────────────────────────

export interface DurableEndpointRegistryOptions {
  /** When supplied and `runtime.persistence` is configured, circuit-breaker
   *  state (open/closed/half-open) is persisted across process restarts so a
   *  known-bad endpoint stays open through a deploy instead of thundering-herd.
   *  Falls back to `weaveInMemoryPersistence()` when no runtime is given. */
  runtime?: WeaveRuntime;
  /** Key namespace. Defaults to `'er'`. */
  namespace?: string;
}

interface CircuitSnapshot {
  state: CircuitState;
  consecutiveFailures: number;
  openedAt: number;
  cooldownMs: number;
  failureThreshold: number;
}

export interface DurableEndpointRegistry {
  /** Async equivalent of the module-level `getOrCreateEndpointState`. */
  getOrCreateEndpointState(endpoint: string, opts?: EndpointStateOptions): Promise<EndpointState>;
  getEndpointState(endpoint: string): EndpointState | undefined;
  listEndpointStates(): readonly EndpointState[];
  /** Test-only reset. */
  _reset(): void;
}

/**
 * Durable, runtime-aware endpoint registry (Phase 4 — Durability everywhere).
 *
 * Circuit-breaker state is snapshotted to `runtime.persistence.kv` after each
 * `recordSuccess`, `recordFailure`, and `reset` call. On the next process boot,
 * if a circuit was open and its cooldown has not yet elapsed, the breaker is
 * re-tripped so the bad endpoint stays open rather than receiving a thundering
 * herd of immediate retries.
 *
 * Token-bucket and concurrency state is inherently ephemeral and is not
 * persisted — buckets refill quickly and concurrency slots reset cleanly.
 */
export function createDurableEndpointRegistry(opts: DurableEndpointRegistryOptions = {}): DurableEndpointRegistry {
  const ns = opts.namespace ?? 'er';
  const slot = opts.runtime?.persistence ?? weaveInMemoryPersistence();
  const kv = slot.kv;
  const local = new Map<string, EndpointState>();

  function circuitKey(endpoint: string): string {
    return `${ns}:circuit:${endpoint}`;
  }

  async function persistCircuit(endpoint: string, circuit: CircuitBreaker): Promise<void> {
    await kv.set(circuitKey(endpoint), JSON.stringify(circuit.snapshot()));
  }

  async function restoreCircuit(endpoint: string, circuit: CircuitBreaker): Promise<void> {
    const raw = await kv.get(circuitKey(endpoint));
    if (!raw) return;
    let snap: CircuitSnapshot;
    try { snap = JSON.parse(raw) as CircuitSnapshot; } catch { return; }
    if ((snap.state === 'open' || snap.state === 'half_open') && Date.now() < snap.openedAt + snap.cooldownMs) {
      // Re-trip by recording enough failures; recordFailure is idempotent once open.
      for (let i = 0; i < snap.failureThreshold; i++) {
        circuit.recordFailure();
      }
    }
  }

  function wrapCircuit(endpoint: string, circuit: CircuitBreaker): CircuitBreaker {
    return {
      canPass: () => circuit.canPass(),
      state: () => circuit.state(),
      snapshot: () => circuit.snapshot(),
      recordSuccess() {
        circuit.recordSuccess();
        void persistCircuit(endpoint, circuit);
      },
      recordFailure() {
        const result = circuit.recordFailure();
        void persistCircuit(endpoint, circuit);
        return result;
      },
      reset() {
        circuit.reset();
        void persistCircuit(endpoint, circuit);
      },
    };
  }

  return {
    async getOrCreateEndpointState(endpoint, endpointOpts): Promise<EndpointState> {
      const existing = local.get(endpoint);
      if (existing) return existing;

      const rawCircuit = endpointOpts?.circuit ? createCircuitBreaker(endpointOpts.circuit) : undefined;
      if (rawCircuit) await restoreCircuit(endpoint, rawCircuit);

      const state: EndpointState = {
        endpoint,
        ...(endpointOpts?.rateLimit ? { rateLimit: createTokenBucket(endpointOpts.rateLimit) } : {}),
        ...(endpointOpts?.concurrency ? { concurrency: createConcurrencyLimiter(endpointOpts.concurrency) } : {}),
        ...(rawCircuit ? { circuit: wrapCircuit(endpoint, rawCircuit) } : {}),
      };
      local.set(endpoint, state);
      return state;
    },

    getEndpointState(endpoint): EndpointState | undefined {
      return local.get(endpoint);
    },

    listEndpointStates(): readonly EndpointState[] {
      return [...local.values()];
    },

    _reset(): void {
      local.clear();
    },
  };
}
