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

## Run your whole runtime on one Postgres

Here's the thing an adopter actually wants once they've picked Postgres: **one database, one connection, and every part of the system running on it** — memory, workflows, live-agents, triggers, and the runtime's own bookkeeping. Each of those already ships a Postgres backend, but on their own they'd each quietly open *their own* connection pool. Opening many pools to the same database wastes connections and is the classic way to run a Postgres server out of them; the standard advice is **one pool per process, shared**.

`weaveSharedPostgres` is that one shared connection. You bring a pool (or just a connection string) and hand the *same* pool to every store:

```ts
import pg from 'pg';
import { weaveSharedPostgres } from '@weaveintel/persistence';
import { weavePostgresCheckpointStore } from '@weaveintel/workflows';
import { weavePostgresTriggerStore } from '@weaveintel/triggers';
import { weavePostgresStateStore } from '@weaveintel/live-agents';
import { weavePgVectorMemoryStore } from '@weaveintel/memory';

// ONE pool for the whole process.
const hub = weaveSharedPostgres({ client: new pg.Pool({ connectionString: process.env.DATABASE_URL }) });

// The runtime's own durable state — each in its own table on that pool:
const runtime = weaveRuntime({ persistence: { kind: 'postgres', kv: hub.slot('runtime').kv } });

// Every domain store shares the SAME pool — just pass `hub.pool`:
const checkpoints = await weavePostgresCheckpointStore({ pool: hub.pool });
const triggers    = await weavePostgresTriggerStore({ pool: hub.pool });
const agents      = await weavePostgresStateStore({ pool: hub.pool });
const memory      = weavePgVectorMemoryStore({ pool: hub.pool }); // embeddings in the same DB

await hub.health(); // { ok: true, latencyMs: 3 }
```

A few deliberate design choices worth knowing:

- **Each slot lives in its own table.** `hub.slot('dead-letter-queue')` and `hub.slot('cost-meter')` never tread on each other, and the hub refuses two names that would collide (e.g. `"cost-meter"` and `"Cost Meter"`).
- **It's safe on serverless poolers.** Managed poolers like Neon/PgBouncer hand the connection back after every transaction, which breaks tricks like `SET search_path`. The hub never relies on session state — every slot is a plainly-named table — so it works the same on a pooler as on a direct connection.
- **You own your pool's lifecycle.** If you inject a pool, `hub.close()` leaves it open (it's yours). If you pass a `connectionString` instead, the hub creates the pool and closes it for you.
- **This package doesn't import the store packages.** It stays a light, low-level primitive; you do the one-line wiring above. That keeps the dependency arrows pointing the right way.

### Proving they coexist before you cut over

"Everything on one database" is only reassuring if you can *show* the stores get along there. `runSharedPostgresCoexistence` does exactly that: you describe each store as a tiny probe (its name, the tables it creates, and a write-then-read), and it verifies every store works on the shared connection, that no two stores share a table, that one store's writes don't corrupt another's, and that a runtime KV slot passes its full contract — all on the one Postgres.

```ts
import { runSharedPostgresCoexistence, coexistenceReport } from '@weaveintel/persistence';

const results = await runSharedPostgresCoexistence({
  hub,
  probes: [
    { name: 'workflows.checkpoints', expectedTables: ['wf_checkpoints'], roundTrip: async () => { /* save + load */ } },
    { name: 'triggers',              expectedTables: ['triggers', 'trigger_invocations'], roundTrip: async () => { /* save + get */ } },
    { name: 'live-agents.state',     expectedTables: ['la_entities'], roundTrip: async () => { /* save + load */ } },
    { name: 'memory',                expectedTables: ['memory_vec'], roundTrip: async () => { /* write + query */ } },
  ],
});

console.log(coexistenceReport(results)); // { ok: true, passed: N, byTier: { … } }
```

The repo runs this for real against a throwaway Postgres container with all four stores wired up — plus a real-embeddings leg where a semantic memory search runs in the *same* database as the workflow and agent state.

## Moving to a new database without losing anything (cutover)

