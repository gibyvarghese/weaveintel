/**
 * @weaveintel/routing — Public API
 */

// Smart router
export { SmartModelRouter } from './router.js';
export type { SmartModelRouterOptions } from './router.js';

// Health
export { ModelHealthTracker } from './health.js';

// Scorer
export { ModelScorer } from './scorer.js';
export type { ModelCostInfo, ModelQualityInfo } from './scorer.js';

// Policy
export { filterByConstraints, roundRobinSelect, fallbackCandidate } from './policy.js';
export type { ModelCandidate } from './policy.js';

// Decision
export { InMemoryDecisionStore } from './decision.js';
export type { DecisionStore } from './decision.js';
