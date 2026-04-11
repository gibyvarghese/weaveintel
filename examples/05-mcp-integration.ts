/**
 * Example 05: MCP Client ↔ Server Integration
 *
 * Demonstrates creating an MCP server with tools and resources,
 * connecting an MCP client, and invoking tools via the MCP protocol.
 * Uses the fake in-memory transport pair for testing.
 */
import { weaveContext } from '@weaveintel/core';
import { weaveMCPServer } from '@weaveintel/mcp-server';
import { weaveMCPClient, weaveMCPTools } from '@weaveintel/mcp-client';
import { weaveFakeTransport } from '@weaveintel/testing';

async function main() {
  const ctx = weaveContext({ userId: 'demo-user' });

  // Create a transport pair (client ↔ server linked in memory)
  const { client: clientTransport, server: serverTransport } = weaveFakeTransport();

  // --- Server side ---
  const server = weaveMCPServer({
    name: 'demo-server',
    version: '1.0.0',
  });

  server.addTool(
    {
      name: 'greet',
      description: 'Greet someone by name',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
    async (_ctx, args) => ({
      content: [{ type: 'text', text: `Hello, ${(args as { name: string }).name}! Welcome to weaveIntel.` }],
    }),
  );

  server.addTool(
    {
      name: 'add',
      description: 'Add two numbers',
      inputSchema: {
        type: 'object',
        properties: {
          a: { type: 'number' },
          b: { type: 'number' },
        },
        required: ['a', 'b'],
      },
    },
    async (_ctx, args) => {
      const { a, b } = args as { a: number; b: number };
      return { content: [{ type: 'text', text: String(a + b) }] };
    },
  );

  server.addResource(
    {
      uri: 'config://app/version',
      name: 'App Version',
      description: 'Current application version',
    },
    async () => ({
      uri: 'config://app/version',
      text: '1.0.0-beta',
      mimeType: 'text/plain',
    }),
  );

  // Start the server on the server-side transport
  await server.start(serverTransport);

  // --- Client side ---
  const client = weaveMCPClient();
  await client.connect(clientTransport);

  // List available tools
  console.log('=== Available MCP Tools ===');
  const tools = await client.listTools();
  for (const tool of tools) {
    console.log(`  ${tool.name}: ${tool.description}`);
  }

  // Call a tool
  console.log('\n=== Tool Calls ===');
  const greetResult = await client.callTool(ctx, { name: 'greet', arguments: { name: 'Alice' } });
  console.log('greet:', JSON.stringify(greetResult));

  const addResult = await client.callTool(ctx, { name: 'add', arguments: { a: 17, b: 25 } });
  console.log('add:', JSON.stringify(addResult));

  // List and read resources
  console.log('\n=== Resources ===');
  const resources = await client.listResources();
  for (const res of resources) {
    console.log(`  ${res.uri}: ${res.name}`);
  }
  const versionResource = await client.readResource('config://app/version');
  console.log('Version:', JSON.stringify(versionResource));

  // Bridge MCP tools into weaveIntel ToolRegistry
  console.log('\n=== MCP → weaveIntel Bridge ===');
  const registry = weaveMCPTools(client, tools);
  const bridgedTools = registry.list();
  console.log(`Bridged ${bridgedTools.length} tools into ToolRegistry`);

  // Call a bridged tool via the weaveIntel Tool.invoke interface
  const bridgedResult = await registry.get('greet')!.invoke(ctx, { name: 'greet', arguments: { name: 'Bob' } });
  console.log('Bridged greet:', JSON.stringify(bridgedResult));

  await client.disconnect();
}

main().catch(console.error);
