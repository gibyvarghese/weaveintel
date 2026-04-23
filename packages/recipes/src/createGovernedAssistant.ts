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
  ExecutionContext,
  AgentStep,
  AgentUsage,
  ToolSchema,
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
  /** Governance rules injected into the system prompt for model guidance */
  governanceRules?: string[];
  /**
   * Tool names explicitly denied at runtime via AgentPolicy.approveToolCall.
   * This is the runtime enforcement layer; governanceRules is advisory only.
   */
  deniedTools?: string[];
  maxSteps?: number;
}

/**
 * Create an assistant with governance rules and runtime tool enforcement.
 *
 * Governance rules are injected into the system prompt as model-facing
 * guidance. Denied tools are enforced at runtime via AgentPolicy so the
 * block cannot be circumvented by model instructions.
 */
export function createGovernedAssistant(opts: GovernedAssistantOptions): Agent {
  const rules = opts.governanceRules ?? [];
  const denied = opts.deniedTools ?? [];
  const rulesBlock = rules.length > 0
    ? `\n\nGovernance rules:\n${rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}`
    : '';

  const systemPrompt = `You are a governed AI assistant. Follow all governance rules strictly.
If a user request violates any rule, decline politely and explain which rule applies.
${opts.systemPrompt ?? ''}${rulesBlock}`;

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
      // Runtime enforcement for denied tools — not advisory prompt text.
      if (denied.includes(tool.name)) {
        return { approved: false, reason: `Tool "${tool.name}" is denied by governance policy.` };
      }
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
    name: opts.name ?? 'governed-assistant',
    model: opts.model,
    tools: opts.tools,
    bus: opts.bus,
    memory: opts.memory,
    policy: effectivePolicy,
    systemPrompt,
    maxSteps: opts.maxSteps ?? 20,
  });
}
