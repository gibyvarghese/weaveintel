/**
 * @weaveintel/workflows — circuit-breaker.ts
 *
 * Phase W2 — Per-handler-kind circuit breaker.
 *
 * The circuit breaker prevents cascading failures when an upstream service
 * is degraded. It tracks consecutive failures per handler kind and trips to
 * OPEN (fail-fast) after `failureThreshold` failures. After `resetIntervalMs`
 * it moves to HALF-OPEN and allows one probe; success → CLOSED, failure →
 * OPEN again.
 *
 * The `CircuitBreakerRegistry` maps handler kind strings (e.g. `'tool'`,
 * `'mcp'`, `'agent'`) to individual CircuitBreaker instances. The engine
 * consults the registry when wrapping resolver-based handlers at run-start.
 */

export interface CircuitBreakerConfig {
  /** Number of consecutive failures before the circuit opens. Default 5. */
  failureThreshold?: number;
  /** Milliseconds to stay OPEN before allowing a half-open probe. Default 30 000. */
  resetIntervalMs?: number;
  /** Optional name shown in stats/logs. */
  name?: string;
}

export type CircuitBreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerStats {
  state: CircuitBreakerState;
  failures: number;
  openedAt?: number;
  name?: string;
}

export class CircuitBreaker {
  private state: CircuitBreakerState = 'closed';
  private failures = 0;
  private openedAt?: number;
  private readonly threshold: number;
  private readonly resetMs: number;
  readonly name?: string;

  constructor(config: CircuitBreakerConfig = {}) {
    this.threshold = config.failureThreshold ?? 5;
    this.resetMs    = config.resetIntervalMs ?? 30_000;
    this.name       = config.name;
  }

  /**
   * Returns `false` when the circuit is OPEN and the reset interval has not
   * yet elapsed — callers should fail fast without invoking the handler.
   */
  canExecute(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'half-open') return true; // one probe allowed
    // OPEN: check reset interval
    if (this.openedAt !== undefined && Date.now() - this.openedAt >= this.resetMs) {
      this.state = 'half-open';
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    if (this.state === 'half-open') {
      // Probe succeeded — close the circuit
      this.state = 'closed';
      this.failures = 0;
      this.openedAt = undefined;
    } else if (this.state === 'closed') {
      // Reset failure counter on a clean success
      this.failures = 0;
    }
  }

  recordFailure(): void {
    this.failures++;
    if (this.state === 'half-open' || this.failures >= this.threshold) {
      this.state = 'open';
      this.openedAt = Date.now();
    }
  }

  getState(): CircuitBreakerState { return this.state; }

  getStats(): CircuitBreakerStats {
    return { state: this.state, failures: this.failures, openedAt: this.openedAt, name: this.name };
  }

  /** Force-close the circuit (e.g. after manual intervention). */
  reset(): void {
    this.state = 'closed';
    this.failures = 0;
    this.openedAt = undefined;
  }
}

export class CircuitBreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();

  /** Register a circuit breaker for a handler kind. Returns `this` for chaining. */
  register(handlerKind: string, config?: CircuitBreakerConfig): this {
    this.breakers.set(handlerKind, new CircuitBreaker(config));
    return this;
  }

  /** Look up by handler kind. Returns `undefined` if no CB is configured. */
  get(handlerKind: string): CircuitBreaker | undefined {
    return this.breakers.get(handlerKind);
  }

  /** All registered circuit breakers with their current stats. */
  list(): Array<{ kind: string; stats: CircuitBreakerStats }> {
    return [...this.breakers.entries()].map(([kind, cb]) => ({ kind, stats: cb.getStats() }));
  }
}
