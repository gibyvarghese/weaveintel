# @weaveintel/mcp-server

## 0.3.0

### Minor Changes

- 0d4427a: MCP 2026-07-28 beside 2025-11-25 on one URL, scope-to-tool, manifest hashing and URL elicitation.
  - `weaveMcpEndpoint({ serverInfo, contextFactory, tools, ... })`: a stateless remote endpoint that answers 2025-11-25
    (and 2025-06-18, 2025-03-26, 2024-11-05) clients and 2026-07-28 clients on one URL. The revision is settled per
    request (`negotiateMcpProtocolVersion`). `handle()` is framework-neutral; `serve(req, res, { authInfo })` adapts
    Node HTTP (1 MiB body cap, 413 above it).
  - Scope-to-tool: each endpoint tool names the OAuth scopes it needs. A tool is listed only when the token carries
    them; a call without them is HTTP 403 with an `insufficient_scope` challenge; an unidentified caller is HTTP 401
    with the `resource_metadata` challenge. Helpers: `missingScopes`, `bearerChallenge`, `insufficientScopeChallenge`,
    `assertScopeToken`.
  - Manifest hashing: `manifestHash(tools)` is published in `tools/list` and `tools/call` `_meta` under
    `io.weaveintel/manifest`; a call carrying a stale hash is refused (`MCP_ERROR_MANIFEST_CHANGED`).
    `parameterHash(name, args)` and `canonicalJson` are exported.
  - URL elicitation hook: a `confirm` hook (or tool handler) can return `urlElicitationRequired({ elicitationId, url,
message })` (-32042 for 2025-11-25 clients, `resultType: "input_required"` for 2026-07-28 clients). Elicitation URLs
    must be https (http only on loopback) without credentials.
  - `McpTool` gains optional `outputSchema`, `annotations` and `_meta`; `McpToolResult` gains `structuredContent` and
    `_meta`.

  Unchanged: `weaveMCPServer`, the SDK transports, `handleMcpMessage` and `MCP_PROTOCOL_VERSION` (2025-11-25).

## 0.2.3

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

## 0.2.2

### Patch Changes

- Updated dependencies
  - @weaveintel/core@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies [766246e]
  - @weaveintel/core@0.2.0

## 0.2.0

### Breaking

- `weaveMCPServer(config, { contextFactory })`: the factory is required (type and runtime,
  `MCPServerConfigError`); there is no anonymous default (GAPS G-WI-10, platform-architecture §7.4
  item 3).
- The factory receives `MCPRequestInfo` — `authInfo` (what HTTP middleware verified onto `req.auth`),
  `sessionId`, `headers`, `signal`, `method`, `requestId` — and never the caller's JSON-RPC params. It
  runs for every request, listing included; a throw refuses the caller with a generic
  "unauthenticated" error.

### Added

- `inProcessMCPContext` (stdio/in-process servers, no identity) and `callerAssertedMCPContext`
  (builds the context from `_meta.executionContext`; the server refuses to start with it on any
  non-stdio transport).
- `weaveRealMCPTransport` takes a `contextFactory`; it is optional only when bound to loopback.
