/**
 * Phase K5 — Kaggle attention policies.
 *
 * Each of the six roles gets a small deterministic policy. When the agent has
 * an unprocessed message in its inbox, it picks ProcessMessage; otherwise it
 * rests until the next tick. This keeps Phase K5 e2e deterministic without
 * needing a model — the orchestrator drives the pipeline by seeding the next
 * stage's message after each tick completes (see examples/79).
 *
 * Real production deployments would wire `createModelAttentionPolicy()` here.
 */

import type { AttentionAction, AttentionContext, AttentionPolicy } from '@weaveintel/live-agents';
import type { ExecutionContext } from '@weaveintel/core';
import type { KaggleAgentRole } from './account-bindings.js';

export interface KaggleAttentionPolicyOptions {
  /** Minutes between rest ticks when the inbox is empty. Defaults to 60. */
  restMinutes?: number;
}

const NEXT_TICK_MINUTES_DEFAULT = 60;

/** Pure heuristic policy: pick the oldest unprocessed message, or rest. */
export function createKaggleAttentionPolicy(
  role: KaggleAgentRole,
  opts: KaggleAttentionPolicyOptions = {},
): AttentionPolicy {
  const restMinutes = opts.restMinutes ?? NEXT_TICK_MINUTES_DEFAULT;
  return {
    key: `kaggle-${role}`,
    async decide(context: AttentionContext, _ctx: ExecutionContext): Promise<AttentionAction> {
      const pending = context.inbox.find((m) => m.status === 'PENDING' || m.status === 'DELIVERED');
      if (pending) {
        return { type: 'ProcessMessage', messageId: pending.id };
      }
      const accepted = context.backlog.find((b) => b.status === 'ACCEPTED' || b.status === 'PROPOSED');
      if (accepted) {
        return { type: 'StartTask', backlogItemId: accepted.id };
      }
      const inProgress = context.backlog.find((b) => b.status === 'IN_PROGRESS');
      if (inProgress) {
        return { type: 'ContinueTask', backlogItemId: inProgress.id };
      }
      const next = new Date(Date.parse(context.nowIso) + restMinutes * 60_000).toISOString();
      return { type: 'NoopRest', nextTickAt: next };
    },
  };
}
