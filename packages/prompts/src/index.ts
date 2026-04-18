/**
 * @weaveintel/prompts — Public API
 */

// Template engine (Phase 1 + Phase 2: fragment expansion, lint integration)
export {
  createTemplate,
  extractVariables,
  isTextRenderablePromptVersion,
  renderPromptVersion,
  renderStructuredPromptMessages,
  renderWithOptions,
  type RenderWithOptions,
  type RenderResult,
} from './template.js';

// Registry
export { InMemoryPromptRegistry } from './registry.js';

// Resolver
export { PromptResolver } from './resolver.js';
export type { PromptVersionStore } from './resolver.js';

// Experiments
export { InMemoryExperimentStore, weightedSelect } from './experiment.js';
export type { PromptExperimentStore } from './experiment.js';

// Instructions
export {
  InstructionBundleBuilder,
  composeInstructions,
  createInstructionBundle,
} from './instructions.js';

// Database record helpers
export {
  parsePromptVariables,
  stringifyPromptVariables,
  createPromptDefinitionFromRecord,
  createPromptVersionFromRecord,
  type PromptRecordLike,
} from './records.js';

// Runtime helpers
export {
  renderPromptRecord,
  executePromptRecord,
  InMemoryPromptStrategyRegistry,
  strategyFromRecord,
  defaultPromptStrategyRegistry,
  type PromptRenderEvaluation,
  type PromptRenderEvaluationResult,
  type PromptRenderLifecycleHooks,
  type PromptExecutionStrategy,
  type PromptStrategyRegistry,
  type PromptStrategyRecordLike,
  type PromptRecordRenderOptions,
  type PromptRecordRenderResult,
  type PromptRecordExecutionOptions,
  type PromptRecordExecutionResult,
} from './runtime.js';

// ─── Phase 2: Frameworks ─────────────────────────────────────
// Named, ordered prompt section structures for explicit prompt composition.
export {
  InMemoryFrameworkRegistry,
  frameworkFromRecord,
  renderFramework,
  defaultFrameworkRegistry,
  FRAMEWORK_RTCE,
  FRAMEWORK_FULL,
  FRAMEWORK_CRITIQUE,
  FRAMEWORK_JUDGE,
  type PromptFramework,
  type PromptFrameworkSectionDef,
  type FrameworkRenderResult,
  type FrameworkRegistry,
  type PromptFrameworkRecordLike,
} from './frameworks.js';

// ─── Phase 2: Fragments ───────────────────────────────────────
// Reusable text blocks included via {{>key}} syntax.
export {
  InMemoryFragmentRegistry,
  fragmentFromRecord,
  resolveFragments,
  extractFragmentKeys,
  defaultFragmentRegistry,
  type FragmentDefinition,
  type FragmentVariable,
  type FragmentRegistry,
  type FragmentRecordLike,
  type ResolveFragmentsOptions,
} from './fragments.js';

// ─── Phase 2: Lint ────────────────────────────────────────────
// Static analysis producing typed diagnostics before render time.
export {
  lintPromptTemplate,
  hasLintErrors,
  topLintSeverity,
  formatLintResults,
  type PromptLintResult,
  type PromptLintSeverity,
  type PromptLintRuleId,
  type LintVariable,
  type LintContext,
} from './lint.js';

// ─── Phase 2: Provider adapters ───────────────────────────────
// Convert rendered prompts into provider-native message formats.
export {
  openAIAdapter,
  anthropicAdapter,
  textAdapter,
  systemAsUserAdapter,
  resolveAdapter,
  type ProviderRenderAdapter,
  type AnthropicAdaptResult,
  type KnownProvider,
} from './providers.js';

// ─── Phase 3: Output Contracts ──────────────────────────────
// Enforce quality and format constraints on prompt outputs before and after execution.
// Contracts validate JSON structure, markdown sections, code generation, length limits,
// forbidden content, and support composite validation with repair hooks.
export {
  validateContract,
  InMemoryContractRegistry,
  contractFromRecord,
  type PromptContract,
  type ContractValidationResult,
  type ContractValidationError,
  type ContractSeverity,
  type ContractRepairHook,
  type JsonContract,
  type MarkdownContract,
  type CodeContract,
  type MaxLengthContract,
  type ForbiddenContentContract,
  type StructuredContract,
  type ContractRegistry,
} from './contracts.js';
