/**
 * @weaveintel/a2a — Agent-as-A2A-server adapter (v1.0)
 *
 * `weaveAgentAsA2AServer` wraps any `Agent` as an `A2AServer` conforming to
 * A2A v1.0. Register the returned server on an `InternalA2ABus` for in-process
 * discovery, or mount it behind HTTP routes for external A2A clients.
 *
 * v1.0 changes vs v0.3:
 *   - `handleMessage(ctx, params: A2ATaskSendParams)` is the primary handler
 *   - Returns `A2ATask` (with contextId, artifacts[], history[]) not A2ATaskResult
 *   - `handleStreamMessage` yields `A2AStreamEvent` (statusUpdate + artifactUpdate)
 *   - `handleTask` / `handleStreamTask` kept as deprecated shims for old callers
 *
 * @example
 * const server = weaveAgentAsA2AServer({
 *   agent: weaveAgent({ model, tools }),
 *   card: {
 *     name: 'research-agent',
 *     description: 'Performs research tasks',
 *     version: '1.0.0',
 *     skills: [{ id: 'research', name: 'Research', description: 'Web research' }],
 *     capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false, stateTransitionHistory: false },
 *     supportedInterfaces: [{ url: 'https://api.example.com/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
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
  A2ATaskLegacy,
  A2ATaskSendParams,
  A2AStreamEvent,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
  A2AArtifact,
  AgentCard,
  A2APart,
  A2AMessage,
  ExecutionContext,
} from '@weaveintel/core';
import {
  weaveAudit,
  newUUIDv7,
  a2aPartsText,
  makeCompletedA2ATask,
  makeFailedA2ATask,
} from '@weaveintel/core';

export interface AgentA2AServerOptions {
  /** The agent to wrap as an A2A server. */
  agent: Agent;
  /**
   * Agent Card published at `/.well-known/agent-card.json`.
   * `supportedInterfaces[0].url` should be the public base URL of this agent.
   */
  card: AgentCard;
}

