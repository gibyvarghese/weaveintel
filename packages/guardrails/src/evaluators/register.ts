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

defaultRegistry.register('moderation', createModerationEvaluator());
defaultRegistry.register('llm-judge', createLlmJudgeEvaluator());
defaultRegistry.register('injection-classifier', createInjectionEvaluator());
defaultRegistry.register('sycophancy-judge', createSycophancyEvaluator());
defaultRegistry.register('semantic-grounding', createSemanticGroundingEvaluator());
