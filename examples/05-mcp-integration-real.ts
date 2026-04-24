/**
 * Example 05: MCP Client ↔ Server Integration (Real HTTP Transport)
 *
 * Demonstrates creating a real HTTP-based MCP server with tools and resources,
 * connecting an MCP client, and invoking tools via the MCP protocol.
 * Uses weaveRealMCPTransport() for actual network communication instead of
 * the in-process fake transport.
 *
 * WeaveIntel packages used:
 *   @weaveintel/core          — ExecutionContext + weaveSetDefaultTracer for runtime tracing
 *   @weaveintel/mcp-server    — weaveMCPServer() creates an MCP-protocol server
 *   @weaveintel/mcp-client    — weaveMCPClient() connects to an MCP server;
 *                              weaveMCPTools() bridges MCP tools into weaveIntel
 *   @weaveintel/mcp-server    — weaveRealMCPTransport() creates an HTTP-based MCP server
 *   @weaveintel/observability — weaveConsoleTracer() for default tracing across MCP calls
 */
import { weaveContext, weaveSetDefaultTracer } from '@weaveintel/core';
import { weaveMCPClient, weaveMCPTools } from '@weaveintel/mcp-client';
import { createMCPStreamableHttpTransport } from '@weaveintel/mcp-client';
import { weaveRealMCPTransport } from '@weaveintel/mcp-server';
import { weaveConsoleTracer } from '@weaveintel/observability';

async function main() {
  weaveSetDefaultTracer(weaveConsoleTracer());

  const ctx = weaveContext({ userId: 'demo-user' });

  // weaveRealMCPTransport() creates a real HTTP-based MCP server and returns
  // the server instance, endpoint URL, and cleanup function.
  console.log('Starting real HTTP MCP server...');
  const { server, endpoint, close } = await weaveRealMCPTransport();
  console.log(`Server running at ${endpoint}\n`);

  try {
    // --- Server side ---
    // Add tools to the server
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

    // Add a resource
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

    console.log('Server tools registered and ready!\n');

    // --- Client side ---
    // Create an MCP client and connect via HTTP to the server
    const client = weaveMCPClient();
    const clientTransport = createMCPStreamableHttpTransport(endpoint);
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
  } finally {
    // Clean up the HTTP server
    await close();
    console.log('\nServer closed');
  }
}

main().catch(console.error);
