/**
 * @weaveintel/prompts — Runtime rendering helpers with observability/eval hooks
 *
 * Apps can use this for database-backed prompt rendering while keeping
 * telemetry/evaluation integration consistent across runtimes.
 */

import type { PromptDefinition, PromptVersion } from '@weaveintel/core';
import {
  createPromptDefinitionFromRecord,
  createPromptVersionFromRecord,
  type PromptRecordLike,
} from './records.js';
import { renderPromptVersion } from './template.js';
import { createPromptCapabilityTelemetry } from './telemetry.js';
import type { CapabilityTelemetrySummary } from '@weaveintel/core';

export interface PromptRenderEvaluation {
  id: string;
  description: string;
  evaluate(args: {
    content: string;
    definition: PromptDefinition;
    version: PromptVersion;
    variables: Record<string, unknown>;
    durationMs: number;
  }): { passed: boolean; score?: number; reason?: string };
}

export interface PromptRenderEvaluationResult {
  id: string;
  description: string;
  passed: boolean;
  score?: number;
  reason?: string;
}

export interface PromptRenderLifecycleHooks {
  onStart?(args: {
    definition: PromptDefinition;
    version: PromptVersion;
    variables: Record<string, unknown>;
    startedAt: number;
  }): void;
  onSuccess?(args: {
    definition: PromptDefinition;
    version: PromptVersion;
    content: string;
    variables: Record<string, unknown>;
    durationMs: number;
    evaluations: PromptRenderEvaluationResult[];
  }): void;
  onError?(args: {
    definition: PromptDefinition;
    version: PromptVersion;
    variables: Record<string, unknown>;
    durationMs: number;
    error: Error;
  }): void;
  onTelemetry?(args: {
    telemetry: CapabilityTelemetrySummary;
    stage: 'success' | 'error';
    error?: Error;
  }): void;
}

export interface PromptRecordRenderOptions {
  hooks?: PromptRenderLifecycleHooks;
  evaluations?: PromptRenderEvaluation[];
}

export interface PromptRecordRenderResult {
  content: string;
  definition: PromptDefinition;
  version: PromptVersion;
  durationMs: number;
  evaluations: PromptRenderEvaluationResult[];
}

/**
 * A model-facing execution strategy that can transform rendered prompt content
 * before it is sent to an LLM. Strategies are data-driven and can be loaded
 * from DB records (GeneWeave) or in-memory registrations.
 */
export interface PromptExecutionStrategy {
  key: string;
  name: string;
  description: string;
  apply(args: {
    content: string;
    definition: PromptDefinition;
    version: PromptVersion;
    variables: Record<string, unknown>;
  }): {
    content: string;
    metadata?: Record<string, unknown>;
  };
}

export interface PromptStrategyRegistry {
  register(strategy: PromptExecutionStrategy): void;
  get(key: string): PromptExecutionStrategy | undefined;
  list(): PromptExecutionStrategy[];
}

/**
 * Lightweight strategy registry used by app runtimes to inject built-in and
 * DB-defined strategies into a single execution pipeline.
 */
export class InMemoryPromptStrategyRegistry implements PromptStrategyRegistry {
  private readonly byKey = new Map<string, PromptExecutionStrategy>();

  constructor(initial: PromptExecutionStrategy[] = []) {
    for (const strategy of initial) this.register(strategy);
  }

  register(strategy: PromptExecutionStrategy): void {
    this.byKey.set(strategy.key, strategy);
  }

  get(key: string): PromptExecutionStrategy | undefined {
    return this.byKey.get(key);
  }

  list(): PromptExecutionStrategy[] {
    return [...this.byKey.values()];
  }
}

/**
 * DB row shape for prompt strategies. Kept app-agnostic so any runtime can
 * provide compatible rows from its own persistence layer.
 */
