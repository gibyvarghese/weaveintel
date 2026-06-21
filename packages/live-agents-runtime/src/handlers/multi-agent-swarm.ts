/**
 * Built-in handler kind: `multi-agent.swarm`.
 *
 * Peer agents collaborate without a designated supervisor. Each peer processes
 * the inbox independently and emits a response. Consensus is reached when
 * ≥ threshold fraction of peers agree on an output (consensus logic lives in a
 * separate collector agent or the mesh supervisor, not here).
 *
 * The handler's job: broadcast the inbound task to all peer role keys, attaching
 * the consensus threshold and round number as metadata in the message header so
 * peers can act accordingly.
 *
 * Mid-2026 pattern: swarm coordination is implemented as:
 *   1. Swarm supervisor (this handler) → broadcasts task to peers
 *   2. Each peer (agentic.react or agentic.scripted) → processes and replies
 *   3. A consensus collector role (uses external reducer logic) → aggregates
 *
 * --- Config shape ---
 *
 *   {
 *     "peer_role_keys":      ["critic", "analyst", "reviewer"],  // REQUIRED
 *     "consensus_threshold": 0.67,    // 0–1, fraction that must agree
 *     "max_rounds":          3,       // max fan-out iterations
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
import type { ExecutionContext } from '@weaveintel/core';
import type { HandlerContext, HandlerKindRegistration } from '../handler-registry.js';
import type { DeterministicForwardContextExtras } from './deterministic-forward.js';
import { enqueueDownstreamTask } from './enqueue-downstream.js';

export interface MultiAgentSwarmConfig {
  peer_role_keys: string[];
  consensus_threshold?: number;
  max_rounds?: number;
}

const DEFAULT_CONSENSUS_THRESHOLD = 0.67;
const DEFAULT_MAX_ROUNDS = 3;

function readConfig(raw: Record<string, unknown>): MultiAgentSwarmConfig {
  if (!Array.isArray(raw['peer_role_keys']) || (raw['peer_role_keys'] as unknown[]).length === 0) {
    throw new Error('multi-agent.swarm: config.peer_role_keys must be a non-empty array.');
  }
  const cfg: MultiAgentSwarmConfig = { peer_role_keys: raw['peer_role_keys'] as string[] };
  if (typeof raw['consensus_threshold'] === 'number') cfg.consensus_threshold = raw['consensus_threshold'];
  if (typeof raw['max_rounds'] === 'number') cfg.max_rounds = raw['max_rounds'];
  return cfg;
}

function makeId(prefix: string, nowIso: string, suffix?: string): string {
  return `${prefix}_${Date.parse(nowIso)}_${Math.random().toString(36).slice(2, 10)}${suffix ?? ''}`;
}

function buildMultiAgentSwarm(ctx: HandlerContext): TaskHandler {
  const cfg = readConfig(ctx.binding.config);
  const ctxEx = ctx as HandlerContext & DeterministicForwardContextExtras;

  return async (
    _action: AttentionAction & { type: 'StartTask' | 'ContinueTask' },
    execCtx: ActionExecutionContext,
    _xCtx: ExecutionContext,
  ): Promise<TaskHandlerResult> => {
    const inbound = await loadLatestInboundTask(execCtx);
    if (!inbound) {
      ctx.log(`multi-agent.swarm: empty inbox for ${ctx.agent.id}, no-op.`);
      return { completed: true, summaryProse: 'no-op (empty inbox)' };
    }

    const threshold = cfg.consensus_threshold ?? DEFAULT_CONSENSUS_THRESHOLD;
    const maxRounds = cfg.max_rounds ?? DEFAULT_MAX_ROUNDS;
    const peers = cfg.peer_role_keys;
    const createdMessageIds: string[] = [];

    for (const roleKey of peers) {
      let targetId: string | null = null;
      if (ctxEx.resolveAgentByRole) {
        const resolved = await Promise.resolve(ctxEx.resolveAgentByRole(roleKey));
        if (resolved) targetId = resolved;
      }

      const header = `[Swarm | peers: ${peers.length} | threshold: ${(threshold * 100).toFixed(0)}% | max_rounds: ${maxRounds}]`;
      const outbound: Message = {
        id:           makeId('msg', execCtx.nowIso, `_${roleKey}`),
        meshId:       ctx.agent.meshId,
        fromType:     'AGENT',
        fromId:       ctx.agent.id,
        fromMeshId:   ctx.agent.meshId,
        toType:       targetId ? 'AGENT' : 'BROADCAST',
        toId:         targetId,
        topic:        null,
        kind:         'TASK',
        replyToMessageId: null,
        threadId:     makeId('thr', execCtx.nowIso, `_${roleKey}`),
        contextRefs:  [],
        contextPacketRef: null,
        expiresAt:    null,
        priority:     'NORMAL',
        status:       'DELIVERED',
        deliveredAt:  execCtx.nowIso,
        readAt:       null,
        processedAt:  null,
        createdAt:    execCtx.nowIso,
        subject:      `${header} ${inbound.subject}`,
        body:         inbound.body,
      };
      await enqueueDownstreamTask({ execCtx, message: outbound });
      createdMessageIds.push(outbound.id);
    }

    ctx.log(
      `multi-agent.swarm: broadcast "${inbound.subject}" to ${peers.length} peers: ${peers.join(', ')} (threshold: ${threshold})`,
    );

    return {
      completed: true,
      summaryProse: `Swarm broadcast "${inbound.subject}" to ${peers.length} peers (threshold: ${(threshold * 100).toFixed(0)}%, max_rounds: ${maxRounds})`,
      createdMessageIds,
    };
  };
}

export const multiAgentSwarmHandler: HandlerKindRegistration = {
  kind:        'multi-agent.swarm',
  description: 'Peer agents collaborate without a designated supervisor. Each peer processes the inbox and emits a response; consensus is reached when ≥ threshold fraction agree.',
  configSchema: {
    type: 'object',
    required: ['peer_role_keys'],
    properties: {
      peer_role_keys: {
        type: 'array',
        items: { type: 'string' },
        description: 'Role keys of peer agents participating in the swarm.',
      },
      consensus_threshold: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        default: 0.67,
        description: 'Fraction of peers that must agree for a decision to be final.',
      },
      max_rounds: { type: 'integer', default: 3 },
    },
  },
  factory: buildMultiAgentSwarm,
};
