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

**Phase 2 — Wire the already-Postgres-ready packages.** memory/workflows/live-agents/triggers already have Postgres adapters — just select them + point at the shared Postgres. Move `memory` to `memory-pgvector` for embeddings.

**Phase 3 — Promote the "reference-only" packages.** Give `notes`, `notifications`, `human-tasks` real Postgres adapters (ideally Drizzle-backed) so their SQL lives in the monorepo behind their ports, with shared migrations + contract tests — instead of only in the app.

**Phase 4 — Refactor the duplicated adapters onto Drizzle.** Collapse the ~36 workflow adapters (and the memory/live-agents/triggers SQL) onto one Drizzle schema per domain; keep the SQLite path generated from the same schema for edge. Delete dialect drift.

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
