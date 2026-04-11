# @weaveintel/mcp-client

MCP (Model Context Protocol) client — connect to MCP servers and consume their tools, resources, and prompts.

## Usage

```typescript
import { createMCPClient, mcpToolsToRegistry } from '@weaveintel/mcp-client';

const client = createMCPClient();
await client.connect(transport);

// Discover available tools
const tools = await client.listTools();

// Bridge MCP tools into a weaveIntel ToolRegistry
const registry = mcpToolsToRegistry(client, tools);

// Invoke a tool
const result = await client.callTool('greet', { name: 'Alice' });
```
