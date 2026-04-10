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
}

export interface MCPToolCallResponse {
  readonly content: MCPContent[];
  readonly isError?: boolean;
}

export type MCPContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: string }
  | { readonly type: 'resource'; readonly uri: string; readonly text?: string };

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
