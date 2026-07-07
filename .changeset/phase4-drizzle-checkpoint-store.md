---
"@weaveintel/workflows": minor
---

Collapse the checkpoint store's per-dialect SQL onto one Drizzle implementation (persistence review
Phase 4). The Postgres and SQLite checkpoint adapters were hand-written twice and drifting apart (`$1`
vs `?`, `jsonb` vs text, `NOW()` vs `CURRENT_TIMESTAMP`, `id` vs `rowid` ordering). They now share ONE
type-safe Drizzle query implementation (`createDrizzleCheckpointStore`), with `pgCheckpoints` /
`sqliteCheckpoints` declared side by side from the same field intent. The one real dialect difference —
node-postgres runs on `await`, better-sqlite3 is synchronous — is hidden behind a tiny `exec` seam.

Backward compatible: `weavePostgresCheckpointStore` and `weaveSqliteCheckpointStore` keep the exact same
names, signatures, and options — they're now thin wrappers. Adds a shared `checkpointStoreContract` that
the in-memory reference, the SQLite adapter, and a real Postgres all pass (so behaviour is provably
identical), and `drizzle-orm` as a dependency. This is the proven template for collapsing the remaining
SQL-backed workflow stores.
