import type { MCPTransport } from '@weaveintel/core';
import { Client as SDKClient } from '@modelcontextprotocol/sdk/client/index.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport as SDKTransport } from '@modelcontextprotocol/sdk/shared/transport.js';

export class CoreTransportAdapter implements SDKTransport {
  public onclose?: () => void;
  public onerror?: (error: Error) => void;
  public onmessage?: <T extends JSONRPCMessage>(message: T) => void;

  public constructor(private readonly transport: MCPTransport) {}

  public async start(): Promise<void> {
    this.transport.onMessage((message) => {
      this.onmessage?.(message as JSONRPCMessage);
    });
  }

  public async send(message: JSONRPCMessage): Promise<void> {
    try {
      await this.transport.send(message);
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  public async close(): Promise<void> {
    await this.transport.close();
    this.onclose?.();
  }
}

export function toSDKTransport(transport: MCPTransport): SDKTransport {
  const candidate = transport as MCPTransport & { __sdkTransport?: SDKTransport };
  if (candidate.__sdkTransport) {
    return candidate.__sdkTransport;
  }
  return new CoreTransportAdapter(transport);
}

