# @weaveintel/sandbox

## 0.1.7

### Patch Changes

- Updated dependencies [0d4427a]
  - @weaveintel/mcp-server@0.3.0

## 0.1.6

### Patch Changes

- b57835c: Raise vulnerable dependency floors flagged by npm audit and Trivy.
  - `@weaveintel/core`, `@weaveintel/sandbox`: `undici` `^6.27.0` → `^6.29.1` (TLS options dropped in `Agent`, CRLF injection, retry-interceptor desync and several DoS advisories).
  - `@weaveintel/mcp-client`, `@weaveintel/mcp-server`: `@modelcontextprotocol/sdk` `^1.29.0` → `^1.32.2` (OAuth credential leak to a server-chosen authorization server, cross-service bearer tokens, unbounded request bodies, cross-origin redirect header re-send).
  - `@weaveintel/upgrade`: `zod` `^4.3.6` → `^4.6.6` (memory exhaustion on oversized constrained collections).
  - `@weaveintel/api-client`: `zod` `^3.23.0` → `^4.6.6`. No zod 3 release fixes GHSA-mrhx-c7xc-m3w5. The exported schemas are now zod 4 schemas, so a consumer that composes them with its own zod 3 instance must move to zod 4 (`z.infer` types are unchanged).

  examples: none @weaveintel/core — dependency floor bump only, no API change
  examples: none @weaveintel/sandbox — dependency floor bump only, no API change
  examples: none @weaveintel/mcp-client — dependency floor bump only, no API change
  examples: none @weaveintel/mcp-server — dependency floor bump only, no API change
  examples: none @weaveintel/upgrade — dependency floor bump only, no API change
  examples: none @weaveintel/api-client — schemas unchanged; only the zod major they are built with

- Updated dependencies [b57835c]
  - @weaveintel/core@0.3.1
  - @weaveintel/mcp-server@0.2.3

## 0.1.5

### Patch Changes

- Updated dependencies
  - @weaveintel/core@0.3.0
  - @weaveintel/mcp-server@0.2.2

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
