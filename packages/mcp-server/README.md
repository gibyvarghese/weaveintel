# @weaveintel/mcp-server

MCP (Model Context Protocol) server — expose tools, resources, and prompts via the MCP protocol.

## Usage

```typescript
import { createMCPServer } from '@weaveintel/mcp-server';

const server = createMCPServer({ name: 'my-tools', version: '1.0.0' });

// Register a tool
server.addTool(
  {
    name: 'add',
    description: 'Add two numbers',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
  async (args) => ({ content: [{ type: 'text', text: String(args.a + args.b) }] }),
);

// Register a resource
server.addResource(
  { uri: 'config://app/version', name: 'App Version' },
  async () => ({ contents: [{ uri: 'config://app/version', text: '1.0.0' }] }),
);

// Register a prompt
server.addPrompt(
  { name: 'summarize', description: 'Summarize text' },
  async (args) => ({ messages: [{ role: 'user', content: `Summarize: ${args.text}` }] }),
);

await server.start(transport);
```
