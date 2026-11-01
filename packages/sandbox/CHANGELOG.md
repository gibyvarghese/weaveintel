# @weaveintel/sandbox

## 0.1.3

### Changed

- `createCSEMCPServer` accepts a `contextFactory`; without one it uses `callerAssertedMCPContext`, which
  only runs on stdio (GAPS G-WI-10). Requires `@weaveintel/mcp-server` ^0.2.0.
