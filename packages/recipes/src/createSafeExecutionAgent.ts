/**
 * @weaveintel/recipes — Safe Execution Agent
 *
 * Agent with sandbox constraints for safe code/tool execution.
 */

import type {
  Agent,
  Model,
  ToolRegistry,
  EventBus,
  AgentMemory,
  AgentPolicy,
  ExecutionContext,
  AgentStep,
  AgentUsage,
  ToolSchema,
} from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';

export interface SafeExecutionAgentOptions {
  name?: string;
  model: Model;
  tools?: ToolRegistry;
  bus?: EventBus;
  memory?: AgentMemory;
  policy?: AgentPolicy;
  /** Denied tool names (always blocked at runtime via AgentPolicy.approveToolCall) */
  deniedTools?: string[];
  /** Max execution time per tool call (ms) */
  maxToolExecutionMs?: number;
  /** System prompt */
  systemPrompt?: string;
  maxSteps?: number;
}

/**
 * Create an agent with safety constraints — denied tool list enforced at
 * runtime via AgentPolicy.approveToolCall (not just prompt text), execution
 * time limits in the system prompt advisory, and a defensive system prompt.
 */
export function createSafeExecutionAgent(opts: SafeExecutionAgentOptions): Agent {
  const denied = opts.deniedTools ?? [];
  const maxMs = opts.maxToolExecutionMs ?? 30_000;
  const safetyBlock = `\n\nSafety constraints:
- Max tool execution time: ${maxMs}ms
${denied.length > 0 ? `- Blocked tools: ${denied.join(', ')}\n` : ''}- Never execute destructive operations without confirmation
- Never access the filesystem or network unless explicitly authorized
- Report any errors clearly without leaking internal details`;

  const systemPrompt = `You are a safety-constrained execution agent.
Follow all safety rules. Prefer minimal, read-only operations.
${opts.systemPrompt ?? ''}${safetyBlock}`;

  // Build an effective policy that enforces the denied-tool list at runtime,
  // then delegates to any caller-supplied policy.
  const callerPolicy = opts.policy;
  const effectivePolicy: AgentPolicy = {
    async shouldContinue(
      ctx: ExecutionContext,
      steps: readonly AgentStep[],
      usage: AgentUsage,
    ) {
      if (callerPolicy) return callerPolicy.shouldContinue(ctx, steps, usage);
      return { continue: true };
    },

    async approveToolCall(
      ctx: ExecutionContext,
      tool: ToolSchema,
      args: Record<string, unknown>,
    ) {
      // Enforce denied list first — this is a hard runtime block, not advisory text.
      if (denied.includes(tool.name)) {
        return { approved: false, reason: `Tool "${tool.name}" is on the denied list for this agent.` };
      }
      // Delegate to caller policy if present
      if (callerPolicy?.approveToolCall) {
        return callerPolicy.approveToolCall(ctx, tool, args);
      }
      return { approved: true };
    },

    ...(callerPolicy?.approveDelegation
      ? { approveDelegation: callerPolicy.approveDelegation.bind(callerPolicy) }
      : {}),
  };

  return weaveAgent({
    name: opts.name ?? 'safe-execution-agent',
    model: opts.model,
    tools: opts.tools,
    bus: opts.bus,
    memory: opts.memory,
    policy: effectivePolicy,
    systemPrompt,
    maxSteps: opts.maxSteps ?? 15,
  });
}
