/**
 * @weaveintel/workflows — Public API
 */

// Engine
export { DefaultWorkflowEngine, createWorkflowEngine, type WorkflowEngineOptions } from './engine.js';

// Builder
export { WorkflowBuilder, defineWorkflow } from './definition.js';

// State utilities
export { createInitialState, advanceState, resolveNextStep, isTerminal } from './state.js';

// Step execution
export { executeStep, getStepExecutor, type StepExecutor, type StepHandler, type StepHandlerMap } from './steps.js';

// Scheduler
export { InMemoryScheduler, type TriggerCallback } from './scheduler.js';

// Compensation
export {
  DefaultCompensationRegistry,
  runCompensations,
  type CompensationHandler,
  type CompensationRegistry,
} from './compensation.js';

// Checkpoint store
export { InMemoryCheckpointStore, type CheckpointStore } from './checkpoint-store.js';

// Run repository
export {
  InMemoryWorkflowRunRepository,
  JsonFileWorkflowRunRepository,
  type WorkflowRunRepository,
} from './run-repository.js';

// Phase 1 — Handler resolver registry + built-in resolvers
export {
  HandlerResolverRegistry,
  createHandlerResolverRegistry,
  type HandlerResolver,
  type HandlerResolveContext,
} from './handler-resolver.js';
export {
  createNoopResolver,
  createScriptResolver,
  createToolResolver,
  createPromptResolver,
  createAgentResolver,
  createMcpResolver,
  createSubWorkflowResolver,
  createDefaultResolvers,
  type ToolResolverDeps,
  type PromptResolverDeps,
  type AgentResolverDeps,
  type McpResolverDeps,
  type SubWorkflowResolverDeps,
} from './resolvers.js';

// Phase 1 — Definition store
export {
  InMemoryWorkflowDefinitionStore,
  type WorkflowDefinitionStore,
} from './definition-store.js';

// Phase 1 — Handler kind registry helpers
export {
  describeHandlerKinds,
  describeResolver,
  type HandlerKindDescriptor,
} from './handler-kind-registry.js';

// Phase 1 — Path + expression utilities (exposed for app composers/tests)
export { readPath, writePath, applyInputMap, applyOutputMap } from './path.js';

// Phase 4 — Mesh ↔ workflow binding (output contract emission)
export {
  type ContractEmitter,
  type EmittedContract,
  type EmittedContractMeta,
  buildContractBody,
  buildEmittedContract,
} from './contract-emitter.js';
export { evaluateExpression, evaluateBoolean, hasExpression, type Expression } from './expressions.js';

// Phase 5 — Input schema validation
export {
  validateWorkflowInput,
  WorkflowInputValidationError,
  type ValidationError,
  type ValidationResult,
} from './input-validator.js';

// Phase 5 — Cost meter
export {
  InMemoryCostMeter,
  type CostMeter,
  type CostDelta,
} from './cost-meter.js';

// Phase 5 — Workflow replay primitives
export {
  WorkflowReplayRecorder,
  wrapRegistryWithRecorder,
  createReplayRegistry,
  type WorkflowReplayStep,
  type WorkflowReplayTrace,
} from './replay-recorder.js';