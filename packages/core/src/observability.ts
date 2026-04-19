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

// ─── Capability telemetry ───────────────────────────────────

/**
 * Shared capability categories used by observability, evals, and runtime
 * metadata. Keeping the vocabulary in core ensures prompts, skills, tools,
 * and agents can all emit a comparable shape without app-local adapters.
 */
export type CapabilityKind = 'prompt' | 'skill' | 'agent' | 'tool';

export interface CapabilityEvaluationTelemetry {
  readonly id: string;
  readonly description: string;
  readonly passed: boolean;
  readonly score?: number;
  readonly reason?: string;
}

export interface CapabilityContractTelemetry {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly warnings?: number;
  readonly errors?: number;
}

/**
 * Normalized, capability-agnostic execution summary.
 *
 * Why: prompts, skills, agents, and tools should all be observable through the
 * same top-level shape so traces, dashboards, and audits can compare them.
 */
export interface CapabilityTelemetrySummary {
  readonly kind: CapabilityKind;
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly version?: string;
  readonly source?: 'db' | 'builtin' | 'runtime' | 'user';
  readonly selectedBy?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly strategyKey?: string;
  readonly strategyName?: string;
  readonly strategyDescription?: string;
  readonly usedFallbackStrategy?: boolean;
  readonly renderedCharacters?: number;
  readonly renderedLines?: number;
  readonly baseCharacters?: number;
  readonly durationMs?: number;
  readonly evaluations?: readonly CapabilityEvaluationTelemetry[];
  readonly contracts?: CapabilityContractTelemetry;
  readonly tags?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export type CapabilityTelemetryStage = 'start' | 'success' | 'error';

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
