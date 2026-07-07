---
"@weaveintel/notes": minor
"@weaveintel/notifications": minor
"@weaveintel/human-tasks": minor
---

Real Postgres adapters for the reference-only packages (persistence review Phase 3). Each package
already defined a storage port + an in-memory reference + (notes/notifications) a shared contract; now
each ships a REAL Postgres adapter behind that same port, so the SQL lives in the monorepo and is
contract-tested — instead of only in the consuming app.

- `@weaveintel/notes` — `createPostgresNoteRepository({ pool })`: the full `NoteRepository` (notes,
  links, databases, rows) at parity with the in-memory reference — owner-scoping, favourite-then-recent
  ordering, LIKE-escaped title/body search, one-level cascade delete.
- `@weaveintel/notifications` — `createPostgresNotificationFeedStore({ pool })`: the durable in-app
  inbox — `(tenant, principal)` isolation and at-least-once dedupe enforced by a partial unique index
  on `(principal_id, dedupe_key)`.
- `@weaveintel/human-tasks` — `createPostgresHumanTaskRepository({ pool })`: human tasks with a
  race-free work queue — `claimNextPending` uses `FOR UPDATE SKIP LOCKED` so two workers never get the
  same task. Also adds `humanTaskRepositoryContract`, a new shared conformance test the in-memory,
  JSON-file, and Postgres adapters all pass.

All adapters are pool-injected (a shared `pg.Pool`, e.g. from `weaveSharedPostgres`), use a type-only
`pg` import (no runtime driver forced), create their tables on first use, and bind every value as a
parameter (injection-safe). Additive and backward compatible — existing in-memory usage is unchanged.
