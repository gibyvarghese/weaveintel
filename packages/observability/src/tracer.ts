/**
 * @weaveintel/observability — Tracer implementation
 *
 * Console tracer for development and an in-memory tracer for testing.
 * Both implement the Tracer interface from core. Production adapters
 * (OTLP, Datadog, etc.) follow the same TraceSink contract.
 */

import type {
  Tracer,
  Span,
  SpanRecord,
  SpanEvent,
  TraceSink,
  UsageTracker,
  UsageRecord,
  ExecutionContext,
} from '@weaveintel/core';

// ─── Span implementation ─────────────────────────────────────

function createSpanImpl(
  traceId: string,
  name: string,
  parentSpanId?: string,
  sinkFn?: (record: SpanRecord) => void,
  attrs?: Record<string, unknown>,
): Span {
  let spanIdCounter = 0;
  const spanId = `span_${Date.now()}_${++spanIdCounter}_${Math.random().toString(36).slice(2, 8)}`;
  const startTime = Date.now();
  const events: SpanEvent[] = [];
  const attributes: Record<string, unknown> = { ...attrs };
  let status: 'ok' | 'error' = 'ok';
  let endTime: number | undefined;

  const span: Span = {
    spanId,
    parentSpanId,
    name,
    startTime,
    get endTime() { return endTime; },
    set endTime(v) { endTime = v; },
    get status() { return status; },
    set status(v) { status = v ?? 'ok'; },
    attributes,

    setAttribute(key: string, value: unknown): void {
      attributes[key] = value;
    },

    addEvent(eventName: string, data?: Record<string, unknown>): void {
      events.push({ name: eventName, timestamp: Date.now(), data });
    },

    setError(error: Error): void {
      status = 'error';
      attributes['error.message'] = error.message;
      attributes['error.name'] = error.name;
      if (error.stack) attributes['error.stack'] = error.stack;
    },

    end(): void {
      endTime = Date.now();
      sinkFn?.({
        traceId,
        spanId,
        parentSpanId,
        name,
        startTime,
        endTime,
        status,
        attributes: { ...attributes },
        events: [...events],
      });
    },
  };

  return span;
}

// ─── Console tracer ──────────────────────────────────────────

export function createConsoleTracer(): Tracer & { sink: TraceSink } {
  const sink: TraceSink = {
    record(span: SpanRecord): void {
      const dur = span.endTime - span.startTime;
      const prefix = span.status === 'error' ? '✗' : '✓';
      const indent = span.parentSpanId ? '  ' : '';
      console.log(
        `${indent}${prefix} [${span.name}] ${dur}ms`,
        span.attributes['error.message'] ? `| error: ${span.attributes['error.message']}` : '',
      );
    },
  };

  return {
    sink,

    startSpan(ctx: ExecutionContext, name: string, attributes?: Record<string, unknown>): Span {
      return createSpanImpl(ctx.executionId, name, ctx.parentSpanId, sink.record, attributes);
    },

    async withSpan<T>(
      ctx: ExecutionContext,
      name: string,
      fn: (span: Span) => Promise<T>,
      attributes?: Record<string, unknown>,
    ): Promise<T> {
      const span = this.startSpan(ctx, name, attributes);
      try {
        const result = await fn(span);
        span.end();
        return result;
      } catch (err) {
        span.setError(err instanceof Error ? err : new Error(String(err)));
        span.end();
        throw err;
      }
    },
  };
}

// ─── In-memory tracer (for testing) ──────────────────────────

export function createInMemoryTracer(): Tracer & { spans: SpanRecord[]; clear(): void; sink: TraceSink } {
  const spans: SpanRecord[] = [];

  const sink: TraceSink = {
    record(span: SpanRecord): void {
      spans.push(span);
    },
    async flush(): Promise<void> {
      // no-op for in-memory
    },
  };

  return {
    spans,
    sink,

    clear(): void {
      spans.length = 0;
    },

    startSpan(ctx: ExecutionContext, name: string, attributes?: Record<string, unknown>): Span {
      return createSpanImpl(ctx.executionId, name, ctx.parentSpanId, sink.record, attributes);
    },

    async withSpan<T>(
      ctx: ExecutionContext,
      name: string,
      fn: (span: Span) => Promise<T>,
      attributes?: Record<string, unknown>,
    ): Promise<T> {
      const span = this.startSpan(ctx, name, attributes);
      try {
        const result = await fn(span);
        span.end();
        return result;
      } catch (err) {
        span.setError(err instanceof Error ? err : new Error(String(err)));
        span.end();
        throw err;
      }
    },
  };
}

// ─── Usage tracker implementation ────────────────────────────

export function createUsageTracker(): UsageTracker {
  const records: UsageRecord[] = [];
  const totals = new Map<string, UsageRecord>();

  return {
    record(usage: UsageRecord): void {
      records.push(usage);

      const existing = totals.get(usage.executionId);
      if (existing) {
        totals.set(usage.executionId, {
          ...existing,
          promptTokens: existing.promptTokens + usage.promptTokens,
          completionTokens: existing.completionTokens + usage.completionTokens,
          totalTokens: existing.totalTokens + usage.totalTokens,
          costUsd: (existing.costUsd ?? 0) + (usage.costUsd ?? 0),
          timestamp: usage.timestamp,
        });
      } else {
        totals.set(usage.executionId, usage);
      }
    },

    getTotal(executionId: string): UsageRecord | undefined {
      return totals.get(executionId);
    },

    getAll(): UsageRecord[] {
      return [...records];
    },
  };
}
