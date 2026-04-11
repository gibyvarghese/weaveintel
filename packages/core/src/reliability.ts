/**
 * @weaveintel/core — Reliability engineering contracts
 */

// ─── Idempotency ─────────────────────────────────────────────

export interface IdempotencyPolicy {
  id: string;
  name: string;
  keyBuilder: string;
  ttlMs: number;
  enabled: boolean;
}

// ─── Retry Budget ────────────────────────────────────────────

export interface RetryBudget {
  id: string;
  name: string;
  maxRetries: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  retryableErrors?: string[];
}

// ─── Dead Letter ─────────────────────────────────────────────

export interface DeadLetterRecord {
  id: string;
  originalId: string;
  type: string;
  payload: unknown;
  error: string;
  attempts: number;
  firstFailedAt: string;
  lastFailedAt: string;
  resolved: boolean;
}

// ─── Concurrency ─────────────────────────────────────────────

export interface ConcurrencyPolicy {
  id: string;
  name: string;
  maxConcurrent: number;
  queueSize?: number;
  timeoutMs?: number;
  strategy: 'reject' | 'queue' | 'shed-oldest';
}

// ─── Backpressure ────────────────────────────────────────────

export interface BackpressureSignal {
  type: 'healthy' | 'warning' | 'overloaded' | 'critical';
  utilization: number;
  queueDepth: number;
  recommendation: 'proceed' | 'slow-down' | 'shed-load' | 'stop';
}

// ─── Health ──────────────────────────────────────────────────

export type HealthStatusState = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

export interface HealthStatus {
  service: string;
  status: HealthStatusState;
  checks: HealthCheck[];
  timestamp: string;
}

export interface HealthCheck {
  name: string;
  status: HealthStatusState;
  message?: string;
  durationMs: number;
}

// ─── Failure Envelope ────────────────────────────────────────

export interface FailureEnvelope {
  id: string;
  type: string;
  error: string;
  stack?: string;
  context: Record<string, unknown>;
  recoverable: boolean;
  retryable: boolean;
  timestamp: string;
}
