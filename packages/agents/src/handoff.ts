/**
 * @weaveintel/agents — P3-2: Agent handoff (lateral transfer)
 *
 * Enables an agent to transfer control to a peer agent mid-task, without
 * requiring a supervisor at the top of the hierarchy.
 *
 * Each entry in `ToolCallingAgentOptions.handoffs` registers a synthetic
 * `transfer_to_<name>` tool. When the LLM calls that tool:
 *   1. A `HandoffSignal` is thrown from the tool's `invoke()`.
 *   2. `executeToolCall` propagates it (not caught as a normal tool error).
 *   3. The agent loop catches `HandoffSignal` and runs the target agent.
 *   4. The target agent's result is returned as the current agent's result,
 *      with `metadata.handoff` describing the transfer.
 *
 * Useful for:
 *   - Triage bots that route to specialist agents
 *   - Escalation chains (support → billing → human)
 *   - A2A-style peer networks without a top-level supervisor
 */

import type { Agent, AgentInput, ExecutionContext, Tool } from '@weaveintel/core';
import { weaveTool } from '@weaveintel/core';

// ─── Public types ─────────────────────────────────────────────

export interface HandoffDefinition {
  /**
   * Short slug (no spaces).  A tool named `transfer_to_<name>` is registered
   * automatically.
   */
  name: string;
  /** Description shown to the LLM explaining when to hand off to this agent. */
  description: string;
  /** The peer agent to run after the handoff. */
  agent: Agent;
  /**
   * Optional filter: when provided, the handoff is only offered to the model
   * (i.e. the tool is registered) if the filter returns `true`.  The check
   * runs once at agent construction time with a null context.
   */
  filter?: (ctx: ExecutionContext | null) => boolean;
}

export interface HandoffMetadata {
  /** Name of the agent that initiated the handoff. */
  from: string;
  /** Name of the target agent that handled the request. */
  to: string;
  /**
   * The input string that was passed to the target agent.
   * This is the `context` argument from the transfer tool call.
   */
  transferInput: string | undefined;
}

// ─── Internal signal (propagated through executeToolCall) ─────

/**
 * Thrown by a handoff tool's `invoke()` to signal that the current agent
 * should yield control to `targetAgent`.  Not a real error — caught by the
 * agent loop specifically to execute the transfer.
 */
export class HandoffSignal extends Error {
  constructor(
    readonly targetAgent: Agent,
    readonly targetName: string,
    readonly transferInput: AgentInput,
  ) {
    super('__WEAVE_HANDOFF__');
    this.name = 'HandoffSignal';
  }
}

// ─── Tool builder ─────────────────────────────────────────────

/**
 * Build the `transfer_to_<name>` tool for each handoff definition.
 * Returns only the tools for definitions whose `filter` passes (or have no
 * filter).  Call this once when constructing the agent.
 */
export function buildHandoffTools(
  handoffs: HandoffDefinition[],
  callerCtx: ExecutionContext | null = null,
): Tool[] {
  return handoffs
    .filter((h) => !h.filter || h.filter(callerCtx))
    .map((h) =>
      weaveTool({
        name: `transfer_to_${h.name}`,
        description: `${h.description}\n\nCalling this tool transfers control to the "${h.name}" agent. The current conversation context and any relevant information should be passed as the 'context' argument.`,
        parameters: {
          type: 'object' as const,
          properties: {
            context: {
              type: 'string',
              description:
                'Summary of the conversation and task context to pass to the target agent. Be thorough — the target agent only sees what you include here.',
            },
            reason: {
              type: 'string',
              description: 'Brief explanation of why you are transferring to this agent.',
            },
          },
          required: ['context'],
        },
        execute: async (args) => {
          const { context, reason } = args as { context: string; reason?: string };
          void reason;
          const input: AgentInput = {
            goal: context,
            messages: [{ role: 'user', content: context }],
          };
          throw new HandoffSignal(h.agent, h.name, input);
        },
      }),
    );
}
