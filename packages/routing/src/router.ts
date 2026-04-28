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
  ModelCapabilityRow,
  TaskTypeInferenceHints,
  TaskTypeInferenceSource,
  OutputModality,
} from '@weaveintel/core';
import { ModelHealthTracker } from './health.js';
import { ModelScorer } from './scorer.js';
import type { ModelCostInfo, ModelQualityInfo, ModelCapabilityInfo } from './scorer.js';
import {
  filterByConstraints,
  fallbackCandidate,
  roundRobinSelect,
  filterByCapability,
  filterByModality,
  filterByCostCeiling,
} from './policy.js';
import type { ModelCandidate } from './policy.js';
import type { DecisionStore } from './decision.js';
import { inferTaskType } from './inference.js';
import type { TaskInferenceHintsMap } from './inference.js';

// ─── Router options ──────────────────────────────────────────

export interface SmartModelRouterOptions {
  candidates: ModelCandidate[];
  costs?: ModelCostInfo[];
  qualities?: ModelQualityInfo[];
  decisionStore?: DecisionStore;
  healthWindowSize?: number;
  initialHealth?: ModelHealth[];
  /** Phase 2: per-(model, task) capability rows for capability filter + scorer dim. */
  capabilityRows?: ModelCapabilityRow[];
  /** Phase 2: per-task inference hints for `inferTaskType`. */
  taskInferenceHints?: TaskInferenceHintsMap;
  /** Phase 2: per-(provider, model) declared output modality for modality filter. */
  modalityMap?: Map<string, OutputModality>;
}

// ─── Decision metadata extension ─────────────────────────────

export interface TaskAwareDecisionMeta {
  taskKey: string;
  inferredTaskKey: string;
  inferenceSource: TaskTypeInferenceSource;
  exclusionReasons: Array<{ modelId: string; providerId: string; reason: string }>;
  capabilityScoreUsed: boolean;
}

// ─── Smart router ────────────────────────────────────────────

export class SmartModelRouter implements IModelRouter {
  private readonly healthTracker: ModelHealthTracker;
  private readonly scorer = new ModelScorer();
  private readonly candidates: ModelCandidate[];
  private readonly costs: ModelCostInfo[];
  private readonly qualities: ModelQualityInfo[];
  private readonly decisionStore?: DecisionStore;
  private readonly capabilityRows: ModelCapabilityRow[];
  private readonly taskInferenceHints: TaskInferenceHintsMap;
  private readonly modalityMap: Map<string, OutputModality>;

  constructor(opts: SmartModelRouterOptions) {
    this.healthTracker = new ModelHealthTracker({ windowSize: opts.healthWindowSize });
    this.candidates = opts.candidates;
    this.costs = opts.costs ?? [];
    this.qualities = opts.qualities ?? [];
    this.decisionStore = opts.decisionStore;
    this.capabilityRows = opts.capabilityRows ?? [];
    this.taskInferenceHints = opts.taskInferenceHints ?? new Map();
    this.modalityMap = opts.modalityMap ?? new Map();
    for (const h of opts.initialHealth ?? []) {
      this.healthTracker.applySnapshot(h);
    }
  }

  /**
   * Route a request according to the given policy.
   * Returns the selected model + provider with an explanation.
   */
  async route(
    request: { prompt: string; context?: RoutingContext },
    policy: RoutingPolicy,
  ): Promise<RoutingDecision> {
    const healthList = this.healthTracker.listHealth();
    const healthMap = new Map(healthList.map(h => [`${h.providerId}:${h.modelId}`, h]));
    const requiredFromContext = request.context?.requiredCapabilities ?? [];

    const mergedConstraints = policy.constraints
      ? {
          ...policy.constraints,
          requiredCapabilities: Array.from(new Set([
            ...(policy.constraints.requiredCapabilities ?? []),
            ...requiredFromContext,
          ])),
        }
      : (requiredFromContext.length > 0 ? { requiredCapabilities: requiredFromContext } : undefined);

    // 1. Filter by constraints
    let eligible = filterByConstraints(this.candidates, mergedConstraints, healthMap);

    // 2. Remove unhealthy
    eligible = eligible.filter(c => {
      const h = healthMap.get(`${c.providerId}:${c.modelId}`);
      return !h || h.available;
    });

    // 2.5 Phase 2: task-aware filters
    const exclusionReasons: Array<{ modelId: string; providerId: string; reason: string }> = [];
    let inferred = { taskKey: '', source: 'default' as TaskTypeInferenceSource };
    let capabilityScoreUsed = false;
    let taskCapabilities: ModelCapabilityInfo[] = [];

    if (this.taskInferenceHints.size > 0 || request.context?.taskType) {
      inferred = inferTaskType(
        {
          explicit: request.context?.taskType,
          tools: request.context?.tools,
          skill: request.context?.skill,
          prompt: request.context?.prompt ?? request.prompt,
        },
        this.taskInferenceHints,
      );
    }

    // Capability filter (only when capability rows are configured for the task)
    if (this.capabilityRows.length > 0 && inferred.taskKey) {
      const hasRowsForTask = this.capabilityRows.some(
        r => r.taskKey === inferred.taskKey && r.isActive !== false,
      );
      if (hasRowsForTask) {
        const fr = filterByCapability(eligible, inferred.taskKey, this.capabilityRows, request.context?.tenantId);
        eligible = fr.eligible;
        for (const e of fr.excluded) {
          exclusionReasons.push({ modelId: e.candidate.modelId, providerId: e.candidate.providerId, reason: e.reason });
        }
        // Build capability scores for the active task
        taskCapabilities = this.capabilityRows
          .filter(r => r.taskKey === inferred.taskKey && r.isActive !== false)
          .map(r => ({
            modelId: r.modelId,
            providerId: r.providerId,
            capabilityScore: Math.max(0, Math.min(1, r.qualityScore / 100)),
          }));
        capabilityScoreUsed = true;
      }
    }

    // Modality filter
    if (request.context?.outputModality && this.modalityMap.size > 0) {
      const fr = filterByModality(eligible, request.context.outputModality, this.modalityMap);
      eligible = fr.eligible;
      for (const e of fr.excluded) {
        exclusionReasons.push({ modelId: e.candidate.modelId, providerId: e.candidate.providerId, reason: e.reason });
      }
    }

    // Cost ceiling filter
    if (request.context?.maxCostPerCall && this.costs.length > 0) {
      const costMap = new Map(
        this.costs.map(c => [
          `${c.providerId}:${c.modelId}`,
          { inputCostPer1M: c.inputCostPer1M, outputCostPer1M: c.outputCostPer1M },
        ]),
      );
      const fr = filterByCostCeiling(eligible, costMap, request.context.maxCostPerCall);
      eligible = fr.eligible;
      for (const e of fr.excluded) {
        exclusionReasons.push({ modelId: e.candidate.modelId, providerId: e.candidate.providerId, reason: e.reason });
      }
    }

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
      const scores = this.scorer.score(eligible, healthList, this.costs, this.qualities, policy, taskCapabilities);
      const best = scores[0]!;
      selected = { modelId: best.modelId, providerId: best.providerId };
      reason = `Strategy "${policy.strategy}" — best score ${best.overallScore}`;
    }

    // Build decision
    const allScores = this.scorer.score(eligible, healthList, this.costs, this.qualities, policy, taskCapabilities);
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

    if (inferred.taskKey) {
      decision.taskMeta = {
        taskKey: inferred.taskKey,
        inferredTaskKey: inferred.taskKey,
        inferenceSource: inferred.source,
        exclusionReasons,
        capabilityScoreUsed,
      };
    }

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
