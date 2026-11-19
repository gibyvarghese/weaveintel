---
"@weaveintel/collab": minor
---

Add `createPostgresPresenceManager`, a PostgreSQL adapter for the `PresenceManager`
port that shares presence between server copies, uses database time for expiry and
supports sweeping expired entries. Presence scopes isolate arbitrary identifiers
without delimiter collisions, and the in-memory adapter can bound its entries.
