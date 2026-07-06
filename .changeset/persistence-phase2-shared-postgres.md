---
"@weaveintel/persistence": minor
---

Postgres wiring (persistence review Phase 2). Adds `weaveSharedPostgres` — a composition root that runs
the WHOLE runtime on ONE Postgres over ONE connection: you bring a `pg.Pool` (or a `connectionString`
and it lazily creates one via the optional `pg`), and hand the *same* pool to every store
(`memory` / `workflows` / `live-agents` / `triggers`) via `hub.pool`, plus mint durable KV `slot(name)`s
(each in its own table, reusing `weavePostgresPersistence`) for the runtime's own dead-letter queue /
cost meter / idempotency. Research-aligned: one pool per process, shared (not a pool per store), and
pooler-safe — slots are isolated by explicit table name, never `SET search_path` (which breaks under
Neon/PgBouncer transaction mode). Exposes `health()` / `capabilities()` / `registeredTables()` /
`close()` (an injected pool is left open; a hub-created one is closed). Deliberately does NOT import the
store packages — persistence sits below them in the stack, so wiring is one line per store in app code.

Also adds `runSharedPostgresCoexistence` / `coexistenceReport` — a coexistence contract that proves all
those stores + KV slots safely share one Postgres (each works, no two stores share a table, no
cross-contamination, and a KV slot passes its full contract) before you cut over. Additive; no new
runtime dependencies.
