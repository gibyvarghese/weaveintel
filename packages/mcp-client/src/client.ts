/**
 * @weaveintel/mcp-client — MCP client implementation
 *
 * Connects to MCP servers via any transport (stdio, HTTP, WebSocket).
 * Discovers tools, resources, and prompts, then exposes them through
 * the weaveIntel Tool interface for seamless agent integration.
 */

import type {
  MCPClient,
  MCPTransport,
  MCPToolDefinition,
  MCPToolCallRequest,
  MCPToolCallResponse,
  MCPResource,
  MCPResourceContent,
  MCPPrompt,
  MCPPromptMessage,
  Tool,
  ToolRegistry,
  ExecutionContext,
} from '@weaveintel/core';
import { weaveToolRegistry } from '@weaveintel/core';

// ─── JSON-RPC message types ──────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ─── MCP client ──────────────────────────────────────────────

export function weaveMCPClient(): MCPClient {
  let transport: MCPTransport | null = null;
  let nextId = 1;
  const pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();

  function send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!transport) throw new Error('MCP client not connected');

    const id = nextId++;
    const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

    return new Promise((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject });
      transport!.send(request).catch(reject);
    });
  }

  return {
    async connect(t: MCPTransport): Promise<void> {
      transport = t;
      t.onMessage((msg) => {
        const response = msg as JsonRpcResponse;
        if (response.id != null && pendingRequests.has(response.id)) {
          const pending = pendingRequests.get(response.id)!;
          pendingRequests.delete(response.id);
          if (response.error) {
            pending.reject(new Error(`MCP error: ${response.error.message}`));
          } else {
            pending.resolve(response.result);
          }
        }
      });

      // Initialize handshake
      await send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'weaveintel-mcp-client', version: '0.0.1' },
      });

      // Send initialized notification (no id, no response expected)
      await transport!.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    },

    async listTools(): Promise<MCPToolDefinition[]> {
      const result = await send('tools/list') as { tools: MCPToolDefinition[] };
      return result.tools ?? [];
    },

    async callTool(_ctx: ExecutionContext, request: MCPToolCallRequest): Promise<MCPToolCallResponse> {
      const result = await send('tools/call', {
        name: request.name,
        arguments: request.arguments,
      }) as MCPToolCallResponse;
      return result;
    },

    async listResources(): Promise<MCPResource[]> {
      const result = await send('resources/list') as { resources: MCPResource[] };
      return result.resources ?? [];
    },

    async readResource(uri: string): Promise<MCPResourceContent> {
      const result = await send('resources/read', { uri }) as { contents: MCPResourceContent[] };
      return result.contents[0]!;
    },

    async listPrompts(): Promise<MCPPrompt[]> {
      const result = await send('prompts/list') as { prompts: MCPPrompt[] };
      return result.prompts ?? [];
    },

    async getPrompt(name: string, args?: Record<string, string>): Promise<MCPPromptMessage[]> {
      const result = await send('prompts/get', { name, arguments: args }) as { messages: MCPPromptMessage[] };
      return result.messages ?? [];
    },

    async disconnect(): Promise<void> {
      if (transport) {
        await transport.close();
        transport = null;
      }
    },
  };
}

// ─── Bridge: MCP tools → weaveIntel tools ────────────────────

export function weaveMCPTools(
  client: MCPClient,
  tools: MCPToolDefinition[],
): ToolRegistry {
  const registry = weaveToolRegistry();

  for (const toolDef of tools) {
    const tool: Tool = {
      schema: {
        name: toolDef.name,
        description: toolDef.description,
        parameters: toolDef.inputSchema,
        tags: ['mcp'],
      },
      async invoke(ctx, input) {
        const response = await client.callTool(ctx, {
          name: input.name,
          arguments: input.arguments,
        });
        const text = response.content
          .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
          .map((c) => c.text)
          .join('\n');
        return { content: text || JSON.stringify(response.content), isError: response.isError };
      },
    };
    registry.register(tool);
  }

  return registry;
}
