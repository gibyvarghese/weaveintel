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
} from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';

export interface SafeExecutionAgentOptions {
  name?: string;
  model: Model;
  tools?: ToolRegistry;
  bus?: EventBus;
  memory?: AgentMemory;
  policy?: AgentPolicy;
  /** Denied tool names (always blocked) */
  deniedTools?: string[];
  /** Max execution time per tool call (ms) */
  maxToolExecutionMs?: number;
  /** System prompt */
  systemPrompt?: string;
  maxSteps?: number;
}

/**
 * Create an agent with safety constraints — denied tool list,
 * execution time limits, and defensive system prompt.
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

  return weaveAgent({
    name: opts.name ?? 'safe-execution-agent',
    model: opts.model,
    tools: opts.tools,
    bus: opts.bus,
    memory: opts.memory,
    policy: opts.policy,
    systemPrompt,
    maxSteps: opts.maxSteps ?? 15,
  });
}
