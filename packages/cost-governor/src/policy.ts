/**
 * Phase 2 — Cost Tier Config Surface
 *
 * Defines the operator-facing `CostPolicy` shape and the four built-in tier
 * presets. These are pure data; no runtime side-effects.
 *
 * Phase 2 ships these knobs as *configuration only* — the lever resolvers
 * returned by `weaveCostGovernor()` are no-op stubs that pass through
 * unchanged. Each subsequent phase (3 through 7) wires one lever group
 * for real, but reads its config from the same shape.
 */

/** Reference to a model — kept loose so cost-governor stays provider-agnostic. */
export interface ModelRef {
  readonly modelId: string;
  readonly provider?: string;
}

/** When to escalate from cheap → expensive in a model cascade (lever L1). */
export interface EscalationRule {
  readonly kind: 'tool_call_failed_count' | 'json_parse_failed_count' | 'step_kind' | 'intel_score_below';
  readonly threshold?: number;
  readonly stepKinds?: ReadonlyArray<string>;
}

export type CostTier = 'economy' | 'balanced' | 'performance' | 'max' | 'custom';

export interface ModelCascadeConfig {
  readonly cheap?: ModelRef;
  readonly expensive?: ModelRef;
  readonly escalateOn?: ReadonlyArray<EscalationRule>;
}

export interface PromptCachingConfig {
  readonly enabled: boolean;
  readonly keyStrategy?: 'role' | 'role+phase' | 'static';
}

/** Map from logical phase → list of tool keys allowed in that phase. */
export type PhaseToolMap = Record<string, ReadonlyArray<string>>;

export interface ToolSubsetConfig {
  readonly strategy: 'phase' | 'intent-rag' | 'all';
  readonly phases?: PhaseToolMap;
  /** When `strategy: 'intent-rag'`, top-K tools per step. Default 6. */
  readonly topK?: number;
  /**
   * Phase 8 — minimum cosine similarity for a tool to be considered.
   * Tools below this score are excluded from the top-K result. Default 0.15.
   * Only meaningful when `strategy: 'intent-rag'`.
   */
  readonly minSimilarity?: number;
  /**
   * Phase 8 — tool keys that are always included in the kept set when
   * present in the available registry, even when their similarity score
   * is below `minSimilarity`. Useful for `submit` / `final_answer` style
   * tools the agent must always be able to reach.
   * Only meaningful when `strategy: 'intent-rag'`.
   */
  readonly includeAlways?: ReadonlyArray<string>;
}

export interface IntelThresholds {
  /** Below this score → keep full intel header & snippets. */
  readonly low?: number;
  /** Above this score → drop intel header & snippets, use cheap model. */
  readonly high?: number;
}

export interface IntelGatingConfig {
  readonly enabled: boolean;
  readonly thresholds?: IntelThresholds;
}

export interface HistoryCompactionConfig {
  readonly strategy: 'sliding' | 'summary' | 'hierarchical' | 'none';
  /** Window size in tool turns when strategy = sliding. */
  readonly windowTurns?: number;
}

export interface ToolOutputTruncationConfig {
  readonly maxBytesPerTurn?: number;
  readonly keepLastN?: number;
}

/**
 * The single operator-facing config — composed of tier + per-lever overrides.
 * `tier` supplies defaults; any field set explicitly wins.
 */
export interface CostPolicy {
  readonly tier: CostTier;
  readonly modelCascade?: ModelCascadeConfig;
  readonly promptCaching?: PromptCachingConfig;
  readonly toolSubset?: ToolSubsetConfig;
  readonly intelGating?: IntelGatingConfig;
  readonly historyCompaction?: HistoryCompactionConfig;
  readonly maxStepsCap?: number;
  readonly reasoningEffort?: 'low' | 'medium' | 'high';
  readonly toolOutputTruncation?: ToolOutputTruncationConfig;
  readonly budgetCeilingUsd?: number;
}

/**
 * A `CostPolicy` after preset + override merge — every lever is resolved.
 * Returned by `resolveCostPolicy()` and stored on `CostGovernorBundle.policy`.
 */
export interface ResolvedCostPolicy {
  readonly tier: CostTier;
  readonly modelCascade: ModelCascadeConfig;
  readonly promptCaching: PromptCachingConfig;
  readonly toolSubset: ToolSubsetConfig;
  readonly intelGating: IntelGatingConfig;
  readonly historyCompaction: HistoryCompactionConfig;
  readonly maxStepsCap: number;
  readonly reasoningEffort: 'low' | 'medium' | 'high';
  readonly toolOutputTruncation: ToolOutputTruncationConfig;
  readonly budgetCeilingUsd: number;
}

/**
 * Built-in tier presets. Source of truth for the default lever values per
 * tier. Apps and operators can fork by setting `tier: 'custom'` and supplying
 * every lever explicitly — the merge logic in `resolveCostPolicy` will not
 * pull preset values when tier === 'custom'.
 */
