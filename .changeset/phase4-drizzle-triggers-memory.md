---
"@weaveintel/triggers": minor
"@weaveintel/memory": minor
---

Collapse the triggers and memory SQL adapters onto one Drizzle implementation each (persistence review
Phase 4, follow-on). Their hand-written Postgres and SQLite adapters were maintained twice and drifting
(`$1` vs `?`, `BOOLEAN` vs `INTEGER`, `jsonb` vs text, `json_extract` vs `->>`). Each now shares ONE
type-safe Drizzle query surface behind the same port, so there's nothing left to drift.

- `@weaveintel/triggers`: `weavePostgresTriggerStore` / `weaveSqliteTriggerStore` keep the exact same
  API; the `enabled` flag is now a real boolean on both databases via Drizzle. Adds
  `triggerStoreContract` — the in-memory reference, SQLite, and a real Postgres all pass it.
- `@weaveintel/memory`: `weavePostgresMemoryStore` / `weaveSqliteMemoryStore` keep the same API (and the
  Phase 2 shared-pool option). `clear(filter)` now filters in one shared place instead of dialect-
  specific `json_extract` / `->>` SQL — same rows deleted on both. Adds `memoryStoreContract`.

Backward compatible (the on-disk shapes are unchanged, so existing databases keep working). Adds real
Postgres coverage that never ran in-package before — Testcontainers tests exercise both on real
Postgres, plus stress (2,000 triggers / a 5,000-row invocation ledger; 5,000 memories), injection
safety, and real-LLM end-to-ends (a model designs a trigger rule; a model chooses facts to remember).
