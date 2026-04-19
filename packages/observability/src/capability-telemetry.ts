/**
 * @weaveintel/observability — shared capability telemetry helpers
 *
 * Why: prompt/skill/agent/tool execution data should all map to one traceable,
 * queryable shape. These helpers flatten the shared core contracts into span
 * attributes and events without coupling apps to any one tracing backend.
 */

import type {
  CapabilityTelemetryStage,
  CapabilityTelemetrySummary,
  Span,
  SpanEvent,
} from '@weaveintel/core';

function summarizeEvaluations(summary: CapabilityTelemetrySummary): {
  total: number;
  failed: number;
  averageScore?: number;
} {
  const evaluations = summary.evaluations ?? [];
  const total = evaluations.length;
  const failed = evaluations.filter((entry) => !entry.passed).length;
  const scored = evaluations.filter((entry) => typeof entry.score === 'number');
  const averageScore = scored.length
    ? scored.reduce((acc, entry) => acc + (entry.score ?? 0), 0) / scored.length
    : undefined;
  return { total, failed, averageScore };
}

/**
 * Convert a shared capability summary into span-safe attributes.
 *
 * The flattened keys make dashboards and audits easier to filter while the
 * nested summary keeps the full payload available for richer UIs.
 */
export function capabilityTelemetryToSpanAttributes(
  summary: CapabilityTelemetrySummary,
  prefix: string = 'capability',
): Record<string, unknown> {
  const evaluationSummary = summarizeEvaluations(summary);
  return {
    [`${prefix}.kind`]: summary.kind,
    [`${prefix}.key`]: summary.key,
    [`${prefix}.name`]: summary.name,
    [`${prefix}.description`]: summary.description,
    [`${prefix}.version`]: summary.version,
    [`${prefix}.source`]: summary.source,
    [`${prefix}.selectedBy`]: summary.selectedBy,
    [`${prefix}.provider`]: summary.provider,
    [`${prefix}.model`]: summary.model,
    [`${prefix}.strategy.key`]: summary.strategyKey,
    [`${prefix}.strategy.name`]: summary.strategyName,
    [`${prefix}.strategy.description`]: summary.strategyDescription,
    [`${prefix}.strategy.usedFallback`]: summary.usedFallbackStrategy,
    [`${prefix}.renderedCharacters`]: summary.renderedCharacters,
    [`${prefix}.renderedLines`]: summary.renderedLines,
    [`${prefix}.baseCharacters`]: summary.baseCharacters,
    [`${prefix}.durationMs`]: summary.durationMs,
    [`${prefix}.evaluations.total`]: evaluationSummary.total,
    [`${prefix}.evaluations.failed`]: evaluationSummary.failed,
    [`${prefix}.evaluations.averageScore`]: evaluationSummary.averageScore,
    [`${prefix}.contracts.total`]: summary.contracts?.total,
    [`${prefix}.contracts.failed`]: summary.contracts?.failed,
    [`${prefix}.contracts.errors`]: summary.contracts?.errors,
    [`${prefix}.tags`]: summary.tags ? [...summary.tags] : undefined,
    [`${prefix}.summary`]: summary,
  };
}

/**
 * Produce a standard capability event payload for traces.
 */
export function capabilityTelemetryToEvent(
  summary: CapabilityTelemetrySummary,
  stage: CapabilityTelemetryStage,
): SpanEvent {
  const evaluationSummary = summarizeEvaluations(summary);
  return {
    name: `capability.${stage}`,
    timestamp: Date.now(),
    data: {
      kind: summary.kind,
      key: summary.key,
      name: summary.name,
      version: summary.version,
      strategyKey: summary.strategyKey,
      evaluationTotal: evaluationSummary.total,
      evaluationFailed: evaluationSummary.failed,
      contractFailed: summary.contracts?.failed,
    },
  };
}

/**
 * Apply capability telemetry to an active span using the shared attribute/event
 * schema. Apps can call this for prompts today and reuse the same path for
 * skills, agents, and tools later.
 */
export function annotateSpanWithCapabilityTelemetry(
  span: Span,
  summary: CapabilityTelemetrySummary,
  stage: CapabilityTelemetryStage = 'success',
): void {
  const attributes = capabilityTelemetryToSpanAttributes(summary);
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) span.setAttribute(key, value);
  }
  const event = capabilityTelemetryToEvent(summary, stage);
  span.addEvent(event.name, event.data);
}