/**
 * @weaveintel/routing — Routing decision logger
 *
 * Records and retrieves routing decisions for auditability and debugging.
 */

import type { RoutingDecision } from '@weaveintel/core';

// ─── Decision store ──────────────────────────────────────────

export interface DecisionStore {
  record(decision: RoutingDecision): Promise<void>;
  list(opts?: { limit?: number; modelId?: string; providerId?: string }): Promise<RoutingDecision[]>;
  clear(): Promise<void>;
}

// ─── In-memory decision store ────────────────────────────────

export class InMemoryDecisionStore implements DecisionStore {
  private decisions: RoutingDecision[] = [];

  async record(decision: RoutingDecision): Promise<void> {
    this.decisions.push(decision);
  }

  async list(opts?: { limit?: number; modelId?: string; providerId?: string }): Promise<RoutingDecision[]> {
    let result = [...this.decisions];
    if (opts?.modelId) result = result.filter(d => d.modelId === opts.modelId);
    if (opts?.providerId) result = result.filter(d => d.providerId === opts.providerId);
    result.reverse(); // newest first
    if (opts?.limit) result = result.slice(0, opts.limit);
    return result;
  }

  async clear(): Promise<void> {
    this.decisions = [];
  }
}
