// SPDX-License-Identifier: MIT
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
export {
  InMemoryCheckpointStore,
  JsonFileCheckpointStore,
  createDurableCheckpointStore,
  type CheckpointStore,
  type DurableCheckpointStoreOptions,
} from './checkpoint-store.js';

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
  // Phase W7 — opt-in planner resolver (dependency-injected, not in createDefaultResolvers)
  createPlannerResolver,
  type ToolResolverDeps,
  type PromptResolverDeps,
  type AgentResolverDeps,
  type McpResolverDeps,
  type SubWorkflowResolverDeps,
  type PlannerResolverDeps,
} from './resolvers.js';

// Phase W7 — Dynamic Graph governance error
export { WorkflowExpansionError, type WorkflowExpansionErrorCode } from './expansion-error.js';

// Phase 1 — Definition store (InMemory + file-backed)
export {
  InMemoryWorkflowDefinitionStore,
  JsonFileWorkflowDefinitionStore,
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
  // Phase 4 — durable cost meter via runtime.persistence
  createDurableCostMeter,
  type DurableCostMeterOptions,
} from './cost-meter.js';

// Phase W2 — Idempotency store
export {
  InMemoryIdempotencyStore,
  JsonFileIdempotencyStore,
  type StepIdempotencyStore,
} from './idempotency-store.js';

// Phase W2 — Circuit breaker
export {
  CircuitBreaker,
  CircuitBreakerRegistry,
  type CircuitBreakerConfig,
  type CircuitBreakerState,
  type CircuitBreakerStats,
} from './circuit-breaker.js';

// Phase W2 — Bulkhead
export {
  Bulkhead,
  BulkheadRegistry,
  type BulkheadStats,
} from './bulkhead.js';

// Phase W2 — Retry delay utility (useful for tests and custom retry logic)
export { computeRetryDelay } from './engine-sleep.js';

// Phase 5 — Workflow replay primitives
export {
  WorkflowReplayRecorder,
  wrapRegistryWithRecorder,
  createReplayRegistry,
  type WorkflowReplayStep,
  type WorkflowReplayTrace,
} from './replay-recorder.js';

// Phase W3 — State and Data Layer
export { maskStepOutput, maskValue } from './secret-masker.js';
export {
  validateStepOutput,
  type OutputValidationResult,
  type OutputValidationError,
} from './output-schema-validator.js';
export {
  InMemoryPayloadStore,
  JsonFilePayloadStore,
  isPayloadRef,
  PAYLOAD_REF_PROP,
  type PayloadStore,
} from './payload-store.js';

// Phase W4 — Durability and Recovery
export {
  InMemoryStepLockStore,
  JsonFileStepLockStore,
  newStepLockId,
  type StepLockStore,
  type StepLockEntry,
} from './step-lock-store.js';
export {
  InMemorySleepStore,
  JsonFileSleepStore,
  DurableSleepScheduler,
  type SleepResumeTarget,
} from './sleep-store.js';
export {
  InMemoryAuditLog,
  JsonFileAuditLog,
  makeAuditEvent,
} from './audit-log.js';

// Phase W5 — Governance and Operations
export {
  InMemoryWorkflowRateLimiter,
  JsonFileWorkflowRateLimiter,
  type WorkflowRateLimiter,
} from './rate-limiter.js';
export {
  InMemoryRunQueue,
  JsonFileRunQueue,
  type WorkflowRunQueue,
  type RunQueueEntry,
} from './run-queue.js';
export {
  DefaultWorkflowAdminService,
  type WorkflowAdminService,
  type AdminListRunsOpts,
  type AdminRunView,
} from './admin-service.js';
export { type RunFilterOpts } from './run-repository.js';

