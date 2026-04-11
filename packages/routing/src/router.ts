/**
 * @weaveintel/routing — Smart model router
 *
 * Implements the core ModelRouter interface from @weaveintel/core.
 * Evaluates routing policies, scores candidates, selects the best
 * model, and logs an explainable decision.
 */

import type {
  ModelRouter as IModelRouter,
  ModelHealth,
  RoutingPolicy,
  RoutingContext,
  RoutingDecision,
} from '@weaveintel/core';
import { ModelHealthTracker } from './health.js';
import { ModelScorer } from './scorer.js';
import type { ModelCostInfo, ModelQualityInfo } from './scorer.js';
import { filterByConstraints, fallbackCandidate, roundRobinSelect } from './policy.js';
import type { ModelCandidate } from './policy.js';
import type { DecisionStore } from './decision.js';

// ─── Router options ──────────────────────────────────────────

export interface SmartModelRouterOptions {
  candidates: ModelCandidate[];
  costs?: ModelCostInfo[];
  qualities?: ModelQualityInfo[];
  decisionStore?: DecisionStore;
  healthWindowSize?: number;
}

// ─── Smart router ────────────────────────────────────────────

export class SmartModelRouter implements IModelRouter {
  private readonly healthTracker: ModelHealthTracker;
  private readonly scorer = new ModelScorer();
  private readonly candidates: ModelCandidate[];
  private readonly costs: ModelCostInfo[];
  private readonly qualities: ModelQualityInfo[];
  private readonly decisionStore?: DecisionStore;

  constructor(opts: SmartModelRouterOptions) {
    this.healthTracker = new ModelHealthTracker({ windowSize: opts.healthWindowSize });
    this.candidates = opts.candidates;
    this.costs = opts.costs ?? [];
    this.qualities = opts.qualities ?? [];
    this.decisionStore = opts.decisionStore;
  }

  /**
   * Route a request according to the given policy.
   * Returns the selected model + provider with an explanation.
   */
  async route(
    _request: { prompt: string; context?: RoutingContext },
    policy: RoutingPolicy,
  ): Promise<RoutingDecision> {
    const healthList = this.healthTracker.listHealth();
    const healthMap = new Map(healthList.map(h => [`${h.providerId}:${h.modelId}`, h]));

    // 1. Filter by constraints
    let eligible = filterByConstraints(this.candidates, policy.constraints, healthMap);

    // 2. Remove unhealthy
    eligible = eligible.filter(c => {
      const h = healthMap.get(`${c.providerId}:${c.modelId}`);
      return !h || h.available;
    });

    // 3. Strategy-specific selection
    let selected: ModelCandidate | null = null;
    let reason = '';

    if (eligible.length === 0) {
      // Use fallback
      const fb = fallbackCandidate(policy);
      if (!fb) throw new Error(`No eligible models and no fallback for policy "${policy.id}"`);
      selected = fb;
      reason = 'All candidates filtered out; using fallback';
    } else if (policy.strategy === 'round-robin') {
      selected = roundRobinSelect(eligible);
      reason = 'Round-robin selection';
    } else {
      // Score and pick best
      const scores = this.scorer.score(eligible, healthList, this.costs, this.qualities, policy);
      const best = scores[0]!;
      selected = { modelId: best.modelId, providerId: best.providerId };
      reason = `Strategy "${policy.strategy}" — best score ${best.overallScore}`;
    }

    // Build decision
    const allScores = this.scorer.score(eligible, healthList, this.costs, this.qualities, policy);
    const scoreMap: Record<string, number> = {};
    for (const s of allScores) scoreMap[`${s.providerId}:${s.modelId}`] = s.overallScore;

    const decision: RoutingDecision = {
      modelId: selected.modelId,
      providerId: selected.providerId,
      reason,
      scores: scoreMap,
      alternatives: allScores
        .filter(s => s.modelId !== selected!.modelId || s.providerId !== selected!.providerId)
        .map(s => ({ modelId: s.modelId, providerId: s.providerId, score: s.overallScore })),
      timestamp: new Date().toISOString(),
    };

    if (this.decisionStore) await this.decisionStore.record(decision);

    return decision;
  }

  async getHealth(modelId: string, providerId: string): Promise<ModelHealth | null> {
    return this.healthTracker.getHealth(modelId, providerId);
  }

  async listHealth(): Promise<ModelHealth[]> {
    return this.healthTracker.listHealth();
  }

  async recordOutcome(
    decision: RoutingDecision,
    outcome: { latencyMs: number; success: boolean; cost?: number },
  ): Promise<void> {
    this.healthTracker.record(decision.modelId, decision.providerId, outcome);
  }
}
