/**
 * @weaveintel/observability — OTel GenAI-compatible tracer (Phase 1)
 *
 * Implements the WeaveIntel `Tracer` interface while emitting spans
 * to an OTLP HTTP/JSON endpoint (Grafana Cloud, Honeycomb, Jaeger, etc.)
 * using GenAI semantic conventions from the 2026 OTel specification.
 *
 * No `@opentelemetry/sdk-*` dependency — the OTLP JSON protocol is a
 * simple REST call, so we POST directly and avoid the heavyweight SDK.
 *
 * Usage:
 *   import { createOtelTracer } from '@weaveintel/observability';
 *   const tracer = createOtelTracer({ serviceName: 'geneweave', endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT });
 *   // Falls back to console tracer when endpoint is falsy.
 *
 * OTLP endpoint convention:
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318  (Jaeger / OTel Collector)
 *   OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io  (Honeycomb)
 *   Traces are POSTed to  <endpoint>/v1/traces
 */

import { createHash } from 'node:crypto';
import type { ExecutionContext, Span, SpanRecord, Tracer, TraceSink } from '@weaveintel/core';

// ─── GenAI Semantic Convention Attribute Keys (OTel 2026) ────────────────────

/**
 * OpenTelemetry GenAI semantic convention attribute keys.
 * Import this object to keep attribute names consistent across the codebase.
 *
 * @see https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */
export const GEN_AI = {
  /** AI provider (e.g. 'anthropic', 'openai', 'google'). */
  SYSTEM: 'gen_ai.system',
  /** The requested model identifier (e.g. 'claude-sonnet-4-6'). */
  REQUEST_MODEL: 'gen_ai.request.model',
  /** The actual model that responded (may differ from requested). */
  RESPONSE_MODEL: 'gen_ai.response.model',
  /** Max tokens requested. */
  REQUEST_MAX_TOKENS: 'gen_ai.request.max_tokens',
  /** Sampling temperature. */
  REQUEST_TEMPERATURE: 'gen_ai.request.temperature',
  /** Number of prompt/input tokens consumed. */
  USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  /** Number of completion/output tokens generated. */
  USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  /** Reasons the model stopped generating (e.g. ['stop', 'max_tokens']). */
  RESPONSE_FINISH_REASONS: 'gen_ai.response.finish_reasons',
  /** Operation name: 'chat', 'tool_call', 'embedding', 'completion'. */
  OPERATION_NAME: 'gen_ai.operation.name',
  /** Token cost in USD for this generation. */
  USAGE_COST_USD: 'gen_ai.usage.cost_usd',
} as const;

export type GenAiAttributeKey = (typeof GEN_AI)[keyof typeof GEN_AI];

// ─── OTLP ID helpers ─────────────────────────────────────────────────────────

/**
 * Deterministically convert an arbitrary string ID to a 32-hex-char OTel trace ID.
 * OTLP requires a 16-byte (32 hex char) trace ID.
 */
function toOtelTraceId(id: string): string {
  return createHash('md5').update(id).digest('hex'); // 32 hex chars ✓
}

/**
 * Deterministically convert an arbitrary string ID to a 16-hex-char OTel span ID.
 * OTLP requires an 8-byte (16 hex char) span ID.
 */
function toOtelSpanId(id: string): string {
  return createHash('md5').update(id).digest('hex').slice(0, 16); // 16 hex chars ✓
}

// ─── OTLP JSON format helpers ─────────────────────────────────────────────────

interface OtlpAnyValue {
  stringValue?: string;
  intValue?: number;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values: OtlpAnyValue[] };
}

interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

function toOtlpValue(v: unknown): OtlpAnyValue {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { intValue: v } : { doubleValue: v };
  }
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map(toOtlpValue) } };
  }
  if (v !== null && v !== undefined) return { stringValue: String(v) };
  return { stringValue: '' };
}

function toOtlpAttributes(attrs: Record<string, unknown>): OtlpKeyValue[] {
  return Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([key, value]) => ({ key, value: toOtlpValue(value) }));
}

function toOtlpSpan(span: SpanRecord): Record<string, unknown> {
  const statusCode = span.status === 'error' ? 2 : 1; // 1=OK, 2=ERROR
  return {
    traceId: toOtelTraceId(span.traceId),
    spanId: toOtelSpanId(span.spanId),
    ...(span.parentSpanId ? { parentSpanId: toOtelSpanId(span.parentSpanId) } : {}),
    name: span.name,
    kind: 3, // SPAN_KIND_CLIENT
    startTimeUnixNano: String(span.startTime * 1_000_000),
    endTimeUnixNano: String(span.endTime * 1_000_000),
    attributes: toOtlpAttributes(span.attributes),
    events: span.events.map((e) => ({
      name: e.name,
      timeUnixNano: String(e.timestamp * 1_000_000),
      attributes: toOtlpAttributes(e.data ?? {}),
    })),
    status: { code: statusCode },
  };
}

// ─── OTLP HTTP sink ───────────────────────────────────────────────────────────

export interface OtlpSinkOptions {
  /** OTLP HTTP endpoint base URL (e.g. 'http://localhost:4318').
   *  Traces are POSTed to `<endpoint>/v1/traces`. */
  endpoint: string;
  /** Service name attribute (resource-level). Default: 'weaveruntime'. */
  serviceName?: string;
  /** Optional service version. */
  serviceVersion?: string;
  /** Optional extra resource attributes. */
  resourceAttributes?: Record<string, string>;
  /** Optional bearer token for OTLP endpoint auth (e.g. Honeycomb API key). */
  apiKey?: string;
  /** Max ms to wait for the OTLP export to complete. Default: 5000. */
  exportTimeoutMs?: number;
  /** Batch size — flush when this many spans are buffered. Default: 50. */
  batchSize?: number;
  /** Max age of buffered spans before auto-flush (ms). Default: 2000. */
  flushIntervalMs?: number;
}

