# @weaveintel/realm

## 0.5.2

### Patch Changes

- Updated dependencies
  - @weaveintel/core@0.3.0
  - @weaveintel/identity@0.1.4

## 0.5.1

### Patch Changes

- Updated dependencies [766246e]
  - @weaveintel/core@0.2.0
  - @weaveintel/identity@0.1.3

## 0.5.0

### Added

- `proposeFork(store, family, fork, { queue, reviewer, proposedBy, change, blastRadius })` opens an
  approval task on the core `HumanTaskQueue` port carrying the base, the fork as stored, the change
  (promote or share) and its blast radius, and returns the task id (GAPS G-WI-14,
  platform-architecture §5.2 item 1, §7.4 item 8).
- `decideForkProposal({ store, versionLog, queue }, taskId, decision)`: refuses self-approval, closes
  the task as `stale` when the fork or the global default changed after the proposal, otherwise calls
  `promoteFork` / `setShareMode` and completes the task. A rejection applies nothing.
