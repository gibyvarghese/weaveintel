---
"@weaveintel/persistence": patch
---

Postgres de-risking (persistence review Phase 0). Adds `weavePostgresPersistence` — a real
Postgres-backed `RuntimePersistenceSlot` at parity with `weaveSqlitePersistence`, driver-agnostic via an
injected `SqlClient` (`pg.Pool` / serverless drivers / a test container all satisfy it); fully
parameterised (keys/values are data, never SQL), TTL-aware, and byte-order-correct for prefix scans via
`starts_with` + `COLLATE "C"` so it behaves identically to SQLite. Adds `runPersistenceContract` /
`contractPassed` — a framework-agnostic conformance harness (positive / negative / stress / security)
you run against any KV backend to prove it's a safe drop-in before migrating. Clarifies the package's
role in code + README: it is a **runtime capability registry + durable KV slots**, NOT a general data
layer (`PersistenceAdapter` is a capability descriptor, not CRUD). Additive; published deps unchanged
(pg / Testcontainers are dev-only test dependencies).