// Phase W6 — Observability and Developer Experience
export {
  InMemorySpanEmitter,
  ConsoleSpanEmitter,
  JsonFileSpanEmitter,
  type WorkflowSpanEmitter,
} from './span-emitter.js';
export {
  lintWorkflow,
  getWorkflowGraph,
} from './linter.js';
export {
  createWorkflowTestHarness,
  type WorkflowTestHarness,
  type WorkflowTestResult,
  type MockHandlerFn,
} from './test-harness.js';

// DB-backed persistence adapters — SQLite, Postgres, MongoDB, Redis, DynamoDB.
// All five back the three canonical durable stores: CheckpointStore,
// WorkflowDefinitionStore, WorkflowRunRepository.
export {
  weaveSqliteCheckpointStore,
  type WeaveSqliteCheckpointStoreOptions,
} from './sqlite-checkpoint-store.js';
export {
  weaveSqliteWorkflowDefinitionStore,
  type WeaveSqliteDefinitionStoreOptions,
} from './sqlite-definition-store.js';
export {
  weaveSqliteWorkflowRunRepository,
  type WeaveSqliteRunRepositoryOptions,
} from './sqlite-run-repository.js';

export {
  weavePostgresCheckpointStore,
  type WeavePostgresCheckpointStoreOptions,
} from './postgres-checkpoint-store.js';
export {
  weavePostgresWorkflowDefinitionStore,
  type WeavePostgresDefinitionStoreOptions,
} from './postgres-definition-store.js';
export {
  weavePostgresWorkflowRunRepository,
  type WeavePostgresRunRepositoryOptions,
} from './postgres-run-repository.js';

export {
  weaveMongoDbCheckpointStore,
  type WeaveMongoDbCheckpointStoreOptions,
} from './mongodb-checkpoint-store.js';
export {
  weaveMongoDbWorkflowDefinitionStore,
  type WeaveMongoDbDefinitionStoreOptions,
} from './mongodb-definition-store.js';
export {
  weaveMongoDbWorkflowRunRepository,
  type WeaveMongoDbRunRepositoryOptions,
} from './mongodb-run-repository.js';

export {
  weaveRedisCheckpointStore,
  type WeaveRedisCheckpointStoreOptions,
} from './redis-checkpoint-store.js';
export {
  weaveRedisWorkflowDefinitionStore,
  type WeaveRedisDefinitionStoreOptions,
} from './redis-definition-store.js';
export {
  weaveRedisWorkflowRunRepository,
  type WeaveRedisRunRepositoryOptions,
} from './redis-run-repository.js';

export {
  weaveDynamoDbCheckpointStore,
  type WeaveDynamoDbCheckpointStoreOptions,
} from './dynamodb-checkpoint-store.js';
export {
  weaveDynamoDbWorkflowDefinitionStore,
  type WeaveDynamoDbDefinitionStoreOptions,
} from './dynamodb-definition-store.js';
export {
  weaveDynamoDbWorkflowRunRepository,
  type WeaveDynamoDbRunRepositoryOptions,
} from './dynamodb-run-repository.js';

// DB-backed persistence adapters — extended capabilities.
// Each of the 5 backends (sqlite/postgres/mongodb/redis/dynamodb) implements:
//   StepIdempotencyStore, PayloadStore, DurableSleepStore, StepLockStore,
//   WorkflowRateLimiter, WorkflowRunQueue, WorkflowAuditLog.

// SQLite
export { weaveSqliteIdempotencyStore, type WeaveSqliteIdempotencyStoreOptions } from './sqlite-idempotency-store.js';
export { weaveSqlitePayloadStore, type WeaveSqlitePayloadStoreOptions } from './sqlite-payload-store.js';
export { weaveSqliteSleepStore, type WeaveSqliteSleepStoreOptions } from './sqlite-sleep-store.js';
export { weaveSqliteStepLockStore, type WeaveSqliteStepLockStoreOptions } from './sqlite-step-lock-store.js';
export { weaveSqliteRateLimiter, type WeaveSqliteRateLimiterOptions } from './sqlite-rate-limiter.js';
export { weaveSqliteRunQueue, type WeaveSqliteRunQueueOptions } from './sqlite-run-queue.js';
export { weaveSqliteAuditLog, type WeaveSqliteAuditLogOptions } from './sqlite-audit-log.js';

