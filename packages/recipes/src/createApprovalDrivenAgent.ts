/**
 * @weaveintel/recipes — Approval-Driven Agent
 *
 * Agent that pauses for human approval before executing high-risk actions.
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

export interface ApprovalDrivenAgentOptions {
  name?: string;
  model: Model;
  tools?: ToolRegistry;
  bus?: EventBus;
  memory?: AgentMemory;
  policy?: AgentPolicy;
  /** Tool names that require approval before execution */
  approvalRequired?: string[];
  /** System prompt */
  systemPrompt?: string;
  maxSteps?: number;
}

/**
 * Create an agent that documents any high-risk action before executing it.
 * The system prompt instructs the agent to announce tool calls and wait.
 */
export function createApprovalDrivenAgent(opts: ApprovalDrivenAgentOptions): Agent {
  const approvalList = opts.approvalRequired ?? [];
  const toolBlock = approvalList.length > 0
    ? `\n\nThe following tools require human approval before execution:\n${approvalList.map((t) => `- ${t}`).join('\n')}\nBefore calling any of these, explain what you intend to do and why.`
    : '';

  const systemPrompt = `You are an approval-driven agent. For any destructive or high-risk action,
you must clearly state what you plan to do before proceeding.
${opts.systemPrompt ?? ''}${toolBlock}`;

  return weaveAgent({
    name: opts.name ?? 'approval-agent',
    model: opts.model,
    tools: opts.tools,
    bus: opts.bus,
    memory: opts.memory,
    policy: opts.policy,
    systemPrompt,
    maxSteps: opts.maxSteps ?? 20,
  });
}
