/**
 * @weaveintel/guardrails — Public API
 */

// Pipeline
export {
  DefaultGuardrailPipeline,
  createGuardrailPipeline,
  hasDeny,
  hasWarning,
  getDenyReason,
  type PipelineOptions,
} from './pipeline.js';

// Built-in guardrails
export { evaluateGuardrail } from './guardrail.js';

// Risk classification
export {
  DefaultRiskClassifier,
  createRiskClassifier,
  type RiskRule,
} from './risk-classifier.js';

// Confidence & action gates
export {
  DefaultConfidenceGate,
  DefaultActionGate,
  createConfidenceGate,
  createActionGate,
} from './confidence-gate.js';

// Governance
export {
  DefaultGovernanceContext,
  createGovernanceContext,
  evaluateRuntimePolicies,
} from './governance.js';

// Cost guard
export {
  CostGuard,
  createCostGuard,
  costGuardFromPolicies,
  type CostGuardConfig,
  type CostTracker,
} from './cost-guard.js';
