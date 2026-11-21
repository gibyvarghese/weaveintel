# @weaveintel/sandbox

## 0.1.4

### Patch Changes

- 049a0d2: Clearing away a finished run's scratch folder can no longer report that run as a failure.

  The Compute Sandbox Engine's Docker provider removed its temporary folder inside a `finally`, and a
  `finally` that throws replaces whatever the function was about to return. On macOS the container
  releases its mount of that folder a moment after the process exits, so a deletion issued immediately
  is refused with `EACCES` — and `force: true` forgives a folder that is already gone, not one the
  operating system will not yet let you touch.

  The visible effect was that a run whose code had executed perfectly, and whose output was already in
  hand, came back to the caller as a failed execution. With one run at a time it almost never happened;
  measured with forty concurrent runs it happened forty times out of forty.

  Removal now retries briefly, because the condition is momentary, and then gives up in silence: a
  temporary folder that outlives its run belongs to the operating system's temporary directory and is
  not the caller's error.

- Updated dependencies [766246e]
  - @weaveintel/core@0.2.0
  - @weaveintel/mcp-server@0.2.1

## 0.1.3

### Changed

- `createCSEMCPServer` accepts a `contextFactory`; without one it uses `callerAssertedMCPContext`, which
  only runs on stdio (GAPS G-WI-10). Requires `@weaveintel/mcp-server` ^0.2.0.
