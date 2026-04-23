/**
 * @weaveintel/core — MCP protocol contracts
 *
 * Why: MCP (Model Context Protocol) support must be native, not bolted on.
 * These contracts define how internal tools/resources map to MCP and vice versa.
 * Transport is abstracted so stdio, HTTP, and WebSocket all work.
 */

import type { ExecutionContext } from './context.js';
import type { JsonSchema } from './models.js';

// ─── MCP Tool ────────────────────────────────────────────────

export interface MCPToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

export interface MCPToolCallRequest {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  /**
   * Optional, explicitly propagated execution context metadata for policy,
   * tenancy, and observability across transport boundaries.
   */
  readonly executionContext?: {
    readonly executionId?: string;
    readonly tenantId?: string;
    readonly userId?: string;
    readonly parentSpanId?: string;
    readonly deadline?: number;
    readonly metadata?: Record<string, unknown>;
  };
}

export interface MCPToolCallResponse {
  readonly content: MCPContent[];
  readonly isError?: boolean;
}

export type MCPContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string }
  | { readonly type: 'resource'; readonly uri: string; readonly text?: string };

// ─── Streaming, discovery, and composition contracts ────────

export type MCPStreamEventType =
  | 'started'
  | 'progress'
  | 'partial_output'
  | 'final_output'
  | 'warning'
  | 'error'
  | 'cancelled';

export interface MCPStreamEvent {
  readonly type: MCPStreamEventType;
  readonly timestamp: string;
  readonly executionId?: string;
  readonly stepId?: string;
  readonly message?: string;
  readonly progress?: {
    readonly status?: string;
    readonly current?: number;
    readonly total?: number;
  };
  readonly output?: MCPToolCallResponse;
  readonly metadata?: Record<string, unknown>;
}

export interface MCPToolCallStreamOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly requestMetadata?: Record<string, unknown>;
}

export type MCPCapabilityKind = 'tool' | 'resource' | 'prompt';

export interface MCPCapabilitySummary {
  readonly kind: MCPCapabilityKind;
  readonly name: string;
  readonly source: string;
  readonly title?: string;
  readonly description?: string;
  readonly namespace?: string;
  readonly tags?: readonly string[];
  readonly lastRefreshedAt: string;
  readonly etag?: string;
}

export interface MCPCapabilityDetails extends MCPCapabilitySummary {
  readonly inputSchema?: JsonSchema;
  readonly metadata?: Record<string, unknown>;
}

export interface MCPCapabilityDiscoveryQuery {
  readonly cursor?: string;
  readonly limit?: number;
  readonly namespacePrefix?: string;
  readonly tags?: readonly string[];
  readonly includeDetails?: boolean;
}

export interface MCPCapabilityDiscoveryPage {
  readonly items: readonly MCPCapabilitySummary[];
  readonly details?: Readonly<Record<string, MCPCapabilityDetails>>;
  readonly nextCursor?: string;
  readonly source: string;
  readonly fetchedAt: string;
}

export interface MCPComposableCallStep {
  readonly id: string;
  readonly toolName: string;
  readonly arguments?: Record<string, unknown>;
  readonly dependsOn?: readonly string[];
  readonly inputFromStepId?: string;
  readonly inputPath?: string;
  readonly mergeInputAs?: string;
  readonly retries?: number;
  readonly timeoutMs?: number;
  readonly continueOnError?: boolean;
  readonly metadata?: Record<string, unknown>;
}

export interface MCPComposableCallPlan {
  readonly id: string;
  readonly steps: readonly MCPComposableCallStep[];
}

export interface MCPComposableStepResult {
  readonly stepId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly status: 'ok' | 'error' | 'skipped';
  readonly request: MCPToolCallRequest;
  readonly response?: MCPToolCallResponse;
  readonly error?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface MCPComposableCallResult {
  readonly planId: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly steps: readonly MCPComposableStepResult[];
  readonly outputsByStepId: Readonly<Record<string, MCPToolCallResponse>>;
}

// ─── MCP Resource ────────────────────────────────────────────

export interface MCPResource {
  readonly uri: string;
  readonly name: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export interface MCPResourceContent {
  readonly uri: string;
  readonly mimeType?: string;
  readonly text?: string;
  readonly blob?: string;
}

// ─── MCP Prompt ──────────────────────────────────────────────

export interface MCPPrompt {
  readonly name: string;
  readonly description?: string;
  readonly arguments?: readonly MCPPromptArgument[];
}

export interface MCPPromptArgument {
  readonly name: string;
  readonly description?: string;
  readonly required?: boolean;
}

export interface MCPPromptMessage {
  readonly role: 'user' | 'assistant';
  readonly content: MCPContent;
}

// ─── MCP Transport ───────────────────────────────────────────

export interface MCPTransport {
  readonly type: 'stdio' | 'http' | 'websocket';
  send(message: unknown): Promise<void>;
  onMessage(handler: (message: unknown) => void): void;
  close(): Promise<void>;
}

// ─── MCP Client ──────────────────────────────────────────────

export interface MCPClient {
  connect(transport: MCPTransport): Promise<void>;
  listTools(): Promise<MCPToolDefinition[]>;
  callTool(ctx: ExecutionContext, request: MCPToolCallRequest): Promise<MCPToolCallResponse>;
  listResources(): Promise<MCPResource[]>;
  readResource(uri: string): Promise<MCPResourceContent>;
  listPrompts(): Promise<MCPPrompt[]>;
  getPrompt(name: string, args?: Record<string, string>): Promise<MCPPromptMessage[]>;
  /** Optional streaming-first tool execution path. */
  streamToolCall?(
    ctx: ExecutionContext,
    request: MCPToolCallRequest,
    options?: MCPToolCallStreamOptions,
  ): AsyncGenerator<MCPStreamEvent, void, void>;
  /** Optional progressive capability discovery path. */
  discoverCapabilities?(query?: MCPCapabilityDiscoveryQuery): Promise<MCPCapabilityDiscoveryPage>;
  /** Optional composable call-chain execution helper. */
  composeToolCalls?(
    ctx: ExecutionContext,
    plan: MCPComposableCallPlan,
  ): Promise<MCPComposableCallResult>;
  disconnect(): Promise<void>;
}

// ─── MCP Server ──────────────────────────────────────────────

export interface MCPServerConfig {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
}

export interface MCPServer {
  readonly config: MCPServerConfig;
  addTool(definition: MCPToolDefinition, handler: MCPToolHandler): void;
  addResource(resource: MCPResource, handler: MCPResourceHandler): void;
  addPrompt(prompt: MCPPrompt, handler: MCPPromptHandler): void;
  start(transport: MCPTransport): Promise<void>;
  stop(): Promise<void>;
}

export type MCPToolHandler = (
  ctx: ExecutionContext,
  args: Record<string, unknown>,
) => Promise<MCPToolCallResponse>;

export type MCPResourceHandler = (uri: string) => Promise<MCPResourceContent>;

export type MCPPromptHandler = (
  args: Record<string, string>,
) => Promise<MCPPromptMessage[]>;
