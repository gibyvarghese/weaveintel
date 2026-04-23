import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { weaveContext } from '@weaveintel/core';
import {
  createMCPStreamableHttpServerTransport,
  weaveMCPServer,
} from '@weaveintel/mcp-server';
import { weaveMCPClient } from './client.js';
import { createMCPStreamableHttpTransport } from './transports.js';

interface RunningFixture {
  close(): Promise<void>;
  endpoint: string;
}

function createServerInstance() {
  const server = weaveMCPServer({ name: 'streamable-http-fixture', version: '1.0.0' });
  server.addTool(
    {
      name: 'ping',
      description: 'Ping tool',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    async () => ({
      content: [{ type: 'text', text: 'pong' }],
    }),
  );
  return server;
}

async function createFixture(): Promise<RunningFixture> {
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!req.url || !req.url.startsWith('/mcp')) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    let parsedBody: unknown = undefined;
    if (req.method === 'POST') {
      let rawBody = '';
      for await (const chunk of req) {
        rawBody += chunk.toString();
      }
      if (rawBody.trim().length > 0) {
        parsedBody = JSON.parse(rawBody);
      }
    }

    const server = createServerInstance();
    const transport = createMCPStreamableHttpServerTransport({
      sessionIdGenerator: undefined,
    });

    await server.start(transport);
    await transport.handleRequest(req, res, parsedBody);

    res.on('close', () => {
      void server.stop();
      void transport.close();
    });
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });

  const address = httpServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind streamable HTTP test server');
  }

  return {
    endpoint: `http://127.0.0.1:${address.port}/mcp`,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

describe('weaveMCPClient Streamable HTTP transport', () => {
  const fixtures: RunningFixture[] = [];

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) await fixture.close();
    }
  });

  it('connects and executes tool calls against stateless-compatible streamable HTTP server', async () => {
    const fixture = await createFixture();
    fixtures.push(fixture);

    const client = weaveMCPClient();
    const transport = createMCPStreamableHttpTransport(fixture.endpoint);

    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.some((tool) => tool.name === 'ping')).toBe(true);

    const result = await client.callTool(weaveContext({ tenantId: 'tenant', userId: 'user' }), {
      name: 'ping',
      arguments: {},
    });
    expect(result.content[0]).toEqual({ type: 'text', text: 'pong' });

    await client.disconnect();
  });
});
