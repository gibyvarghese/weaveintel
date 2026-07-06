# @weaveintel/persistence

**Durable key/value storage for the runtime's own bookkeeping — plus a way to describe what each database backend can do. It is *not* a general "store all your app data here" layer.**

## What this package is (and isn't)

It's easy to assume — from the name — that this is *the* place all of weaveIntel saves its data. It isn't, and that distinction matters.

weaveIntel follows **ports and adapters**: each feature owns its *own* storage interface and its own backends. Your notes live behind `@weaveintel/notes`' `NoteRepository`; workflow checkpoints behind `@weaveintel/workflows`' `CheckpointStore`; agent memory behind `@weaveintel/memory`; and an app's tables behind that app's own `DatabaseAdapter`. There is **no single god-object that stores everything.**

This package provides two small, specific things:

1. **Durable runtime KV slots** — a real key/value store (with expiry) that the *runtime itself* uses for its housekeeping: the dead-letter queue, the cost meter, and step-idempotency. Think of it as the runtime's scratchpad, not your application's database.
2. **A backend capability registry** — a way to ask "does this backend support transactions? TTL? pub/sub? JSON queries?" so the runtime can adapt. These are *descriptions* of a backend, not a set of CRUD methods.

> If your goal is "put my app's tables in Postgres", that belongs behind your app's own storage port — not here. See `PERSISTENCE_ARCHITECTURE_REVIEW_2026.md` at the repo root for the full map.

## The durable KV slots

The runtime needs somewhere durable to remember a few things between restarts. You hand it a *slot* and it does the rest. Two backends ship today, and they behave **identically** — so you can develop on SQLite and deploy on Postgres with no code change.

**SQLite** (great for local, desktop, single-node):

```ts
import { weaveSqlitePersistence } from '@weaveintel/persistence';
import { weaveRuntime } from '@weaveintel/core';

const runtime = weaveRuntime({ persistence: weaveSqlitePersistence({ path: './weave.db' }) });
// DLQ, cost meter, and idempotency now survive restarts.
```

**Postgres** (the recommended production default — including serverless Postgres like Neon). It's *driver-agnostic*: you pass in any Postgres client with a `query()` method — a plain `pg.Pool`, a pooled/proxied client, or a serverless driver — so this package never forces a database driver on you.

```ts
import pg from 'pg';
import { weavePostgresPersistence } from '@weaveintel/persistence';
import { weaveRuntime } from '@weaveintel/core';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const runtime = weaveRuntime({ persistence: weavePostgresPersistence({ client: pool }) });
```

Both slots are **safe by construction**: keys and values are always sent as parameters, never glued into the SQL text — so a value containing `'; DROP TABLE …; --` is stored as harmless text, never executed. Expiry (`ttlMs`) is honoured on every read.

## Proving a backend is a safe drop-in (the contract harness)

Before you switch the runtime from SQLite to Postgres, you want to *know* the new backend behaves the same. `runPersistenceContract` runs one battery of checks — the same set — against any backend and tells you what passed. It's framework-agnostic: it returns results, so you assert on them however you test.

```ts
import { runPersistenceContract, contractPassed } from '@weaveintel/persistence';

const results = await runPersistenceContract({
  makeStore: () => weavePostgresPersistence({ client: pool }).kv,
});

if (!contractPassed(results)) {
  console.error(results.filter((r) => !r.ok));
}
```

The battery covers four angles: **positive** (set/get/overwrite/delete/list/TTL all do the obvious thing), **negative** (missing keys and empty lists are graceful, never a crash), **stress** (thousands of keys and bursts of concurrent writes stay correct), and **security** (SQL metacharacters are stored as data, and one prefix's keys never leak into another's — tenant isolation). Point it at your own custom backend and it must pass too.

## Postgres + pgvector as one data layer

Because the recommended backend is Postgres, you can keep your relational data *and* your embeddings in the same database using the `pgvector` extension — no separate vector database to run. The repo's tests prove this end-to-end: real OpenAI embeddings stored in Postgres and searched by meaning with a `<=>` similarity query, in the same instance as everything else.

## The capability registry (advanced)

The other half of the package answers "what can this backend do?" rather than "store this row". `createPersistenceAdapter({ backend: { kind } })` returns a descriptor with `connect()` / `disconnect()` / `health()` and a `capabilities` flag set (`transactions`, `ttl`, `pubsub`, `jsonQuery`). The runtime uses this to negotiate behaviour. These are capability descriptors — **not** a CRUD/repository API — which is why the real storage lives in each feature's own port.

## What's in the box

| Export | What it does |
|---|---|
| `weaveSqlitePersistence` / `weavePostgresPersistence` | Durable KV slots (with TTL) for `weaveRuntime({ persistence })`. Identical behaviour; SQLite for local, Postgres for production. |
| `runPersistenceContract` / `contractPassed` | Run the conformance battery against any KV backend and prove it's a safe drop-in. |
| `SqlClient` (type) | The tiny `query()` surface the Postgres slot needs — `pg.Pool` and serverless drivers satisfy it. |
| `createPersistenceAdapter` + adapters | Backend **capability registry** (transactions/TTL/pubsub/jsonQuery) — descriptors, not CRUD. |
| `createPhase7RuntimePersistence`, `createPhase8PersistenceBenchmark` | Persisted traces/eval runs/checkpoints + latency/throughput benchmarking. |

## License

MIT.
