/**
 * @weaveintel/recipes — Workflow Agent
 *
 * Pre-configured agent that executes multi-step workflows with state tracking.
 */

import type {
  Agent,
  Model,
  ToolRegistry,
  EventBus,
  AgentMemory,
  ExecutionContext,
  AgentInput,
  AgentResult,
} from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';

export interface WorkflowAgentOptions {
  name?: string;
  model: Model;
  tools?: ToolRegistry;
  bus?: EventBus;
  memory?: AgentMemory;
  /** System prompt that includes workflow step instructions */
  workflowInstructions: string;
  /** Max steps for the agent loop */
  maxSteps?: number;
}

/**
 * Create a workflow-aware agent that follows structured step instructions.
 * The system prompt is augmented with step-tracking guidance.
 */
export function createWorkflowAgent(opts: WorkflowAgentOptions): Agent {
  const systemPrompt = `You are a workflow execution agent. Follow the steps precisely.
Report each step's progress before moving to the next.

${opts.workflowInstructions}

Always indicate which step you're on and whether it passed or failed.`;

  return weaveAgent({
    name: opts.name ?? 'workflow-agent',
    model: opts.model,
    tools: opts.tools,
    bus: opts.bus,
    memory: opts.memory,
    systemPrompt,
    maxSteps: opts.maxSteps ?? 30,
  });
}
