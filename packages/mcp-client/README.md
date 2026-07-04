# @weaveintel/mcp-client

**Connect to any external MCP server and hand its tools straight to your agent.**

## Why it exists

Lots of useful capabilities now live behind the Model Context Protocol — a filesystem server, a database server, a company's internal server. Each one is a little appliance with its own plug. This package is the extension cord: point it at a server, and every tool that server offers shows up in your agent's tool registry as if you'd written it yourself. You don't learn each server's wiring; you just plug in.

## When to reach for it

Reach for it when you want your agent to *use* tools that some other MCP server provides. If instead you want to *publish* your own tools for others to consume, that's the other end of the cord — use `@weaveintel/mcp-server`.

## How to use it

```ts
import {
  weaveMCPClient,
  weaveMCPTools,
  createMCPStreamableHttpTransport,
} from '@weaveintel/mcp-client';
import { weaveContext } from '@weaveintel/core';

const client = weaveMCPClient();
await client.connect(createMCPStreamableHttpTransport('https://example.com/mcp'));

const tools = await client.listTools();          // what the server offers
const registry = weaveMCPTools(client, tools);    // drop-in ToolRegistry for your agent

const ctx = weaveContext();
const result = await client.callTool(ctx, { name: tools[0].name, arguments: {} });
console.log(result.content);
```

## What's in the box

| Export | What it does |
| --- | --- |
| `weaveMCPClient()` | The client: `connect`, `listTools`, `callTool` (plus resources & prompts) |
| `weaveMCPTools(client, tools)` | Wraps discovered tools into a `ToolRegistry` your agent can call |
| `createMCPStreamableHttpTransport(endpoint, opts?)` | Talk to a server over HTTP (with custom/dynamic headers) |
| `createMCPStdioClientTransport(params)` | Talk to a server running as a local subprocess (stdio) |

## License

MIT.
