import type {
  MCPClient,
  MCPTransport,
  MCPToolDefinition,
  MCPToolCallRequest,
  MCPToolCallResponse,
  MCPStreamEvent,
  MCPToolCallStreamOptions,
  MCPCapabilityDiscoveryPage,
  MCPCapabilityDiscoveryQuery,
  MCPCapabilitySummary,
  MCPComposableCallPlan,
  MCPComposableCallResult,
  MCPComposableStepResult,
  MCPResource,
  MCPResourceContent,
  MCPPrompt,
  MCPPromptMessage,
  Tool,
  ToolRegistry,
  ExecutionContext,
  JsonSchema,
} from '@weaveintel/core';
import { weaveToolRegistry } from '@weaveintel/core';
import { Client as SDKClient } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Transport as SDKTransport } from '@modelcontextprotocol/sdk/shared/transport.js';

const DEFAULT_PAGE_LIMIT = 100;

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

function toExecutionContextMeta(ctx: ExecutionContext): Record<string, unknown> {
  return {
    executionId: ctx.executionId,
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    parentSpanId: ctx.parentSpanId,
    deadline: ctx.deadline,
    budget: ctx.budget,
    metadata: ctx.metadata,
  };
}

function normalizeMCPContent(content: unknown): MCPToolCallResponse['content'] {
  if (!Array.isArray(content)) return [];

  return content.flatMap<MCPToolCallResponse['content'][number]>((item) => {
    const value = item as Record<string, unknown>;
    const type = String(value['type'] ?? '');
    if (type === 'text') {
      return [{ type: 'text', text: String(value['text'] ?? '') }];
    }
    if (type === 'image') {
      return [{ type: 'image', data: String(value['data'] ?? ''), mimeType: String(value['mimeType'] ?? '') }];
    }
    if (type === 'resource') {
      const resource = (value['resource'] ?? {}) as Record<string, unknown>;
      return [{
        type: 'resource',
        uri: String(resource['uri'] ?? ''),
        text: typeof resource['text'] === 'string' ? resource['text'] : undefined,
      }];
    }
    if (type === 'resource_link') {
      return [{
        type: 'resource',
        uri: String(value['uri'] ?? ''),
        text: typeof value['name'] === 'string' ? value['name'] : undefined,
      }];
    }
    if (type === 'audio') {
      return [{ type: 'text', text: `[audio:${String(value['mimeType'] ?? 'unknown')}]` }];
    }
    return [{ type: 'text', text: JSON.stringify(value) }];
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parsePathValue(root: unknown, dottedPath?: string): unknown {
  if (!dottedPath) return root;
  const segments = dottedPath.split('.').filter(Boolean);
  let current: unknown = root;
  for (const segment of segments) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function applyMergedInput(
  baseArgs: Record<string, unknown> | undefined,
  mergeKey: string | undefined,
  mergedInput: unknown,
): Record<string, unknown> {
  const args = { ...(baseArgs ?? {}) };
  if (mergeKey) {
    args[mergeKey] = mergedInput;
  }
  return args;
}

async function gatherAllTools(client: SDKClient): Promise<MCPToolDefinition[]> {
  const output: MCPToolDefinition[] = [];
  let cursor: string | undefined;
  do {
    const result = await client.listTools(cursor ? { cursor } : undefined);
    output.push(
      ...(result.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description ?? tool.title ?? '',
        inputSchema: tool.inputSchema as JsonSchema,
      })),
    );
    cursor = result.nextCursor;
  } while (cursor);
  return output;
}

async function gatherAllResources(client: SDKClient): Promise<MCPResource[]> {
  const output: MCPResource[] = [];
  let cursor: string | undefined;
  do {
    const result = await client.listResources(cursor ? { cursor } : undefined);
    output.push(
      ...(result.resources ?? []).map((resource) => ({
        uri: resource.uri,
        name: resource.name ?? resource.title ?? resource.uri,
        description: resource.description,
        mimeType: resource.mimeType,
      })),
    );
    cursor = result.nextCursor;
  } while (cursor);
  return output;
}

async function gatherAllPrompts(client: SDKClient): Promise<MCPPrompt[]> {
  const output: MCPPrompt[] = [];
  let cursor: string | undefined;
  do {
    const result = await client.listPrompts(cursor ? { cursor } : undefined);
    output.push(
      ...(result.prompts ?? []).map((prompt) => ({
        name: prompt.name,
        description: prompt.description,
        arguments: prompt.arguments?.map((arg) => ({
          name: arg.name,
          description: arg.description,
          required: arg.required,
        })),
      })),
    );
    cursor = result.nextCursor;
  } while (cursor);
  return output;
}

// ─── MCP client ──────────────────────────────────────────────

export function weaveMCPClient(): MCPClient {
  let transport: MCPTransport | null = null;
  let sdkClient: SDKClient | null = null;
  let lastDiscoveryCursor: string | undefined;
  const discoveryCache = new Map<string, { item: MCPCapabilitySummary; fetchedAt: string }>();

  function assertClient(): SDKClient {
    if (!sdkClient) throw new Error('MCP client not connected');
    return sdkClient;
  }

  async function callToolInternal(ctx: ExecutionContext, request: MCPToolCallRequest): Promise<MCPToolCallResponse> {
    const client = assertClient();
    const result = await client.callTool(
      {
        name: request.name,
        arguments: request.arguments,
        _meta: {
          executionContext: {
            ...toExecutionContextMeta(ctx),
            ...(request.executionContext ?? {}),
          },
        },
      },
      CallToolResultSchema,
    );

    return {
      content: normalizeMCPContent((result as Record<string, unknown>)['content']),
      isError: (result as { isError?: boolean }).isError,
    };
  }

  function makeDiscoveryItem(
    kind: MCPCapabilitySummary['kind'],
    source: string,
    name: string,
    description?: string,
    metadata?: Record<string, unknown>,
  ): MCPCapabilitySummary {
    const namespace = name.includes('.') ? name.slice(0, name.indexOf('.')) : undefined;
    const summary: MCPCapabilitySummary = {
      kind,
      source,
      name,
      description,
      namespace,
      tags: Array.isArray(metadata?.['tags'])
        ? metadata['tags'].filter((t): t is string => typeof t === 'string')
        : undefined,
      lastRefreshedAt: nowIso(),
      etag: typeof metadata?.['etag'] === 'string' ? metadata['etag'] : undefined,
      title: typeof metadata?.['title'] === 'string' ? metadata['title'] : undefined,
    };
    discoveryCache.set(`${kind}:${name}`, { item: summary, fetchedAt: summary.lastRefreshedAt });
    return summary;
  }

  return {
    async connect(t: MCPTransport): Promise<void> {
      transport = t;
      sdkClient = new SDKClient(
        { name: 'weaveintel-mcp-client', version: '0.0.1' },
        { capabilities: {} },
      );
      await sdkClient.connect(toSDKTransport(t));
    },

    async listTools(): Promise<MCPToolDefinition[]> {
      const client = assertClient();
      return gatherAllTools(client);
    },

    async callTool(ctx: ExecutionContext, request: MCPToolCallRequest): Promise<MCPToolCallResponse> {
      return callToolInternal(ctx, request);
    },

    async listResources(): Promise<MCPResource[]> {
      const client = assertClient();
      return gatherAllResources(client);
    },

    async readResource(uri: string): Promise<MCPResourceContent> {
      const client = assertClient();
      const result = await client.readResource({ uri });
      const first = result.contents?.[0];
      if (!first) {
        throw new Error(`Resource ${uri} returned no content`);
      }
      return {
        uri: first.uri,
        mimeType: first.mimeType,
        text: 'text' in first ? first.text : undefined,
        blob: 'blob' in first ? first.blob : undefined,
      };
    },

    async listPrompts(): Promise<MCPPrompt[]> {
      const client = assertClient();
      return gatherAllPrompts(client);
    },

    async getPrompt(name: string, args?: Record<string, string>): Promise<MCPPromptMessage[]> {
      const client = assertClient();
      const result = await client.getPrompt({ name, arguments: args });
      return (result.messages ?? []).map((message) => {
        const content = message.content;
        if (content.type === 'text') {
          return { role: message.role, content: { type: 'text', text: content.text } };
        }
        if (content.type === 'image') {
          return {
            role: message.role,
            content: { type: 'image', data: content.data, mimeType: content.mimeType },
          };
        }
        if (content.type === 'resource') {
          return {
            role: message.role,
            content: {
              type: 'resource',
              uri: content.resource.uri,
              text: 'text' in content.resource ? content.resource.text : undefined,
            },
          };
        }
        return {
          role: message.role,
          content: { type: 'text', text: JSON.stringify(content) },
        };
      });
    },

    async *streamToolCall(
      ctx: ExecutionContext,
      request: MCPToolCallRequest,
      options?: MCPToolCallStreamOptions,
    ): AsyncGenerator<MCPStreamEvent, void, void> {
      const client = assertClient();
      yield {
        type: 'started',
        timestamp: nowIso(),
        executionId: ctx.executionId,
        message: `Starting ${request.name}`,
      };

      if (options?.signal?.aborted) {
        yield {
          type: 'cancelled',
          timestamp: nowIso(),
          executionId: ctx.executionId,
          message: `Cancelled before ${request.name} execution`,
        };
        return;
      }

      try {
        const stream = client.experimental.tasks.callToolStream(
          {
            name: request.name,
            arguments: request.arguments,
            _meta: {
              executionContext: {
                ...toExecutionContextMeta(ctx),
                ...(request.executionContext ?? {}),
              },
              ...(options?.requestMetadata ?? {}),
            },
          },
          CallToolResultSchema,
          {
            timeout: options?.timeoutMs,
            signal: options?.signal,
          },
        );

        for await (const message of stream) {
          if (options?.signal?.aborted) {
            yield {
              type: 'cancelled',
              timestamp: nowIso(),
              executionId: ctx.executionId,
              message: `Cancelled during ${request.name}`,
            };
            return;
          }

          if (message.type === 'taskCreated') {
            yield {
              type: 'progress',
              timestamp: nowIso(),
              executionId: ctx.executionId,
              message: `Task created for ${request.name}`,
              metadata: { task: message.task },
            };
            continue;
          }
          if (message.type === 'taskStatus') {
            yield {
              type: 'progress',
              timestamp: nowIso(),
              executionId: ctx.executionId,
              progress: {
                status: message.task.status,
              },
              metadata: { task: message.task },
            };
            continue;
          }
          if (message.type === 'result') {
            const response: MCPToolCallResponse = {
              content: normalizeMCPContent((message.result as Record<string, unknown>)['content']),
              isError: (message.result as { isError?: boolean }).isError,
            };
            yield {
              type: 'final_output',
              timestamp: nowIso(),
              executionId: ctx.executionId,
              output: response,
              message: `Completed ${request.name}`,
            };
            return;
          }
          if (message.type === 'error') {
            yield {
              type: 'error',
              timestamp: nowIso(),
              executionId: ctx.executionId,
              message: message.error.message,
              metadata: { code: message.error.code },
            };
            return;
          }
        }
      } catch (error) {
        const fallback = await callToolInternal(ctx, request);
        yield {
          type: 'warning',
          timestamp: nowIso(),
          executionId: ctx.executionId,
          message: `Streaming unavailable for ${request.name}; returned non-streaming result`,
          metadata: { reason: error instanceof Error ? error.message : String(error) },
        };
        yield {
          type: 'final_output',
          timestamp: nowIso(),
          executionId: ctx.executionId,
          output: fallback,
        };
      }
    },

    async discoverCapabilities(query?: MCPCapabilityDiscoveryQuery): Promise<MCPCapabilityDiscoveryPage> {
      const client = assertClient();
      const limit = Math.max(1, query?.limit ?? DEFAULT_PAGE_LIMIT);
      const cursor = query?.cursor ?? lastDiscoveryCursor;

      const [toolsPage, resourcesPage, promptsPage] = await Promise.all([
        client.listTools(cursor ? { cursor } : undefined),
        client.listResources(cursor ? { cursor } : undefined),
        client.listPrompts(cursor ? { cursor } : undefined),
      ]);

      const source = transport?.type ?? 'unknown';

      const allItems: MCPCapabilitySummary[] = [
        ...(toolsPage.tools ?? []).map((tool) =>
          makeDiscoveryItem('tool', source, tool.name, tool.description, {
            tags: (tool._meta as Record<string, unknown> | undefined)?.['tags'],
            title: tool.title,
          })),
        ...(resourcesPage.resources ?? []).map((resource) =>
          makeDiscoveryItem('resource', source, resource.uri, resource.description, {
            title: resource.title ?? resource.name,
            tags: (resource._meta as Record<string, unknown> | undefined)?.['tags'],
          })),
        ...(promptsPage.prompts ?? []).map((prompt) =>
          makeDiscoveryItem('prompt', source, prompt.name, prompt.description, {
            title: prompt.title,
            tags: (prompt._meta as Record<string, unknown> | undefined)?.['tags'],
          })),
      ];

      const namespacePrefix = query?.namespacePrefix;
      const tagFilter = query?.tags && query.tags.length > 0 ? new Set(query.tags) : null;
      const filtered = allItems
        .filter((item) => !namespacePrefix || item.name.startsWith(namespacePrefix))
        .filter((item) => {
          if (!tagFilter) return true;
          const itemTags = item.tags ?? [];
          return itemTags.some((tag: string) => tagFilter.has(tag));
        })
        .slice(0, limit);

      const toolsByName = new Map((toolsPage.tools ?? []).map((tool) => [tool.name, tool]));
      const resourcesByName = new Map((resourcesPage.resources ?? []).map((resource) => [resource.uri, resource]));
      const promptsByName = new Map((promptsPage.prompts ?? []).map((prompt) => [prompt.name, prompt]));

      const details = query?.includeDetails
        ? Object.fromEntries(filtered.map((item) => [
          `${item.kind}:${item.name}`,
          (() => {
            const key = `${item.kind}:${item.name}`;
            const cached = discoveryCache.has(key);
            if (item.kind === 'tool') {
              const tool = toolsByName.get(item.name);
              return {
                ...item,
                inputSchema: tool?.inputSchema as JsonSchema | undefined,
                metadata: {
                  cached,
                  ...(isRecord(tool?._meta) ? tool._meta : {}),
                },
              };
            }
            if (item.kind === 'resource') {
              const resource = resourcesByName.get(item.name);
              return {
                ...item,
                metadata: {
                  cached,
                  ...(isRecord(resource?._meta) ? resource._meta : {}),
                  ...(resource?.mimeType ? { mimeType: resource.mimeType } : {}),
                },
              };
            }
            const prompt = promptsByName.get(item.name);
            return {
              ...item,
              metadata: {
                cached,
                ...(isRecord(prompt?._meta) ? prompt._meta : {}),
                ...(prompt?.arguments ? { arguments: prompt.arguments } : {}),
              },
            };
          })(),
        ]))
        : undefined;

      lastDiscoveryCursor = toolsPage.nextCursor ?? resourcesPage.nextCursor ?? promptsPage.nextCursor;
      return {
        items: filtered,
        details,
        nextCursor: lastDiscoveryCursor,
        source,
        fetchedAt: nowIso(),
      };
    },

    async composeToolCalls(ctx: ExecutionContext, plan: MCPComposableCallPlan): Promise<MCPComposableCallResult> {
      const startedAt = nowIso();
      const stepResults: MCPComposableStepResult[] = [];
      const outputsByStepId: Record<string, MCPToolCallResponse> = {};
      const completed = new Set<string>();

      const pending = [...plan.steps];
      while (pending.length > 0) {
        const ready = pending.filter((step) => (step.dependsOn ?? []).every((dep: string) => completed.has(dep)));
        if (ready.length === 0) {
          throw new Error(`Cannot resolve composable plan ${plan.id}: unresolved dependencies`);
        }

        await Promise.all(ready.map(async (step) => {
          const started = nowIso();
          const dependencyOutput = step.inputFromStepId ? outputsByStepId[step.inputFromStepId] : undefined;
          const mergedInput = parsePathValue(dependencyOutput, step.inputPath);
          const request: MCPToolCallRequest = {
            name: step.toolName,
            arguments: applyMergedInput(step.arguments, step.mergeInputAs, mergedInput),
          };

          let retriesRemaining = Math.max(0, step.retries ?? 0);
          let response: MCPToolCallResponse | undefined;
          let errorMessage: string | undefined;

          while (response === undefined) {
            try {
              response = await callToolInternal(ctx, request);
            } catch (error) {
              errorMessage = error instanceof Error ? error.message : String(error);
              if (retriesRemaining > 0) {
                retriesRemaining -= 1;
                continue;
              }
              break;
            }
          }

          const ended = nowIso();
          if (response) {
            outputsByStepId[step.id] = response;
            stepResults.push({
              stepId: step.id,
              startedAt: started,
              endedAt: ended,
              status: 'ok',
              request,
              response,
              metadata: step.metadata,
            });
          } else {
            stepResults.push({
              stepId: step.id,
              startedAt: started,
              endedAt: ended,
              status: 'error',
              request,
              error: errorMessage ?? 'unknown error',
              metadata: step.metadata,
            });
            if (!step.continueOnError) {
              throw new Error(`Composable call step ${step.id} failed: ${errorMessage ?? 'unknown error'}`);
            }
          }
          completed.add(step.id);
        }));

        for (const step of ready) {
          const index = pending.findIndex((candidate) => candidate.id === step.id);
          if (index >= 0) pending.splice(index, 1);
        }
      }

      return {
        planId: plan.id,
        startedAt,
        endedAt: nowIso(),
        steps: stepResults,
        outputsByStepId,
      };
    },

    async disconnect(): Promise<void> {
      if (sdkClient) {
        await sdkClient.close();
        sdkClient = null;
      }
      if (transport) await transport.close();
      transport = null;
      lastDiscoveryCursor = undefined;
      discoveryCache.clear();
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
        let response: MCPToolCallResponse | undefined;
        if (client.streamToolCall) {
          for await (const event of client.streamToolCall(ctx, {
            name: input.name,
            arguments: input.arguments,
          })) {
            if (event.output) {
              response = event.output;
            }
            if (event.type === 'final_output' && event.output) {
              response = event.output;
              break;
            }
          }
        }
        response ??= await client.callTool(ctx, {
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
