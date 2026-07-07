---
"@weaveintel/realm": minor
---

Tenancy realm Phase 1 — the `@weaveintel/realm` resolver. Resolve the effective configuration record
for a tenant across a global→tenant hierarchy: global defaults, copy-on-write tenant customizations,
and parent-shared records, with "nearest owner wins" resolution and full provenance
(global/native/own_override/inherited). Records carry realm columns + a content hash, and drift is a
git-style three-way (base/local/remote) check (in_sync/customized/stale/diverged). Ships the pure
resolution engine, a content-hash + drift core, an in-memory store, one dual-engine SQLite/Postgres
SQL store (visibility pushed into a single WHERE), a `RealmResolver`, and a conformance contract.
Composes with the Phase 0 tenant hierarchy in `@weaveintel/identity`.
