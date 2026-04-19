/**
 * @weaveintel/prompts — prompt telemetry helpers
 *
 * Why: prompt execution already knows about versioning, strategies,
 * evaluations, and rendered content shape. This module maps that runtime state
 * into the shared observability schema so apps can emit prompt telemetry
 * without rebuilding prompt-specific summaries themselves.
 */

import type {
  CapabilityContractTelemetry,
  CapabilityTelemetrySummary,
} from '@weaveintel/core';
import type {
  PromptRecordExecutionResult,
  PromptRecordRenderResult,
} from './runtime.js';

function countLines(value: string): number {
  if (!value) return 0;
  return value.split('\n').length;
}

export interface PromptTelemetryOptions {
  source?: CapabilityTelemetrySummary['source'];
  selectedBy?: string;
  provider?: string;
  model?: string;
  tags?: string[];
  contracts?: CapabilityContractTelemetry;
  metadata?: Record<string, unknown>;
}

/**
 * Build a shared capability summary from a rendered/executed prompt result.
 */
export function createPromptCapabilityTelemetry(
  result: PromptRecordRenderResult | PromptRecordExecutionResult,
  options: PromptTelemetryOptions = {},
): CapabilityTelemetrySummary {
  const capabilityKey = result.definition.key ?? result.definition.id;
  const strategy = 'strategy' in result ? result.strategy : undefined;
  return {
    kind: 'prompt',
    key: capabilityKey,
    name: result.definition.name,
    description: result.definition.description ?? 'Prompt execution telemetry emitted from shared runtime hooks.',
    version: result.version.version,
    source: options.source,
    selectedBy: options.selectedBy,
    provider: options.provider,
    model: options.model,
    strategyKey: strategy?.resolvedKey,
    strategyName: strategy?.name,
    strategyDescription: strategy?.description,
    usedFallbackStrategy: strategy?.usedFallback,
    renderedCharacters: result.content.length,
    renderedLines: countLines(result.content),
    baseCharacters: 'baseContent' in result ? result.baseContent.length : undefined,
    durationMs: result.durationMs,
    evaluations: result.evaluations.map((entry) => ({
      id: entry.id,
      description: entry.description,
      passed: entry.passed,
      score: entry.score,
      reason: entry.reason,
    })),
    contracts: options.contracts,
    tags: options.tags,
    metadata: options.metadata,
  };
}