/**
 * @weaveintel/core — A2A (Agent-to-Agent) protocol contracts
 *
 * Why: Agents need to communicate across process/network boundaries.
 * A2A defines the protocol for remote agent discovery, task delegation,
 * status updates, and result collection. It maps naturally to the
 * Google A2A protocol while staying implementation-flexible.
 */

import type { ExecutionContext } from './context.js';

// ─── Agent card (discovery) ──────────────────────────────────

export interface AgentCard {
  readonly name: string;
  readonly description: string;
  readonly url: string;
  readonly version?: string;
  readonly capabilities?: readonly string[];
  readonly skills?: readonly AgentSkill[];
  readonly authentication?: AgentAuthentication;
}

export interface AgentSkill {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
}

export interface AgentAuthentication {
  readonly type: 'none' | 'api_key' | 'oauth2' | 'bearer';
  readonly credentials?: Record<string, string>;
}

// ─── A2A Task ────────────────────────────────────────────────

export interface A2ATask {
  readonly id: string;
  readonly skill?: string;
  readonly input: A2AMessage;
  readonly metadata?: Record<string, unknown>;
}

export interface A2AMessage {
  readonly role: 'user' | 'agent';
  readonly parts: readonly A2APart[];
}

export type A2APart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'file'; readonly mimeType: string; readonly data: string }
  | { readonly type: 'data'; readonly data: Record<string, unknown> };

export type A2ATaskStatus = 'submitted' | 'working' | 'completed' | 'failed' | 'cancelled';

export interface A2ATaskResult {
  readonly id: string;
  readonly status: A2ATaskStatus;
  readonly output?: A2AMessage;
  readonly error?: string;
  readonly metadata?: Record<string, unknown>;
}

// ─── A2A Client ──────────────────────────────────────────────

export interface A2AClient {
  discover(url: string): Promise<AgentCard>;
  sendTask(ctx: ExecutionContext, agentUrl: string, task: A2ATask): Promise<A2ATaskResult>;
  streamTask?(
    ctx: ExecutionContext,
    agentUrl: string,
    task: A2ATask,
  ): AsyncIterable<A2ATaskResult>;
  cancelTask?(ctx: ExecutionContext, agentUrl: string, taskId: string): Promise<void>;
  getTaskStatus?(
    ctx: ExecutionContext,
    agentUrl: string,
    taskId: string,
  ): Promise<A2ATaskResult>;
}

// ─── A2A Server ──────────────────────────────────────────────

export interface A2AServer {
  readonly card: AgentCard;

  handleTask(
    ctx: ExecutionContext,
    task: A2ATask,
  ): Promise<A2ATaskResult>;

  handleStreamTask?(
    ctx: ExecutionContext,
    task: A2ATask,
  ): AsyncIterable<A2ATaskResult>;

  start(port: number): Promise<void>;
  stop(): Promise<void>;
}

// ─── Internal A2A bus ────────────────────────────────────────

export interface InternalA2ABus {
  register(name: string, handler: A2AServer): void;
  unregister(name: string): void;
  send(ctx: ExecutionContext, target: string, task: A2ATask): Promise<A2ATaskResult>;
  discover(name: string): AgentCard | undefined;
  listAgents(): AgentCard[];
}
