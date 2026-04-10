/**
 * Example 05: MCP Client ↔ Server Integration
 *
 * Demonstrates creating an MCP server with tools and resources,
 * connecting an MCP client, and invoking tools via the MCP protocol.
 * Uses the fake in-memory transport pair for testing.
 */
import { createExecutionContext, createToolRegistry, defineTool } from '@weaveintel/core';
import { createMCPServer } from '@weaveintel/mcp-server';
import { createMCPClient, mcpToolsToRegistry } from '@weaveintel/mcp-client';
import { createFakeTransportPair } from '@weaveintel/testing';

async function main() {
  const ctx = createExecutionContext({ userId: 'demo-user' });

  // Create a transport pair (client ↔ server linked in memory)
  const { clientTransport, serverTransport } = createFakeTransportPair();

  // --- Server side ---
  const server = createMCPServer({
    name: 'demo-server',
    version: '1.0.0',
    transport: serverTransport,
  });

  server.addTool({
    name: 'greet',
    description: 'Greet someone by name',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    handler: async (args) => ({
      content: [{ type: 'text', text: `Hello, ${(args as { name: string }).name}! Welcome to WeaveIntel.` }],
    }),
  });

  server.addTool({
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
    handler: async (args) => {
      const { a, b } = args as { a: number; b: number };
      return { content: [{ type: 'text', text: String(a + b) }] };
    },
  });

  server.addResource({
    uri: 'config://app/version',
    name: 'App Version',
    description: 'Current application version',
    handler: async () => ({
      contents: [{ uri: 'config://app/version', text: '1.0.0-beta', mimeType: 'text/plain' }],
    }),
  });

  // Start the server
  await server.start();

  // --- Client side ---
  const client = await createMCPClient({
    transport: clientTransport,
    clientInfo: { name: 'demo-client', version: '1.0.0' },
  });

  // List available tools
  console.log('=== Available MCP Tools ===');
  const tools = await client.listTools();
  for (const tool of tools) {
    console.log(`  ${tool.name}: ${tool.description}`);
  }

  // Call a tool
  console.log('\n=== Tool Calls ===');
  const greetResult = await client.callTool('greet', { name: 'Alice' });
  console.log('greet:', greetResult);

  const addResult = await client.callTool('add', { a: 17, b: 25 });
  console.log('add:', addResult);

  // List and read resources
  console.log('\n=== Resources ===');
  const resources = await client.listResources();
  for (const res of resources) {
    console.log(`  ${res.uri}: ${res.name}`);
  }
  const versionResource = await client.readResource('config://app/version');
  console.log('Version:', versionResource);

  // Bridge MCP tools into WeaveIntel ToolRegistry
  console.log('\n=== MCP → WeaveIntel Bridge ===');
  const registry = await mcpToolsToRegistry(client);
  const bridgedTools = registry.list();
  console.log(`Bridged ${bridgedTools.length} tools into ToolRegistry`);

  // Call a bridged tool
  const bridgedResult = await registry.get('greet')!.execute({ name: 'Bob' }, ctx);
  console.log('Bridged greet:', bridgedResult);
}

main().catch(console.error);
