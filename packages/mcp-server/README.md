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
  mcpText,
} from '@weaveintel/mcp-server';

const server = weaveMCPServer({ name: 'my-tools', version: '1.0.0' });

server.addTool(
  { name: 'greet', description: 'Say hello', inputSchema: { type: 'object' } },
  async (_ctx, _args) => mcpText('Hello from my server!'),
);

await server.connect(createMCPStdioServerTransport());
```

## What's in the box

| Export | What it does |
| --- | --- |
| `weaveMCPServer(config, opts?)` | The server: `addTool`, add resources/prompts, `connect` |
| `createMCPStdioServerTransport()` | Serve over stdio (e.g. to a desktop client subprocess) |
| `createMCPStreamableHttpServerTransport()` | Serve over streamable HTTP |
| `weaveRealMCPTransport(opts)` | Batteries-included real HTTP transport server |
| `handleMcpMessage`, `mcpText`, `MCP_PROTOCOL_VERSION` | Transport-free JSON-RPC core + helpers |

## License

MIT.
