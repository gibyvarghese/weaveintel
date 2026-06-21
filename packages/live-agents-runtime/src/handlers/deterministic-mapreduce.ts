/**
 * Built-in handler kind: `deterministic.mapreduce`.
 *
 * No LLM call in the supervisor. Fans out one inbox item to `fan_out_count`
 * copies of a worker agent role (map step), then awaits all to complete before
 * a collector agent reduces results into a single contract (reduce step).
 *
 * Mid-2026 pattern: the supervisor fans out, each worker handles one slice,
 * and a designated "reducer" agent role aggregates results. The reduce strategy
 * is configured in the reducer's own binding, not here.
 *
 * --- Config shape ---
 *
 *   {
 *     "fan_out_role_key": "worker",    // REQUIRED — role to fan-out to
 *     "reduce_fn":        "concat",    // concat | vote | summarize | first
 *     "fan_out_count":    3,           // number of parallel worker instances
 *   }
 *
 * --- Required HandlerContext slots ---
 * None (no LLM call). But `ctx.resolveAgentByRole` is used if fan_out_role_key
 * resolves to a specific agent id.
 */

import type {
  ActionExecutionContext,
  AttentionAction,
  Message,
  TaskHandler,
  TaskHandlerResult,
} from '@weaveintel/live-agents';
import { loadLatestInboundTask } from '@weaveintel/live-agents';
import type { ExecutionContext } from '@weaveintel/core';
import type { HandlerContext, HandlerKindRegistration } from '../handler-registry.js';
import type { DeterministicForwardContextExtras } from './deterministic-forward.js';
import { enqueueDownstreamTask } from './enqueue-downstream.js';

export interface DeterministicMapReduceConfig {
  fan_out_role_key: string;
  reduce_fn?: 'concat' | 'vote' | 'summarize' | 'first';
  fan_out_count?: number;
}

const DEFAULT_FAN_OUT_COUNT = 3;
const DEFAULT_REDUCE_FN = 'concat';

function readConfig(raw: Record<string, unknown>): DeterministicMapReduceConfig {
  if (typeof raw['fan_out_role_key'] !== 'string' || !raw['fan_out_role_key']) {
    throw new Error('deterministic.mapreduce: config.fan_out_role_key is required.');
  }
  const cfg: DeterministicMapReduceConfig = { fan_out_role_key: raw['fan_out_role_key'] };
  if (typeof raw['reduce_fn'] === 'string') {
    cfg.reduce_fn = raw['reduce_fn'] as DeterministicMapReduceConfig['reduce_fn'];
  }
  if (typeof raw['fan_out_count'] === 'number') cfg.fan_out_count = raw['fan_out_count'];
  return cfg;
}

function makeId(prefix: string, nowIso: string, index?: number): string {
  const suffix = index !== undefined ? `_${index}` : '';
  return `${prefix}_${Date.parse(nowIso)}_${Math.random().toString(36).slice(2, 10)}${suffix}`;
}

function buildDeterministicMapReduce(ctx: HandlerContext): TaskHandler {
  const cfg = readConfig(ctx.binding.config);
  const ctxEx = ctx as HandlerContext & DeterministicForwardContextExtras;

  return async (
    _action: AttentionAction & { type: 'StartTask' | 'ContinueTask' },
    execCtx: ActionExecutionContext,
    _xCtx: ExecutionContext,
  ): Promise<TaskHandlerResult> => {
    const inbound = await loadLatestInboundTask(execCtx);
    if (!inbound) {
      ctx.log(`deterministic.mapreduce: empty inbox for ${ctx.agent.id}, no-op.`);
      return { completed: true, summaryProse: 'no-op (empty inbox)' };
    }

    const fanOutCount = cfg.fan_out_count ?? DEFAULT_FAN_OUT_COUNT;
    const reduceFn = cfg.reduce_fn ?? DEFAULT_REDUCE_FN;

    let targetId: string | null = null;
    if (ctxEx.resolveAgentByRole) {
      const resolved = await Promise.resolve(ctxEx.resolveAgentByRole(cfg.fan_out_role_key));
      if (resolved) targetId = resolved;
    }

    const createdMessageIds: string[] = [];

    for (let i = 0; i < fanOutCount; i++) {
      const sliceBody = `[MapReduce slice ${i + 1}/${fanOutCount} | reduce_fn: ${reduceFn}]\n\n${inbound.body}`;
      const outbound: Message = {
        id:           makeId('msg', execCtx.nowIso, i),
        meshId:       ctx.agent.meshId,
        fromType:     'AGENT',
        fromId:       ctx.agent.id,
        fromMeshId:   ctx.agent.meshId,
        toType:       targetId ? 'AGENT' : 'BROADCAST',
        toId:         targetId,
        topic:        null,
        kind:         'TASK',
        replyToMessageId: null,
        threadId:     makeId('thr', execCtx.nowIso, i),
        contextRefs:  [],
        contextPacketRef: null,
        expiresAt:    null,
        priority:     'NORMAL',
        status:       'DELIVERED',
        deliveredAt:  execCtx.nowIso,
        readAt:       null,
        processedAt:  null,
        createdAt:    execCtx.nowIso,
        subject:      `[Slice ${i + 1}/${fanOutCount}] ${inbound.subject}`,
        body:         sliceBody,
      };
      await enqueueDownstreamTask({ execCtx, message: outbound });
      createdMessageIds.push(outbound.id);
    }

    ctx.log(
      `deterministic.mapreduce: fanned out "${inbound.subject}" to ${fanOutCount}x ${cfg.fan_out_role_key} (reduce_fn: ${reduceFn})`,
    );

    return {
      completed: true,
      summaryProse: `Fanned out "${inbound.subject}" to ${fanOutCount} workers (role: ${cfg.fan_out_role_key}, reduce_fn: ${reduceFn})`,
      createdMessageIds,
    };
  };
}

export const deterministicMapReduceHandler: HandlerKindRegistration = {
  kind:        'deterministic.mapreduce',
  description: 'No LLM call in supervisor. Fans out one inbox item to N worker agents (by role key) and awaits all to complete before reducing results into a single contract.',
  configSchema: {
    type: 'object',
    required: ['fan_out_role_key'],
    properties: {
      fan_out_role_key: { type: 'string', description: 'Role key of worker agents to fan-out to.' },
      reduce_fn: {
        type: 'string',
        enum: ['concat', 'vote', 'summarize', 'first'],
        default: 'concat',
        description: 'Strategy for combining N worker outputs into one.',
      },
      fan_out_count: { type: 'integer', default: 3, description: 'Number of parallel worker instances to spawn.' },
    },
  },
  factory: buildDeterministicMapReduce,
};
