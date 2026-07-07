---
"@weaveintel/persistence": minor
---

Cutover toolkit (persistence review Phase 5). Once every backend is a proven drop-in (Phases 0–4), you
still have to *move the durable state you already have* — the dead-letter queue, cost meter, and
idempotency records — from one database to another without losing anything. This adds the small,
backend-agnostic toolkit that makes that a checklist, following the standard zero-downtime playbook
(expand → backfill → verify → cut over) over the one `RuntimeKvStore` port every backend implements:

- `weaveDualWriteKv(primary, secondary)` — a KV store that writes to both while you keep reading the
  primary, so the new database stays current from the moment you start. Optional deterministic shadow
  reads flag any divergence; the secondary is best-effort unless `failOnSecondaryError`.
- `migrateKv(source, target, opts)` — backfill the history: idempotent, batched, with `prefix`,
  `overwrite`, `dryRun`, and progress.
- `reconcileKv(source, target, opts)` — the verify gate: reports exactly what's missing, extra, or
  different, with `ok: true` as your green light to switch.

Proven on real Postgres (Testcontainers): a full SQLite→Postgres cutover verified identical before the
switch (plus a rollback-safety reverse dual-write), a 50,000-key migration, injection-safe keys/values,
drift detection, and a cost + idempotency ledger built from real completions migrated with zero records
lost. Note: the KV port doesn't expose remaining TTL, so migrated keys carry no expiry — migrate durable
state and re-set short-lived TTLs on the new side afterwards.
