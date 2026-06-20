/**
 * @weaveintel/a2a — Agent-as-A2A-server adapter (v1.0, Phase 3)
 *
 * `weaveAgentAsA2AServer` wraps any `Agent` as an `A2AServer` conforming to
 * A2A v1.0. Phase 3 additions vs Phase 2:
 *
 *   - Durable task store: every task transitions through SUBMITTED → WORKING → terminal
 *   - Full A2A v1.0 state machine:
 *       SUBMITTED → WORKING → COMPLETED | FAILED | REJECTED | INPUT_REQUIRED | AUTH_REQUIRED | CANCELED
 *   - Multi-turn resumption: `params.message.taskId` continues an INPUT_REQUIRED task
 *   - Guardrail pre-check: `ctx.runtime?.guardrails?.checkInput` blocks before running
 *   - AgentResult.status mapping:
 *       'completed'       → TASK_STATE_COMPLETED
 *       'failed'          → TASK_STATE_FAILED
 *       'cancelled'       → TASK_STATE_CANCELED
 *       'budget_exceeded' → TASK_STATE_FAILED
 *       'needs_approval'  → TASK_STATE_INPUT_REQUIRED
 *       'guardrail_denied'→ TASK_STATE_REJECTED
 *   - getTask / listTasks / cancelTask wired to task store
 *   - Deprecated shims (handleTask / handleStreamTask) preserved
 *
 * @example
 * const store = createInMemoryA2ATaskStore();
 * const server = weaveAgentAsA2AServer({
 *   agent: weaveAgent({ model, tools }),
 *   card: { ... },
 *   store,
 * });
 */

import type {
  Agent,
  AgentInput,
  AgentResult,
  A2AServer,
  A2ATask,
  A2ATaskResult,
  A2ATaskLegacy,
  A2ATaskSendParams,
  A2AStreamEvent,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
  A2AArtifact,
  A2AListTasksFilter,
  AgentCard,
  A2APart,
  A2AMessage,
  A2ATaskState,
  ExecutionContext,
} from '@weaveintel/core';
import {
  weaveAudit,
  newUUIDv7,
  a2aPartsText,
  makeCompletedA2ATask,
  makeFailedA2ATask,
} from '@weaveintel/core';
import type { A2ATaskStore } from './task-store.js';

