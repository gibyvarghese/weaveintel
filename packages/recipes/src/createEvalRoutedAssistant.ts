/**
 * @weaveintel/recipes — Eval-Routed Assistant
 *
 * Agent that routes requests based on eval scores or complexity classification.
 */

import type {
  Agent,
  Model,
  ToolRegistry,
  EventBus,
  AgentMemory,
} from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';

export interface EvalRoutedAssistantOptions {
  name?: string;
  /** Primary model for complex queries */
  primaryModel: Model;
  /** Fast/cheap model for simple queries */
  fallbackModel?: Model;
  tools?: ToolRegistry;
  bus?: EventBus;
  memory?: AgentMemory;
  /** Complexity threshold (0-1). Below → fallback, above → primary */
  complexityThreshold?: number;
  /** System prompt */
  systemPrompt?: string;
  maxSteps?: number;
}

/**
 * Create an eval-routed assistant. Uses the primary model by default.
 * When paired with routing logic, the fallbackModel handles simpler queries.
 */
export function createEvalRoutedAssistant(opts: EvalRoutedAssistantOptions): Agent {
  const threshold = opts.complexityThreshold ?? 0.5;
  const systemPrompt = `You are an intelligent assistant with routing awareness.
Your responses are evaluated for quality. Aim for accuracy, completeness, and conciseness.
Complexity threshold: ${threshold} — complex queries get more compute budget.
${opts.systemPrompt ?? ''}`;

  return weaveAgent({
    name: opts.name ?? 'eval-routed-assistant',
    model: opts.primaryModel,
    tools: opts.tools,
    bus: opts.bus,
    memory: opts.memory,
    systemPrompt,
    maxSteps: opts.maxSteps ?? 20,
  });
}