export interface PromptStrategyRecordLike {
  id: string;
  key: string;
  name: string;
  description?: string | null;
  instruction_prefix?: string | null;
  instruction_suffix?: string | null;
  config?: string | null;
  enabled?: number;
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Convert a DB-backed strategy row into a runtime strategy.
 *
 * Config conventions:
 * - delimiter: string used between prefix/content/suffix (defaults to "\n\n")
 * - wrapTag: optional string to wrap result as <wrapTag>...</wrapTag>
 */
export function strategyFromRecord(record: PromptStrategyRecordLike): PromptExecutionStrategy {
  const cfg = parseJsonObject(record.config) ?? {};
  const delimiter = typeof cfg['delimiter'] === 'string' ? cfg['delimiter'] : '\n\n';
  const wrapTag = typeof cfg['wrapTag'] === 'string' ? cfg['wrapTag'] : undefined;

  return {
    key: record.key,
    name: record.name,
    description: record.description ?? 'Database-backed prompt execution strategy.',
    apply: ({ content }) => {
      const pieces: string[] = [];
      if (record.instruction_prefix?.trim()) pieces.push(record.instruction_prefix.trim());
      pieces.push(content.trim());
      if (record.instruction_suffix?.trim()) pieces.push(record.instruction_suffix.trim());

      let rendered = pieces.join(delimiter).trim();
      if (wrapTag) rendered = `<${wrapTag}>\n${rendered}\n</${wrapTag}>`;

      return {
        content: rendered,
        metadata: {
          source: 'db',
          strategyId: record.id,
          wrapTag,
        },
      };
    },
  };
}

const SINGLE_PASS_STRATEGY: PromptExecutionStrategy = {
  key: 'singlePass',
  name: 'Single Pass',
  description: 'Render prompt once and send directly to the model without additional orchestration instructions.',
  apply: ({ content }) => ({ content }),
};

const DELIBERATE_STRATEGY: PromptExecutionStrategy = {
  key: 'deliberate',
  name: 'Deliberate',
  description: 'Append a lightweight internal quality checklist encouraging verification before final answer generation.',
  apply: ({ content }) => ({
    content: `${content}\n\nBefore finalizing: verify assumptions, check constraints, and ensure the response format is followed exactly.`,
    metadata: { source: 'builtin' },
  }),
};

const CRITIQUE_REVISE_STRATEGY: PromptExecutionStrategy = {
  key: 'critiqueRevise',
  name: 'Critique then Revise',
  description: 'Ask the model to draft mentally, critique against constraints, then return a revised final answer only.',
  apply: ({ content }) => ({
    content: `${content}\n\nProcess requirement: internally draft, critique against requirements, revise once, then return only the final revised answer.`,
    metadata: { source: 'builtin' },
  }),
};

/**
 * Default strategy registry. Apps can clone and extend this registry with
 * DB-defined strategies for tenant- or environment-specific execution behavior.
 */
export const defaultPromptStrategyRegistry = new InMemoryPromptStrategyRegistry([
  SINGLE_PASS_STRATEGY,
  DELIBERATE_STRATEGY,
  CRITIQUE_REVISE_STRATEGY,
]);

export interface PromptRecordExecutionOptions extends PromptRecordRenderOptions {
  strategyRegistry?: PromptStrategyRegistry;
  strategyKey?: string;
  fallbackStrategyKey?: string;
}

export interface PromptRecordExecutionResult extends PromptRecordRenderResult {
  baseContent: string;
  strategy: {
    requestedKey: string;
    resolvedKey: string;
    usedFallback: boolean;
    name: string;
    description: string;
    metadata?: Record<string, unknown>;
  };
}

/**
 * Render a prompt persisted in an app-specific DB row using shared prompt
 * contracts, while exposing hook points for app-level telemetry and evals.
 */
export function renderPromptRecord(
  record: PromptRecordLike,
  variables: Record<string, unknown>,
  options: PromptRecordRenderOptions = {},
): PromptRecordRenderResult {
  const definition = createPromptDefinitionFromRecord(record);
  const version = createPromptVersionFromRecord(record);
  const capabilityKey = definition.key ?? definition.id;
  const startedAt = Date.now();

  options.hooks?.onStart?.({ definition, version, variables, startedAt });

  try {
    const content = renderPromptVersion(version, variables);
    const durationMs = Date.now() - startedAt;
    const evaluations = (options.evaluations ?? []).map<PromptRenderEvaluationResult>((item) => {
      const result = item.evaluate({ content, definition, version, variables, durationMs });
      return {
        id: item.id,
        description: item.description,
        passed: result.passed,
        score: result.score,
        reason: result.reason,
      };
    });

    options.hooks?.onSuccess?.({ definition, version, content, variables, durationMs, evaluations });
    options.hooks?.onTelemetry?.({
      telemetry: createPromptCapabilityTelemetry({ content, definition, version, durationMs, evaluations }),
      stage: 'success',
    });

    return { content, definition, version, durationMs, evaluations };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const err = error instanceof Error ? error : new Error(String(error));
    options.hooks?.onError?.({ definition, version, variables, durationMs, error: err });
    options.hooks?.onTelemetry?.({
      telemetry: {
        kind: 'prompt',
        key: capabilityKey,
        name: definition.name,
        description: definition.description ?? 'Prompt render telemetry emitted from shared runtime hooks.',
        version: version.version,
        durationMs,
        metadata: { errorName: err.name, errorMessage: err.message },
      },
      stage: 'error',
      error: err,
    });
    throw err;
  }
}

/**
 * Phase 4 runtime entry point:
 * 1) Render prompt record using shared prompt contracts.
 * 2) Resolve strategy from explicit option or executionDefaults.strategy.
 * 3) Apply strategy transformation to produce final model-facing prompt text.
 * 4) Emit standard evaluations and lifecycle hooks for observability.
 */
export function executePromptRecord(
  record: PromptRecordLike,
  variables: Record<string, unknown>,
  options: PromptRecordExecutionOptions = {},
): PromptRecordExecutionResult {
  const definition = createPromptDefinitionFromRecord(record);
  const version = createPromptVersionFromRecord(record);
  const capabilityKey = definition.key ?? definition.id;
  const startedAt = Date.now();

  options.hooks?.onStart?.({ definition, version, variables, startedAt });

  try {
    const baseContent = renderPromptVersion(version, variables);
    const requestedKey = options.strategyKey ?? version.executionDefaults?.strategy ?? 'singlePass';
    const fallbackKey = options.fallbackStrategyKey ?? 'singlePass';
    const strategyRegistry = options.strategyRegistry ?? defaultPromptStrategyRegistry;
    const requestedStrategy = strategyRegistry.get(requestedKey);
    const strategy = requestedStrategy ?? strategyRegistry.get(fallbackKey) ?? SINGLE_PASS_STRATEGY;
    const strategyResult = strategy.apply({ content: baseContent, definition, version, variables });
    const content = strategyResult.content;
    const durationMs = Date.now() - startedAt;
    const evaluations = (options.evaluations ?? []).map<PromptRenderEvaluationResult>((item) => {
      const result = item.evaluate({ content, definition, version, variables, durationMs });
      return {
        id: item.id,
        description: item.description,
        passed: result.passed,
        score: result.score,
        reason: result.reason,
      };
    });

    options.hooks?.onSuccess?.({ definition, version, content, variables, durationMs, evaluations });
    options.hooks?.onTelemetry?.({
      telemetry: createPromptCapabilityTelemetry({
        content,
        baseContent,
        definition,
        version,
        durationMs,
        evaluations,
        strategy: {
          requestedKey,
          resolvedKey: strategy.key,
          usedFallback: !requestedStrategy,
          name: strategy.name,
          description: strategy.description,
          metadata: strategyResult.metadata,
        },
      }),
      stage: 'success',
    });

    return {
      content,
      baseContent,
      definition,
      version,
      durationMs,
      evaluations,
      strategy: {
        requestedKey,
        resolvedKey: strategy.key,
        usedFallback: !requestedStrategy,
        name: strategy.name,
        description: strategy.description,
        metadata: strategyResult.metadata,
      },
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const err = error instanceof Error ? error : new Error(String(error));
    options.hooks?.onError?.({ definition, version, variables, durationMs, error: err });
    options.hooks?.onTelemetry?.({
      telemetry: {
        kind: 'prompt',
        key: capabilityKey,
        name: definition.name,
        description: definition.description ?? 'Prompt execution telemetry emitted from shared runtime hooks.',
        version: version.version,
        strategyKey: options.strategyKey ?? version.executionDefaults?.strategy ?? 'singlePass',
        durationMs,
        metadata: { errorName: err.name, errorMessage: err.message },
      },
      stage: 'error',
      error: err,
    });
    throw err;
  }
}
