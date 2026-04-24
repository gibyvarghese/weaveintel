/**
 * @weaveintel/mcp-server — Real HTTP-based MCP transport
 *
 * Helper for creating a real HTTP MCP server for examples, E2E tests,
 * and any scenario that requires actual network-level MCP communication.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type {
  MCPContent,
  MCPPrompt,
  MCPPromptHandler,
  MCPResource,
  MCPResourceHandler,
  MCPServer,
  MCPServerConfig,
  MCPToolDefinition,
  MCPToolHandler,
} from '@weaveintel/core';
import { createMCPStreamableHttpServerTransport } from './transports.js';
import { weaveMCPServer } from './server.js';

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

type ToolEntry = { definition: MCPToolDefinition; handler: MCPToolHandler };
type ResourceEntry = { resource: MCPResource; handler: MCPResourceHandler };
type PromptEntry = { prompt: MCPPrompt; handler: MCPPromptHandler };

/**
 * Creates a real HTTP-based MCP server.
 *
 * Uses a stateless-compatible Streamable HTTP request handling model so clients
 * can connect without sticky session affinity.
 */
export async function weaveRealMCPTransport(
  options: RealMCPTransportOptions = {},
): Promise<RealMCPTransportServer> {
  const hostname = options.hostname ?? '127.0.0.1';
  const port = options.port ?? 0;

  const config: MCPServerConfig = { name: 'real-mcp-server', version: '1.0.0' };
  const tools = new Map<string, ToolEntry>();
  const resources = new Map<string, ResourceEntry>();
  const prompts = new Map<string, PromptEntry>();

  const activeDisposers = new Set<() => Promise<void>>();
  let closing = false;
  let resolvedPort = 0;
  let actualEndpoint = '';

  const logicalServer: MCPServer = {
    config,
    addTool(definition, handler) {
      tools.set(definition.name, { definition, handler });
    },
    addResource(resource, handler) {
      resources.set(resource.uri, { resource, handler });
    },
    addPrompt(prompt, handler) {
      prompts.set(prompt.name, { prompt, handler });
    },
    // The HTTP fixture owns lifecycle; these are no-ops for compatibility.
    async start() {},
    async stop() {},
  };

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (closing) {
      res.statusCode = 503;
      res.end('Server shutting down');
      return;
    }

    if (!req.url || !req.url.startsWith('/mcp')) {
      res.statusCode = 404;
      res.end('Not found');
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

    const requestServer = weaveMCPServer(config);
    for (const entry of tools.values()) {
      requestServer.addTool(entry.definition, entry.handler);
    }
    for (const entry of resources.values()) {
      requestServer.addResource(entry.resource, entry.handler);
    }
    for (const entry of prompts.values()) {
      requestServer.addPrompt(entry.prompt, entry.handler);
    }

    const transport = createMCPStreamableHttpServerTransport({
      sessionIdGenerator: undefined,
    });

    await requestServer.start(transport);

    const dispose = async () => {
      try {
        await requestServer.stop();
      } catch {
        // best effort
      }
      try {
        await transport.close();
      } catch {
        // best effort
      }
    };
    activeDisposers.add(dispose);

    res.on('close', () => {
      activeDisposers.delete(dispose);
      void dispose();
    });

    try {
      await transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        const msg = error instanceof Error ? error.message : String(error);
        res.end(JSON.stringify({ error: msg }));
      }
    }
  });

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
    server: logicalServer,
    endpoint: actualEndpoint,
    async close(): Promise<void> {
      closing = true;
      const disposers = [...activeDisposers];
      activeDisposers.clear();
      await Promise.all(disposers.map(async (dispose) => {
        await dispose();
      }));

      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}
