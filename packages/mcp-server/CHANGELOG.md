# @weaveintel/mcp-server

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
