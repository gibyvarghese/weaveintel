---
'@weaveintel/mcp-server': minor
---

MCP 2026-07-28 beside 2025-11-25 on one URL, scope-to-tool, manifest hashing and URL elicitation.

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