// Postgres
export { weavePostgresIdempotencyStore, type WeavePostgresIdempotencyStoreOptions } from './postgres-idempotency-store.js';
export { weavePostgresPayloadStore, type WeavePostgresPayloadStoreOptions } from './postgres-payload-store.js';
export { weavePostgresSleepStore, type WeavePostgresSleepStoreOptions } from './postgres-sleep-store.js';
export { weavePostgresStepLockStore, type WeavePostgresStepLockStoreOptions } from './postgres-step-lock-store.js';
export { weavePostgresRateLimiter, type WeavePostgresRateLimiterOptions } from './postgres-rate-limiter.js';
export { weavePostgresRunQueue, type WeavePostgresRunQueueOptions } from './postgres-run-queue.js';
export { weavePostgresAuditLog, type WeavePostgresAuditLogOptions } from './postgres-audit-log.js';

// MongoDB
export { weaveMongoDbIdempotencyStore, type WeaveMongoDbIdempotencyStoreOptions } from './mongodb-idempotency-store.js';
export { weaveMongoDbPayloadStore, type WeaveMongoDbPayloadStoreOptions } from './mongodb-payload-store.js';
export { weaveMongoDbSleepStore, type WeaveMongoDbSleepStoreOptions } from './mongodb-sleep-store.js';
export { weaveMongoDbStepLockStore, type WeaveMongoDbStepLockStoreOptions } from './mongodb-step-lock-store.js';
export { weaveMongoDbRateLimiter, type WeaveMongoDbRateLimiterOptions } from './mongodb-rate-limiter.js';
export { weaveMongoDbRunQueue, type WeaveMongoDbRunQueueOptions } from './mongodb-run-queue.js';
export { weaveMongoDbAuditLog, type WeaveMongoDbAuditLogOptions } from './mongodb-audit-log.js';

// Redis
export { weaveRedisIdempotencyStore, type WeaveRedisIdempotencyStoreOptions } from './redis-idempotency-store.js';
export { weaveRedisPayloadStore, type WeaveRedisPayloadStoreOptions } from './redis-payload-store.js';
export { weaveRedisSleepStore, type WeaveRedisSleepStoreOptions } from './redis-sleep-store.js';
export { weaveRedisStepLockStore, type WeaveRedisStepLockStoreOptions } from './redis-step-lock-store.js';
export { weaveRedisRateLimiter, type WeaveRedisRateLimiterOptions } from './redis-rate-limiter.js';
export { weaveRedisRunQueue, type WeaveRedisRunQueueOptions } from './redis-run-queue.js';
export { weaveRedisAuditLog, type WeaveRedisAuditLogOptions } from './redis-audit-log.js';

// DynamoDB
export { weaveDynamoDbIdempotencyStore, type WeaveDynamoDbIdempotencyStoreOptions } from './dynamodb-idempotency-store.js';
export { weaveDynamoDbPayloadStore, type WeaveDynamoDbPayloadStoreOptions } from './dynamodb-payload-store.js';
export { weaveDynamoDbSleepStore, type WeaveDynamoDbSleepStoreOptions } from './dynamodb-sleep-store.js';
export { weaveDynamoDbStepLockStore, type WeaveDynamoDbStepLockStoreOptions } from './dynamodb-step-lock-store.js';
export { weaveDynamoDbRateLimiter, type WeaveDynamoDbRateLimiterOptions } from './dynamodb-rate-limiter.js';
export { weaveDynamoDbRunQueue, type WeaveDynamoDbRunQueueOptions } from './dynamodb-run-queue.js';
export { weaveDynamoDbAuditLog, type WeaveDynamoDbAuditLogOptions } from './dynamodb-audit-log.js';