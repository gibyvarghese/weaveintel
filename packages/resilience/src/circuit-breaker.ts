/**
 * @weaveintel/resilience — Circuit breaker
 *
 * Three states: closed → open → half-open → closed.
 * - closed: normal traffic. Failures counted; threshold trips → open.
 * - open:   all calls rejected for `cooldownMs`. Then transitions to half-open.
 * - half-open: one probe call allowed. Success → closed. Failure → open again.
 *
 * Endpoint-scoped — one breaker per endpoint, shared across all callers in the
 * process via the endpoint registry.
 */

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Consecutive failures that flip from closed to open. */
  readonly failureThreshold: number;
  /** How long to stay open before allowing a single probe. */
  readonly cooldownMs: number;
}

export interface CircuitBreaker {
  /** Throws (or returns false) if the breaker is currently open. */
  canPass(): { allowed: true } | { allowed: false; reason: 'open'; reopensAt: number };
  /** Record a successful call. */
  recordSuccess(): void;
  /** Record a failure. Returns true if this transitioned the breaker open. */
  recordFailure(): { state: CircuitState; transitionedToOpen: boolean; consecutiveFailures: number };
  state(): CircuitState;
  snapshot(): {
    state: CircuitState;
    consecutiveFailures: number;
    openedAt: number;
    cooldownMs: number;
    failureThreshold: number;
  };
  /** Force-reset (admin/manual). */
  reset(): void;
}

export function createCircuitBreaker(opts: CircuitBreakerOptions): CircuitBreaker {
  if (opts.failureThreshold <= 0) throw new Error('CircuitBreaker: failureThreshold must be > 0');
  if (opts.cooldownMs <= 0) throw new Error('CircuitBreaker: cooldownMs must be > 0');

  let state: CircuitState = 'closed';
  let consecutiveFailures = 0;
  let openedAt = 0;

  function maybeTransitionToHalfOpen(): void {
    if (state !== 'open') return;
    if (Date.now() >= openedAt + opts.cooldownMs) {
      state = 'half_open';
    }
  }

  return {
    canPass() {
      maybeTransitionToHalfOpen();
      if (state === 'open') {
        return { allowed: false, reason: 'open' as const, reopensAt: openedAt + opts.cooldownMs };
      }
      return { allowed: true as const };
    },
    recordSuccess() {
      consecutiveFailures = 0;
      if (state !== 'closed') {
        state = 'closed';
        openedAt = 0;
      }
    },
    recordFailure() {
      consecutiveFailures += 1;
      let transitionedToOpen = false;
      if (state === 'half_open') {
        // probe failed — back to open with refreshed cooldown
        state = 'open';
        openedAt = Date.now();
        transitionedToOpen = true;
      } else if (state === 'closed' && consecutiveFailures >= opts.failureThreshold) {
        state = 'open';
        openedAt = Date.now();
        transitionedToOpen = true;
      }
      return { state, transitionedToOpen, consecutiveFailures };
    },
    state() {
      maybeTransitionToHalfOpen();
      return state;
    },
    snapshot() {
      maybeTransitionToHalfOpen();
      return {
        state,
        consecutiveFailures,
        openedAt,
        cooldownMs: opts.cooldownMs,
        failureThreshold: opts.failureThreshold,
      };
    },
    reset() {
      state = 'closed';
      consecutiveFailures = 0;
      openedAt = 0;
    },
  };
}
