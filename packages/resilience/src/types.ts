/**
 * @weaveintel/resilience — Public types
 */

import type { ClassifiedError } from '@weaveintel/core';

/**
 * Normalized signal emitted by the resilience pipeline. Apps subscribe to
 * these instead of trying to inspect thrown errors after the fact.
 */
export type ResilienceSignal =
  | { kind: 'rate_limited'; endpoint: string; retryAfterMs: number; attempt: number; at: number }
  | { kind: 'retrying'; endpoint: string; attempt: number; nextDelayMs: number; cause: ClassifiedError; at: number }
  | { kind: 'circuit_opened'; endpoint: string; consecutiveFailures: number; cooldownMs: number; at: number }
  | { kind: 'circuit_half_opened'; endpoint: string; at: number }
  | { kind: 'circuit_closed'; endpoint: string; at: number }
  | { kind: 'shed'; endpoint: string; reason: 'queue_full' | 'circuit_open' | 'rate_limit'; at: number }
  | { kind: 'success'; endpoint: string; attempt: number; durationMs: number; at: number }
  | { kind: 'failed'; endpoint: string; attempt: number; durationMs: number; cause: ClassifiedError; at: number };

export type SignalKind = ResilienceSignal['kind'];

/** Per-call overrides that selectively change pipeline behaviour. */
export interface CallOverrides {
  /**
   * `'wait'` (default for tools) blocks until a rate-limit slot is available.
   * `'fail-fast'` (default for live-agent ticks) throws immediately so the
   * outer scheduler can defer the work.
   */
  rateLimitMode?: 'wait' | 'fail-fast';
  /** Override the configured retry policy's max attempts (0 = no retries). */
  maxRetries?: number;
  /** Per-call timeout. Defaults to the controller's configured `timeoutMs`. */
  timeoutMs?: number;
  /** Skip the circuit-breaker check (probe / break-glass). */
  bypassCircuit?: boolean;
}