export interface AgentA2AServerOptions {
  /** The agent to wrap as an A2A server. */
  agent: Agent;
  /**
   * Agent Card published at `/.well-known/agent-card.json`.
   * `supportedInterfaces[0].url` should be the public base URL of this agent.
   */
  card: AgentCard;
  /**
   * Task store for durable state persistence (Phase 3).
   * When omitted, tasks are computed synchronously and not stored — calling
   * `getTask` / `listTasks` / `cancelTask` will return UNSUPPORTED errors.
   * Pass `createInMemoryA2ATaskStore()` for development or
   * `createDurableA2ATaskStore(kv)` for production.
   */
  store?: A2ATaskStore;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

/** Convert A2AMessage history to AgentInput messages for multi-turn context. */
function historyToAgentInput(
  history: readonly A2AMessage[],
  metadata?: Record<string, unknown>,
): AgentInput {
  return {
    messages: history.map((msg) => ({
      role: (msg.role === 'agent' ? 'assistant' : 'user') as 'user' | 'assistant',
      content: partsToContent(msg.parts),
    })),
    context: metadata as Record<string, unknown> | undefined,
  };
}

function sendParamsToAgentInput(params: A2ATaskSendParams): AgentInput {
  return {
    messages: [{ role: 'user', content: partsToContent(params.message.parts) }],
    context: params.metadata as Record<string, unknown> | undefined,
  };
}

/** Map AgentResult.status → A2ATaskState. */
function mapAgentStatus(status: AgentResult['status']): A2ATaskState {
  switch (status) {
    case 'completed':       return 'TASK_STATE_COMPLETED';
    case 'failed':          return 'TASK_STATE_FAILED';
    case 'cancelled':       return 'TASK_STATE_CANCELED';
    case 'budget_exceeded': return 'TASK_STATE_FAILED';
    case 'needs_approval':  return 'TASK_STATE_INPUT_REQUIRED';
    case 'guardrail_denied':return 'TASK_STATE_REJECTED';
    default:                return 'TASK_STATE_FAILED';
  }
}

/** Build the final A2ATask from an AgentResult given the mapped state. */
function buildFinalTask(
  taskId: string,
  contextId: string,
  agentResult: AgentResult,
  finalState: A2ATaskState,
  history: readonly A2AMessage[],
): A2ATask {
  const timestamp = new Date().toISOString();

  if (finalState === 'TASK_STATE_COMPLETED') {
    return {
      ...makeCompletedA2ATask(taskId, contextId, agentResult.output, history),
      metadata: {
        steps: agentResult.usage.totalSteps,
        tokens: agentResult.usage.totalTokens,
        durationMs: agentResult.usage.totalDurationMs,
      },
    };
  }

  if (finalState === 'TASK_STATE_INPUT_REQUIRED' || finalState === 'TASK_STATE_AUTH_REQUIRED') {
    return {
      id: taskId,
      contextId,
      status: {
        state: finalState,
        message: {
          role: 'agent',
          parts: [{ text: agentResult.output || 'Agent is waiting for additional input.' }],
          contextId,
          taskId,
        },
        timestamp,
      },
      artifacts: [],
      history,
      metadata: agentResult.metadata,
    };
  }

  if (finalState === 'TASK_STATE_REJECTED') {
    return {
      id: taskId,
      contextId,
      status: {
        state: 'TASK_STATE_REJECTED',
        message: {
          role: 'agent',
          parts: [{ text: agentResult.output || 'Task rejected by guardrail policy.' }],
        },
        timestamp,
      },
      artifacts: [],
      history,
    };
  }

  if (finalState === 'TASK_STATE_CANCELED') {
    return {
      id: taskId,
      contextId,
      status: {
        state: 'TASK_STATE_CANCELED',
        message: agentResult.output
          ? { role: 'agent', parts: [{ text: agentResult.output }] }
          : undefined,
        timestamp,
      },
      artifacts: [],
      history,
    };
  }

  // FAILED / unknown
  return makeFailedA2ATask(
    taskId,
    contextId,
    agentResult.output || `Agent ended with status: ${finalState}`,
    history,
  );
}

// ─── Core run logic ───────────────────────────────────────────────────────────

async function runAgentWithStateTransitions(
  agent: Agent,
  ctx: ExecutionContext,
  taskId: string,
  contextId: string,
  agentInput: AgentInput,
  history: readonly A2AMessage[],
  store: A2ATaskStore | undefined,
): Promise<A2ATask> {
  // Guardrail input check (best-effort — never load-bearing)
  const guardrails = ctx.runtime?.guardrails;
  if (guardrails?.checkInput) {
    const lastUserMsg = [...history].reverse().find((m) => m.role === 'user');
    const inputText = lastUserMsg ? partsToContent(lastUserMsg.parts) : '';
    try {
      const check = await guardrails.checkInput(ctx, inputText);
      if (!check.allow) {
        const rejectedTask: A2ATask = {
          id: taskId,
          contextId,
          status: {
            state: 'TASK_STATE_REJECTED',
            message: {
              role: 'agent',
              parts: [{ text: check.reason ?? 'Input rejected by guardrail policy.' }],
            },
            timestamp: new Date().toISOString(),
          },
          artifacts: [],
          history,
        };
        if (store) await store.save(rejectedTask);
        void weaveAudit(ctx, {
          action: 'a2a.task.rejected',
          outcome: 'failure',
          resource: agent.config.name,
          details: { taskId, reason: check.reason },
        });
        return rejectedTask;
      }
    } catch {
      // Swallow — guardrails are never load-bearing
    }
  }

  // Transition to WORKING
  if (store) {
    await store.update(taskId, {
      status: { state: 'TASK_STATE_WORKING', timestamp: new Date().toISOString() },
    });
  }

  // Run agent
  let agentResult: AgentResult;
  try {
    agentResult = await agent.run(ctx, agentInput);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    void weaveAudit(ctx, {
      action: 'a2a.task.error',
      outcome: 'failure',
      resource: agent.config.name,
      details: { taskId, error },
    });
    const failedTask = makeFailedA2ATask(taskId, contextId, error, history);
    if (store) await store.save(failedTask);
    return failedTask;
  }

  const finalState = mapAgentStatus(agentResult.status);
  const agentMessage: A2AMessage = {
    role: 'agent',
    parts: [{ text: agentResult.output }],
    contextId,
    taskId,
  };
  const finalHistory: readonly A2AMessage[] = [...history, agentMessage];
  const finalTask = buildFinalTask(taskId, contextId, agentResult, finalState, finalHistory);

  if (store) await store.save(finalTask);

  void weaveAudit(ctx, {
    action: finalState === 'TASK_STATE_COMPLETED' ? 'a2a.task.completed' : 'a2a.task.terminal',
    outcome: finalState === 'TASK_STATE_COMPLETED' ? 'success' : 'failure',
    resource: agent.config.name,
    details: { taskId, state: finalState, steps: agentResult.usage.totalSteps },
  });

  return finalTask;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Wrap a `weaveAgent` as an `A2AServer` for in-process bus and HTTP dispatch.
 */
export function weaveAgentAsA2AServer(opts: AgentA2AServerOptions): A2AServer {
  const { agent, card, store } = opts;

  return {
    card,

    async handleMessage(ctx: ExecutionContext, params: A2ATaskSendParams): Promise<A2ATask> {
      // ── Multi-turn RESUME path ─────────────────────────────────────────────
      if (params.message.taskId && store) {
        const existingTaskId = params.message.taskId;
        const existing = await store.load(existingTaskId);

        if (!existing) {
          return makeFailedA2ATask(
            existingTaskId,
            params.message.contextId ?? existingTaskId,
            `Multi-turn resume failed: task not found: ${existingTaskId}`,
          );
        }

        if (
          existing.status.state !== 'TASK_STATE_INPUT_REQUIRED' &&
          existing.status.state !== 'TASK_STATE_AUTH_REQUIRED'
        ) {
          return makeFailedA2ATask(
            existingTaskId,
            existing.contextId,
            `Cannot resume task in state ${existing.status.state} (must be INPUT_REQUIRED or AUTH_REQUIRED)`,
            existing.history,
          );
        }

        const updatedHistory: readonly A2AMessage[] = [...existing.history, params.message];
        await store.update(existingTaskId, { history: updatedHistory });

        void weaveAudit(ctx, {
          action: 'a2a.task.resume',
          outcome: 'success',
          resource: agent.config.name,
          details: { taskId: existingTaskId, contextId: existing.contextId },
        });

        return runAgentWithStateTransitions(
          agent,
          ctx,
          existingTaskId,
          existing.contextId,
          historyToAgentInput(updatedHistory, params.metadata),
          updatedHistory,
          store,
        );
      }

      // ── New task path ──────────────────────────────────────────────────────
      const taskId = newUUIDv7();
      const contextId = params.message.contextId ?? taskId;
      const history: readonly A2AMessage[] = [params.message];
      const submittedAt = new Date().toISOString();

      const submittedTask: A2ATask = {
        id: taskId,
        contextId,
        status: { state: 'TASK_STATE_SUBMITTED', timestamp: submittedAt },
        artifacts: [],
        history,
        metadata: { submittedAt },
      };
      if (store) await store.save(submittedTask);

      void weaveAudit(ctx, {
        action: 'a2a.task.received',
        outcome: 'success',
        resource: agent.config.name,
        details: { taskId, contextId },
      });

      // returnImmediately: save SUBMITTED, run agent in background, return immediately.
      // Callers poll GetTask or subscribe via SubscribeToTask for completion.
      // Requires a store — without one, fall through to synchronous processing.
      if (params.configuration?.returnImmediately && store) {
        void runAgentWithStateTransitions(
          agent, ctx, taskId, contextId,
          sendParamsToAgentInput(params), history, store,
        ).catch((err: unknown) => {
          const error = err instanceof Error ? err.message : String(err);
          void weaveAudit(ctx, {
            action: 'a2a.task.background.error',
            outcome: 'failure',
            resource: agent.config.name,
            details: { taskId, error },
          });
          // Best-effort FAILED update if background processing crashes
          void store.update(taskId, {
            status: { state: 'TASK_STATE_FAILED', timestamp: new Date().toISOString() },
          }).catch(() => {});
        });
        return submittedTask;
      }

      return runAgentWithStateTransitions(
        agent,
        ctx,
        taskId,
        contextId,
        sendParamsToAgentInput(params),
        history,
        store,
      );
    },

    async *handleStreamMessage(
      ctx: ExecutionContext,
      params: A2ATaskSendParams,
    ): AsyncIterable<A2AStreamEvent> {
      const taskId = newUUIDv7();
      const contextId = params.message.contextId ?? taskId;
      const history: A2AMessage[] = [params.message];

      const submittedTask: A2ATask = {
        id: taskId,
        contextId,
        status: { state: 'TASK_STATE_SUBMITTED', timestamp: new Date().toISOString() },
        artifacts: [],
        history,
      };
      if (store) await store.save(submittedTask);

      void weaveAudit(ctx, {
        action: 'a2a.task.stream.start',
        outcome: 'success',
        resource: agent.config.name,
        details: { taskId, contextId },
      });

      // Emit WORKING status
      const workingEvent: TaskStatusUpdateEvent = {
        taskId,
        contextId,
        status: { state: 'TASK_STATE_WORKING', timestamp: new Date().toISOString() },
      };
      if (store) await store.update(taskId, { status: workingEvent.status });
      yield { statusUpdate: workingEvent };

      if (!agent.runStream) {
        // Fallback to synchronous handleMessage (but via non-storing path)
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
        if (store) await store.save(failedTask);
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

      const agentMessage: A2AMessage = {
        role: 'agent',
        parts: [{ text: lastOutput }],
        contextId,
        taskId,
      };
      history.push(agentMessage);

      const completedTask = makeCompletedA2ATask(taskId, contextId, lastOutput, history);
      if (store) await store.save(completedTask);
      yield { task: completedTask };
    },

    // ── Store-backed task management ─────────────────────────────────────────

    async getTask(ctx: ExecutionContext, taskId: string): Promise<A2ATask | null> {
      if (!store) return null;
      void ctx;
      return store.load(taskId);
    },

    async listTasks(
      ctx: ExecutionContext,
      filter?: A2AListTasksFilter,
    ) {
      if (!store) return { tasks: [], nextPageToken: undefined, totalSize: 0 };
      void ctx;
      return store.list(filter);
    },

    async cancelTask(ctx: ExecutionContext, taskId: string): Promise<void> {
      if (!store) return;
      const task = await store.load(taskId);
      if (!task) return;
      // Mark as CANCELED (in-flight agents are not interrupted in Phase 3)
      await store.update(taskId, {
        status: { state: 'TASK_STATE_CANCELED', timestamp: new Date().toISOString() },
      });
      void weaveAudit(ctx, {
        action: 'a2a.task.canceled',
        outcome: 'success',
        resource: agent.config.name,
        details: { taskId },
      });
    },

    // ── Deprecated shims ─────────────────────────────────────────────────────

    /** @deprecated Use handleMessage(). Kept for callers using the old A2ATask shape. */
    async handleTask(ctx: ExecutionContext, task: A2ATaskLegacy): Promise<A2ATaskResult> {
      const params: A2ATaskSendParams = {
        message: task.input,
        metadata: task.metadata,
      };
      const result = await this.handleMessage(ctx, params);
      const outputText = a2aPartsText(result.artifacts[0]?.parts ?? []);
      return {
        id: task.id,
        status: result.status.state === 'TASK_STATE_COMPLETED' ? 'completed' : 'failed',
        output: outputText ? { role: 'agent', parts: [{ text: outputText }] } : undefined,
        error:
          result.status.state !== 'TASK_STATE_COMPLETED'
            ? a2aPartsText(result.status.message?.parts ?? []) || undefined
            : undefined,
        metadata: result.metadata,
      };
    },

    /** @deprecated Use handleStreamMessage(). */
    async *handleStreamTask(
      ctx: ExecutionContext,
      task: A2ATaskLegacy,
    ): AsyncIterable<A2ATaskResult> {
      const params: A2ATaskSendParams = { message: task.input, metadata: task.metadata };
      for await (const event of this.handleStreamMessage!(ctx, params)) {
        if ('statusUpdate' in event) {
          yield {
            id: task.id,
            status:
              event.statusUpdate.status.state === 'TASK_STATE_COMPLETED' ? 'completed' : 'working',
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
            error:
              t.status.state !== 'TASK_STATE_COMPLETED'
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
