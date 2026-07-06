// SPDX-License-Identifier: MIT
/**
 * @weaveintel/persistence — runtime persistence: a **capability registry** + **durable KV slots**.
 *
 * IMPORTANT: this package is NOT a general "store everything" data layer, and `PersistenceAdapter` is
 * NOT a repository/ORM. weaveIntel follows ports-and-adapters: each domain package owns its OWN storage
 * port (e.g. `@weaveintel/memory`'s `DurableMemoryStore`, `@weaveintel/workflows`'s `CheckpointStore`,
 * an app's `DatabaseAdapter`) and ships real backends. This package provides two orthogonal things:
 *
 *   1. A **backend capability registry** — `PersistenceAdapter` / `createPersistenceAdapter` describe
 *      what a backend *supports* (transactions, TTL, pub/sub, JSON query) so the runtime can negotiate.
 *      These are capability descriptors, not CRUD.
 *   2. **Durable runtime KV slots** — `weaveSqlitePersistence` / `weavePostgresPersistence` give the
 *      runtime a real key/value store (with TTL) for the dead-letter queue, cost meter, and
 *      step-idempotency. Both implement the same `RuntimeKvStore` contract, verifiable with
 *      `runPersistenceContract` — so Postgres is a proven drop-in for SQLite.
 *
 * If you want to store an app's tables in Postgres, that belongs behind that app's own port (see the
 * persistence architecture review), not here.
 */
export type {
  PersistenceAdapter,
  PersistenceBackendConfig,
  PersistenceBackendKind,
  PersistenceCapabilities,
  PersistenceDomain,
  PersistenceFactoryOptions,
  PersistenceHealth,
} from './types.js';

export { parsePersistenceBackendKind } from './backend.js';
export { createPersistenceAdapter } from './factory.js';

export {
  LIVE_AGENTS_STATE_METHODS,
  type LiveAgentsStateMethodName,
} from './live-agents-inventory.js';

export { AbstractPersistenceAdapter } from './adapters/abstract-adapter.js';
export { CloudNoSqlPersistenceAdapter } from './adapters/cloud-nosql-adapter.js';
export { InMemoryPersistenceAdapter } from './adapters/in-memory-adapter.js';
export { PostgresPersistenceAdapter } from './adapters/postgres-adapter.js';
export { RedisPersistenceAdapter } from './adapters/redis-adapter.js';
export { SqlitePersistenceAdapter } from './adapters/sqlite-adapter.js';
export { MongoDbPersistenceAdapter } from './adapters/mongodb-adapter.js';
export { CosmosDbPersistenceAdapter } from './adapters/cosmosdb-adapter.js';

export {
  createPhase7RuntimePersistence,
  type Phase7RuntimePersistence,
  type Phase7RuntimePersistenceOptions,
  type PersistedEvalSuiteRun,
  type PersistedReplayCheckpoint,
  type PersistedTraceSpan,
  type TraceSpanFilter,
  type EvalSuiteRunFilter,
} from './phase7-runtime-persistence.js';

export {
  createPhase8PersistenceBenchmark,
  type Phase8PersistenceBenchmark,
  type Phase8BenchmarkOptions,
  type Phase8BenchmarkScenario,
  type Phase8LatencySummary,
  type Phase8ThroughputSummary,
  type Phase8BenchmarkReport,
} from './phase8-benchmark.js';

// Phase 4 — concrete RuntimePersistenceSlot factories. Adopters drop one
// into `weaveRuntime({ persistence })` so DLQ + cost meter + idempotency
// inherit durable behavior automatically.
export {
  weaveSqlitePersistence,
  type SqliteRuntimePersistenceOptions,
} from './runtime-slot.js';
// Postgres-backed runtime persistence slot (parity with the SQLite one) — driver-agnostic via an
// injected SqlClient (pg.Pool / Neon / a test container all satisfy it).
export {
  weavePostgresPersistence,
  type PostgresRuntimePersistenceOptions,
  type SqlClient,
} from './postgres-slot.js';
// Shared conformance harness — prove any backend behaves identically before you migrate to it.
export {
  runPersistenceContract,
  contractPassed,
  type ContractCheck,
  type PersistenceContractOptions,
} from './persistence-contract.js';
