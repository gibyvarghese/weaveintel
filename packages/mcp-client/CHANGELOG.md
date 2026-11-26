# @weaveintel/mcp-client

## 0.1.4

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

## 0.1.3

### Patch Changes

- Updated dependencies
  - @weaveintel/core@0.3.0

## 0.1.2

### Patch Changes

- Updated dependencies [766246e]
  - @weaveintel/core@0.2.0
