/**
 * @weaveintel/mcp-server — MCP server implementation
 *
 * Exposes tools, resources, and prompts via JSON-RPC over any transport.
 * Register handlers, then start with a transport adapter.
 */

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
  MCPPromptMessage,
  MCPToolCallResponse,
  MCPTransport,
  ExecutionContext,
} from '@weaveintel/core';
import { weaveContext } from '@weaveintel/core';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
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

  async function handleRequest(msg: unknown): Promise<void> {
    const request = msg as JsonRpcRequest;
    if (!request.method) return;

    // Ignore notifications (no id)
    if (request.id == null && request.method.startsWith('notifications/')) return;

    let result: unknown;
    let error: JsonRpcResponse['error'];

    try {
      switch (request.method) {
        case 'initialize':
          result = {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: tools.size > 0 ? {} : undefined,
              resources: resources.size > 0 ? {} : undefined,
              prompts: prompts.size > 0 ? {} : undefined,
            },
            serverInfo: { name: config.name, version: config.version },
          };
          break;

        case 'tools/list':
          result = { tools: [...tools.values()].map((t) => t.definition) };
          break;

        case 'tools/call': {
          const name = request.params?.['name'] as string;
          const args = (request.params?.['arguments'] ?? {}) as Record<string, unknown>;
          const tool = tools.get(name);
          if (!tool) {
            error = { code: -32602, message: `Tool not found: ${name}` };
          } else {
            // Use the caller-supplied context factory so identity, tenant,
            // budget, and cancellation signal flow into the handler.
            // Fall back to a fresh anonymous context when no factory is provided.
            const params = request.params ?? {};
            const ctx = options.contextFactory
              ? options.contextFactory(params)
              : weaveContext();
            result = await tool.handler(ctx, args);
          }
          break;
        }

        case 'resources/list':
          result = { resources: [...resources.values()].map((r) => r.resource) };
          break;

        case 'resources/read': {
          const uri = request.params?.['uri'] as string;
          const res = resources.get(uri);
          if (!res) {
            error = { code: -32602, message: `Resource not found: ${uri}` };
          } else {
            const content = await res.handler(uri);
            result = { contents: [content] };
          }
          break;
        }

        case 'prompts/list':
          result = { prompts: [...prompts.values()].map((p) => p.prompt) };
          break;

        case 'prompts/get': {
          const promptName = request.params?.['name'] as string;
          const promptArgs = (request.params?.['arguments'] ?? {}) as Record<string, string>;
          const p = prompts.get(promptName);
          if (!p) {
            error = { code: -32602, message: `Prompt not found: ${promptName}` };
          } else {
            const messages = await p.handler(promptArgs);
            result = { messages };
          }
          break;
        }

        default:
          error = { code: -32601, message: `Method not found: ${request.method}` };
      }
    } catch (err) {
      error = { code: -32603, message: err instanceof Error ? err.message : String(err) };
    }

    if (request.id != null) {
      const response: JsonRpcResponse = { jsonrpc: '2.0', id: request.id };
      if (error) response.error = error;
      else response.result = result;
      await transport?.send(response);
    }
  }

  return {
    config,

    addTool(definition: MCPToolDefinition, handler: MCPToolHandler): void {
      tools.set(definition.name, { definition, handler });
    },

    addResource(resource: MCPResource, handler: MCPResourceHandler): void {
      resources.set(resource.uri, { resource, handler });
    },

    addPrompt(prompt: MCPPrompt, handler: MCPPromptHandler): void {
      prompts.set(prompt.name, { prompt, handler });
    },

    async start(t: MCPTransport): Promise<void> {
      transport = t;
      t.onMessage(handleRequest);
    },

    async stop(): Promise<void> {
      if (transport) {
        await transport.close();
        transport = null;
      }
    },
  };
}
