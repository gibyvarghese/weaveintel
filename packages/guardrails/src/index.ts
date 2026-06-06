/**
 * @weaveintel/guardrails — Public API
 */

// ── Side-effect: register built-in async evaluators into defaultRegistry ──
import './evaluators/register.js';

// Pipeline
export {
  DefaultGuardrailPipeline,
  createGuardrailPipeline,
  hasDeny,
  hasWarning,
  getDenyReason,
  type PipelineOptions,
} from './pipeline.js';

// Built-in sync guardrail evaluators + cognitive check summariser
export {
  evaluateGuardrail,
  summarizeGuardrailResults,
  type GuardrailCategorySummary,
} from './guardrail.js';

// W1 — Async evaluation foundation
export {
  AsyncEvaluatorRegistry,
  defaultRegistry,
  evaluateGuardrailAsync,
  type AsyncGuardrailEvaluatorFn,
} from './async-evaluator.js';

// W2 — Model-graded evaluator factories (for custom registration)
export { createModerationEvaluator } from './evaluators/moderation.js';
export { createLlmJudgeEvaluator } from './evaluators/llm-judge.js';
export { createInjectionEvaluator } from './evaluators/injection.js';
export { createSycophancyEvaluator } from './evaluators/sycophancy.js';

// W3 — Semantic grounding evaluator factory
export { createSemanticGroundingEvaluator } from './evaluators/semantic-grounding.js';

// W4 — Escalation policy
export {
  evaluateEscalation,
  type EscalationContext,
  type EscalationTaskHandler,
} from './escalation.js';

// W5 — Streaming output screening
export {
  createStreamingGuardrail,
  type StreamingGuardrailOptions,
  type StreamGuardrailHandle,
  type StreamCheckResult,
} from './streaming.js';

// W6 — Per-tenant resolver
export {
  InMemoryGuardrailResolver,
  createGuardrailResolver,
} from './resolver.js';

// W7 — Revision store
export {
  InMemoryRevisionStore,
  createRevisionStore,
  trackGuardrailChange,
  type TrackGuardrailChangeOptions,
} from './revision-store.js';

// W8 — Eval corpus (for external harnesses)
export { CORPUS, type CorpusCase } from './eval/corpus.js';

// W10 — Input normaliser
export {
  normalizeInput,
  type NormalizeOptions,
  type NormalizeResult,
} from './normalizer.js';

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

// Seed utilities
export { DEFAULT_GUARDRAILS, type GuardrailSeedRow } from './seed.js';
