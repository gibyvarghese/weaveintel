import type {
  MCPServer,
  MCPServerConfig,
  MCPToolDefinition,
  MCPToolHandler,
  MCPResource,
  MCPResourceHandler,
  MCPResourceContent,
  MCPPrompt,
  MCPPromptHandler,
  MCPTransport,
  ExecutionContext,
} from '@weaveintel/core';
import { weaveContext } from '@weaveintel/core';
import { Server as SDKServer } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport as SDKTransport } from '@modelcontextprotocol/sdk/shared/transport.js';

class CoreTransportAdapter implements SDKTransport {
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

function toSDKTransport(transport: MCPTransport): SDKTransport {
  const candidate = transport as MCPTransport & { __sdkTransport?: SDKTransport };
  if (candidate.__sdkTransport) {
    return candidate.__sdkTransport;
  }
  return new CoreTransportAdapter(transport);
}

/**
 * Options for creating an MCP server.
 *
 * contextFactory — optional. Called for every tool/resource/prompt invocation
 * to build the ExecutionContext that flows into handler functions. Use this to
 * propagate caller identity (userId, tenantId), cancellation signal, and budget
 * from the transport layer.
 *
 * If omitted, a fresh anonymous context is created per call (legacy behaviour —
 * no identity, no tenant, no budget, no cancellation signal).
 */
export interface WeaveMCPServerOptions {
  /**
   * Factory that produces an ExecutionContext for each incoming request.
   * Receives the raw JSON-RPC params so the factory can extract caller
   * identity from an authentication header forwarded through params, etc.
   */
  contextFactory?: (params: Record<string, unknown>) => ExecutionContext;
}

export function weaveMCPServer(config: MCPServerConfig, options: WeaveMCPServerOptions = {}): MCPServer {
  const tools = new Map<string, { definition: MCPToolDefinition; handler: MCPToolHandler }>();
  const resources = new Map<string, { resource: MCPResource; handler: MCPResourceHandler }>();
  const prompts = new Map<string, { prompt: MCPPrompt; handler: MCPPromptHandler }>();
  let transport: MCPTransport | null = null;
  const sdkServer = new SDKServer(
    { name: config.name, version: config.version },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
      instructions: config.description,
    },
  );

  sdkServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...tools.values()].map((entry) => ({
      name: entry.definition.name,
      description: entry.definition.description,
      inputSchema: entry.definition.inputSchema,
    })),
  }));

  sdkServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    const tool = tools.get(name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Tool not found: ${name}` }],
        isError: true,
      };
    }

    const paramsRecord = request.params as unknown as Record<string, unknown>;
    const ctx = options.contextFactory
      ? options.contextFactory(paramsRecord)
      : weaveContext();

    const result = await tool.handler(ctx, args as Record<string, unknown>);
    return {
      content: result.content.map((content) => {
        if (content.type === 'resource') {
          return {
            type: 'resource' as const,
            resource: {
              uri: content.uri,
              text: content.text ?? '',
            },
          };
        }
        return content;
      }),
      isError: result.isError,
    };
  });

  sdkServer.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [...resources.values()].map((entry) => ({
      uri: entry.resource.uri,
      name: entry.resource.name,
      description: entry.resource.description,
      mimeType: entry.resource.mimeType,
    })),
  }));

  sdkServer.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const resource = resources.get(uri);
    if (!resource) {
      return {
        contents: [{ uri, text: `Resource not found: ${uri}` }],
      };
    }
    const content = await resource.handler(uri);
    return {
      contents: [{
        uri: content.uri,
        mimeType: content.mimeType,
        ...(content.text ? { text: content.text } : {}),
        ...(content.blob ? { blob: content.blob } : {}),
      }],
    };
  });

  sdkServer.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [...prompts.values()].map((entry) => ({
      name: entry.prompt.name,
      description: entry.prompt.description,
      arguments: entry.prompt.arguments,
    })),
  }));

  sdkServer.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    const prompt = prompts.get(name);
    if (!prompt) {
      return {
        messages: [{
          role: 'assistant' as const,
          content: { type: 'text' as const, text: `Prompt not found: ${name}` },
        }],
      };
    }

    const messages = await prompt.handler(args as Record<string, string>);
    return {
      messages: messages.map((message) => {
        if (message.content.type === 'resource') {
          return {
            role: message.role,
            content: {
              type: 'resource' as const,
              resource: {
                uri: message.content.uri,
                text: message.content.text ?? '',
              },
            },
          };
        }
        return message as unknown as {
          role: 'user' | 'assistant';
          content: { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
        };
      }),
    };
  });

  return {
    config,

    addTool(definition: MCPToolDefinition, handler: MCPToolHandler): void {
      tools.set(definition.name, { definition, handler });
      if (transport) {
        void sdkServer.sendToolListChanged();
      }
    },

    addResource(resource: MCPResource, handler: MCPResourceHandler): void {
      resources.set(resource.uri, { resource, handler });
      if (transport) {
        void sdkServer.sendResourceListChanged();
      }
    },

    addPrompt(prompt: MCPPrompt, handler: MCPPromptHandler): void {
      prompts.set(prompt.name, { prompt, handler });
      if (transport) {
        void sdkServer.sendPromptListChanged();
      }
    },

    async start(t: MCPTransport): Promise<void> {
      transport = t;
      await sdkServer.connect(toSDKTransport(t));
    },

    async stop(): Promise<void> {
      await sdkServer.close();
      if (transport) await transport.close();
      transport = null;
    },
  };
}
