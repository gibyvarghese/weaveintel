/**
 * Example 05: MCP Client ↔ Server Integration
 *
 * Demonstrates creating an MCP server with tools and resources,
 * connecting an MCP client, and invoking tools via the MCP protocol.
 * Uses the fake in-memory transport pair for testing.
 *
 * WeaveIntel packages used:
 *   @weaveintel/core       — ExecutionContext (passed through MCP tool calls)
 *   @weaveintel/mcp-server — weaveMCPServer() creates an MCP-protocol server that
 *                            exposes tools and resources over any Transport
 *   @weaveintel/mcp-client — weaveMCPClient() connects to an MCP server;
 *                            weaveMCPTools() bridges MCP tools into a weaveIntel ToolRegistry
 *   @weaveintel/testing    — weaveFakeTransport() creates a linked client↔server
 *                            in-memory transport pair for testing without a network
 *
 * MCP (Model Context Protocol) is an open standard for connecting AI models
 * to external data sources and tools. WeaveIntel's MCP packages let you both
 * serve and consume MCP-compliant endpoints.
 */
import { weaveContext } from '@weaveintel/core';
import { weaveMCPServer } from '@weaveintel/mcp-server';
import { weaveMCPClient, weaveMCPTools } from '@weaveintel/mcp-client';
import { weaveFakeTransport } from '@weaveintel/testing';

async function main() {
  const ctx = weaveContext({ userId: 'demo-user' });

  // weaveFakeTransport() returns a { client, server } pair where writes to
  // one side are readable from the other. This lets you test MCP client↔server
  // interactions in-process without network sockets or stdio pipes.
  const { client: clientTransport, server: serverTransport } = weaveFakeTransport();

  // --- Server side ---
  // weaveMCPServer() creates an MCP-compliant server. You give it a name and
  // version, then register tools (functions the client can call) and resources
  // (data the client can read). The server speaks the MCP JSON-RPC protocol.
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

  // server.addResource() exposes read-only data via MCP's resource protocol.
  // Resources have a URI and can return text, JSON, or binary content.
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

  // Start the server — it begins listening for MCP JSON-RPC requests
  // on the given transport. For production, you'd use StdioTransport or
  // SSETransport instead of the fake in-memory transport.
  await server.start(serverTransport);

  // --- Client side ---
  // weaveMCPClient() creates an MCP client that can connect to any
  // MCP-compliant server. It supports listTools, callTool, listResources,
  // readResource — the standard MCP client operations.
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

  // weaveMCPTools() is the key bridge: it takes MCP tool descriptors and wraps
  // them into a weaveIntel ToolRegistry so they can be used by weaveAgent(),
  // weaveSupervisor(), or any component that accepts a ToolRegistry.
  // This means an agent can seamlessly call tools from both local registries
  // and remote MCP servers in the same run.
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
