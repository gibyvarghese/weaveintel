import type { MCPTransport } from '@weaveintel/core';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport as SDKTransport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPClientTransportOptions,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  StdioClientTransport,
  type StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js';

interface SDKBackedMCPTransport extends MCPTransport {
  __sdkTransport?: SDKTransport;
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

export interface MCPStreamableHttpTransportOptions {
  /**
   * Optional static request init merged into every request sent by the transport.
   */
  requestInit?: RequestInit;
  /**
   * Optional fetch implementation override.
   */
  fetch?: typeof fetch;
  /**
   * Optional async headers callback used for dynamic auth token injection.
   */
  getHeaders?: () => Promise<Record<string, string>>;
  /**
   * Optional explicit session ID. Omit for stateless-compatible behavior.
   */
  sessionId?: string;
}

export function createMCPStreamableHttpTransport(
  endpoint: string,
  options: MCPStreamableHttpTransportOptions = {},
): MCPTransport {
  const baseInit = options.requestInit;

  const fetchWithDynamicHeaders: typeof fetch = async (url, init) => {
    const dynamicHeaders = options.getHeaders ? await options.getHeaders() : {};
    const mergedHeaders: HeadersInit = {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      ...(baseInit?.headers ?? {}),
      ...(init?.headers ?? {}),
      ...dynamicHeaders,
    };

    const mergedInit: RequestInit = {
      ...(baseInit ?? {}),
      ...(init ?? {}),
      headers: mergedHeaders,
    };

    const effectiveFetch = options.fetch ?? fetch;
    return effectiveFetch(url, mergedInit);
  };

  const sdkOptions: StreamableHTTPClientTransportOptions = {
    requestInit: baseInit,
    fetch: fetchWithDynamicHeaders,
    sessionId: options.sessionId,
  };

  const sdkTransport = new StreamableHTTPClientTransport(new URL(endpoint), sdkOptions);
  return wrapSDKTransport('http', sdkTransport);
}

export function createMCPStdioClientTransport(params: StdioServerParameters): MCPTransport {
  const sdkTransport = new StdioClientTransport(params);
  return wrapSDKTransport('stdio', sdkTransport);
}
