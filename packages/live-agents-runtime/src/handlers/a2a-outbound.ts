/**
 * Built-in handler kind: `a2a.outbound`.
 *
 * Reads the most-recent inbound TASK from the agent's inbox, wraps its
 * content as an A2A v1.0 `A2ATaskSendParams`, POSTs it to a configured remote
 * agent URL, and returns the `A2ATask` result as an outbound message.
 * No LLM call — pure protocol bridge.
 *
 * Wire format: REST POST to `{targetUrl}/api/a2a/tasks` (Phase 1).
 * Request body: A2ATaskSendParams (v1.0 — message.parts, no type discriminator).
 * Response body: A2ATask (v1.0 — contextId, status.state, artifacts[]).
 *
 * --- When to use ---
 *
 * Register `a2a.outbound` on "delegator" agents that hand off tasks to remote
 * specialist agents via the A2A protocol. The binding config must include
 * `targetUrl`; the optional `skill` field tags the request metadata.
 *
 * --- Config shape (live_agent_handler_bindings.config_json) ---
 *
 *   {
 *     "targetUrl": "https://remote.example.com",  // required
 *     "skill": "code-review",                     // optional
 *     "timeoutMs": 30000                          // optional, default 30 s
 *   }
 */

import type {
  ActionExecutionContext,
  AttentionAction,
  Message,
  TaskHandler,
  TaskHandlerResult,
} from '@weaveintel/live-agents';
import { loadLatestInboundTask } from '@weaveintel/live-agents';
import type { A2ATask, A2ATaskSendParams, ExecutionContext } from '@weaveintel/core';
import { newUUIDv7 } from '@weaveintel/core';
import type { HandlerContext, HandlerKindRegistration } from '../handler-registry.js';

export interface A2AOutboundConfig {
  targetUrl: string;
  skill?: string;
  timeoutMs?: number;
}

function readConfig(raw: Record<string, unknown>): A2AOutboundConfig {
  if (typeof raw['targetUrl'] !== 'string' || raw['targetUrl'].length === 0) {
    throw new Error('a2a.outbound: config.targetUrl is required (non-empty string).');
  }
  const cfg: A2AOutboundConfig = { targetUrl: raw['targetUrl'] };
  if (typeof raw['skill'] === 'string') cfg.skill = raw['skill'];
  if (typeof raw['timeoutMs'] === 'number') cfg.timeoutMs = raw['timeoutMs'];
  return cfg;
}

