---
"@weaveintel/identity": minor
---

Tenancy realm Phase 0 — tenant hierarchy primitive. `@weaveintel/identity/tenancy` now ships a
brand-neutral, dual-engine (SQLite + Postgres) tenant tree: real tenants with parent/child links, a
materialized path for cheap depth/ancestor/descendant reads (no recursive CTEs), cycle-safe subtree
reparenting as a single prefix-rewrite UPDATE, and an idempotent `ensureDefault()` for the single-org
case. Ships the pure path engine, an in-memory reference, one `SqlClient`-based SQL adapter, a
conformance contract, and `tenantHierarchyDdl()`. Proven identical on in-memory / real SQLite / real
Postgres, with a 3,127-node stress test, adversarial-id security tests, and a real-LLM org-chart e2e.
