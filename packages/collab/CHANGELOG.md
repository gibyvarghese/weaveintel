# @weaveintel/collab

## 0.2.1

### Patch Changes

- Updated dependencies
  - @weaveintel/core@0.3.0

## 0.2.0

### Minor Changes

- 4e417a6: Add `createPostgresPresenceManager`, a PostgreSQL adapter for the `PresenceManager`
  port that shares presence between server copies, uses database time for expiry and
  supports sweeping expired entries. Presence scopes isolate arbitrary identifiers
  without delimiter collisions, and the in-memory adapter can bound its entries.
- 766246e: Add a scoped collaboration receiving boundary and opt-in full-history journals
  for gap-safe RGA and block-document replay. Authentication, durable storage and
  transport remain host responsibilities.
  Allow plain-text local inserts of supplementary Unicode code points and preserve them and their
  mark ranges through block diffs, ProseMirror, Markdown and HTML conversion.
  Reject client operations with fractional or unsafe counters and empty site namespaces.
  Fail local edits before counter overflow rather than generating duplicate or imprecise operation IDs.
  Make out-of-range deletes no-ops instead of deleting the last character or a block marker.

### Patch Changes

- Updated dependencies [766246e]
  - @weaveintel/core@0.2.0
