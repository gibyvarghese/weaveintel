/**
 * @weaveintel/guardrails — evaluators/register.ts
 *
 * Side-effect module: registers all built-in async evaluators into
 * `defaultRegistry`. Imported once by `index.ts` so any consumer of
 * `@weaveintel/guardrails` gets the built-ins automatically.
 *
 * The registry maps rule names (used in `guardrail.config.rule`) to evaluator
 * factory results. Add custom evaluators with `defaultRegistry.register(...)`.
 */
import { defaultRegistry } from '../async-evaluator.js';
import { createModerationEvaluator } from './moderation.js';
import { createLlmJudgeEvaluator } from './llm-judge.js';
import { createInjectionEvaluator } from './injection.js';
import { createSycophancyEvaluator } from './sycophancy.js';
import { createSemanticGroundingEvaluator } from './semantic-grounding.js';
import { createSystemPromptLeakageEvaluator } from './system-prompt-leakage.js';
// Phase 4 — EU AI Act, AI-content detection, IP, agent safety, compliance
import {
  createEuAiActHighRiskEvaluator,
  createEuAiActManipulationEvaluator,
  createEuAiActTransparencyEvaluator,
  createDataResidencyEvaluator,
  createGdprConsentEvaluator,
} from './eu-ai-act.js';
import {
  createAiPaperDetectionEvaluator,
  createSyntheticDataFlagEvaluator,
  createIpVerbatimReproductionEvaluator,
  createIpLicenseCheckEvaluator,
} from './ai-content-detection.js';
import {
  createMemoryPoisoningEvaluator,
  createGoalHijackingEvaluator,
  createDelegationCheckEvaluator,
} from './agent-safety.js';

// ── Baseline evaluators ───────────────────────────────────────────────────────
defaultRegistry.register('moderation', createModerationEvaluator());
defaultRegistry.register('llm-judge', createLlmJudgeEvaluator());
defaultRegistry.register('injection-classifier', createInjectionEvaluator());
defaultRegistry.register('sycophancy-judge', createSycophancyEvaluator());
defaultRegistry.register('semantic-grounding', createSemanticGroundingEvaluator());
defaultRegistry.register('system-prompt-leakage', createSystemPromptLeakageEvaluator());

// ── Phase 4: EU AI Act ────────────────────────────────────────────────────────
defaultRegistry.register('eu-ai-act-high-risk', createEuAiActHighRiskEvaluator());
defaultRegistry.register('eu-ai-act-manipulation', createEuAiActManipulationEvaluator());
defaultRegistry.register('eu-ai-act-transparency', createEuAiActTransparencyEvaluator());

// ── Phase 4: Data Residency & GDPR ───────────────────────────────────────────
defaultRegistry.register('data-residency-check', createDataResidencyEvaluator());
defaultRegistry.register('gdpr-consent-check', createGdprConsentEvaluator());

// ── Phase 4: AI-Content Detection & IP ───────────────────────────────────────
defaultRegistry.register('ai-paper-detection', createAiPaperDetectionEvaluator());
defaultRegistry.register('synthetic-data-flag', createSyntheticDataFlagEvaluator());
defaultRegistry.register('ip-verbatim-reproduction', createIpVerbatimReproductionEvaluator());
defaultRegistry.register('ip-license-check', createIpLicenseCheckEvaluator());

// ── Phase 4: Agent Safety ─────────────────────────────────────────────────────
defaultRegistry.register('agent-memory-poisoning', createMemoryPoisoningEvaluator());
defaultRegistry.register('agent-goal-hijacking', createGoalHijackingEvaluator());
defaultRegistry.register('agent-delegation-check', createDelegationCheckEvaluator());
