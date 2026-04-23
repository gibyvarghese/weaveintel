import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MCPTransport } from '@weaveintel/core';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport as SDKTransport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  StreamableHTTPServerTransport,
  type StreamableHTTPServerTransportOptions,
} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

interface SDKBackedMCPTransport extends MCPTransport {
  __sdkTransport?: SDKTransport;
}

export interface MCPStreamableHttpServerTransport extends MCPTransport {
  handleRequest(req: IncomingMessage, res: ServerResponse, parsedBody?: unknown): Promise<void>;
}

function wrapSDKTransport(type: MCPTransport['type'], sdkTransport: SDKTransport): MCPTransport {
  let messageHandler: ((message: unknown) => void) | null = null;

  sdkTransport.onmessage = (message) => {
    messageHandler?.(message);
  };

  const wrapped = {
    type,
    async send(message: unknown): Promise<void> {
      await sdkTransport.send(message as JSONRPCMessage);
    },
    onMessage(handler: (message: unknown) => void): void {
      messageHandler = handler;
    },
    async close(): Promise<void> {
      await sdkTransport.close();
    },
  } as SDKBackedMCPTransport;

  wrapped.__sdkTransport = sdkTransport;
  return wrapped;
}

export function createMCPStdioServerTransport(): MCPTransport {
  const sdkTransport = new StdioServerTransport();
  return wrapSDKTransport('stdio', sdkTransport);
}

export function createMCPStreamableHttpServerTransport(
  options: StreamableHTTPServerTransportOptions = {},
): MCPStreamableHttpServerTransport {
  const sdkTransport = new StreamableHTTPServerTransport(options);
  const base = wrapSDKTransport('http', sdkTransport);

  return {
    ...base,
    async handleRequest(req: IncomingMessage, res: ServerResponse, parsedBody?: unknown): Promise<void> {
      await sdkTransport.handleRequest(req, res, parsedBody);
    },
  };
}
