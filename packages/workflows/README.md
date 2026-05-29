# `@weaveintel/workflows`

DB-driven workflow engine: composable steps resolved through a `HandlerResolverRegistry`, persisted via a `WorkflowDefinitionStore`, and optionally observable via a `ContractEmitter` that publishes immutable work products to downstream consumers.

## Surface

- `DefaultWorkflowEngine` — engine with `startRun`, `tickRun`, persistence-via-store, and optional `contractEmitter`.
- `HandlerResolverRegistry` — kind → resolver lookup. Built-ins: `noop`, `script`, `tool`.
- `WorkflowDefinitionStore` — pluggable persistence (`save`, `get`, `list`, `delete`). `InMemoryWorkflowDefinitionStore` ships in-package.
- `ContractEmitter` — interface used by the engine to publish a workflow's `outputContract` after a successful run.

## `outputContract` (Phase 4 — Mesh ↔ workflow binding)

Workflow definitions can declare a single `outputContract` that the engine emits via `ContractEmitter` once the run reaches a successful terminal state. This is how a workflow signals "I produced a verified work product" so other workflows or live agents can react.

```ts
import { defineWorkflow } from '@weaveintel/core';

const def = defineWorkflow({
  id: 'order-fulfillment',
  name: 'Order Fulfillment',
  steps: [/* ... */],
  outputContract: {
    kind: 'order.fulfilled',          // contract type — used by triggers/agents to filter
    bodyMap: {                         // project final state.variables into the contract body
      orderId: 'orderId',
      amount: 'amount',
    },
    evidence: { fromHistory: true },  // optional: attach run step history as evidence
    meshId: 'sales',                   // optional: tag with mesh
    metadata: { source: 'fulfillment-svc' },
  },
});
```

## `ContractEmitter` interface

```ts
interface ContractEmitter {
  emit(contract: {
    kind: string;
    body: unknown;
    evidence?: WorkflowStepResult[];
    meshId?: string;
    metadata?: Record<string, unknown>;
    sourceWorkflowDefinitionId: string;
    sourceWorkflowRunId: string;
  }): Promise<void>;
}
```

Contract emission is **best-effort**: if `emit()` throws, the engine logs a `workflow:contract_emit_failed` event and the workflow run still completes successfully. Never let contract publication block run completion.

## Reference impl in geneweave

GeneWeave provides `DbContractEmitter` (writes to `mesh_contracts`) plus a Node `EventEmitter` bus, then `MeshContractSourceAdapter` from `@weaveintel/triggers` consumes the bus to fire downstream workflows or agents. See `apps/geneweave/src/contracts/db-contract-emitter.ts` and `examples/100-mesh-workflow-binding.ts`.

## Phase 5 — Governance, Durability, Replay

Phase 5 of the DB-Driven Capability Plan adds four primitives, all in-process and DB-pluggable:

### 1. Input schema validation
- `validateWorkflowInput(input, schema)` — ajv-free JSON-schema-lite validator. Supports `type`, `required`, `properties`, `minLength`/`maxLength`, `minimum`/`maximum`, `enum`. Returns `{ valid, errors: [{ path, message }] }`.
- `WorkflowInputValidationError` — thrown by `engine.startRun()` when the workflow definition declares `inputSchema` and the input fails. Failure is surfaced before any step runs.

### 2. Cost ceiling
- `CostMeter` interface + `InMemoryCostMeter`. Steps record cost via `meter.record(runId, { costUsd, source })`.
- `WorkflowPolicy.costCeiling: number` (USD). When cumulative cost exceeds the ceiling the engine sets the run to `failed`, sets `run.error = "Cost ceiling exceeded: $X > $Y"`, and emits `workflow:cost_exceeded` on the bus.
- `WorkflowRun.costTotal?: number` is persisted alongside the run (geneweave column `workflow_runs.cost_total`).

### 3. Replay
- `WorkflowReplayRecorder` records `(runId, step) => void` step entries with monotonic ordinals. `recorder.trace(runId, workflowId)` returns the deterministic `WorkflowReplayTrace`.
- `wrapRegistryWithRecorder(registry, recorder, runIdGetter)` is the canonical helper to wrap any `HandlerResolverRegistry` so step outputs are captured automatically. Manual wrapping is also supported (see `examples/101-workflow-governance.ts`).
- `createReplayRegistry(trace)` returns a registry where each step replays its captured output by ordinal — no resolver is invoked, no LLM calls happen, no clock is consulted. Determinism is **ordinal-strict**.
- Replay roundtrip in `examples/101` shows a script step that picks a random price, captured once, then replayed twice with byte-identical output.

### 4. Checkpoint store + run repository
- `CheckpointStore` interface + `InMemoryCheckpointStore` — store `WorkflowCheckpoint` (state snapshots) keyed by `runId`. `latest(runId)` returns the most recent.
- `WorkflowRunRepository` interface + `InMemoryWorkflowRunRepository` + `JsonFileWorkflowRunRepository` — persist `WorkflowRun` rows and look up by id / workflowId.
- GeneWeave provides `DbWorkflowRunRepository` and `DbCheckpointStore` over SQLite tables `workflow_runs` and `workflow_checkpoints`. SQLite `created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP` has 1s precision — `latest()` always orders `created_at DESC, rowid DESC`.

