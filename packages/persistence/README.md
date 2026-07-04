# @weaveintel/persistence

**One storage interface that weaveIntel runtimes talk to, with ready-made adapters for the databases you actually run.**

## Why it exists

Your runtime needs to save things — dead-letter queues, cost meters, idempotency keys, traces — but it shouldn't care *where*. Wiring Postgres, Redis, or SQLite directly into the runtime would weld it to one database forever. This package is the universal power adapter: the runtime speaks a single `PersistenceAdapter` contract, and you plug in whichever backend fits your deployment. Swap SQLite for Postgres by changing one line, not your application.

## When to reach for it

Reach for it when you need durable, backend-agnostic storage behind a weaveIntel runtime, or when you're writing a new backend and want it to drop into everything for free — extend `AbstractPersistenceAdapter` and it works everywhere the contract is honored. If you only need an ephemeral map for a test, `InMemoryPersistenceAdapter` (or a plain `Map`) is enough; you don't need the factory.

## How to use it

```ts
import { createPersistenceAdapter } from '@weaveintel/persistence';

const store = createPersistenceAdapter({ backend: { kind: 'sqlite' } });
await store.connect();

const health = await store.health();
console.log(health.status); // 'healthy'

await store.disconnect();
```

## What's in the box

- `createPersistenceAdapter` — pick a backend by `kind` and get the matching adapter.
- Adapters: `InMemoryPersistenceAdapter`, `SqlitePersistenceAdapter`, `PostgresPersistenceAdapter`, `RedisPersistenceAdapter`, `MongoDbPersistenceAdapter`, `CosmosDbPersistenceAdapter`, `CloudNoSqlPersistenceAdapter`.
- `AbstractPersistenceAdapter` — the base class to extend when writing your own backend.
- `weaveSqlitePersistence` — a ready-to-drop persistence slot for `weaveRuntime({ persistence })`, so DLQ, cost meter, and idempotency inherit durable behavior.
- `createPhase7RuntimePersistence`, `createPhase8PersistenceBenchmark` — persisted traces/eval runs/checkpoints, plus latency & throughput benchmarking.
- Types: `PersistenceAdapter`, `PersistenceBackendKind`, `PersistenceCapabilities`, `PersistenceHealth`, plus `parsePersistenceBackendKind`.

## License

MIT.
