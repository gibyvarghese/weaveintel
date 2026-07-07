---
"@weaveintel/workflows": minor
---

Collapse the remaining nine SQL-backed workflow stores onto one Drizzle implementation each
(persistence review Phase 4, follow-on). After the checkpoint store, the definition, run-repository,
idempotency, payload, step-lock, sleep, run-queue, rate-limiter, and audit-log stores now share ONE
type-safe Drizzle query surface per store instead of hand-written per-dialect SQL — so all ten
SQL-backed workflow stores are drift-free.

`drizzle-workflow-schema.ts` declares each table for both dialects side by side (jsonb vs JSON-in-text,
bigint vs integer for ms timestamps); `drizzle-workflow-stores.ts` holds the shared query logic; the
`weavePostgres*` / `weaveSqlite*` factories keep the exact same names, signatures, and options — they're
thin wrappers now. The one genuinely dialect-divergent method, run-queue `dequeue`, uses Postgres'
`FOR UPDATE SKIP LOCKED` for race-free parallel draining (injected by the Postgres factory) and a simple
select-then-delete on single-writer SQLite.

Backward compatible. Adds real Postgres coverage that never existed before (the Postgres adapters were
previously compile-checked only): a Testcontainers test exercises all nine on real Postgres, including a
1,000-entry concurrent queue drain with no double-pop, injection-safety, and a real-LLM end-to-end.