Deciding to run on Postgres is one thing; *moving the data you already have* is another. Your dead-letter queue, cost meter, and idempotency records are sitting in SQLite (or an old Postgres) right now, and you can't afford to drop a single one. This package includes a small toolkit that turns the switch into a checklist instead of a leap of faith. It follows the standard, boring, safe playbook the industry uses for zero-downtime migrations — **write to both, copy the rest, prove they match, then flip** — and it works over the same KV interface every backend already implements, so it doesn't care what you're moving between.

```ts
import { weaveSqlitePersistence, weavePostgresPersistence, weaveDualWriteKv, migrateKv, reconcileKv } from '@weaveintel/persistence';

const oldStore = weaveSqlitePersistence({ path: './weave.db' }).kv;      // where you are today
const newStore = weavePostgresPersistence({ client: pool }).kv;          // where you're going

// 1) EXPAND — send new writes to both databases, but keep reading the old one.
const live = weaveDualWriteKv(oldStore, newStore);
// …point your runtime's persistence at `live` for a while…

// 2) BACKFILL — copy everything that was there before you turned dual-writes on.
await migrateKv(oldStore, newStore, { onProgress: (done, total) => console.log(`${done}/${total}`) });

// 3) VERIFY — compare key by key. `ok: true` is your green light.
const report = await reconcileKv(oldStore, newStore);
if (!report.ok) console.error('not equal yet:', report.missingInTarget, report.valueMismatches);

// 4) CUT OVER — point reads at `newStore`. Keep the old one as a warm standby for a bit
//    (run `weaveDualWriteKv(newStore, oldStore)`) so you can roll back if anything looks off.
```

The three tools map one-to-one to the steps: **`weaveDualWriteKv`** keeps the new database current from the moment you start (it can also "shadow read" a fraction of requests from the new store and tell you if the two ever disagree); **`migrateKv`** copies the history (idempotent, batched, with a dry-run mode to see what *would* move); and **`reconcileKv`** is the safety gate — it lists exactly what's missing, extra, or different, so you never cut over on unequal data. Proven end-to-end on a real Postgres: a full SQLite→Postgres cutover, a 50,000-key migration, injection-safe keys/values, drift detection, and a real cost-and-idempotency ledger (built from live model calls) moved without losing a record. One caveat: the KV interface doesn't expose remaining expiry, so migrated keys are copied without a TTL — migrate durable state (DLQ, cost meter, idempotency) and re-set any short-lived TTLs on the new side afterwards.

## The capability registry (advanced)

The other half of the package answers "what can this backend do?" rather than "store this row". `createPersistenceAdapter({ backend: { kind } })` returns a descriptor with `connect()` / `disconnect()` / `health()` and a `capabilities` flag set (`transactions`, `ttl`, `pubsub`, `jsonQuery`). The runtime uses this to negotiate behaviour. These are capability descriptors — **not** a CRUD/repository API — which is why the real storage lives in each feature's own port.

## What's in the box

| Export | What it does |
|---|---|
| `weaveSqlitePersistence` / `weavePostgresPersistence` | Durable KV slots (with TTL) for `weaveRuntime({ persistence })`. Identical behaviour; SQLite for local, Postgres for production. |
| `runPersistenceContract` / `contractPassed` | Run the conformance battery against any KV backend and prove it's a safe drop-in. |
| `weaveSharedPostgres` | One shared Postgres connection for the whole runtime — hands the same pool to memory/workflows/live-agents/triggers, and mints per-table KV slots on it. |
| `runSharedPostgresCoexistence` / `coexistenceReport` | Prove all those stores + KV slots safely share one Postgres (each works, no table clashes, no cross-contamination) before you cut over. |
| `weaveDualWriteKv` / `migrateKv` / `reconcileKv` | The cutover toolkit — write to both while you migrate, backfill the history, and verify the two are identical before you switch. |
| `SqlClient` (type) | The tiny `query()` surface the Postgres slot needs — `pg.Pool` and serverless drivers satisfy it. |
| `createPersistenceAdapter` + adapters | Backend **capability registry** (transactions/TTL/pubsub/jsonQuery) — descriptors, not CRUD. |
| `createPhase7RuntimePersistence`, `createPhase8PersistenceBenchmark` | Persisted traces/eval runs/checkpoints + latency/throughput benchmarking. |

## License

MIT.
