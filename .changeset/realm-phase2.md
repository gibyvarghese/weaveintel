---
"@weaveintel/realm": minor
---

Tenancy realm Phase 2 — the version log + package-upgrade reconcile engine. Ships defaults and lets
operators edit them without either side clobbering the other, exactly like an OS package manager
handling a config file in /etc on upgrade. Adds an append-only, content-addressed version log
(`createInMemoryVersionLog` / `createSqlVersionLog` + `realmVersionsDdl`) that stores the baseline —
the last version you shipped — separate from the live record. `reconcile(store, log, family, defaults)`
compares three hashes (what we shipped last time / what's stored now / what the new release wants) and
sorts every default into in_sync, customized (keep theirs), stale (adopt ours), diverged (review), new
(publish), removed (flag) — the same three-way logic as Debian's ucf/dpkg conffile handling. `reconcile`
is also the seeding mechanism (first run publishes everything; re-runs are no-ops). `resyncToDesired`
takes the shipped version for a diverged default; `publishToRealm` publishes one global default + its
version. Proven on the in-memory reference, real SQLite and real Postgres, with a 1,000-default upgrade
stress test, adversarial-input security tests, and a real-LLM flagship (a model ships v1, an operator
edits some, the model ships v2, reconcile keeps the edits and adopts only the safe changes). Also fixes
a latent bug where `listAll` could query before the schema was ensured on a first read.
