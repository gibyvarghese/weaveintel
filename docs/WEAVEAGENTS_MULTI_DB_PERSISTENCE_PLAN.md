# WeaveAgents Multi-Database Persistence Plan

## Goal
Provide **pluggable persistence backends** across weaveIntel agent runtimes (not only live-agents), while retaining the existing in-memory mode for tests/local development.

This plan delivers:
- A shared persistence contract for all weave agents.
- Durable, production-grade implementations.
- Configurable backend selection per environment.
- Phase-by-phase rollout with explicit acceptance criteria.

## Scope
In scope:
- `@weaveintel/live-agents`
- Other weave agent runtimes that persist execution state, memory, messages, contracts, tool/audit records, replay traces, and evaluation metadata.
- Shared persistence abstractions and adapters.

Out of scope (for initial rollout):
- Full event-sourcing rewrite of every runtime.
- Automated migration of historical custom external databases.

## Design Principles
1. Preserve current in-memory mode.
2. Use a **shared, package-level persistence contract** for all weave agents.
3. Define one **authoritative source of truth** mode for production.
4. Keep coordination/cache concerns separate from durable state.
5. Enforce tenant scoping and idempotent writes everywhere.
6. Keep backend adapters swappable by configuration.

## Target Backend Options
1. In-Memory (existing): development/tests only.
2. PostgreSQL: primary durable backend.
3. Redis: coordination/cache backend; optional durable mode behind explicit flag.
4. SQLite: single-node local durable mode.
5. MongoDB: document-centric durable backend.
6. DynamoDB / Cosmos DB style adapter: cloud managed KV/document mode.

## Architecture

### 1) Shared Persistence Contract Layer
Create a shared package contract (proposed location: `packages/persistence` or `packages/agents-persistence`) that defines:
- Core entities (agent runtime state, memory, messages, ticks, contracts, account/binding/grants, workflows, observability pointers).
- Transaction semantics.
- Idempotency key contract.
- Optimistic concurrency contract (`version` or `updatedAt` precondition).
- Tenant isolation contract.

### 2) Backend Adapter Interface
Each backend adapter implements the same contract:
- `save*`, `load*`, `list*`, `claim*`, `resolve*` families.
- `transaction()` where supported; otherwise fallback strategy with documented guarantees.
- Consistent error categories (`conflict`, `not-found`, `transient`, `fatal`).

### 3) Runtime Wiring
Every runtime package receives persistence through DI:
- Runtime constructor accepts a `PersistenceAdapter`.
- Default remains in-memory when no adapter is provided.
- Environment-based factory selects adapter in app/server layers.

### 4) Hybrid Mode
For scale:
- Postgres/Mongo/Cloud-NoSQL as source of truth.
- Redis used for fast lease claiming, distributed locks, and hot caches.
- Read-through cache invalidation strategy required.

## Data Domains to Persist for All Agent Runtimes
1. Agent identity/state
2. Mesh/workspace/team state
3. Contracts/versioned policy state
4. Messages/threaded communication
5. Heartbeat/ticks/scheduling state
6. Tool execution metadata + outcomes
7. Account bindings + capability grants + approvals
8. Working memory/compressed memory artifacts
9. Replay checkpoints and trace references
10. Evaluation run metadata and outcomes

## Backend-Specific Guidance

### PostgreSQL
Best for durable system of record.
- Use normalized tables with JSONB where shape evolves.
- Enforce unique idempotency constraints.
- Use row-level tenant filters and indexed foreign keys.

### Redis
Best for coordination and fast ephemeral access.
- Use Redis streams/sorted sets for scheduling queues.
- Use Lua or atomic commands for claim/lease semantics.
- If durable mode enabled, document weaker guarantees vs SQL transactions.

### SQLite
Best for local/single-node deployments.
- WAL mode enabled.
- File locking caveats documented for multi-process.

### MongoDB
Best for document-first runtimes.
- Compound indexes on tenant + entity keys.
- Versioned documents for concurrency checks.

### DynamoDB/Cosmos-style
Best for managed cloud scale.
- Clear partition key model per tenant + entity type.
- Conditional writes for idempotency/concurrency.

## Phased Implementation Plan

## Phase 0: Contract and Inventory
Deliverables:
- Shared persistence contract package scaffold.
- Full entity/method mapping from each runtime package.
- Gap matrix for current in-memory/live/postgres/redis behavior.

Acceptance criteria:
- All runtime state methods mapped to contract.
- No unmapped mutating path remains undocumented.

## Phase 1: Postgres Canonical Adapter
Deliverables:
- Complete Postgres adapter covering all contract methods.
- Migration set for all required entities.
- Transaction + idempotency support.

Acceptance criteria:
- Restart durability verified end-to-end.
- Integration tests pass for full CRUD/claim/resolve flows.

## Phase 2: Redis Adapter (Coordination + Optional Durable)
Deliverables:
- Full Redis adapter implementation.
- Distinct modes:
  - `coordination-only`
  - `durable-explicit` (opt-in)
- Lease/claim correctness tests with concurrent workers.

Acceptance criteria:
- No double-claim under concurrency tests.
- Documented consistency guarantees by mode.

## Phase 3: SQLite Adapter
Deliverables:
- SQLite adapter for local durable operation.
- Schema parity with contract.

Acceptance criteria:
- Local restart retains full runtime state.
- Single-node integration tests pass.

## Phase 4: MongoDB Adapter
Deliverables:
- Mongo adapter with document mappings and indexes.
- Concurrency and idempotency semantics implemented.

