/**
 * @weaveintel/a2a — Agent-as-A2A-server adapter (W6)
 *
 * `weaveAgentAsA2AServer` wraps a `weaveAgent` (or any `Agent`) as an `A2AServer`
 * value. Register the returned server on an `InternalA2ABus` for in-process
 * discovery, or mount it behind HTTP routes for external A2A clients.
 *
 * The adapter:
 *   1. Maps inbound `A2ATask.input.parts` to `AgentInput.messages` (text parts
 *      become user messages; data parts are JSON-stringified).
 *   2. Calls `agent.run(ctx, input)` under the normal guardrails/budget/audit path.
 *   3. Maps `AgentResult.output` back to an `A2ATaskResult` with `status: 'completed'`.
 *   4. For failures, maps to `status: 'failed'` with the error in `result.error`.
 *
 * Transport and HTTP serving stay in the app layer (geneWeave registers these
 * as HTTP routes behind auth — see apps/geneweave/src/routes/a2a.ts).
 *
 * @example
 * const server = weaveAgentAsA2AServer({
 *   agent: weaveAgent({ model, tools }),
 *   card: {
 *     name: 'research-agent',
 *     description: 'Performs scientific literature research',
 *     url: 'https://api.example.com/a2a/research-agent',
 *     capabilities: ['web-search', 'pdf-reading'],
 *   },
 * });
 * bus.register('research-agent', server);
 */

import type {
  Agent,
  AgentInput,
  A2AServer,
  A2ATask,
  A2ATaskResult,
  AgentCard,
  A2APart,
  ExecutionContext,
} from '@weaveintel/core';
import { weaveAudit } from '@weaveintel/core';

export interface AgentA2AServerOptions {
  /** The agent to wrap as an A2A server. */
  agent: Agent;
  /**
   * Agent Card published at `/.well-known/agent.json`.
   * Populate `url` with the public base URL if this agent is served externally.
   */
  card: AgentCard;
}

/**
 * Extract the text content from A2A task parts.
 * Text parts are concatenated; data parts are JSON-stringified.
 * File parts produce a placeholder (agents cannot process raw bytes here).
 */
function partsToContent(parts: readonly A2APart[]): string {
  return parts
    .map((p) => {
      if (p.type === 'text') return p.text;
      if (p.type === 'data') return JSON.stringify(p.data);
      if (p.type === 'file') return `[File attachment: ${p.mimeType}]`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function taskToAgentInput(task: A2ATask): AgentInput {
  const content = partsToContent(task.input.parts);
  return {
    messages: [{ role: 'user', content }],
    goal: task.skill,
    context: task.metadata as Record<string, unknown> | undefined,
  };
}

/**
 * Wrap a `weaveAgent` as an `A2AServer` for in-process and HTTP dispatch.
 *
 * The returned server:
 * - Exposes `server.card` for discovery (Agent Card)
 * - Implements `server.handleTask(ctx, task)` for polling mode
 * - Implements `server.handleTaskStream(ctx, task)` for SSE streaming mode
 *
 * All execution runs under the agent's existing guardrails, budget, and
 * audit trail — no special permissions are granted by the A2A surface.
 */
export function weaveAgentAsA2AServer(opts: AgentA2AServerOptions): A2AServer {
  const { agent, card } = opts;

  return {
    card,

    async handleTask(ctx: ExecutionContext, task: A2ATask): Promise<A2ATaskResult> {
      void weaveAudit(ctx, {
        action: 'a2a.task.received',
        outcome: 'success',
        resource: agent.config.name,
        details: { taskId: task.id, skill: task.skill },
      });

      let agentResult;
      try {
        agentResult = await agent.run(ctx, taskToAgentInput(task));
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        void weaveAudit(ctx, {
          action: 'a2a.task.error',
          outcome: 'failure',
          resource: agent.config.name,
          details: { taskId: task.id, error },
        });
        return {
          id: task.id,
          status: 'failed',
          error,
        };
      }

      if (agentResult.status === 'failed' || agentResult.status === 'cancelled') {
        return {
          id: task.id,
          status: agentResult.status === 'cancelled' ? 'cancelled' : 'failed',
          error: agentResult.output || `Agent ended with status: ${agentResult.status}`,
        };
      }

      void weaveAudit(ctx, {
        action: 'a2a.task.completed',
        outcome: 'success',
        resource: agent.config.name,
        details: { taskId: task.id, steps: agentResult.usage.totalSteps },
      });

      return {
        id: task.id,
        status: 'completed',
        output: {
          role: 'agent',
          parts: [{ type: 'text', text: agentResult.output }],
        },
        metadata: {
          steps: agentResult.usage.totalSteps,
          tokens: agentResult.usage.totalTokens,
          durationMs: agentResult.usage.totalDurationMs,
        },
      };
    },

    async *handleStreamTask(ctx: ExecutionContext, task: A2ATask): AsyncIterable<A2ATaskResult> {
      void weaveAudit(ctx, {
        action: 'a2a.task.stream.start',
        outcome: 'success',
        resource: agent.config.name,
        details: { taskId: task.id, skill: task.skill },
      });

      // Emit a working status immediately so the SSE client knows we started.
      yield { id: task.id, status: 'working' };

      if (!agent.runStream) {
        // Agent doesn't support streaming — fall back to run() and yield the result.
        const result = await this.handleTask(ctx, task);
        yield result;
        return;
      }

      let lastOutput = '';
      let streamError: string | undefined;

      try {
        for await (const event of agent.runStream(ctx, taskToAgentInput(task))) {
          if (event.type === 'text_chunk' && event.text) {
            lastOutput += event.text;
            // Emit incremental text chunks as working+partial results.
            yield {
              id: task.id,
              status: 'working',
              output: {
                role: 'agent',
                parts: [{ type: 'text', text: event.text }],
              },
              metadata: { partial: true },
            };
          }
          if (event.type === 'done' && event.result) {
            lastOutput = event.result.output || lastOutput;
          }
        }
      } catch (err) {
        streamError = err instanceof Error ? err.message : String(err);
      }

      if (streamError) {
        void weaveAudit(ctx, { action: 'a2a.task.stream.error', outcome: 'failure', resource: agent.config.name, details: { taskId: task.id, error: streamError } });
        yield { id: task.id, status: 'failed', error: streamError };
        return;
      }

      void weaveAudit(ctx, { action: 'a2a.task.stream.completed', outcome: 'success', resource: agent.config.name, details: { taskId: task.id } });
      yield {
        id: task.id,
        status: 'completed',
        output: {
          role: 'agent',
          parts: [{ type: 'text', text: lastOutput }],
        },
      };
    },

    async start(_port: number): Promise<void> {
      // HTTP serving is handled by the host application (geneWeave routes).
      // This no-op satisfies the A2AServer contract for in-process bus usage.
    },

    async stop(): Promise<void> {
      // No-op for in-process adapters.
    },
  };
}