/**
 * Create a `TraceSink` that exports spans to an OTLP HTTP/JSON endpoint.
 *
 * Spans are batched and flushed either when the batch reaches `batchSize`
 * or when `flushIntervalMs` elapses — whichever comes first.
 * Call `.flush()` on process exit to ensure all buffered spans are sent.
 */
export function weaveOtlpSink(opts: OtlpSinkOptions): TraceSink {
  const endpoint = opts.endpoint.replace(/\/$/, '') + '/v1/traces';
  const serviceName = opts.serviceName ?? 'weaveruntime';
  const serviceVersion = opts.serviceVersion ?? '1.0.0';
  const exportTimeoutMs = opts.exportTimeoutMs ?? 5_000;
  const batchSize = opts.batchSize ?? 50;
  const flushIntervalMs = opts.flushIntervalMs ?? 2_000;

  const resourceAttributes: OtlpKeyValue[] = [
    { key: 'service.name', value: { stringValue: serviceName } },
    { key: 'service.version', value: { stringValue: serviceVersion } },
    ...Object.entries(opts.resourceAttributes ?? {}).map(([k, v]) => ({
      key: k,
      value: { stringValue: v },
    })),
  ];

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (opts.apiKey) headers['Authorization'] = `Bearer ${opts.apiKey}`;

  let buffer: SpanRecord[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  async function exportBatch(batch: SpanRecord[]): Promise<void> {
    if (batch.length === 0) return;
    const body = JSON.stringify({
      resourceSpans: [{
        resource: { attributes: resourceAttributes },
        scopeSpans: [{
          scope: { name: '@weaveintel/observability', version: '0.0.1' },
          spans: batch.map(toOtlpSpan),
        }],
      }],
    });

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), exportTimeoutMs);
    try {
      await fetch(endpoint, { method: 'POST', headers, body, signal: ctrl.signal });
    } catch {
      // Best-effort — observability never blocks the critical path
    } finally {
      clearTimeout(timer);
    }
  }

  function scheduleFlush(): void {
    if (flushTimer !== undefined) return;
    flushTimer = setTimeout(async () => {
      flushTimer = undefined;
      const batch = buffer.splice(0, buffer.length);
      await exportBatch(batch);
    }, flushIntervalMs);
    // Don't block process exit
    if (flushTimer.unref) flushTimer.unref();
  }

  return {
    record(span: SpanRecord): void {
      buffer.push(span);
      if (buffer.length >= batchSize) {
        const batch = buffer.splice(0, buffer.length);
        void exportBatch(batch);
      } else {
        scheduleFlush();
      }
    },

    async flush(): Promise<void> {
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      const batch = buffer.splice(0, buffer.length);
      await exportBatch(batch);
    },
  };
}

// ─── OTel Tracer ─────────────────────────────────────────────────────────────

export interface OtelTracerOptions {
  /** OTLP HTTP endpoint base URL (e.g. 'http://localhost:4318').
   *  When falsy, the tracer falls back to a no-op / console-compatible sink
   *  so the same code runs in dev without an OTel collector. */
  endpoint?: string | null;
  /** Service name (default: 'geneweave'). */
  serviceName?: string;
  serviceVersion?: string;
  /** Extra resource attributes forwarded to every span. */
  resourceAttributes?: Record<string, string>;
  /** Optional bearer token for OTLP endpoint auth. */
  apiKey?: string;
}

function createSpanImpl(
  traceId: string,
  name: string,
  parentSpanId?: string,
  sinkFn?: (record: SpanRecord) => void,
  attrs?: Record<string, unknown>,
): Span {
  const spanId = `span_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const startTime = Date.now();
  const events: Array<{ name: string; timestamp: number; data?: Record<string, unknown> }> = [];
  const attributes: Record<string, unknown> = { ...attrs };
  let status: 'ok' | 'error' = 'ok';
  let endTime: number | undefined;

  return {
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
}

/**
 * Create an OTel GenAI-compatible tracer that exports to an OTLP endpoint.
 *
 * When `endpoint` is falsy (e.g. `OTEL_EXPORTER_OTLP_ENDPOINT` is not set),
 * the tracer is a no-op that creates spans in memory but doesn't export them.
 * This lets the same code run in dev (no collector) and production (with one).
 *
 * @example
 * ```ts
 * const tracer = createOtelTracer({
 *   serviceName: 'geneweave',
 *   endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
 * });
 * ```
 */
export function createOtelTracer(opts: OtelTracerOptions): Tracer & { sink: TraceSink } {
  const sink: TraceSink = opts.endpoint
    ? weaveOtlpSink({
        endpoint: opts.endpoint,
        serviceName: opts.serviceName ?? 'geneweave',
        serviceVersion: opts.serviceVersion,
        resourceAttributes: opts.resourceAttributes,
        apiKey: opts.apiKey,
      })
    : {
        record(): void { /* no-op when no endpoint */ },
        async flush(): Promise<void> { /* no-op */ },
      };

  const tracer: Tracer & { sink: TraceSink } = {
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
      const span = tracer.startSpan(ctx, name, attributes);
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

  return tracer;
}