Acceptance criteria:
- Contract test suite green against Mongo adapter.

## Phase 5: Cloud NoSQL Adapter (DynamoDB/Cosmos style)
Deliverables:
- Provider-agnostic cloud NoSQL adapter interface.
- First concrete adapter implementation.

Acceptance criteria:
- Contract test suite green.
- Throughput and retry behavior documented.

## Phase 6: Cross-Runtime Adoption (All Weave Agents)
Deliverables:
- Runtime constructor/factory updates across all weave agent runtimes.
- Config-driven adapter selection.
- Backward compatibility with in-memory default.

Acceptance criteria:
- Each runtime can run with in-memory, Postgres, Redis, SQLite at minimum.
- Runtime smoke tests for every backend option.

Status: implemented for non-live agent memory adoption.

Phase 6 implementation notes:
- `@weaveintel/memory` now exports `createConfiguredMemoryStore()` and `createConfiguredConversationMemory()` for `in-memory`, `postgres`, `redis`, `sqlite`, `mongodb`, and `cloud-nosql` backends.
- Durable memory stores were added for Postgres, Redis, SQLite, MongoDB, and DynamoDB-style cloud NoSQL while preserving the existing in-memory default.
- `@weaveintel/agents` already supported injected `memory?: AgentMemory`, so cross-runtime adoption was completed by wiring durable conversation memory through the shared memory package rather than app-local changes.
- New validation coverage lives in `packages/memory/src/memory.test.ts`.
- New end-to-end example for non-live agents lives in `examples/61-agent-persistence-methods-e2e.ts`.

Phase 6 validation completed:
- PASS: `npm run typecheck --workspace @weaveintel/memory`
- PASS: `npm run build --workspace @weaveintel/memory`
- PASS: `npm run test --workspace @weaveintel/memory`
- PASS: `npm run build --workspace @weaveintel/agents`
- PASS: `node --import tsx examples/61-agent-persistence-methods-e2e.ts` using in-memory and sqlite locally, with service-backed scenarios gated behind env vars for Postgres, Redis, MongoDB, and DynamoDB Local.

## Phase 7: Observability, Replay, and Eval Hardening
Deliverables:
- Backend-agnostic persistence telemetry.
- Durable replay checkpoints.
- Eval metadata persistence parity.

Acceptance criteria:
- Replay and evaluation flows survive restarts across backends.

Status: implemented with shared runtime persistence APIs in `@weaveintel/persistence`.

Phase 7 implementation notes:
- Added `createPhase7RuntimePersistence()` in `packages/persistence/src/phase7-runtime-persistence.ts`.
- Added backend-agnostic persistence methods for:
  - trace span records (`saveTraceSpan`, `listTraceSpans`)
  - replay checkpoints (`saveReplayCheckpoint`, `loadLatestReplayCheckpoint`)
  - eval suite run metadata (`saveEvalSuiteRun`, `listEvalSuiteRuns`)
- The Phase 7 store is wired to the same backend options introduced in Phase 6 by reusing configured memory-store backends (`in-memory`, `postgres`, `redis`, `sqlite`, `mongodb`, `cloud-nosql`).
- Added package-level tests in `packages/persistence/src/phase7-runtime-persistence.test.ts`, including sqlite restart durability coverage.
- Added end-to-end integration example in `examples/62-phase7-observability-replay-eval-persistence-e2e.ts` that uses `@weaveintel/observability`, `@weaveintel/replay`, and `@weaveintel/evals` with persisted artefacts.

## Phase 8: Performance and Reliability
Deliverables:
- Load tests, failover tests, chaos testing matrix.
- Cache/connection pool tuning guides per backend.

Acceptance criteria:
- Defined SLOs met for write/read/claim latencies.

## Phase 9: Documentation and Release
Deliverables:
- Operator guides per backend.
- Migration playbooks.
- Example apps for each backend mode.

Acceptance criteria:
- End-to-end deployment docs validated from clean environment.

## Configuration Model
Proposed env variables:
- `WEAVE_PERSISTENCE_BACKEND=inmemory|postgres|redis|sqlite|mongo|cloud-nosql`
- `WEAVE_PERSISTENCE_MODE=durable|coordination`
- `WEAVE_POSTGRES_URL=...`
- `WEAVE_REDIS_URL=...`
- `WEAVE_SQLITE_PATH=...`
- `WEAVE_MONGO_URL=...`
- `WEAVE_NOSQL_ENDPOINT=...`

## Test Strategy
1. Shared contract test suite run against each adapter.
2. Runtime integration tests for each backend.
3. Concurrency tests for claim/lease semantics.
4. Restart-recovery tests.
5. Data migration forward/backward compatibility tests.

## Risks and Mitigations
1. Drift across runtime packages.
- Mitigation: single shared contract test harness.

2. Inconsistent transaction guarantees across backends.
- Mitigation: capability matrix + explicit fallback semantics.

3. Performance regressions from generic abstraction.
- Mitigation: adapter-specific optimized paths with benchmark gates.

## Immediate Execution Sequence
1. Finalize contract package + method mapping (Phase 0).
2. Complete Postgres adapter first (Phase 1).
3. Implement Redis coordination-correct adapter (Phase 2).
4. Roll into all runtimes (Phase 6) before adding additional backend adapters.

## Definition of Done (Program Level)
- All weave agent runtimes support configurable persistence backends.
- In-memory remains available and unchanged for tests/local.
- Postgres and Redis production guidance is complete.
- Contract suite passes against all implemented adapters.
- Restart and recovery behavior validated per backend.
