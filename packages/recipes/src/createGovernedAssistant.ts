/**
 * @weaveintel/recipes — Governed Assistant
 *
 * An assistant with built-in guardrail and policy enforcement.
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

export interface GovernedAssistantOptions {
  name?: string;
  model: Model;
  tools?: ToolRegistry;
  bus?: EventBus;
  memory?: AgentMemory;
  policy?: AgentPolicy;
  /** Domain-specific system prompt */
  systemPrompt?: string;
  /** Governance rules to inject into the system prompt */
  governanceRules?: string[];
  maxSteps?: number;
}

/**
 * Create an assistant with governance rules baked into the system prompt
 * and an optional policy for tool-call approval.
 */
export function createGovernedAssistant(opts: GovernedAssistantOptions): Agent {
  const rules = opts.governanceRules ?? [];
  const rulesBlock = rules.length > 0
    ? `\n\nGovernance rules:\n${rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}`
    : '';

  const systemPrompt = `You are a governed AI assistant. Follow all governance rules strictly.
If a user request violates any rule, decline politely and explain which rule applies.
${opts.systemPrompt ?? ''}${rulesBlock}`;

  return weaveAgent({
    name: opts.name ?? 'governed-assistant',
    model: opts.model,
    tools: opts.tools,
    bus: opts.bus,
    memory: opts.memory,
    policy: opts.policy,
    systemPrompt,
    maxSteps: opts.maxSteps ?? 20,
  });
}
