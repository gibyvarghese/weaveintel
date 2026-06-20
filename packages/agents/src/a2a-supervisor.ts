/**
 * @weaveintel/agents — P6-2: A2A-native supervisor
 *
 * `weaveA2ASupervisor` creates an agent that is BOTH:
 *   1. A fully-functional `weaveAgent` supervisor that can delegate to local
 *      workers (via `workers` array or `WorkerRegistry`) AND remote A2A agents.
 *   2. An `A2AServer` that external callers can invoke via A2A protocol messages.
 *
 * This enables true distributed multi-agent networks where:
 *   - External callers discover the supervisor via its Agent Card
 *   - The supervisor delegates to local workers AND remote A2A agents uniformly
 *   - All task state is persisted in an in-memory store (plug in SQLite via `taskStore`)
 *   - Streaming is supported — callers can receive partial updates via SSE
 *
 * Architecture:
 *   caller (A2A) → weaveA2ASupervisor.handleMessage()
 *                       → converts A2AMessage → AgentInput
 *                       → runs weaveAgent (supervisor mode)
 *                       → converts AgentResult → A2ATask
 *
 * Usage:
 * ```ts
 * const supervisor = weaveA2ASupervisor({
 *   name: 'orchestrator',
 *   description: 'Routes tasks to specialist agents',
 *   model,
 *   workers: [researchWorker, writerWorker],
 *   agentCard: {
 *     name: 'orchestrator',
 *     description: '...',
 *     url: 'https://my-agents.example.com/orchestrator',
 *     skills: [{ id: 'research', name: 'Research', description: '...' }],
 *   },
 * });
 *
 * // Register on the in-process bus so other agents can call it
 * bus.register('orchestrator', supervisor);
 *
 * // Or wire into an HTTP server
 * app.post('/a2a', async (req, res) => {
 *   const task = await supervisor.handleMessage(ctx, req.body.params);
 *   res.json({ result: task });
 * });
 * ```
 */

import type {
  AgentCard,
  A2AServer,
  A2ATask,
  A2ATaskSendParams,
  A2AStreamEvent,
  A2AListTasksFilter,
  A2ATaskPage,
  A2APushNotificationConfig,
  A2APushNotificationConfigEntry,
  ExecutionContext,
  A2ATaskStatusObj,
  A2AArtifact,
  A2AMessage,
} from '@weaveintel/core';
import { a2aPartsText, newUUIDv7 } from '@weaveintel/core';
import type { Agent, AgentInput, AgentResult } from '@weaveintel/core';
import { weaveAgent } from './agent.js';
import type { ToolCallingAgentOptions } from './agent.js';
import type { WorkerDefinition } from './supervisor-runtime.js';
import type { WorkerRegistry } from './worker-registry.js';

// ─── Task store interface ─────────────────────────────────────

/** Minimal persistence contract for A2A task state. */
export interface A2ATaskStore {
  save(task: A2ATask): Promise<void>;
  load(taskId: string): Promise<A2ATask | null>;
  list(filter?: A2AListTasksFilter): Promise<A2ATask[]>;
  delete(taskId: string): Promise<void>;
}

/** In-memory A2A task store (default). */
export function createInMemoryA2ATaskStore(): A2ATaskStore {
  const tasks = new Map<string, A2ATask>();
  return {
    async save(task) { tasks.set(task.id, task); },
    async load(id)   { return tasks.get(id) ?? null; },
    async list(filter) {
      let all = [...tasks.values()];
      if (filter?.contextId) all = all.filter((t) => t.contextId === filter.contextId);
      const limit = filter?.pageSize ?? all.length;
      return all.slice(0, limit);
    },
    async delete(id) { tasks.delete(id); },
  };
}

// ─── Supervisor options ───────────────────────────────────────

export interface WeaveA2ASupervisorOptions extends ToolCallingAgentOptions {
  /**
   * Agent Card advertised at `/.well-known/agent-card.json`.
   * Required for A2A discovery. When omitted a minimal card is generated
   * from `name` and `description`.
   */
  agentCard?: Partial<AgentCard>;
  /**
   * Backing store for A2A task state.
   * Defaults to an in-memory store. Plug in a SQLite adapter for durability.
   */
  taskStore?: A2ATaskStore;
  /**
   * URL at which this supervisor is reachable externally.
   * Used in the Agent Card and in self-referential A2A links.
   */
  serverUrl?: string;
}

