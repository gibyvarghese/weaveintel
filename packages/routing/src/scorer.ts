/**
 * @weaveintel/routing — Model scorer
 *
 * Computes weighted composite scores for models given health data,
 * cost signals, and quality estimates. Used by the router to rank
 * model candidates when making a routing decision.
 */

import type { ModelHealth, ModelScore, RoutingPolicy } from '@weaveintel/core';

// ─── Cost data ───────────────────────────────────────────────

/** Per-million-token costs; caller supplies this data. */
export interface ModelCostInfo {
  modelId: string;
  providerId: string;
  inputCostPer1M: number;
  outputCostPer1M: number;
}

// ─── Quality data ────────────────────────────────────────────

export interface ModelQualityInfo {
  modelId: string;
  providerId: string;
  /** 0-1 quality score from evals or benchmarks */
  qualityScore: number;
}

// ─── Scorer ──────────────────────────────────────────────────

export class ModelScorer {
  /**
   * Score a set of candidate models according to a routing policy.
   * Returns scores sorted by `overallScore` descending (best first).
   */
  score(
    candidates: Array<{ modelId: string; providerId: string }>,
    health: ModelHealth[],
    costs: ModelCostInfo[],
    qualities: ModelQualityInfo[],
    policy: RoutingPolicy,
  ): ModelScore[] {
    const healthMap = new Map(health.map(h => [`${h.providerId}:${h.modelId}`, h]));
    const costMap = new Map(costs.map(c => [`${c.providerId}:${c.modelId}`, c]));
    const qualMap = new Map(qualities.map(q => [`${q.providerId}:${q.modelId}`, q]));

    const w = {
      cost: policy.weights?.cost ?? 0.33,
      latency: policy.weights?.latency ?? 0.33,
      quality: policy.weights?.quality ?? 0.34,
      reliability: policy.weights?.reliability ?? 0,
    };

    // Compute raw per-dimension scores
    const maxCost = Math.max(...costs.map(c => c.inputCostPer1M + c.outputCostPer1M), 1);
    const maxLatency = Math.max(...health.map(h => h.avgLatencyMs), 1);

    const scores: ModelScore[] = candidates.map(c => {
      const k = `${c.providerId}:${c.modelId}`;
      const h = healthMap.get(k);
      const co = costMap.get(k);
      const q = qualMap.get(k);

      // Lower cost → higher score  (invert)
      const rawCost = co ? (co.inputCostPer1M + co.outputCostPer1M) : maxCost;
      const costScore = 1 - rawCost / maxCost;

      // Lower latency → higher score (invert)
      const rawLatency = h ? h.avgLatencyMs : maxLatency;
      const latencyScore = 1 - rawLatency / maxLatency;

      const qualityScore = q ? q.qualityScore : 0.5;

      const reliabilityScore = h ? 1 - h.errorRate : 0.5;

      const overallScore =
        w.cost * costScore +
        w.latency * latencyScore +
        w.quality * qualityScore +
        w.reliability * reliabilityScore;

      return {
        modelId: c.modelId,
        providerId: c.providerId,
        costScore: round(costScore),
        latencyScore: round(latencyScore),
        qualityScore: round(qualityScore),
        reliabilityScore: round(reliabilityScore),
        overallScore: round(overallScore),
      };
    });

    return scores.sort((a, b) => b.overallScore - a.overallScore);
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
