/**
 * Example 65 — Stateless-compatible Streamable HTTP MCP server + client
 *
 * This example demonstrates the new default transport model:
 * - server uses official SDK Streamable HTTP transport in stateless mode
 * - client uses createMCPStreamableHttpTransport() from @weaveintel/mcp-client
 */

import { createServer } from 'node:http';
import { weaveContext } from '@weaveintel/core';
import { weaveMCPClient, createMCPStreamableHttpTransport } from '@weaveintel/mcp-client';
import {
  createMCPStreamableHttpServerTransport,
  weaveMCPServer,
} from '@weaveintel/mcp-server';

function createServerInstance() {
  const mcpServer = weaveMCPServer({
    name: 'stateless-streamable-example',
    version: '1.0.0',
  });

  mcpServer.addTool(
    {
      name: 'echo',
      description: 'Echoes text',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
        },
        required: ['text'],
      },
    },
    async (_ctx, args) => ({
      content: [{ type: 'text', text: `echo:${String(args.text ?? '')}` }],
    }),
  );

  return mcpServer;
}

async function main(): Promise<void> {
  const httpServer = createServer(async (req, res) => {
    if (!req.url || !req.url.startsWith('/mcp')) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    let parsedBody: unknown = undefined;
    if (req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk.toString();
      if (raw.trim().length > 0) parsedBody = JSON.parse(raw);
    }

    const mcpServer = createServerInstance();
    const httpTransport = createMCPStreamableHttpServerTransport({
      // undefined session generator keeps this transport stateless-compatible.
      sessionIdGenerator: undefined,
    });

    await mcpServer.start(httpTransport);
    await httpTransport.handleRequest(req, res, parsedBody);

    res.on('close', () => {
      void mcpServer.stop();
      void httpTransport.close();
    });
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });

  const address = httpServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind HTTP server');
  }
  const endpoint = `http://127.0.0.1:${address.port}/mcp`;

  const client = weaveMCPClient();
  await client.connect(createMCPStreamableHttpTransport(endpoint));

  const tools = await client.listTools();
  console.log('tools:', tools.map((tool) => tool.name));

  const result = await client.callTool(weaveContext({ tenantId: 'demo', userId: 'demo' }), {
    name: 'echo',
    arguments: { text: 'hello-stateless' },
  });
  console.log('result:', result);

  await client.disconnect();
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