// ─── A2A supervisor implementation ───────────────────────────

export interface WeaveA2ASupervisor extends A2AServer, Agent {}

/** Build an A2ATask from an AgentResult. */
function buildA2ATask(
  taskId: string,
  contextId: string,
  result: AgentResult,
  history: readonly A2AMessage[],
): A2ATask {
  const isCompleted = result.status === 'completed';
  const isCancelled = result.status === 'cancelled';

  const state: A2ATask['status']['state'] = isCompleted
    ? 'TASK_STATE_COMPLETED'
    : isCancelled
    ? 'TASK_STATE_CANCELED'
    : result.status === 'needs_approval'
    ? 'TASK_STATE_INPUT_REQUIRED'
    : 'TASK_STATE_FAILED';

  const status: A2ATaskStatusObj = {
    state,
    timestamp: new Date().toISOString(),
    ...(result.output
      ? {
          message: {
            role: 'agent' as const,
            parts: [{ text: result.output }],
            messageId: newUUIDv7(),
          },
        }
      : {}),
  };

  const artifact: A2AArtifact | undefined = result.output
    ? {
        artifactId: newUUIDv7(),
        name: 'response',
        parts: [{ text: result.output }],
        metadata: {
          agentStatus: result.status,
          steps: result.steps.length,
          usage: result.usage,
          ...(result.metadata ?? {}),
        },
      }
    : undefined;

  return {
    id: taskId,
    contextId,
    status,
    artifacts: artifact ? [artifact] : [],
    history,
    metadata: {
      agentSteps: result.steps.length,
      tokenUsage: result.usage,
      ...(result.metadata ?? {}),
    },
  };
}

/**
 * Creates a supervisor agent that is simultaneously an `A2AServer`.
 *
 * The returned object implements:
 * - `Agent.run()` / `Agent.runStream()` — call it locally like any agent
 * - `A2AServer.handleMessage()` — handles incoming A2A protocol messages
 * - `A2AServer.handleStreamMessage()` — streaming SSE variant
 * - `A2AServer.getTask()` — retrieve a previously submitted task
 * - `A2AServer.listTasks()` — paginated task listing
 * - `A2AServer.cancelTask()` — request cancellation (best-effort)
 */
