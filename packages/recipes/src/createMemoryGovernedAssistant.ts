/**
 * @weaveintel/recipes — Memory-Governed Assistant
 *
 * Agent with memory retention policies and semantic memory integration.
 */

import type {
  Agent,
  Model,
  ToolRegistry,
  EventBus,
  AgentMemory,
} from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';

export interface MemoryGovernedAssistantOptions {
  name?: string;
  model: Model;
  tools?: ToolRegistry;
  bus?: EventBus;
  memory: AgentMemory;
  /** Max conversation turns to keep in context */
  maxTurns?: number;
  /** Memory types to use */
  memoryTypes?: Array<'conversation' | 'semantic' | 'entity'>;
  /** System prompt */
  systemPrompt?: string;
  maxSteps?: number;
}

/**
 * Create an assistant with governed memory — enforced turn limits,
 * memory type configuration, and context-aware retrieval.
 */
export function createMemoryGovernedAssistant(opts: MemoryGovernedAssistantOptions): Agent {
  const maxTurns = opts.maxTurns ?? 20;
  const types = opts.memoryTypes ?? ['conversation'];
  const memoryBlock = `\n\nMemory governance:
- Max conversation turns: ${maxTurns}
- Active memory types: ${types.join(', ')}
When the conversation exceeds ${maxTurns} turns, summarize earlier context.
Never fabricate memories. Only reference information you have actually seen.`;

  const systemPrompt = `You are a memory-aware assistant with governed recall.
${opts.systemPrompt ?? ''}${memoryBlock}`;

  return weaveAgent({
    name: opts.name ?? 'memory-governed',
    model: opts.model,
    tools: opts.tools,
    bus: opts.bus,
    memory: opts.memory,
    systemPrompt,
    maxSteps: opts.maxSteps ?? 20,
  });
}
