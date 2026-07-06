---
"@weaveintel/memory": patch
"@weaveintel/live-agents": patch
---

Let the Postgres-backed stores share an existing connection pool (persistence review Phase 2). The
Postgres memory stores (`weavePostgresMemoryStore`, `weavePgVectorMemoryStore`) and the live-agents
Postgres state store (`weavePostgresStateStore`) now accept `{ pool }` in addition to `{ url }`. Pass a
shared `pg.Pool` — e.g. from `weaveSharedPostgres` in `@weaveintel/persistence` — so the whole runtime
runs on ONE connection instead of each store opening its own. Fully backward compatible: existing
`{ url }` callers are unchanged, and a store still closes a pool it opened from a URL while leaving an
injected pool open (the caller owns its lifecycle). The shared memory helper stays driver-free, so the
in-memory / SQLite / Redis backends don't eagerly load `pg`.