### Capability policy bindings (paired with Phase 5)
- `CapabilityPolicyBinding` (in `@weaveintel/core`) — `{ id, bindingKind: 'agent'|'mesh'|'workflow', bindingRef, policyKind: 'tool_policy'|'rate_limit'|'approval', policyRef, precedence, enabled }`.
- `resolveCapabilityBinding(bindings, kind, ref, policyKind)` — precedence is **agent (100) > mesh (50) > workflow (10)**. Highest matching wins.
- GeneWeave admin: `/api/admin/capability-policy-bindings` (full CRUD; auth + CSRF gated). Sidebar entry under Orchestration.

See `examples/101-workflow-governance.ts` for the end-to-end demo (no DB, no LLM).

## Phase W7 — Dynamic Graphs

Phase W7 adds **runtime graph expansion**: a `dynamic` step can return a `DynamicExpansion` from its handler. The engine validates the sub-graph, splices it into the live run, and routes into the expansion's entry step. Control rejoins the original graph once the sub-graph terminates.

### Core primitives

**`WorkflowStepType: 'dynamic'`** — a new step type whose handler is expected to return a `DynamicExpansion`. The engine's splice logic runs immediately after the step handler completes, before normal `resolveNextStep` routing.

**`DynamicExpansion`** (from `@weaveintel/core`):
```typescript
interface DynamicExpansion {
  steps: WorkflowStep[];  // generated sub-graph steps
  entry: string;          // first step to execute in the sub-graph
  rejoin?: string;        // step id to route to when the sub-graph finishes
}
```
Steps with no explicit `next` and no following expansion step are automatically rewritten to point to `rejoin`. When `rejoin` is omitted, `step.next` of the dynamic step is used.

**`WorkflowRun.definitionSnapshot`** — a deep-frozen copy of the workflow definition taken at `startRun` time. All routing within the run uses the snapshot so live definition edits cannot alter in-flight runs.

**`WorkflowRun.dynamicSteps?: WorkflowStep[]`** — all generated steps accumulated across all expansions. Persisted alongside the run so a process restart can resume correctly.

**`WorkflowRun.expansionDepth?: number`** — the number of successive expansions on this run.

### Governance (`validateExpansion`)

Every expansion is validated before splicing. Violations throw `WorkflowExpansionError` and fail the run:

| Code | Trigger |
|---|---|
| `MAX_EXPANSION_DEPTH` | `expansionDepth >= policy.maxExpansionDepth` (default 5) |
| `MAX_GENERATED_STEPS` | cumulative generated steps exceed `policy.maxGeneratedSteps` |
| `INVALID_ENTRY` | expansion entry step not found in expansion.steps |
| `ID_COLLISION` | generated step id collides with an existing step or sibling |
| `DISALLOWED_HANDLER_KIND` | resolver-kind prefix (e.g. `script:`, `subworkflow:`) not in `policy.dynamicHandlerKinds` (default: `['noop','tool','prompt','agent','mcp']`) |
| `LINT_ERROR` | merged graph produces an error-severity lint finding |

Plain handler keys with no colon (pre-registered functions) are not subject to the kind allowlist — only resolver-kind-prefixed refs like `script:…` are blocked.

### `createPlannerResolver(deps)` (opt-in)

```typescript
import { createPlannerResolver } from '@weaveintel/workflows';

registry.register(createPlannerResolver({
  plan: async (goal, context) => {
    // context.variables — current run variables
    // context.config — step config
    // context.capabilities — allowed handler kinds (describeHandlerKinds)
    const expansion: DynamicExpansion = await callYourLLM(goal, context);
    return expansion;
  },
}));
```

Reference syntax: `plan:<goal>` (e.g. `handler: 'plan:organize the data pipeline'`). **Not** added to `createDefaultResolvers()` — must be explicitly registered. The expansion is always passed through `validateExpansion` before execution.

### Restart-safety

Dynamic steps are checkpointed before the sub-graph entry is set as `currentStepId`. On resume, `effectiveDef(run, snapshot)` merges `run.dynamicSteps` into the routing view so previously-spliced steps are visible. A paused `wait` step inside a generated sub-graph resumes correctly because `resumeRun` uses the effective def for step lookup.

### Policy fields (in `WorkflowPolicy`)

```typescript
interface WorkflowPolicy {
  maxExpansionDepth?: number;       // default 5
  maxGeneratedSteps?: number;       // default unlimited
  dynamicHandlerKinds?: string[];   // default ['noop','tool','prompt','agent','mcp']
}
```

### Builder shortcut

```typescript
defineWorkflow('My Flow')
  .dynamic('plan-step', 'AI Planner', {
    handler: 'plan:research the topic',
    next: 'summarise',
    retries: 1,
  })
  .addStep({ id: 'summarise', ... })
```

### Example

See `examples/2x-dynamic-workflows.ts` for a complete demo covering:
- Definition snapshot isolation
- Data-driven expansion (step count at runtime)
- Stub planner resolver
- Governance rejections
- Restart-safety across process restarts
