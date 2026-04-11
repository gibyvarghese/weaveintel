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
