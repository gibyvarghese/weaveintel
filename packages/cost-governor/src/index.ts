/**
 * @weaveintel/cost-governor — Phase 1 surface.
 *
 * Public API:
 *   - Types:           CostLever, CostLedgerEntry, CostBreakdown,
 *                      CostLedger, CostLedgerSink, PricingResolver, PricingRate
 *   - Pure helpers:    computeUsd(usage, rate), aggregate(runId, entries)
 *   - Factories:       createInMemoryCostLedger(), weaveCostLedger({ sink })
 *   - Wrappers:        wrapModelWithCostLedger(), wrapAuditEmitterWithCostLedger()
 *
 * Phase 1 is observational. Subsequent phases will introduce ceilings
 * (Phase 2: budget envelopes), routing pressure, and lever-specific
 * optimisation — all on top of the entries this layer captures.
 */

export * from './types.js';
export { createInMemoryCostLedger, aggregate } from './in-memory-ledger.js';
export { weaveCostLedger } from './weave-cost-ledger.js';
export type { WeaveCostLedgerOptions } from './weave-cost-ledger.js';
export { wrapModelWithCostLedger } from './model-wrapper.js';
export type { WrapModelOptions, ModelCostContext } from './model-wrapper.js';
export { wrapAuditEmitterWithCostLedger } from './audit-wrapper.js';
export type { WrapAuditOptions, ToolCostContext } from './audit-wrapper.js';

// Phase 2 — Cost Tier Config Surface
export {
  TIER_PRESETS,
  DEFAULT_COST_TIER,
  resolveCostPolicy,
} from './policy.js';
export type {
  CostTier,
  CostPolicy,
  ResolvedCostPolicy,
  ModelRef,
  ModelCascadeConfig,
  EscalationRule,
  PromptCachingConfig,
  ToolSubsetConfig,
  PhaseToolMap,
  IntelGatingConfig,
  IntelThresholds,
  HistoryCompactionConfig,
  ToolOutputTruncationConfig,
} from './policy.js';

export {
  weaveCostGovernor,
  noopModelResolver,
  noopToolFilter,
  noopPromptShaper,
  noopHistoryCompactor,
  noopBudgetGate,
  CostCeilingExceededError,
} from './governor.js';
export type {
  CostGovernorBundle,
  CostLeverContext,
  CostModelDecision,
  CostModelResolver,
  CostToolFilter,
  CostPromptShaper,
  PromptShape,
  CostHistoryCompactor,
  HistoryItem,
  CostBudgetGate,
} from './governor.js';

export {
  weaveStaticCostPolicyResolver,
  composeCostPolicyResolvers,
  resolveCostGovernorBundle,
} from './policy-resolver.js';
export type {
  CostPolicyResolver,
  CostPolicyResolutionContext,
  ResolvedCostPolicyBinding,
} from './policy-resolver.js';

// Phase 3 — Prompt Caching (lever L2)
export {
  noopCacheShaper,
  weavePromptCachingShaper,
  wrapModelWithCacheHints,
} from './cache-shaper.js';
export type {
  CacheShaper,
  CacheShapeContext,
  PromptCacheHints,
  WrapModelWithCacheHintsOptions,
} from './cache-shaper.js';

// Phase 4 — Model Cascade (lever L1)
export {
  RunCostStateTracker,
  decideCascadeModel,
  evaluateEscalationRule,
  weaveModelCascadeResolver,
  wrapAuditEmitterWithCascadeTracker,
} from './model-cascade.js';
export type {
  CascadeChoice,
  CascadeDecision,
  CascadeResolverContext,
  ModelResolverLike,
  RunCostState,
  WeaveModelCascadeResolverOptions,
  WrapAuditEmitterWithCascadeTrackerOptions,
} from './model-cascade.js';

// Phase 5 — Dynamic Tool Subset (lever L3)
export {
  decideToolSubset,
  weaveToolSubsetFilter,
  applyToolFilterToRegistry,
} from './tool-subset.js';
export type { ToolSubsetDecision } from './tool-subset.js';

// Phase 6 — Intel Gating (lever L4) + History Compaction (lever L5)
export {
  decideIntelGating,
  weaveIntelGate,
  shouldKeepSection,
  INTEL_HEADER_SECTION,
  INTEL_SNIPPETS_SECTION,
} from './intel-gating.js';
export type {
  IntelScore,
  IntelScoreContext,
  IntelScoreProvider,
  IntelGatingDecision,
} from './intel-gating.js';

export {
  decideCompaction,
  weaveHistoryCompactor,
} from './history-compactor.js';
export type {
  CompactedHistory,
  HistorySummarizer,
} from './history-compactor.js';

export type { CostGovernorOptions } from './governor.js';

// Phase 7 — Max Steps Cap (lever L6)
export { decideMaxSteps, decideMaxStepsDetailed } from './max-steps.js';
export type { MaxStepsDecision } from './max-steps.js';

// Phase 7 — Reasoning Effort (lever L7)
export {
  wrapModelWithReasoningEffort,
  wrapModelWithStaticReasoningEffort,
} from './reasoning-effort.js';
export type {
  ReasoningEffort,
  WrapModelWithReasoningEffortOptions,
} from './reasoning-effort.js';

// Phase 7 — Tool Output Truncation (lever L8)
export {
  TRUNCATION_MARKER,
  truncateText,
  wrapToolRegistryWithOutputTruncation,
  applyOutputTruncationToHistory,
  weaveToolOutputTruncator,
} from './output-truncation.js';
export type {
  TruncationResult,
  HistoryMessageLike,
  ToolOutputTruncator,
} from './output-truncation.js';

// Phase 7 — Budget Gate (lever L9)
export { weaveBudgetGate, weaveCostLedgerFromBreakdown } from './budget-gate.js';
export type {
  WeaveBudgetGateOptions,
  WeaveCostLedgerFromBreakdownOptions,
} from './budget-gate.js';

// Phase 8 — Intent-RAG Tool Retrieval (lever L3 strategy upgrade)
export {
  cosineSimilarity,
  hashDescription,
  decideIntentRagSubset,
  weaveIntentRagToolSubsetFilter,
} from './intent-rag.js';
export type {
  Embedder,
  ToolEmbedding,
  EmbeddingStore,
  GoalResolver,
  IntentRagConfig,
  DecideIntentRagInput,
  WeaveIntentRagToolSubsetFilterOptions,
} from './intent-rag.js';

// Seed utilities
export { DEFAULT_COST_POLICIES, type CostPolicySeedRow } from './seed.js';

// Phase 4 — durable variants backed by `runtime.persistence.kv`.
export {
  createDurableCostLedger,
  createDurableRunCostStateTracker,
  type DurableLedgerOptions,
  type DurableRunCostState,
  type DurableRunCostStateTracker,
} from './durable-ledger.js';