function makeMessageId(nowIso: string): string {
  return `msg_${Date.parse(nowIso)}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildOutboundResultMessage(
  ctx: HandlerContext,
  execCtx: ActionExecutionContext,
  task: A2ATask,
): Message {
  // Extract text from the first artifact, or fall back to the status message.
  const outputText =
    (task.artifacts[0]?.parts ?? [])
      .map((p) => (typeof p.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('\n') ||
    (task.status.message?.parts ?? [])
      .map((p) => (typeof p.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('\n') ||
    `A2A task ${task.id}: ${task.status.state}`;

  return {
    id: makeMessageId(execCtx.nowIso),
    meshId: ctx.agent.meshId,
    fromType: 'AGENT',
    fromId: ctx.agent.id,
    fromMeshId: ctx.agent.meshId,
    toType: 'BROADCAST',
    toId: null,
    topic: null,
    kind: 'REPORT',
    replyToMessageId: null,
    threadId: makeMessageId(execCtx.nowIso),
    contextRefs: [],
    contextPacketRef: null,
    expiresAt: null,
    priority: 'NORMAL',
    status: 'DELIVERED',
    deliveredAt: execCtx.nowIso,
    readAt: null,
    processedAt: null,
    createdAt: execCtx.nowIso,
    subject: `A2A result: ${task.status.state}`,
    body: outputText,
  };
}

function buildA2AOutbound(ctx: HandlerContext): TaskHandler {
  const cfg = readConfig(ctx.binding.config);
  const timeoutMs = cfg.timeoutMs ?? 30_000;
  const tasksUrl = `${cfg.targetUrl.replace(/\/$/, '')}/api/a2a/tasks`;

  return async (
    _action: AttentionAction & { type: 'StartTask' | 'ContinueTask' },
    execCtx: ActionExecutionContext,
    _ctx: ExecutionContext,
  ): Promise<TaskHandlerResult> => {
    const inbound = await loadLatestInboundTask(execCtx);
    if (!inbound) {
      ctx.log(`a2a.outbound: no inbound TASK for agent ${ctx.agent.id}, skipping.`);
      return { completed: true, summaryProse: 'no-op (empty inbox)' };
    }

    const contextId = newUUIDv7();
    const messageId = newUUIDv7();

    // v1.0 A2ATaskSendParams (message.parts, no type discriminator)
    const sendParams: A2ATaskSendParams = {
      message: {
        role: 'user',
        parts: [{ text: `Subject: ${inbound.subject}\n\n${inbound.body}` }],
        messageId,
        contextId,
      },
      ...(cfg.skill ? { metadata: { skill: cfg.skill } } : {}),
    };

    ctx.log(`a2a.outbound: posting task to ${tasksUrl} (contextId=${contextId})`);

    let task: A2ATask;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetch(tasksUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'A2A-Version': '1.0',
          },
          body: JSON.stringify(sendParams),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const errBody = await response.text().catch(() => response.statusText);
        ctx.log(`a2a.outbound: remote returned HTTP ${response.status}: ${errBody}`);
        task = {
          id: contextId,
          contextId,
          status: {
            state: 'TASK_STATE_FAILED',
            message: { role: 'agent', parts: [{ text: `HTTP ${response.status}: ${errBody.slice(0, 200)}` }] },
            timestamp: new Date().toISOString(),
          },
          artifacts: [],
          history: [sendParams.message],
        };
      } else {
        const json = await response.json() as unknown;
        if (json && typeof json === 'object' && 'contextId' in (json as object)) {
          // v1.0 A2ATask response
          task = json as A2ATask;
        } else {
          // Unexpected response shape — wrap as completed
          task = {
            id: contextId,
            contextId,
            status: { state: 'TASK_STATE_COMPLETED', timestamp: new Date().toISOString() },
            artifacts: [{ artifactId: `${contextId}-out`, name: 'output', parts: [{ text: JSON.stringify(json) }] }],
            history: [sendParams.message],
          };
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log(`a2a.outbound: fetch failed: ${msg}`);
      return { completed: false, summaryProse: `fetch error: ${msg}` };
    }

    const outbound = buildOutboundResultMessage(ctx, execCtx, task);
    await execCtx.stateStore.saveMessage(outbound);

    const succeeded = task.status.state === 'TASK_STATE_COMPLETED';
    ctx.log(`a2a.outbound: task → ${task.status.state} (msg=${outbound.id})`);

    return {
      completed: succeeded,
      summaryProse: `A2A task → ${task.status.state}`,
      createdMessageIds: [outbound.id],
    };
  };
}

export const a2aOutboundHandler: HandlerKindRegistration = {
  kind: 'a2a.outbound',
  description:
    'Delegate inbound TASK to a remote A2A agent (v1.0 A2ATaskSendParams via POST). ' +
    'No LLM call. Use for delegator agents that hand off work to specialist remote agents.',
  configSchema: {
    type: 'object',
    required: ['targetUrl'],
    properties: {
      targetUrl: { type: 'string', description: 'Base URL of the remote A2A agent.' },
      skill: { type: 'string', description: 'Optional skill name to tag in the request metadata.' },
      timeoutMs: { type: 'integer', minimum: 1000, default: 30000, description: 'Fetch timeout in milliseconds.' },
    },
  },
  factory: buildA2AOutbound,
};
