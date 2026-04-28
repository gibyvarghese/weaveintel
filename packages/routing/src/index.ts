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
