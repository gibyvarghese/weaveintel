import type { EventBus, HumanTaskQueue, WorkflowPolicy } from '@weaveintel/core';
import type { CheckpointStore } from './checkpoint-store.js';
import type { WorkflowRunRepository } from './run-repository.js';
import type { HandlerResolverRegistry } from './handler-resolver.js';
import type { WorkflowDefinitionStore } from './definition-store.js';
import type { ContractEmitter } from './contract-emitter.js';
import type { CostMeter } from './cost-meter.js';

export interface WorkflowEngineOptions {
  checkpointStore?: CheckpointStore;
  bus?: EventBus;
  defaultPolicy?: WorkflowPolicy;
  /** Optional human task queue for human-task step integration. */
  humanTaskQueue?: HumanTaskQueue;
  /** Optional durable repository for workflow run state. */
  runRepository?: WorkflowRunRepository;
  /**
   * Phase 1 — Optional resolver registry. When set, any `step.handler`
   * containing a `:` (or matching a registered bare-kind resolver such as
   * `'noop'`) is resolved at run-start by the matching `HandlerResolver`.
   * Pre-registered handlers via `engine.registerHandler(...)` always win.
   */
  resolverRegistry?: HandlerResolverRegistry;
  /**
   * Phase 1 — Dependency bag forwarded to every resolver invocation.
   * Apps populate this with registries the resolvers need (tool registry,
   * prompt store, agent registry, MCP client, etc.).
   */
  resolverDeps?: Record<string, unknown>;
  /**
   * Phase 1 — Optional durable definition store. When set, `startRun` falls
   * back to the store if the requested workflowId is not in the in-memory
   * definition map, and `getDefinition` / `listDefinitions` consult both.
   */
  definitionStore?: WorkflowDefinitionStore;
  /**
   * Phase 4 — Optional contract emitter. When set and a workflow definition
   * declares an `outputContract`, the engine builds and emits the contract
   * after the run reaches `completed`. Emitter failures are swallowed (logged
   * via `bus`) so workflow runs never fail because of emission errors.
   */
  contractEmitter?: ContractEmitter;
  /**
   * Phase 5 — Optional cost meter. When set, the engine queries the meter
   * after each step. If the workflow's `WorkflowPolicy.costCeiling` is set
   * and the cumulative cost exceeds it, the run is failed with
   * `Cost ceiling exceeded` and a `workflow:cost_exceeded` event is emitted.
   * Callers (LLM adapters, tool wrappers) report deltas via `costMeter.record(runId, ...)`.
   */
  costMeter?: CostMeter;
}
