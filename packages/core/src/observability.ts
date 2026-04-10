/**
 * @weaveintel/core — Observability contracts
 *
 * Why: Every operation emits structured telemetry through traces, spans, and events.
 * The contracts define how to record activity; adapters (console, OTLP, file)
 * decide where it goes. This keeps the core independent of any observability vendor.
 */

import type { ExecutionContext } from './context.js';

export interface Span {
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly startTime: number;
  endTime?: number;
  status?: 'ok' | 'error';
  attributes: Record<string, unknown>;

  setAttribute(key: string, value: unknown): void;
  addEvent(name: string, data?: Record<string, unknown>): void;
  setError(error: Error): void;
  end(): void;
}

export interface Tracer {
  startSpan(ctx: ExecutionContext, name: string, attributes?: Record<string, unknown>): Span;
  withSpan<T>(
    ctx: ExecutionContext,
    name: string,
    fn: (span: Span) => Promise<T>,
    attributes?: Record<string, unknown>,
  ): Promise<T>;
}

export interface TraceSink {
  record(span: SpanRecord): void;
  flush?(): Promise<void>;
}

export interface SpanRecord {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly status: 'ok' | 'error';
  readonly attributes: Record<string, unknown>;
  readonly events: readonly SpanEvent[];
}

export interface SpanEvent {
  readonly name: string;
  readonly timestamp: number;
  readonly data?: Record<string, unknown>;
}

// ─── Cost & token tracking ───────────────────────────────────

export interface UsageRecord {
  readonly executionId: string;
  readonly model: string;
  readonly provider: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly costUsd?: number;
  readonly timestamp: number;
}

export interface UsageTracker {
  record(usage: UsageRecord): void;
  getTotal(executionId: string): UsageRecord | undefined;
  getAll(): UsageRecord[];
}

// ─── Run logger ──────────────────────────────────────────────

export interface RunLog {
  readonly executionId: string;
  readonly startTime: number;
  readonly endTime?: number;
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled';
  readonly steps: readonly StepLog[];
  readonly totalTokens: number;
  readonly totalCostUsd?: number;
}

export interface StepLog {
  readonly index: number;
  readonly type: string;
  readonly name: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly input?: Record<string, unknown>;
  readonly output?: Record<string, unknown>;
  readonly error?: string;
}
