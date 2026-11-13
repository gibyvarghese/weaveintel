# @weaveintel/mcp-server

## 0.3.0

### Added

- `weaveMcpEndpoint({ serverInfo, contextFactory, tools, ... })`: a stateless remote endpoint that
  answers 2025-11-25 (and 2025-06-18, 2025-03-26, 2024-11-05) clients and 2026-07-28 clients on one
  URL. The revision is settled per request (`negotiateMcpProtocolVersion`): `initialize` for the session
  era; `server/discover`, the version in the `MCP-Protocol-Version` header or `params._meta`, required
  `Mcp-Method` / `Mcp-Name` headers and `resultType` on every result for 2026-07-28. `handle()` is
  framework-neutral; `serve(req, res, { authInfo })` adapts Node HTTP (1 MiB body cap, 413 above it).
- Scope-to-tool: each endpoint tool names the OAuth scopes it needs (required, validated as RFC 6749
  scope tokens). A tool is listed only when the token carries them; a call without them is HTTP 403
  with `WWW-Authenticate: Bearer error="insufficient_scope", scope="...", resource_metadata="..."`. An
  unidentified caller is HTTP 401 with the `resource_metadata` challenge. Helpers: `missingScopes`,
  `bearerChallenge`, `insufficientScopeChallenge`, `assertScopeToken`.
- Manifest hashing: `manifestHash(tools)` (sha256 of the canonical tool list, order-free, `_meta`
  excluded) is published in `tools/list` and `tools/call` `_meta` under `io.weaveintel/manifest`; a call
  that carries a hash the caller's list no longer matches is refused (`MCP_ERROR_MANIFEST_CHANGED`).
  `parameterHash(name, args)` fingerprints one call; `canonicalJson` is exported.
- URL elicitation hook: an endpoint `confirm` hook (and any tool handler) can return
  `urlElicitationRequired({ elicitationId, url, message })`. 2025-11-25 clients get JSON-RPC error
  -32042 with `data.elicitations`; 2026-07-28 clients get `resultType: "input_required"` with an
  `elicitation/create` request and a `requestState` bound to the parameter hash. A retry's
  `inputResponses` reach the hook as `answers` (hints, never proof); decline or cancel refuses the call
  without running anything; answers given for other arguments are dropped. Elicitation URLs must be
  https (http only on loopback) without credentials.
- `McpTool` gains optional `outputSchema`, `annotations` and `_meta`; `McpToolResult` gains
  `structuredContent` and `_meta`.

### Unchanged

- `weaveMCPServer`, the SDK transports, `handleMcpMessage` and `MCP_PROTOCOL_VERSION` (2025-11-25)
  behave as in 0.2.0.

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
