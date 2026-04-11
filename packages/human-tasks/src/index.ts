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
export { InMemoryTaskQueue } from './queue.js';

// Decision
export { DecisionLog, createDecision, type DecisionRecord } from './decision.js';

// Policy
export { PolicyEvaluator, createPolicy, type PolicyCheckContext, type PolicyCheckResult } from './policy.js';
