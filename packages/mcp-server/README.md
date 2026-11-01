# @weaveintel/mcp-server

**Expose your own tools, resources, and prompts over the open Model Context Protocol.**

## Why it exists

You've built tools you'd like other AI apps to use — a desktop assistant, an editor, a colleague's agent. The Model Context Protocol is the USB-C port for AI: one standard socket everyone already knows how to plug into. This package turns your tools into that socket. You describe what you offer once, pick a transport, and any MCP-speaking client can discover and call it — no bespoke API, no custom SDK for each consumer.

## When to reach for it

Reach for it when you want to *publish* capabilities for the outside world to consume. If instead you want your agent to *use* someone else's MCP server, that's the opposite direction — use `@weaveintel/mcp-client`. And if you don't need a live transport at all — say you're embedding MCP inside another HTTP route — drive the transport-free `handleMcpMessage` core directly.

## How to use it

```ts
import {
  weaveMCPServer,
  createMCPStdioServerTransport,
  inProcessMCPContext,
  mcpText,
} from '@weaveintel/mcp-server';

// Every server says how it identifies callers. A stdio server talks only to the process
// that launched it, so `inProcessMCPContext` (no user, no tenant) is the honest answer.
const server = weaveMCPServer({ name: 'my-tools', version: '1.0.0' }, { contextFactory: inProcessMCPContext });

server.addTool(
  { name: 'greet', description: 'Say hello', inputSchema: { type: 'object' } },
  async (_ctx, _args) => mcpText('Hello from my server!'),
);

await server.connect(createMCPStdioServerTransport());
```

### Who is calling?

There is no anonymous default: `weaveMCPServer` refuses to build without a `contextFactory`.
The factory runs on every request (listing and calls) and gets only what the transport
verified — `authInfo` (on HTTP, whatever your auth middleware put on `req.auth`), the
session id, headers and the cancellation signal. It never sees the caller's JSON-RPC params,
because a caller can put any identity there. Throw to refuse the caller; the request then
fails with a generic "unauthenticated" error and no handler runs.

```ts
const server = weaveMCPServer(config, {
  contextFactory: async ({ authInfo, signal }) => {
    if (!authInfo) throw new Error('no verified caller');
    const who = await verifyNote(authInfo.token); // your identity layer
    return weaveContext({ userId: who.userId, tenantId: who.tenantId, signal });
  },
});
```

`callerAssertedMCPContext` builds the context from the caller's own `_meta.executionContext`
(what `weaveMCPClient` forwards). It believes the caller, so the server refuses to start with it
on anything but a stdio transport; the built-in connector servers use it for in-process agents.

## What's in the box

| Export | What it does |
| --- | --- |
| `weaveMCPServer(config, { contextFactory })` | The server: `addTool`, add resources/prompts, `connect` |
| `inProcessMCPContext`, `callerAssertedMCPContext` | Ready-made factories for stdio / in-process servers |
| `createMCPStdioServerTransport()` | Serve over stdio (e.g. to a desktop client subprocess) |
| `createMCPStreamableHttpServerTransport()` | Serve over streamable HTTP |
| `weaveRealMCPTransport(opts)` | Batteries-included real HTTP transport server |
| `handleMcpMessage`, `mcpText`, `MCP_PROTOCOL_VERSION` | Transport-free JSON-RPC core + helpers |

## License

MIT.
