/**
 * @weaveintel/recipes — Event-Driven Agent
 *
 * Agent that reacts to events from the EventBus and emits structured events.
 */

import type {
  Agent,
  Model,
  ToolRegistry,
  EventBus,
  AgentMemory,
} from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';

export interface EventDrivenAgentOptions {
  name?: string;
  model: Model;
  tools?: ToolRegistry;
  bus: EventBus;
  memory?: AgentMemory;
  /** Event types this agent listens to */
  listenTo?: string[];
  /** System prompt */
  systemPrompt?: string;
  maxSteps?: number;
}

/**
 * Create an event-driven agent that is designed to operate within
 * an event-bus architecture. The bus is required.
 */
export function createEventDrivenAgent(opts: EventDrivenAgentOptions): Agent {
  const events = opts.listenTo ?? [];
  const eventBlock = events.length > 0
    ? `\n\nYou respond to these event types: ${events.join(', ')}.
Process each event and emit appropriate response events.`
    : '';

  const systemPrompt = `You are an event-driven agent operating in a reactive architecture.
Process incoming events and produce structured, actionable outputs.
${opts.systemPrompt ?? ''}${eventBlock}`;

  return weaveAgent({
    name: opts.name ?? 'event-driven-agent',
    model: opts.model,
    tools: opts.tools,
    bus: opts.bus,
    memory: opts.memory,
    systemPrompt,
    maxSteps: opts.maxSteps ?? 20,
  });
}
