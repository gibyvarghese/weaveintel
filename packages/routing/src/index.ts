// SPDX-License-Identifier: MIT
/**
 * @weaveintel/routing — Public API
 */

// Smart router
export { SmartModelRouter } from './router.js';
export type { SmartModelRouterOptions, TaskAwareDecisionMeta } from './router.js';

// Health
export { ModelHealthTracker } from './health.js';

// Scorer
export { ModelScorer } from './scorer.js';
export type { ModelCostInfo, ModelQualityInfo, ModelCapabilityInfo } from './scorer.js';

// Policy
export {
  filterByConstraints,
  roundRobinSelect,
  fallbackCandidate,
  fallbackChainCandidates,
  filterByCapability,
  filterByModality,
  filterByCostCeiling,
} from './policy.js';
export type { ModelCandidate } from './policy.js';

// Decision
export { InMemoryDecisionStore } from './decision.js';
export type { DecisionStore } from './decision.js';

// Inference
export { inferTaskType } from './inference.js';
export type { InferTaskTypeInput, InferTaskTypeResult, TaskInferenceHintsMap } from './inference.js';

// Model capability flags
export { getModelCapabilityFlags } from './model-capability-flags.js';
export type { ModelCapabilityFlags } from './model-capability-flags.js';

// Runtime routing adapter (Phase 2 — Shared Routing Slot)
export { createRuntimeRoutingAdapter } from './runtime-routing-adapter.js';

// Seed utilities
export {
  DEFAULT_ROUTING_POLICIES, type RoutingPolicySeedRow,
  DEFAULT_MODEL_PRICING,    type ModelPricingSeedRow,
  DEFAULT_TASK_TYPES,       type TaskTypeSeedRow,
  DEFAULT_PROVIDER_ADAPTERS, type ProviderAdapterSeedRow,
} from './seed.js';
