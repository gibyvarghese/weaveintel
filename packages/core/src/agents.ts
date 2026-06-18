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
  /**
   * M-21: `'guardrail_denied'` is a distinct terminal status returned when the
   * output guardrail blocks the agent's final response. Callers that previously
   * treated `'completed'` as the only success state must now also handle
   * `'guardrail_denied'` to distinguish a policy-blocked output.
   */
  readonly status: 'completed' | 'failed' | 'cancelled' | 'budget_exceeded' | 'needs_approval' | 'guardrail_denied';
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
  /** Input (prompt) tokens billed across all LLM calls in this agent run. */
  readonly promptTokens: number;
  /** Output (completion) tokens billed across all LLM calls in this agent run. */
  readonly completionTokens: number;
  /** promptTokens + completionTokens — kept for backwards compatibility. */
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
  /**
   * M-31: `'verify_failed'` and `'reflect_revised'` are distinct event types
   * emitted when the W2 verify-loop and W1 reflect-loop decide to regenerate
   * instead of accepting the draft. Previously both used `'tool_start'`, which
   * made them indistinguishable from tool calls in traces and stream consumers.
   * Consumers that relied on `'tool_start'` as a catch-all still work because
   * real tool calls continue to emit `'tool_start'`; new code should branch on
   * `'verify_failed'` / `'reflect_revised'` for quality-loop awareness.
   */
  readonly type: 'step_start' | 'step_end' | 'text_chunk' | 'tool_start' | 'tool_end' | 'verify_failed' | 'reflect_revised' | 'done';
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

// ─── Reasoning-quality strategies ───────────────────────────

/**
 * Result returned by a Critic after reviewing a draft response.
 * `accepted` true → the draft is good enough; `feedback` is set on rejection
 * and appended to the conversation as a new user turn so the agent revises.
 */
export interface CritiqueResult {
  /** True when the draft meets the quality bar; false to trigger a revision. */
  accepted: boolean;
  /** Human-readable feedback injected as a new user turn on rejection. */
  feedback?: string;
  /** Optional numeric score in [0,1] for observability. */
  score?: number;
}

/**
 * Evaluates a draft response and decides whether to accept or request revision.
 * Implemented by self-critique (prompts the same model) and rubric critics.
 * W1 reflection uses this directly; W2 Verifier shares the same contract.
 */
export interface Critic {
  /**
   * Evaluate `draft` (produced in response to `input`) and return whether
   * it should be accepted or revised. `ctx` carries the execution context.
   */
  critique(
    ctx: ExecutionContext,
    input: string,
    draft: string,
  ): Promise<CritiqueResult>;
}

/**
 * Result returned by a Verifier after checking an output.
 */
export interface VerifyResult {
  /** True when the output passes; false to trigger regeneration. */
  passed: boolean;
  /** Optional reason logged in the audit trail. */
  reason?: string;
  /** Optional numeric score in [0,1] for observability. */
  score?: number;
}

/**
 * Verifies an agent output against an external quality criterion.
 * `Critic` is a specialisation of this interface (adds `feedback` text).
 * W2 evaluator-optimizer uses Verifier; W1 reflection uses Critic.
 */
export interface Verifier {
  verify(
    ctx: ExecutionContext,
    output: string,
    context?: Record<string, unknown>,
  ): Promise<VerifyResult>;
}

/**
 * A single candidate in a multi-agent ensemble — one agent's answer together
 * with provenance metadata so resolvers can rank or synthesise.
 */
export interface EnsembleCandidate {
  /** Which agent produced this output. */
  agentName: string;
  /** The agent's final response text. */
  output: string;
  /** Optional score from a prior verifier/rubric judge. */
  score?: number;
  /** Raw AgentResult for resolvers that need step/usage data. */
  result: AgentResult;
}

/**
 * Resolves a set of disagreeing candidates into a single authoritative answer.
 * Implementations: vote (majority), judge (rubric-scored), arbiter (model-picked).
 */
export interface ConflictResolver {
  resolve(
    ctx: ExecutionContext,
    candidates: EnsembleCandidate[],
  ): Promise<{ output: string; rationale?: string; winner?: string }>;
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