export const TIER_PRESETS: Record<Exclude<CostTier, 'custom'>, ResolvedCostPolicy> = {
  economy: {
    tier: 'economy',
    modelCascade: { escalateOn: [] },
    promptCaching: { enabled: true, keyStrategy: 'role' },
    toolSubset: { strategy: 'phase' },
    intelGating: { enabled: true, thresholds: { low: 0.3, high: 0.6 } },
    historyCompaction: { strategy: 'sliding', windowTurns: 8 },
    maxStepsCap: 20,
    reasoningEffort: 'low',
    toolOutputTruncation: { maxBytesPerTurn: 2 * 1024, keepLastN: 2 },
    budgetCeilingUsd: 1.5,
  },
  balanced: {
    tier: 'balanced',
    modelCascade: {
      escalateOn: [
        { kind: 'tool_call_failed_count', threshold: 2 },
        { kind: 'json_parse_failed_count', threshold: 2 },
        { kind: 'step_kind', stepKinds: ['final_answer', 'submit'] },
      ],
    },
    promptCaching: { enabled: true, keyStrategy: 'role+phase' },
    toolSubset: { strategy: 'phase' },
    intelGating: { enabled: true, thresholds: { low: 0.4, high: 0.7 } },
    historyCompaction: { strategy: 'sliding', windowTurns: 12 },
    maxStepsCap: 40,
    reasoningEffort: 'medium',
    toolOutputTruncation: { maxBytesPerTurn: 4 * 1024, keepLastN: 3 },
    budgetCeilingUsd: 5,
  },
  performance: {
    tier: 'performance',
    modelCascade: { escalateOn: [] },
    promptCaching: { enabled: true, keyStrategy: 'role+phase' },
    toolSubset: { strategy: 'phase' },
    intelGating: { enabled: true, thresholds: { low: 0.5, high: 0.8 } },
    historyCompaction: { strategy: 'sliding', windowTurns: 20 },
    maxStepsCap: 60,
    reasoningEffort: 'medium',
    toolOutputTruncation: { maxBytesPerTurn: 8 * 1024, keepLastN: 5 },
    budgetCeilingUsd: 15,
  },
  max: {
    tier: 'max',
    modelCascade: { escalateOn: [] },
    promptCaching: { enabled: true, keyStrategy: 'role' },
    toolSubset: { strategy: 'all' },
    intelGating: { enabled: false },
    historyCompaction: { strategy: 'none' },
    maxStepsCap: 80,
    reasoningEffort: 'high',
    toolOutputTruncation: {},
    budgetCeilingUsd: 50,
  },
} as const;

/**
 * Merge `policy` against its tier preset. Per-field overrides win; missing
 * fields fall back to the preset. `tier: 'custom'` produces a pass-through
 * with no preset values — the caller MUST supply every field they want set.
 */
export function resolveCostPolicy(policy: CostPolicy): ResolvedCostPolicy {
  if (policy.tier === 'custom') {
    return {
      tier: 'custom',
      modelCascade: policy.modelCascade ?? {},
      promptCaching: policy.promptCaching ?? { enabled: false },
      toolSubset: policy.toolSubset ?? { strategy: 'all' },
      intelGating: policy.intelGating ?? { enabled: false },
      historyCompaction: policy.historyCompaction ?? { strategy: 'none' },
      maxStepsCap: policy.maxStepsCap ?? 80,
      reasoningEffort: policy.reasoningEffort ?? 'medium',
      toolOutputTruncation: policy.toolOutputTruncation ?? {},
      budgetCeilingUsd: policy.budgetCeilingUsd ?? 50,
    };
  }
  const preset = TIER_PRESETS[policy.tier];
  return {
    tier: policy.tier,
    modelCascade: { ...preset.modelCascade, ...(policy.modelCascade ?? {}) },
    promptCaching: { ...preset.promptCaching, ...(policy.promptCaching ?? {}) },
    toolSubset: { ...preset.toolSubset, ...(policy.toolSubset ?? {}) },
    intelGating: { ...preset.intelGating, ...(policy.intelGating ?? {}) },
    historyCompaction: { ...preset.historyCompaction, ...(policy.historyCompaction ?? {}) },
    maxStepsCap: policy.maxStepsCap ?? preset.maxStepsCap,
    reasoningEffort: policy.reasoningEffort ?? preset.reasoningEffort,
    toolOutputTruncation: { ...preset.toolOutputTruncation, ...(policy.toolOutputTruncation ?? {}) },
    budgetCeilingUsd: policy.budgetCeilingUsd ?? preset.budgetCeilingUsd,
  };
}

/** Default tier when no policy is supplied anywhere. */
export const DEFAULT_COST_TIER: CostTier = 'balanced';
