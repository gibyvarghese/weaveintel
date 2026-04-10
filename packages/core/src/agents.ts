/**
 * @weaveintel/core — Agent contracts
 *
 * Why: Agents are the orchestration layer. They use models, tools, memory,
 * and retrieval — but never own them. Agent contracts define the execution
 * model, delegation protocol, and completion semantics.
 *
 * The hierarchy model allows supervisor-worker patterns while keeping
 * trace continuity and budget enforcement across the whole tree.
 */

import type { ExecutionContext } from './context.js';
import type { Message } from './models.js';
import type { ToolSchema } from './tools.js';

// ─── Agent definition ────────────────────────────────────────

export interface AgentConfig {
  readonly name: string;
  readonly description?: string;
  readonly instructions?: string;
  readonly model?: string;
  readonly tools?: readonly string[];
  readonly maxSteps?: number;
  readonly maxTokenBudget?: number;
  readonly requireApproval?: boolean;
  readonly metadata?: Record<string, unknown>;
}

// ─── Agent execution ─────────────────────────────────────────

export interface AgentInput {
  readonly messages: readonly Message[];
  readonly goal?: string;
  readonly context?: Record<string, unknown>;
}

export interface AgentResult {
  readonly output: string;
  readonly messages: readonly Message[];
  readonly steps: readonly AgentStep[];
  readonly usage: AgentUsage;
  readonly status: 'completed' | 'failed' | 'cancelled' | 'budget_exceeded' | 'needs_approval';
  readonly metadata?: Record<string, unknown>;
}

export interface AgentStep {
  readonly index: number;
  readonly type: 'thinking' | 'tool_call' | 'delegation' | 'response';
  readonly content?: string;
  readonly toolCall?: { name: string; arguments: Record<string, unknown>; result?: string };
  readonly delegation?: { agent: string; goal: string; result?: string };
  readonly durationMs: number;
  readonly tokenUsage?: { prompt: number; completion: number };
}

export interface AgentUsage {
  readonly totalSteps: number;
  readonly totalTokens: number;
  readonly totalDurationMs: number;
  readonly toolCalls: number;
  readonly delegations: number;
}

// ─── Agent interface ─────────────────────────────────────────

export interface Agent {
  readonly config: AgentConfig;

  run(ctx: ExecutionContext, input: AgentInput): Promise<AgentResult>;

  /** Stream agent execution steps as they happen */
  runStream?(ctx: ExecutionContext, input: AgentInput): AsyncIterable<AgentStepEvent>;
}

export interface AgentStepEvent {
  readonly type: 'step_start' | 'step_end' | 'text_chunk' | 'tool_start' | 'tool_end' | 'done';
  readonly step?: AgentStep;
  readonly text?: string;
  readonly result?: AgentResult;
}

// ─── Hierarchical agents ─────────────────────────────────────

export interface SupervisorConfig extends AgentConfig {
  readonly workers: Record<string, AgentConfig>;
  readonly delegationStrategy?: 'round_robin' | 'capability_match' | 'model_decided';
  readonly maxDelegations?: number;
  readonly aggregationStrategy?: 'concatenate' | 'summarize' | 'structured';
}

export interface DelegationRequest {
  readonly targetAgent: string;
  readonly goal: string;
  readonly context?: Record<string, unknown>;
  readonly budget?: { maxSteps?: number; maxTokens?: number };
}

export interface DelegationResult {
  readonly agent: string;
  readonly result: AgentResult;
  readonly durationMs: number;
}

// ─── Agent runtime (the execution engine) ────────────────────

export interface AgentRuntime {
  createAgent(config: AgentConfig): Agent;
  createSupervisor(config: SupervisorConfig): Agent;
  run(agent: Agent, ctx: ExecutionContext, input: AgentInput): Promise<AgentResult>;
}

// ─── Agent memory interface (used by agents, not owned by them) ──

export interface AgentMemory {
  getMessages(ctx: ExecutionContext, limit?: number): Promise<Message[]>;
  addMessage(ctx: ExecutionContext, message: Message): Promise<void>;
  summarize?(ctx: ExecutionContext): Promise<string>;
  clear(ctx: ExecutionContext): Promise<void>;
}

// ─── Agent policy ────────────────────────────────────────────

export interface AgentPolicy {
  /** Called before each step to check if the agent should continue */
  shouldContinue(
    ctx: ExecutionContext,
    steps: readonly AgentStep[],
    usage: AgentUsage,
  ): Promise<{ continue: boolean; reason?: string }>;

  /** Called before tool use to check approval */
  approveToolCall?(
    ctx: ExecutionContext,
    tool: ToolSchema,
    args: Record<string, unknown>,
  ): Promise<{ approved: boolean; reason?: string }>;

  /** Called before delegation */
  approveDelegation?(
    ctx: ExecutionContext,
    request: DelegationRequest,
  ): Promise<{ approved: boolean; reason?: string }>;
}
