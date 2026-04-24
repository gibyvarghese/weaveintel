/**
 * @weaveintel/testing — Real HTTP-based MCP transport
 *
 * Optional helper for creating real HTTP MCP servers in tests and examples.
 * This is separate from the main testing package to avoid circular dependencies
 * and optional dependency issues.
 *
 * Usage:
 *   import { weaveRealMCPTransport } from '@weaveintel/testing/mcp-transport';
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  createMCPStreamableHttpServerTransport,
  weaveMCPServer,
} from '@weaveintel/mcp-server';
import type { MCPServer } from '@weaveintel/core';

export interface RealMCPTransportOptions {
  /** Port to run the HTTP server on. If 0 or undefined, picks a random available port. */
  port?: number;
  /** Hostname to bind to. Defaults to 127.0.0.1 */
  hostname?: string;
}

export interface RealMCPTransportServer {
  /** The MCP server instance for adding tools and resources */
  server: MCPServer;
  /** HTTP endpoint URL for connecting with weaveMCPClient */
  endpoint: string;
  /** Close the HTTP server and cleanup */
  close(): Promise<void>;
}

/**
 * Creates a real HTTP-based MCP server for testing and examples.
 *
 * Unlike weaveFakeTransport() which is in-process and doesn't execute real tools,
 * this creates an actual HTTP server that runs tools and resources using the
 * MCP protocol.
 *
 * @example
 * ```ts
 * const { server, endpoint, close } = await weaveRealMCPTransport();
 *
 * // Add tools to the server
 * server.addTool({
 *   name: 'greet',
 *   description: 'Greet someone',
 *   inputSchema: {
 *     type: 'object',
 *     properties: { name: { type: 'string' } },
 *     required: ['name'],
 *   },
 * }, async (_ctx, args) => ({
 *   content: [{ type: 'text', text: `Hello, ${(args as { name: string }).name}!` }],
 * }));
 *
 * // Connect with MCP client
 * const client = weaveMCPClient();
 * const clientTransport = createMCPStreamableHttpTransport(endpoint);
 * await client.connect(clientTransport);
 *
 * // Clean up when done
 * await close();
 * ```
 */
export async function weaveRealMCPTransport(
  options: RealMCPTransportOptions = {},
): Promise<RealMCPTransportServer> {
  const hostname = options.hostname ?? '127.0.0.1';
  const port = options.port ?? 0;

  let resolvedPort = 0;
  let actualEndpoint = '';

  const mcpServer: MCPServer = weaveMCPServer({ name: 'real-mcp-fixture', version: '1.0.0' });
  const serverTransport = createMCPStreamableHttpServerTransport();
  await mcpServer.start(serverTransport);

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Route to /mcp endpoint
    if (!req.url || !req.url.startsWith('/mcp')) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }

    try {
      // Parse request body
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

      // Handle the HTTP request
      await serverTransport.handleRequest(req, res, parsedBody);
    } catch (error) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(error) }));
      }
    }
  });

  // Start HTTP server
  await new Promise<void>((resolve, reject) => {
    httpServer.listen(port, hostname, () => {
      const addr = httpServer.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to get server address'));
        return;
      }
      resolvedPort = addr.port;
      actualEndpoint = `http://${hostname}:${resolvedPort}/mcp`;
      resolve();
    });
    httpServer.on('error', reject);
  });

  return {
    server: mcpServer,
    endpoint: actualEndpoint,
    async close(): Promise<void> {
      await mcpServer.stop();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}
