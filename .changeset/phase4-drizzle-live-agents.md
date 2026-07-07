---
"@weaveintel/live-agents": minor
---

Collapse the live-agents StateStore's Postgres + SQLite adapters onto one Drizzle implementation
(persistence review Phase 4, final follow-on). The store's design is unchanged — an in-memory store
enforces every business rule, each mutation is snapshotted as JSON into one `la_entities` table, and
`initialize()` replays those snapshots on start-up. Previously that whole ~300-line machine (entity
maps, persist/hydrate dispatch, and the Proxy) was copy-pasted into both adapters, differing only in two
tiny SQL queries; now it lives once in `drizzle-state-store.ts`. The two queries are Drizzle (no raw SQL),
the sync-vs-async driver difference is hidden behind a small `exec` seam, and the 21-case hydration
switch collapses to a single data-driven loop.

`weavePostgresStateStore` / `weaveSqliteStateStore` keep the exact same API (including the Phase 2
`{ url } | { pool }` option), and the on-disk `la_entities` shape is unchanged, so existing databases
keep working. Adds real Postgres coverage that never ran in-package before (Testcontainers):
durability/crash-recovery, `claimNextTicks` persistence, a 1,000-agent rehydration stress, injection
safety, and a real-LLM roster-survives-restart end-to-end.