export function weaveA2ASupervisor(opts: WeaveA2ASupervisorOptions): WeaveA2ASupervisor {
  const store = opts.taskStore ?? createInMemoryA2ATaskStore();
  const serverUrl = opts.serverUrl ?? 'http://localhost:3000';
  const agentName = opts.name ?? 'a2a-supervisor';

  // Build the inner supervisor agent
  const isSupervisorMode = (opts.workers && opts.workers.length > 0) || (opts.workerRegistry && opts.workerRegistry.size > 0);
  const innerAgent = weaveAgent(opts);

  // Build the Agent Card
  const baseCard = opts.agentCard ?? {};
  const card: AgentCard = {
    name: baseCard.name ?? agentName,
    description: baseCard.description ?? `A2A supervisor agent: ${agentName}`,
    url: baseCard.url ?? serverUrl,
    version: (baseCard as { version?: string }).version ?? '1.0.0',
    skills: (baseCard as { skills?: AgentCard['skills'] }).skills ?? [
      {
        id: 'delegate',
        name: 'Task delegation',
        description: isSupervisorMode
          ? 'Delegates tasks to specialist worker agents'
          : 'Processes tasks using tool-augmented reasoning',
        tags: ['orchestration', 'delegation'],
      },
    ],
    capabilities: (baseCard as { capabilities?: AgentCard['capabilities'] }).capabilities ?? {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true,
      extendedAgentCard: false,
    },
    supportedInterfaces: [
      { url: baseCard.url ?? serverUrl, protocolBinding: 'JSONRPC' as const, protocolVersion: '2.0' },
    ],
  };

  // Active cancellation tokens (taskId → controller signal)
  const cancelMap = new Map<string, AbortController>();

  // Push notification registry: taskId → configs
  const pushConfigs = new Map<string, A2APushNotificationConfigEntry[]>();

  // ── Core agent interface ──────────────────────────────────────

  const agentInterface: Pick<Agent, 'config' | 'run' | 'runStream'> = {
    config: innerAgent.config,
    run: innerAgent.run.bind(innerAgent),
    runStream: innerAgent.runStream?.bind(innerAgent),
  };

  // ── A2A message handling ──────────────────────────────────────

  async function handleMessage(
    ctx: ExecutionContext,
    params: A2ATaskSendParams,
  ): Promise<A2ATask> {
    const taskId = (params.metadata?.['taskId'] as string | undefined) ?? newUUIDv7();
    const contextId = params.message.contextId ?? newUUIDv7();

    // Extract text from A2A message parts
    const inputText = a2aPartsText(params.message.parts);

    // Build history: convert prior A2A messages to conversation turns
    const history: A2AMessage[] = [params.message];

    // Working state
    const workingTask: A2ATask = {
      id: taskId,
      contextId,
      status: {
        state: 'TASK_STATE_WORKING',
        timestamp: new Date().toISOString(),
      },
      artifacts: [],
      history,
    };
    await store.save(workingTask);

    // Register abort controller for cancellation support
    const controller = new AbortController();
    cancelMap.set(taskId, controller);

    try {
      const agentInput: AgentInput = {
        messages: [{ role: 'user', content: inputText }],
        goal: inputText,
      };

      const result = await innerAgent.run(ctx, agentInput);

      // Append agent response to history
      if (result.output) {
        history.push({
          role: 'agent',
          parts: [{ text: result.output }],
          messageId: newUUIDv7(),
          contextId,
          taskId,
        });
      }

      const task = buildA2ATask(taskId, contextId, result, history);
      await store.save(task);
      return task;
    } catch (err) {
      const failedTask: A2ATask = {
        id: taskId,
        contextId,
        status: {
          state: 'TASK_STATE_FAILED',
          timestamp: new Date().toISOString(),
          message: {
            role: 'agent',
            parts: [{ text: err instanceof Error ? err.message : String(err) }],
            messageId: newUUIDv7(),
          },
        },
        artifacts: [],
        history,
      };
      await store.save(failedTask);
      return failedTask;
    } finally {
      cancelMap.delete(taskId);
    }
  }

  async function* handleStreamMessage(
    ctx: ExecutionContext,
    params: A2ATaskSendParams,
  ): AsyncIterable<A2AStreamEvent> {
    const taskId = (params.metadata?.['taskId'] as string | undefined) ?? newUUIDv7();
    const contextId = params.message.contextId ?? newUUIDv7();
    const inputText = a2aPartsText(params.message.parts);
    const history: A2AMessage[] = [params.message];

    // Emit working state immediately
    const workingTask: A2ATask = {
      id: taskId,
      contextId,
      status: { state: 'TASK_STATE_WORKING', timestamp: new Date().toISOString() },
      artifacts: [],
      history,
    };
    await store.save(workingTask);
    yield { task: workingTask };

    // Accumulate streaming chunks
    let accumulatedContent = '';
    const agentInput: AgentInput = {
      messages: [{ role: 'user', content: inputText }],
      goal: inputText,
    };

    try {
      if (!innerAgent.runStream) {
        // Fallback to non-streaming when runStream is not implemented
        const result = await innerAgent.run(ctx, agentInput);
        if (result.output) {
          history.push({ role: 'agent', parts: [{ text: result.output }], messageId: newUUIDv7(), contextId, taskId });
        }
        const finalTask = buildA2ATask(taskId, contextId, result, history);
        await store.save(finalTask);
        yield { task: finalTask };
      } else {
        for await (const event of innerAgent.runStream(ctx, agentInput)) {
          if (event.type === 'text_chunk' && event.text) {
            accumulatedContent += event.text;
            const partialTask: A2ATask = {
              id: taskId,
              contextId,
              status: {
                state: 'TASK_STATE_WORKING',
                timestamp: new Date().toISOString(),
                message: {
                  role: 'agent',
                  parts: [{ text: accumulatedContent }],
                  messageId: newUUIDv7(),
                },
              },
              artifacts: [],
              history,
            };
            yield { task: partialTask };
          }

          if (event.type === 'done' && event.result) {
            if (event.result.output) {
              history.push({
                role: 'agent',
                parts: [{ text: event.result.output }],
                messageId: newUUIDv7(),
                contextId,
                taskId,
              });
            }
            const finalTask = buildA2ATask(taskId, contextId, event.result, history);
            await store.save(finalTask);
            yield { task: finalTask };
          }
        }
      }
    } catch (err) {
      const failedTask: A2ATask = {
        id: taskId,
        contextId,
        status: {
          state: 'TASK_STATE_FAILED',
          timestamp: new Date().toISOString(),
          message: {
            role: 'agent',
            parts: [{ text: err instanceof Error ? err.message : String(err) }],
            messageId: newUUIDv7(),
          },
        },
        artifacts: [],
        history,
      };
      await store.save(failedTask);
      yield { task: failedTask };
    }
  }

  async function getTask(
    _ctx: ExecutionContext,
    taskId: string,
  ): Promise<A2ATask | null> {
    return store.load(taskId);
  }

  async function listTasks(
    _ctx: ExecutionContext,
    filter?: A2AListTasksFilter,
  ): Promise<A2ATaskPage> {
    const tasks = await store.list(filter);
    return {
      tasks,
      nextPageToken: undefined,
    };
  }

  async function cancelTask(_ctx: ExecutionContext, taskId: string): Promise<void> {
    // Signal the abort controller if still running
    cancelMap.get(taskId)?.abort();
    // Update task state to CANCELLED
    const existing = await store.load(taskId);
    if (existing) {
      await store.save({
        ...existing,
        status: {
          ...existing.status,
          state: 'TASK_STATE_CANCELED',
          timestamp: new Date().toISOString(),
        },
      });
    }
  }

  async function createPushConfig(
    _ctx: ExecutionContext,
    taskId: string,
    config: A2APushNotificationConfig,
  ): Promise<A2APushNotificationConfigEntry> {
    const entry: A2APushNotificationConfigEntry = {
      pushConfigId: newUUIDv7(),
      taskId,
      createdAt: new Date().toISOString(),
      ...config,
    };
    const existing = pushConfigs.get(taskId) ?? [];
    pushConfigs.set(taskId, [...existing, entry]);
    return entry;
  }

  async function getPushConfig(
    _ctx: ExecutionContext,
    taskId: string,
    configId: string,
  ): Promise<A2APushNotificationConfigEntry | null> {
    const configs = pushConfigs.get(taskId) ?? [];
    return configs.find((c) => c.pushConfigId === configId) ?? null;
  }

  async function listPushConfigs(
    _ctx: ExecutionContext,
    taskId: string,
  ): Promise<readonly A2APushNotificationConfigEntry[]> {
    return pushConfigs.get(taskId) ?? [];
  }

  async function deletePushConfig(
    _ctx: ExecutionContext,
    taskId: string,
    configId: string,
  ): Promise<boolean> {
    const configs = pushConfigs.get(taskId) ?? [];
    const next = configs.filter((c) => c.pushConfigId !== configId);
    pushConfigs.set(taskId, next);
    return next.length < configs.length;
  }

  async function start(_port: number): Promise<void> {
    // HTTP serving is handled by the host application.
    // This supervisor provides the handleMessage / handleStreamMessage contract;
    // wire it into an HTTP framework of your choice.
  }

  async function stop(): Promise<void> {
    // Abort all in-flight tasks
    for (const controller of cancelMap.values()) {
      controller.abort();
    }
    cancelMap.clear();
  }

  return {
    // Agent interface
    ...agentInterface,
    // A2AServer interface
    card,
    handleMessage,
    handleStreamMessage,
    getTask,
    listTasks,
    cancelTask,
    createPushConfig,
    getPushConfig,
    listPushConfigs,
    deletePushConfig,
    start,
    stop,
  };
}

// ─── Re-export worker helpers ─────────────────────────────────

export type { WorkerDefinition, WorkerRegistry };
export { createInMemoryA2ATaskStore as createA2ATaskStore };
