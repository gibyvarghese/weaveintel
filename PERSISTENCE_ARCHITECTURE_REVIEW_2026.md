# weaveIntel Persistence — Architecture Review & Future-Looking Plan (mid-2026)

**Question:** Does `packages/persistence` handle DB persistence for all features, or is it per-package? And what is the mid-2026 / future-looking way to do this (e.g. Postgres everywhere)?

**TL;DR verdict:** The *architecture* is already correct and modern — ports-and-adapters with dependency injection, which is exactly what the 2026 literature recommends. The gap is **not** the shape of the code; it's **(a)** the data-access *mechanism* (hand-written, per-dialect SQL duplicated across every backend × every store, with no single schema source or type-safety) and **(b)** one package (`persistence`) that *looks* like the central data layer but is actually a capability-registry stub. The future-looking move is: **pick Postgres + pgvector as the one primary backend, keep the ports, and replace the hand-written SQL with a schema-first typed query builder (Drizzle)** — reserving SQLite strictly for edge/offline via the same ports.

---

## 1. What the mid-2026 SOTA says

- **Ports-and-adapters (Hexagonal) + Repository is the recommended pattern.** Business logic depends on a port (interface); a composition root injects the concrete adapter at startup. The two patterns are complementary, not competing. ([NN-style hexagonal guide](https://generalistprogrammer.com/tutorials/hexagonal-architecture-complete-guide), [Repository pattern in Node](https://alberthernandez.dev/blog/understanding-the-repository-pattern-in-node-js))
- **Typed query builder / schema-first ORM is the default data-access mechanism.** For new Postgres TS apps, **Drizzle on `postgres.js`** is "the most common right answer" (schema-in-TS, generated migrations, type-safe queries); **Kysely** is query-builder-only (good when schema is owned elsewhere). ([Drizzle vs Kysely 2026](https://www.pkgpulse.com/guides/drizzle-vs-kysely-2026), [best TS ORMs 2026](https://encore.dev/articles/typescript-orms))
- **Don't push multi-backend into the ORM.** Drizzle generates **dialect-specific clients at compile time** — you can't runtime-swap `DATABASE_URL` on one `db` object. Any multi-backend switch belongs in **app code (the port/adapter layer), not inside the ORM.** ([Drizzle multi-dialect discussion](https://github.com/drizzle-team/drizzle-orm/discussions/5269))
- **Dialect gaps bite in production** (`ILIKE` absent in SQLite, `jsonb` operators differ, timestamp handling differs) → **pick one primary engine and test against the engine you deploy to,** unless edge/offline genuinely requires SQLite-at-the-edge + central Postgres. ([Turso + Drizzle](https://mfyz.com/turso-drizzle-perfect-sqlite-combo-in-production/))
- **Postgres + pgvector = a unified data layer for AI.** Keep relational data *and* embeddings in one Postgres instead of a separate vector DB; pgvector + HNSW is a legitimate Pinecone/Weaviate competitor up to ~10M vectors. Serverless Postgres (Neon) is now AI-agent-native (scale-to-zero, native pgvector, hybrid SQL+vector). ([Render pgvector](https://render.com/articles/simplify-ai-stack-managed-postgresql-pgvector), [Neon for AI agents](https://www.gocodeo.com/post/neon-the-serverless-postgresql-platform-built-for-ai-agents), [top vector DBs 2026](https://dev.to/pratikpathak/top-vector-databases-for-ai-agents-a-2026-developer-guide-436k))

---

## 2. How weaveIntel actually persists today (full package audit)

There is **no single central persistence layer**. Persistence is defined **per domain package as a port**, and most durable-runtime packages already ship **multiple real backends**.

### Real, production-ready multi-backend packages (ports + real SQL)
| Package | Port interface | Backends shipped (real query logic) |
|---|---|---|
| **memory** | `DurableMemoryStore` | Postgres, **pgvector**, SQLite, Redis, MongoDB, CloudNoSQL, in-memory |
| **workflows** | `CheckpointStore` / `PayloadStore` / `StepIdempotencyStore` / `DurableSleepStore` / `StepLockStore` / `WorkflowDefinitionStore` | SQLite, Postgres, Redis, MongoDB, DynamoDB (5 backends × 6 stores = ~36 adapter files) |
| **live-agents** | `StateStore` (~21 methods) | Postgres, SQLite, Redis, MongoDB, in-memory |
| **triggers** | `TriggerStore` | SQLite, Postgres, MongoDB, Redis, DynamoDB |
| **artifacts** | `ArtifactStore` | SQLite, filesystem, in-memory |
| **cache** | `CacheStore` / `RedisLikeClient` (injected) | in-memory, Redis |

### Port-defined but "reference-only" (real SQL lives in the consuming app)
`notes` (`NoteRepository`), `notifications` (`NotificationFeedStore`), `human-tasks` (`HumanTaskRepository`), `collab` (`CoeditDoc`/`PresenceStore`) — these define the port and ship only an **in-memory reference adapter**; the actual SQL implementation is in the geneWeave app.

### Injected / decorator / stateless
`cost-governor` (injected `CostLedger`), `encryption` (a **decorator** that wraps *any* DB adapter for at-rest/field encryption), `a2a` (via `RuntimeKvStore`), `identity`/`resilience`/`guardrails`/`skills` (in-memory; retrieval via an injected `VectorStore`).

### `packages/persistence` — **not** the data layer
Its `PersistenceAdapter` interface is only `{ kind, capabilities, connect(), disconnect(), health() }` and the Postgres/SQLite adapters are **~13-line stubs that set capability flags and contain zero query logic.** It's a **runtime capability-negotiation registry** (does this backend support transactions/TTL/pubsub/jsonQuery?), plus a real SQLite KV slot (`runtime-slot.ts` → `weaveSqlitePersistence()`) for durable runtime state (DLQ, cost meter, idempotency). Real persistence deliberately lives in the domain packages above, **not** here.

### The geneWeave **app** — where the real lock-in is
Everything in the app (chat, skills, notes, memory, tools, routing…) goes through **one injected `DatabaseAdapter`** with a single **`SQLiteAdapter`** implementation (`db-sqlite.ts`, ~11k lines of hand-written SQLite SQL) + ~149 SQLite-dialect migrations. **There is no Postgres adapter here.** This is the largest body of data and the single biggest Postgres gap.

---

## 3. Validation: where you are vs. the SOTA

| Dimension | Verdict |
|---|---|
| **Architecture (ports & adapters + DI)** | ✅ **Already SOTA.** Ahead of most codebases. Keep it. |
| **Multi-backend for runtime packages** | ✅ Strong — memory/workflows/live-agents/triggers already run on Postgres. |
| **Vector / embeddings story** | ✅ On-track — `memory-pgvector` exists; retrieval is via an injected `VectorStore`. Aligned with the "one Postgres + pgvector" unified-data-layer trend. |
| **Data-access *mechanism*** | ❌ **Off-SOTA.** Every backend hand-writes the same SQL per dialect (workflows alone = ~36 near-duplicate adapters). No single schema source, no compile-time type-safety, high dialect-drift risk (`excluded.` vs `EXCLUDED`, `?` vs `$1`, `json_extract` vs `->>`, `datetime('now')` vs `now()`). |
| **`packages/persistence` clarity** | ⚠️ **Misleading.** Named/shaped like the central store but is a capability stub — easy to mistake for the data layer (as this very question shows). |
| **App portability** | ❌ **SQLite-locked.** `db-sqlite.ts` + 149 migrations are pure SQLite dialect; no Postgres path. |
| **Testing against deploy engine** | ⚠️ Packages test SQLite/in-memory; Postgres adapters need contract tests against real Postgres (SOTA: test the engine you deploy to). |

**Bottom line:** the *skeleton* is modern; the *muscle* (hand-written per-dialect SQL, SQLite-only app, stub persistence package) is where the debt is.

---

## 4. Future-looking target architecture

1. **One primary backend: Postgres + pgvector** (relational + JSONB + vector in a single engine — the unified AI data layer). Use **serverless Postgres (Neon)** if you want scale-to-zero / AI-agent-native branching; a managed Aurora/RDS/Render Postgres otherwise. **Reserve SQLite strictly for edge/offline/desktop** (via the *same* ports) — not as a co-equal production target.
2. **Keep the ports** (`NoteRepository`, `MemoryStore`, `StateStore`, `CheckpointStore`, the app's `DatabaseAdapter`, …). They are the correct seam and the reason this migration is even tractable.
3. **Replace hand-written SQL with a schema-first typed query builder — Drizzle** — as the shared implementation *behind* those ports. Schema defined once in TS → migrations generated → type-safe queries. This collapses the N-backends × M-stores duplication into one schema + one query surface, and kills dialect drift. (Put the *backend switch* in the port/adapter layer, not in Drizzle.)
4. **Make `packages/persistence` honest:** either (a) grow it into a real generic table/KV store used by the reference adapters, or (b) rename/relabel it "runtime capability registry + KV slot" so nobody mistakes it for the data layer. (Recommend (b) short-term, (a) only if you want a true shared store.)
5. **Unify migrations & schema as one source of truth** (Drizzle migrations per engine) — replacing the app's 149 bespoke SQLite migrations and the scattered `CREATE TABLE` strings inside adapters.
6. **Embeddings on pgvector** everywhere (`memory-pgvector` + the skills `VectorStore`); retire any separate/ephemeral vector store.

---

## 5. Pragmatic migration path (sequenced, low-risk — no rip-and-replace)

**Phase 0 — Decide & de-risk. — ✅ DONE (in `@weaveintel/persistence`, additive patch).**
- **Relabelled the package** in code + README so it's unmistakably a *runtime capability registry + durable KV slots*, not a general data layer (`PersistenceAdapter` = capability descriptor, not CRUD).
- **`weavePostgresPersistence`** — a real Postgres `RuntimePersistenceSlot` at parity with the SQLite one; driver-agnostic via an injected `SqlClient` (`pg.Pool` / serverless drivers / Testcontainers all satisfy it); fully parameterised (injection-safe), TTL-aware, byte-order-correct prefix scans via `starts_with` + `COLLATE "C"` (Postgres text is collation-ordered, unlike SQLite byte order — the key gotcha).
- **`runPersistenceContract` / `contractPassed`** — a framework-agnostic conformance harness (positive / negative / stress / security) that proves any KV backend is a safe drop-in before you migrate.
- **Tested (11/11):** the contract passes on in-memory + SQLite (hermetic) and on **real Postgres via Testcontainers** (pgvector image, Docker-gated); a self-check proves the harness *fails* a broken backend; **SQLite↔Postgres parity** (identical answers for identical ops); injection can't drop the table; and the **flagship real-LLM e2e** — real OpenAI embeddings stored + semantically searched via **pgvector in the same Postgres** (the unified-data-layer thesis, proven end-to-end). Changeset staged.

**Phase 1 — App adapter (biggest lever, most data). — ✅ FOUNDATION DONE (core slice, in the geneWeave app).**
The seam is proven end-to-end: geneWeave now runs on Postgres *or* SQLite behind the same `DatabaseAdapter`, chosen by env (`WEAVE_DB=postgres` + `DATABASE_URL`), with SQLite still the zero-config default.
- **`createPostgresAdapter` (`apps/geneweave/src/db-postgres.ts`)** — a real Postgres `DatabaseAdapter` implementing the **core chat + skills slice** (`users`, `chats`, `messages`, `skills`) at **byte-for-byte parity** with `SQLiteAdapter`. Driver-agnostic via an injected `SqlClient` (a `pg.Pool`, serverless driver, or test container satisfies it) — Postgres is only imported when actually selected.
- **The parity rules** (the whole point): text ordering pinned to `COLLATE "C"` (SQLite compares bytes, Postgres compares by locale — this makes them agree); on/off flags stay `INTEGER` (0/1, not `BOOLEAN`); counts stay `INTEGER` (JS numbers, not bigint-strings); timestamps stay `TEXT` in SQLite's `datetime('now')` format. Result: a row reads back identically on either backend. All values are bound parameters (`$1`), never concatenated → injection-safe.
- **Honest boundary** — a `Proxy` makes every not-yet-ported method throw a clear, self-explaining error the instant it's called (never a silent wrong answer), so it's always obvious what's ready. `createDatabaseAdapter` gains a first-class `'postgres'` type; `resolveDatabaseConfigFromEnv()` does the env switch; the server default is now env-aware.
- **Switch is in APP code, not the ORM** (per the research: Drizzle's per-dialect clients can't runtime-swap). Used **parameterised `pg`** (not Drizzle) for the adapter so parity with the hand-written SQLite SQL is directly provable; Drizzle stays the recommended tool for *generating* the full 86-table schema in later increments.
- **Tested (13/13):** hermetic env-switch + boundary tests (always run); against **real Postgres via Testcontainers** (`postgres:16`, Docker-gated) — positive round-trips, negative (missing→null/[]), **SQLite↔Postgres parity** (identical rows for identical ops, incl. byte-order sort), **stress** (800 skills + 500-message chat + concurrent inserts stay consistent), **security** (injection payloads stored verbatim can't drop tables; tenant isolation), and the **real-LLM flagship** — a genuine OpenAI assistant message (emoji + quotes) persisted to Postgres and read back byte-for-byte, metadata/tokens intact. Docs: `docs-html.ts` (“Running geneWeave on Postgres”) + app README.
- **Remaining (incremental):** the other 17 domains / ~82 tables port the same way — mirror each `SQLiteAdapter` method into `db-postgres.ts`, generating the Postgres schema (Drizzle) as the surface grows. The boundary error names exactly what's missing.

**Phase 2 — Wire the already-Postgres-ready packages. — ✅ DONE (additive, in `@weaveintel/persistence` + memory/live-agents).**
The four runtime store packages can now all run on **one shared Postgres pool**, and there's a single place to do it.
- **The gap it closed:** the packages were split on how they connect — workflows and triggers already took an injected `{ pool }`, but **memory** (`weavePostgresMemoryStore` / `weavePgVectorMemoryStore`) and **live-agents** (`weavePostgresStateStore`) only took a `{ url }` and opened their *own* pool. So you literally couldn't point all four at one pool. Fixed **additively**: those three factories now accept `{ pool }` *or* `{ url }` (existing `{ url }` callers unchanged), and an injected pool is left open on `close()` — the caller owns its lifecycle.
- **`weaveSharedPostgres`** — the composition root: one connection (inject a `pg.Pool`, or pass a `connectionString` and it lazily creates one via the optional `pg`), exposed as `.pool` for every `weavePostgres*Store({ pool })` factory, plus `slot(name)` for the runtime's own durable KV (each slot in its own table, reusing `weavePostgresPersistence`), plus `health()` / `capabilities()` / `registeredTables()` / `close()`. **Research-aligned:** one pool per process, shared (not a pool per store); and **pooler-safe** — isolation is by explicit table name, never `SET search_path` (which breaks under Neon/PgBouncer transaction mode). It deliberately does **not** import the store packages (persistence sits *below* them in the stack — importing them creates a build cycle), so wiring is one line per store in app code.
- **`runSharedPostgresCoexistence` / `coexistenceReport`** — a coexistence contract: describe each store as a probe (name + tables + a write→read) and it proves every store works on the shared connection, no two stores share a table, one store's writes don't corrupt another's, and a KV slot passes its full contract — all on the one Postgres.
- **Tested (16/16):** hermetic hub tests (naming/collision/health/lifecycle/injection guards) + the **flagship** against a real throwaway Postgres (Testcontainers, pgvector image): memory + workflows + live-agents + triggers + KV slots all wired to one pool passing the coexistence contract across all four tiers; plus a **real-OpenAI-embeddings** leg proving a semantic memory search runs in the *same* Postgres as the workflow/agent/trigger state (the unified-data-layer payoff). Changeset staged.
- **Not done here (later phases):** moving `memory` *usage* to `memory-pgvector` by default, and the app's own tables (Phase 1 continues separately).

**Phase 3 — Promote the "reference-only" packages. — ✅ DONE (additive, in notes/notifications/human-tasks).**
`notes`, `notifications`, and `human-tasks` now ship REAL Postgres adapters behind their existing ports — so their SQL lives in the monorepo, contract-tested, instead of only in the app.
- **`createPostgresNoteRepository`** (`@weaveintel/notes`) — the full `NoteRepository` (notes + links + databases + rows) on Postgres, at parity with the in-memory reference: owner-scoping, favourite-then-recent ordering, title/body search (LIKE-escaped so it stays literal), one-level cascade delete, monotonic timestamps for deterministic ordering.
- **`createPostgresNotificationFeedStore`** (`@weaveintel/notifications`) — the durable 🔔 inbox on Postgres: fan-out-on-write, `(tenant, principal)` isolation, and at-least-once **dedupe** enforced by a partial unique index on `(principal_id, dedupe_key)` (correct even under concurrent redelivery).
- **`createPostgresHumanTaskRepository`** (`@weaveintel/human-tasks`) — human tasks on Postgres with a **race-free work queue**: `claimNextPending` uses `FOR UPDATE SKIP LOCKED` (the idiomatic Postgres pattern) so two workers never get the same task; the full task is stored as JSONB with the filtered fields pulled out as indexed columns.
- **Contract-first (the whole point):** each adapter is proven against the package's SHARED contract — `noteRepositoryContract` and `notificationFeedStoreContract` already existed; human-tasks had none, so a new `humanTaskRepositoryContract` was written (an additive win — the in-memory + JSON-file adapters now get contract coverage too). All adapters are pool-injected (`{ pool }`, a **type-only** `pg` import — no runtime driver forced), lazy `CREATE TABLE IF NOT EXISTS`, fully parameterised.
- **Wired into Phase 2:** the three new stores are added as probes to `weaveSharedPostgres`'s coexistence flagship — it now proves **all SEVEN** stores (memory, workflows, live-agents, triggers, notes, notifications, human-tasks) + KV slots coexist on ONE Postgres.
- **Tested (all green on real Postgres via Testcontainers):** notes 12/12 (shared contract + injection/wildcard security + 2,000-note stress) + a **real-LLM** e2e (an OpenAI-drafted note stored and found by search); notifications 8/8 (contract + 5,000-recipient fan-out + concurrent-dedupe); human-tasks 16/16 (contract on in-memory AND Postgres + a **200-worker stampede claiming 200 tasks with zero double-claims**); coexistence 3/3 incl. the 7-store flagship + real-OpenAI leg. Changesets staged (all patch/minor, additive).
- **Not done here:** `collab` (`CoeditDoc`/`PresenceStore`) — its real backend is the CRDT relay, a different concern; left for a later pass. Drizzle was NOT used (kept the established parameterised-`pg` convention for direct parity; Drizzle stays the Phase 4 refactor tool).

**Phase 4 — Refactor the duplicated adapters onto Drizzle. — ✅ PATTERN PROVEN + FIRST STORE COLLAPSED (workflows CheckpointStore).**
The workflows package hand-writes the same SQL per dialect across ~50 adapter files (10 stores × 5 backends). Phase 4 targets the two SQL dialects (Postgres + SQLite — Drizzle doesn't cover Mongo/Redis/DynamoDB, which stay). **Research correction (important): Drizzle deliberately does NOT support one unified schema across dialects** — `pgTable` and `sqliteTable` are different, incompatible types by design. The recommended SOTA pattern is: ONE shared TS source of truth (the field spec + the existing port interface) → thin dialect-specific table declarations → **the query logic written ONCE** against Drizzle's cross-dialect builder. That's the genuine "kill the duplication" win, and it's what we did.
- **`drizzle-checkpoint-schema.ts`** declares `pgCheckpoints` + `sqliteCheckpoints` side by side from identical field intent (only real difference: `jsonb` vs JSON-in-`text`; both map to the same JS object). Timestamps are ISO `text` in BOTH dialects → the old `TIMESTAMPTZ`-vs-`TEXT` drift is gone.
- **`drizzle-checkpoint-store.ts` `createDrizzleCheckpointStore`** is the CheckpointStore implemented **once** with Drizzle's query builder — no raw SQL, so no `$1`-vs-`?`, no hand-rolled JSON parsing, no `NOW()`-vs-`CURRENT_TIMESTAMP`. The one true dialect difference (node-postgres runs on `await`; better-sqlite3 is synchronous via `.all()`/`.run()`) is hidden behind a tiny `exec` seam (`pgExec`/`sqliteExec`). A strictly-increasing clock makes `created_at` never tie → `latest`/`list` are deterministic on either DB (removing the old `rowid`-vs-`id` tiebreak drift; ids are UUIDv7 so ordering is stable regardless).
- **`weavePostgresCheckpointStore` + `weaveSqliteCheckpointStore` are now thin wrappers** around that one implementation — SAME public factory names/signatures/options, just no duplicated bodies. Backward compatible.
- **Shared contract (the review's "shared migrations + contract tests"):** none existed, so wrote **`checkpointStoreContract`** — run against the in-memory reference, the Drizzle-SQLite adapter (hermetic), and the Drizzle-Postgres adapter (Testcontainers). The pre-existing `sqlite-stores.test.ts` (the regression guard) still passes unchanged, proving the swap preserved behaviour.
- **Tested (all green): workflows 129/129** — full suite incl. the engine, the regression guard, 16 hermetic contract (in-memory + Drizzle-SQLite parity), and 11 real-Postgres (Drizzle-pg contract + 2,000-checkpoint stress + injection security + a **real-LLM durable-resume**: GPT-4o-mini extracts `$4,200` → checkpoint to Postgres → a FRESH store loads it after a simulated crash → step 2 resumes from exactly there). `drizzle-orm@^0.45` added as a workflows dep. Changeset staged (minor).
- **ALL 10 workflow SQL stores now collapsed (follow-on pass).** The remaining 9 — definition, run-repository, idempotency, payload, step-lock, sleep, run-queue, rate-limiter, audit-log — were converted onto the same recipe: `drizzle-workflow-schema.ts` (pg + sqlite tables side by side for all of them, from one field intent) + `drizzle-workflow-stores.ts` (one `createDrizzle*` query implementation per store) + thin `weavePostgres*` / `weaveSqlite*` wrappers with the SAME public API. Shared `drizzle-exec.ts` (the `pgExec`/`sqliteExec` sync-vs-async seam + monotonic clocks). Denormalised stores (definition/run) keep the full entity in a JSON column + scalar columns for filtering; JSON is `jsonb` on pg / JSON-in-`text` on sqlite (same JS value); ms timestamps are `bigint`/`integer`.
  - **The one genuinely dialect-divergent method: run-queue `dequeue`.** Postgres needs `FOR UPDATE SKIP LOCKED` (in a transaction) for race-free parallel draining; SQLite is single-writer and uses a simple select-then-delete. Handled cleanly by an injectable `dequeue` override the Postgres factory supplies (`createPgRunQueueDequeue`) — everything else is shared.
  - **Coverage the old code never had:** the Postgres adapters were previously "exercised at compile time only" (never run against a real database in-package). A new `drizzle-workflow-stores.realsandbox.test.ts` runs all 9 on real Postgres (Testcontainers) — positive round-trips + the tricky bits (run-repo listFiltered/countActive, priority+FIFO dequeue, step-lock done/output, token-bucket rate limiter, audit ordering, sleep getDue) + **stress** (1,000-entry concurrent queue drain, no double-pop) + **security** (injection payloads) + a **real-LLM** e2e (a model designs a workflow → definition + run + audit trail persisted to Postgres). The existing `sqlite-stores.test.ts` (unchanged) remains the SQLite regression guard. **workflows 141/141 green.** Changeset staged (minor).
- **Remaining (same recipe):** the memory/live-agents/triggers SQL adapters follow the identical template. Not done in this pass; the workflows package (the review's headline "~36 adapters" target) is now fully collapsed.

**Phase 5 — Cutover & retire.** Backfill/migrate data, run both engines in parallel behind the ports, cut over, keep SQLite only where edge/offline is a real requirement.

---

## 6. Decisions to make (recommendations)

| Decision | Recommendation |
|---|---|
| One backend or multi? | **Postgres-primary.** SQLite only for edge/offline, via the same ports. Multi-dialect only where edge is a real product requirement. |
| Serverless vs managed Postgres | **Neon** if you want scale-to-zero + AI-native branching/pgvector; managed Aurora/RDS otherwise. |
| Query builder | **Drizzle** (schema + migrations + types) as the shared mechanism behind the ports. Kysely if you prefer builder-only + external migrations. |
| Vector store | **pgvector in the same Postgres** (`memory-pgvector`); no separate vector DB under ~10M vectors. |
| `packages/persistence` | Relabel to "runtime capability registry / KV slot" (or grow into a real store). Don't treat it as the data layer. |
| Where the backend switch lives | **App/port layer**, never inside Drizzle. |

---

*Sources: [Hexagonal architecture 2026](https://generalistprogrammer.com/tutorials/hexagonal-architecture-complete-guide) · [Drizzle vs Kysely 2026](https://www.pkgpulse.com/guides/drizzle-vs-kysely-2026) · [TS ORMs 2026](https://encore.dev/articles/typescript-orms) · [Drizzle multi-dialect](https://github.com/drizzle-team/drizzle-orm/discussions/5269) · [pgvector unified stack](https://render.com/articles/simplify-ai-stack-managed-postgresql-pgvector) · [Neon for AI agents](https://www.gocodeo.com/post/neon-the-serverless-postgresql-platform-built-for-ai-agents) · [vector DBs 2026](https://dev.to/pratikpathak/top-vector-databases-for-ai-agents-a-2026-developer-guide-436k)*