/** Extract text from v1.0 parts (field-presence, no `type` discriminator). */
function partsToContent(parts: readonly A2APart[]): string {
  return parts
    .map((p) => {
      if (typeof p.text === 'string') return p.text;
      if (p.data !== undefined) return JSON.stringify(p.data);
      if (typeof p.url === 'string') return `[File: ${p.filename ?? p.url}]`;
      if (typeof p.raw === 'string') return `[Binary: ${p.mediaType ?? 'application/octet-stream'}]`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function sendParamsToAgentInput(params: A2ATaskSendParams): AgentInput {
  const content = partsToContent(params.message.parts);
  return {
    messages: [{ role: 'user', content }],
    context: params.metadata as Record<string, unknown> | undefined,
  };
}

/**
 * Wrap a `weaveAgent` as an `A2AServer` for in-process bus and HTTP dispatch.
 */
export function weaveAgentAsA2AServer(opts: AgentA2AServerOptions): A2AServer {
  const { agent, card } = opts;

  return {
    card,

    async handleMessage(ctx: ExecutionContext, params: A2ATaskSendParams): Promise<A2ATask> {
      const taskId = newUUIDv7();
      const contextId = params.message.contextId ?? taskId;
      const history: A2AMessage[] = [params.message];

      void weaveAudit(ctx, {
        action: 'a2a.task.received',
        outcome: 'success',
        resource: agent.config.name,
        details: { taskId, contextId },
      });

      let agentResult;
      try {
        agentResult = await agent.run(ctx, sendParamsToAgentInput(params));
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        void weaveAudit(ctx, {
          action: 'a2a.task.error',
          outcome: 'failure',
          resource: agent.config.name,
          details: { taskId, error },
        });
        return makeFailedA2ATask(taskId, contextId, error, history);
      }

      if (agentResult.status === 'failed' || agentResult.status === 'cancelled') {
        const error = agentResult.output || `Agent ended with status: ${agentResult.status}`;
        return makeFailedA2ATask(taskId, contextId, error, history);
      }

      void weaveAudit(ctx, {
        action: 'a2a.task.completed',
        outcome: 'success',
        resource: agent.config.name,
        details: { taskId, steps: agentResult.usage.totalSteps },
      });

      const agentMessage: A2AMessage = { role: 'agent', parts: [{ text: agentResult.output }] };
      history.push(agentMessage);

      return {
        ...makeCompletedA2ATask(taskId, contextId, agentResult.output, history),
        metadata: {
          steps: agentResult.usage.totalSteps,
          tokens: agentResult.usage.totalTokens,
          durationMs: agentResult.usage.totalDurationMs,
        },
      };
    },

    async *handleStreamMessage(ctx: ExecutionContext, params: A2ATaskSendParams): AsyncIterable<A2AStreamEvent> {
      const taskId = newUUIDv7();
      const contextId = params.message.contextId ?? taskId;
      const history: A2AMessage[] = [params.message];

      void weaveAudit(ctx, {
        action: 'a2a.task.stream.start',
        outcome: 'success',
        resource: agent.config.name,
        details: { taskId, contextId },
      });

      // Initial WORKING status event
      const workingEvent: TaskStatusUpdateEvent = {
        taskId,
        contextId,
        status: { state: 'TASK_STATE_WORKING', timestamp: new Date().toISOString() },
      };
      yield { statusUpdate: workingEvent };

      if (!agent.runStream) {
        // Fallback to synchronous handleMessage
        const result = await this.handleMessage(ctx, params);
        yield { task: result };
        return;
      }

      let lastOutput = '';
      let streamError: string | undefined;
      let chunkIndex = 0;

      try {
        for await (const event of agent.runStream(ctx, sendParamsToAgentInput(params))) {
          if (event.type === 'text_chunk' && event.text) {
            lastOutput += event.text;

            const artifactUpdate: TaskArtifactUpdateEvent = {
              taskId,
              contextId,
              artifact: {
                artifactId: `${taskId}-output`,
                name: 'output',
                parts: [{ text: event.text }],
              },
              append: chunkIndex > 0,
              lastChunk: false,
            };
            yield { artifactUpdate };
            chunkIndex++;
          }
          if (event.type === 'done' && event.result) {
            lastOutput = event.result.output || lastOutput;
          }
        }
      } catch (err) {
        streamError = err instanceof Error ? err.message : String(err);
      }

      if (streamError) {
        void weaveAudit(ctx, {
          action: 'a2a.task.stream.error',
          outcome: 'failure',
          resource: agent.config.name,
          details: { taskId, error: streamError },
        });
        const failedTask = makeFailedA2ATask(taskId, contextId, streamError, history);
        yield { task: failedTask };
        return;
      }

      // Final lastChunk artifact event
      if (chunkIndex > 0) {
        const finalArtifact: A2AArtifact = {
          artifactId: `${taskId}-output`,
          name: 'output',
          parts: [{ text: lastOutput }],
        };
        const lastChunkEvent: TaskArtifactUpdateEvent = {
          taskId,
          contextId,
          artifact: finalArtifact,
          append: false,
          lastChunk: true,
        };
        yield { artifactUpdate: lastChunkEvent };
      }

      void weaveAudit(ctx, {
        action: 'a2a.task.stream.completed',
        outcome: 'success',
        resource: agent.config.name,
        details: { taskId },
      });

      const agentMessage: A2AMessage = { role: 'agent', parts: [{ text: lastOutput }] };
      history.push(agentMessage);

      const completedTask = makeCompletedA2ATask(taskId, contextId, lastOutput, history);
      yield { task: completedTask };
    },

    // ── Deprecated shims ─────────────────────────────────────────────────────

    /** @deprecated Use handleMessage(). Kept for callers using the old A2ATask shape. */
    async handleTask(ctx: ExecutionContext, task: A2ATaskLegacy): Promise<A2ATaskResult> {
      const params: A2ATaskSendParams = {
        message: task.input,
        metadata: task.metadata,
      };
      const result = await this.handleMessage(ctx, params);
      // Convert A2ATask → deprecated A2ATaskResult
      const outputText = a2aPartsText(result.artifacts[0]?.parts ?? []);
      return {
        id: task.id,
        status: result.status.state === 'TASK_STATE_COMPLETED' ? 'completed' : 'failed',
        output: outputText ? { role: 'agent', parts: [{ text: outputText }] } : undefined,
        error: result.status.state !== 'TASK_STATE_COMPLETED'
          ? a2aPartsText(result.status.message?.parts ?? []) || undefined
          : undefined,
        metadata: result.metadata,
      };
    },

    /** @deprecated Use handleStreamMessage(). */
    async *handleStreamTask(ctx: ExecutionContext, task: A2ATaskLegacy): AsyncIterable<A2ATaskResult> {
      const params: A2ATaskSendParams = { message: task.input, metadata: task.metadata };
      for await (const event of this.handleStreamMessage!(ctx, params)) {
        if ('statusUpdate' in event) {
          yield {
            id: task.id,
            status: event.statusUpdate.status.state === 'TASK_STATE_COMPLETED' ? 'completed' : 'working',
          };
        } else if ('artifactUpdate' in event) {
          const text = event.artifactUpdate.artifact.parts
            .map((p) => (typeof p.text === 'string' ? p.text : ''))
            .join('');
          if (text) {
            yield {
              id: task.id,
              status: 'working',
              output: { role: 'agent', parts: [{ text }] },
              metadata: { partial: true },
            };
          }
        } else if ('task' in event) {
          const t = event.task;
          const outputText = a2aPartsText(t.artifacts[0]?.parts ?? []);
          yield {
            id: task.id,
            status: t.status.state === 'TASK_STATE_COMPLETED' ? 'completed' : 'failed',
            output: outputText ? { role: 'agent', parts: [{ text: outputText }] } : undefined,
            error: t.status.state !== 'TASK_STATE_COMPLETED'
              ? a2aPartsText(t.status.message?.parts ?? []) || undefined
              : undefined,
          };
        }
      }
    },

    async start(_port: number): Promise<void> {
      // HTTP serving handled by host app (geneWeave registers routes).
    },

    async stop(): Promise<void> {
      // No-op for in-process adapters.
    },
  };
}
