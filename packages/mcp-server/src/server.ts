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
  ErrorCode,
  McpError,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
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
 * What the transport knows about an incoming request. This is the only input a
 * `contextFactory` gets: facts the transport established, never the caller's own
 * JSON-RPC params (a caller could put any identity there).
 */
export interface MCPRequestInfo {
  /** The JSON-RPC method, e.g. `tools/call`. */
  readonly method: string;
  /** The JSON-RPC id of the request. */
  readonly requestId: string | number;
  /**
   * Auth the transport verified before the message reached the server. On HTTP this is
   * whatever the host's middleware put on `req.auth` after checking the bearer (for
   * geniWeave: a verified guardWeave note plus proof). Absent on stdio.
   */
  readonly authInfo?: AuthInfo;
  /** The transport session id, when the transport has sessions. */
  readonly sessionId?: string;
  /** HTTP request headers, when the transport is HTTP. */
  readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
  /** Fires when the caller cancels the request. */
  readonly signal: AbortSignal;
}

/**
 * Builds the `ExecutionContext` for one request from what the transport verified.
 * Throw (or reject) to refuse the caller: the request then fails with a generic
 * "unauthenticated" error and no handler runs.
 */
export type MCPContextFactory = (request: MCPRequestInfo) => ExecutionContext | Promise<ExecutionContext>;

/** Options for creating an MCP server. */
export interface WeaveMCPServerOptions {
  /**
   * Required. Called for every request (listing and calls) to authenticate the caller and
   * build the `ExecutionContext` that flows into tool handlers. There is no anonymous
   * default (GAPS G-WI-10). An in-process or stdio server whose transport is itself the
   * trust boundary can pass `inProcessMCPContext` to say so explicitly.
   */
  contextFactory: MCPContextFactory;
}

/** Thrown when an MCP server is built without a way to identify its callers. */
export class MCPServerConfigError extends Error {
  public override readonly name = 'MCPServerConfigError';
}

/**
 * A `contextFactory` for servers that only ever talk to their own process (stdio or an
 * in-memory pair), where whoever can reach the transport already is the operator. It gives
 * each call a fresh context with the request's cancellation signal and no user or tenant.
 * Never use it on a network transport.
 */
export const inProcessMCPContext: MCPContextFactory = (request) => weaveContext({ signal: request.signal });

const CALLER_ASSERTED = Symbol.for('weaveintel.mcp.callerAssertedContext');

/**
 * A `contextFactory` that builds the context from the caller's own `_meta.executionContext`
 * (what `weaveMCPClient` forwards). It believes whatever the caller claims, so it is only
 * for an in-process client in the same trust domain, such as the built-in connector servers
 * driven by a local agent. The server refuses to start with it on any transport other than
 * `stdio`, so it can never answer a network caller.
 */
export const callerAssertedMCPContext: MCPContextFactory = Object.assign(
  () => weaveContext(),
  { [CALLER_ASSERTED]: true as const },
);

function isCallerAsserted(factory: MCPContextFactory): boolean {
  return (factory as unknown as Record<symbol, unknown>)[CALLER_ASSERTED] === true;
}

const UNAUTHENTICATED = 'Unauthenticated: the MCP caller could not be identified';

export function weaveMCPServer(config: MCPServerConfig, options: WeaveMCPServerOptions): MCPServer {
  if (!options || typeof options.contextFactory !== 'function') {
    throw new MCPServerConfigError(
      `MCP server '${config?.name ?? ''}' needs a contextFactory: an MCP caller has no identity by default`,
    );
  }
  const contextFactory = options.contextFactory;
  const callerAsserted = isCallerAsserted(contextFactory);

  /**
   * Authenticates one request through the factory. Any failure becomes the same generic
   * error, so the caller never learns why it was refused.
   */
  async function authenticate(
    method: string,
    extra: { signal: AbortSignal; requestId: string | number; authInfo?: AuthInfo; sessionId?: string; requestInfo?: { headers?: unknown }; _meta?: unknown },
  ): Promise<ExecutionContext> {
    try {
      const headers = extra.requestInfo?.headers as MCPRequestInfo['headers'] | undefined;
      const ctx = await contextFactory({
        method,
        requestId: extra.requestId,
        signal: extra.signal,
        ...(extra.authInfo ? { authInfo: extra.authInfo } : {}),
        ...(extra.sessionId ? { sessionId: extra.sessionId } : {}),
        ...(headers ? { headers } : {}),
      });
      if (!ctx) throw new Error('contextFactory returned no context');
      if (callerAsserted) {
        const asserted = (extra._meta as { executionContext?: Partial<ExecutionContext> } | undefined)?.executionContext;
        return weaveContext({ ...(asserted ?? {}), signal: extra.signal });
      }
      return ctx;
    } catch {
      throw new McpError(ErrorCode.InvalidRequest, UNAUTHENTICATED);
    }
  }

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

  sdkServer.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    await authenticate('tools/list', extra);
    return {
    tools: [...tools.values()].map((entry) => ({
      name: entry.definition.name,
      description: entry.definition.description,
      inputSchema: entry.definition.inputSchema,
    })),
    };
  });

  sdkServer.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    // Authenticate before anything else, so an unknown caller cannot probe tool names.
    const ctx = await authenticate('tools/call', extra);
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    const tool = tools.get(name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Tool not found: ${name}` }],
        isError: true,
      };
    }

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

  sdkServer.setRequestHandler(ListResourcesRequestSchema, async (_request, extra) => {
    await authenticate('resources/list', extra);
    return {
    resources: [...resources.values()].map((entry) => ({
      uri: entry.resource.uri,
      name: entry.resource.name,
      description: entry.resource.description,
      mimeType: entry.resource.mimeType,
    })),
    };
  });

  sdkServer.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
    await authenticate('resources/read', extra);
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

  sdkServer.setRequestHandler(ListPromptsRequestSchema, async (_request, extra) => {
    await authenticate('prompts/list', extra);
    return {
    prompts: [...prompts.values()].map((entry) => ({
      name: entry.prompt.name,
      description: entry.prompt.description,
      arguments: entry.prompt.arguments,
    })),
    };
  });

  sdkServer.setRequestHandler(GetPromptRequestSchema, async (request, extra) => {
    await authenticate('prompts/get', extra);
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
      if (callerAsserted && t.type !== 'stdio') {
        throw new MCPServerConfigError(
          `MCP server '${config.name}' trusts caller-asserted context and may only run on a stdio transport, not '${t.type}'`,
        );
      }
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
