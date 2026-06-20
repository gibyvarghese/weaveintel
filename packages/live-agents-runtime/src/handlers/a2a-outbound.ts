/**
 * Built-in handler kind: `a2a.outbound`.
 *
 * Reads the most-recent inbound TASK from the agent's inbox, wraps its
 * content as an A2A `A2ATask`, POSTs it to a configured remote agent URL,
 * and returns the `A2ATaskResult` as an outbound message to the sender.
 * No LLM call — pure protocol bridge.
 *
 * --- When to use ---
 *
 * Register `a2a.outbound` on "delegator" agents that hand off tasks to
 * remote specialist agents via the A2A protocol. The binding config must
 * include `targetUrl`; the optional `skill` field selects a capability on
 * the remote agent.
 *
 * --- Config shape (live_agent_handler_bindings.config_json) ---
 *
 *   {
 *     "targetUrl": "https://remote.example.com",  // required
 *     "skill": "code-review",                     // optional
 *     "timeoutMs": 30000                          // optional, default 30 s
 *   }
 *
 * --- Failure handling ---
 *
 * Network / parse errors result in a `completed: false` return so the
 * supervisor retries on the next tick. HTTP 4xx errors are reported as
 * outbound RESULT messages with status `failed` and the error body.
 */

import type {
  ActionExecutionContext,
  AttentionAction,
  Message,
  TaskHandler,
  TaskHandlerResult,
} from '@weaveintel/live-agents';
import { loadLatestInboundTask } from '@weaveintel/live-agents';
import type { A2ATask, A2ATaskResult, ExecutionContext } from '@weaveintel/core';
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
  result: A2ATaskResult,
): Message {
  const outputText =
    result.output?.parts
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('\n') ?? result.error ?? `A2A task ${result.id} status: ${result.status}`;

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
    subject: `A2A result: ${result.status}`,
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

    const taskId = newUUIDv7();
    const a2aTask: A2ATask = {
      id: taskId,
      ...(cfg.skill ? { skill: cfg.skill } : {}),
      input: {
        role: 'user',
        parts: [{ type: 'text', text: `Subject: ${inbound.subject}\n\n${inbound.body}` }],
      },
    };

    ctx.log(`a2a.outbound: posting task ${taskId} to ${tasksUrl}`);

    let result: A2ATaskResult;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetch(tasksUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(a2aTask),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const errBody = await response.text().catch(() => response.statusText);
        ctx.log(`a2a.outbound: remote returned HTTP ${response.status}: ${errBody}`);
        result = {
          id: taskId,
          status: 'failed',
          error: `HTTP ${response.status}: ${errBody.slice(0, 200)}`,
        };
      } else {
        const json = await response.json() as unknown;
        if (
          json &&
          typeof json === 'object' &&
          typeof (json as Record<string, unknown>)['id'] === 'string'
        ) {
          result = json as A2ATaskResult;
        } else {
          result = { id: taskId, status: 'completed', output: { role: 'agent', parts: [{ type: 'text', text: JSON.stringify(json) }] } };
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log(`a2a.outbound: fetch failed: ${msg}`);
      // Return non-completed so supervisor retries on next tick.
      return { completed: false, summaryProse: `fetch error: ${msg}` };
    }

    // Broadcast result back into the mesh so upstream agents can pick it up.
    const outbound = buildOutboundResultMessage(ctx, execCtx, result);
    await execCtx.stateStore.saveMessage(outbound);

    ctx.log(
      `a2a.outbound: task ${taskId} → ${result.status} (msg=${outbound.id})`,
    );

    return {
      completed: result.status === 'completed',
      summaryProse: `A2A task ${taskId} → ${result.status}`,
      createdMessageIds: [outbound.id],
    };
  };
}

export const a2aOutboundHandler: HandlerKindRegistration = {
  kind: 'a2a.outbound',
  description:
    'Delegate inbound TASK to a remote A2A agent via POST /api/a2a/tasks. ' +
    'No LLM call. Use for delegator agents that hand off work to specialist remote agents.',
  configSchema: {
    type: 'object',
    required: ['targetUrl'],
    properties: {
      targetUrl: { type: 'string', description: 'Base URL of the remote A2A agent.' },
      skill: { type: 'string', description: 'Optional skill name to invoke on the remote agent.' },
      timeoutMs: { type: 'integer', minimum: 1000, default: 30000, description: 'Fetch timeout in milliseconds.' },
    },
  },
  factory: buildA2AOutbound,
};
