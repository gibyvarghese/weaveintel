// SPDX-License-Identifier: MIT
/**
 * @weaveintel/human-tasks — Public API
 */

// Task factories
export {
  createHumanTask,
  createApprovalTask,
  createReviewTask,
  createEscalationTask,
  type CreateTaskInput,
  type CreateApprovalInput,
  type CreateReviewInput,
  type CreateEscalationInput,
} from './task.js';

// Queue
export {
  InMemoryTaskQueue,
  RepositoryBackedTaskQueue,
  type HumanTaskQueueOptions,
} from './queue.js';

// Repository
export {
  InMemoryHumanTaskRepository,
  JsonFileHumanTaskRepository,
  type HumanTaskRepository,
} from './repository.js';

// Phase 4 — durable runtime-backed repository.
export {
  createDurableHumanTaskRepository,
  type DurableHumanTaskRepositoryOptions,
} from './durable.js';

// Decision
export { DecisionLog, createDecision, type DecisionRecord } from './decision.js';

// Policy
export { PolicyEvaluator, createPolicy, type PolicyCheckContext, type PolicyCheckResult } from './policy.js';

// Action items (W5)
export {
  createActionItem,
  completeActionItem,
  cancelActionItem,
  type CreateActionItemInput,
  type ActionItemLifecycleOptions,
} from './action-items.js';

