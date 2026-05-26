import type {
  MCPToolDefinition,
  MCPToolCallRequest,
  MCPToolCallResponse,
  ExecutionContext,
  MCPTransport,
  AccessTokenResolver,
  SecretScope,
  RuntimeIdentity,
  Model,
} from '@weaveintel/core';
import type { AttentionAction } from './actions.js';
import type { Account } from './accounts.js';
import type { LiveAgent } from './mesh.js';
import type { ActionExecutionContext } from './store.js';

export interface ExternalActionToolCall {
  toolName: string;
  arguments: Record<string, unknown>;
  purposeProse: string;
  summaryProse: string;
}

export interface ExternalActionAdapter {
  resolve(action: AttentionAction, context: ActionExecutionContext, account: Account): Promise<ExternalActionToolCall | null>;
}

export interface AccountToolSession {
  listTools(): Promise<MCPToolDefinition[]>;
  callTool(ctx: ExecutionContext, request: MCPToolCallRequest): Promise<MCPToolCallResponse>;
  streamToolCall?(
    ctx: ExecutionContext,
    request: MCPToolCallRequest,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): AsyncGenerator<{
    type: string;
    timestamp: string;
    message?: string;
    output?: MCPToolCallResponse;
    metadata?: Record<string, unknown>;
  }, void, void>;
  discoverCapabilities?(query?: {
    cursor?: string;
    limit?: number;
    namespacePrefix?: string;
    tags?: readonly string[];
    includeDetails?: boolean;
  }): Promise<{
    items: readonly {
      kind: 'tool' | 'resource' | 'prompt';
      name: string;
      source: string;
      description?: string;
      namespace?: string;
      tags?: readonly string[];
      lastRefreshedAt: string;
    }[];
    nextCursor?: string;
    source: string;
    fetchedAt: string;
  }>;
  disconnect(): Promise<void>;
}

export interface AccountSessionProvider {
  getSession(args: {
    account: Account;
    agent: LiveAgent;
    ctx: ExecutionContext;
  }): Promise<AccountToolSession>;
  disconnectAccount?(accountId: string): Promise<void>;
  disconnectAll?(): Promise<void>;
}

export interface McpTransportFactoryInput {
  account: Account;
  agent: LiveAgent;
  token: string;
  identity: RuntimeIdentity;
  ctx: ExecutionContext;
}

export interface McpTransportFactory {
  createTransport(input: McpTransportFactoryInput): Promise<MCPTransport>;
}

export interface McpAccountSessionProviderOptions {
  tokenResolver: AccessTokenResolver;
  transportFactory: McpTransportFactory;
  scopeFactory?: (account: Account, agent: LiveAgent) => SecretScope;
  identityFactory?: (agent: LiveAgent) => RuntimeIdentity;
  /**
   * Optional cache TTL for account sessions. When elapsed, a fresh session is
   * created from durable account binding + token resolver state.
   */
  sessionTtlMs?: number;
}

export interface ActionExecutionResult {
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED';
  summaryProse: string;
  createdMessageIds: string[];
  createdOutboundRecordIds: string[];
  updatedBacklogItemIds: string[];
}

export interface ActionExecutor {
  execute(action: AttentionAction, context: ActionExecutionContext, ctx: ExecutionContext): Promise<ActionExecutionResult>;
}

export interface ReplayLiveAgentsRunOptions {
  model?: Model;
  preserveTiming?: boolean;
  timeoutMs?: number;
}
