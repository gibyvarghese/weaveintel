/**
 * @weaveintel/evals — Rubric scoring helpers
 *
 * Shared rubric utilities are intentionally capability-agnostic so prompts,
 * skills, workers, and agents can all use one scoring surface.
 */

export interface RubricCriterion {
  id: string;
  description: string;
  weight: number;
  guidance?: string;
}

export interface RubricJudgeRequest {
  content: string;
  criteria: RubricCriterion[];
  expectedOutput?: string;
  context?: Record<string, unknown>;
}

export interface RubricJudgeResponse {
  score: number;
  reason?: string;
  criteriaScores?: Record<string, number>;
  metadata?: Record<string, unknown>;
}

export interface RubricJudgeAdapter {
  id: string;
  description: string;
  score(args: RubricJudgeRequest): Promise<RubricJudgeResponse>;
}

export interface RubricScoreDetail {
  criterionId: string;
  weight: number;
  score: number;
  weightedScore: number;
}

export interface RubricScoreResult {
  score: number;
  details: RubricScoreDetail[];
}

function normalizeScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Compute a weighted score in [0,1] from per-criterion scores.
 */
export function weightedRubricScore(args: {
  criteria: RubricCriterion[];
  criteriaScores: Record<string, number>;
}): RubricScoreResult {
  const details: RubricScoreDetail[] = [];
  let totalWeight = 0;
  let weighted = 0;

  for (const criterion of args.criteria) {
    const score = normalizeScore(args.criteriaScores[criterion.id] ?? 0);
    const weight = Number.isFinite(criterion.weight) && criterion.weight > 0 ? criterion.weight : 1;
    const weightedScore = score * weight;

    details.push({
      criterionId: criterion.id,
      weight,
      score,
      weightedScore,
    });

    totalWeight += weight;
    weighted += weightedScore;
  }

  return {
    score: totalWeight > 0 ? weighted / totalWeight : 0,
    details,
  };
}

/**
 * Helper used by comparisons (baseline vs candidate) across any feature.
 */
export function compareNormalizedScores(baselineScore: number, candidateScore: number): {
  baselineScore: number;
  candidateScore: number;
  delta: number;
  improved: boolean;
} {
  const baseline = normalizeScore(baselineScore);
  const candidate = normalizeScore(candidateScore);
  return {
    baselineScore: baseline,
    candidateScore: candidate,
    delta: candidate - baseline,
    improved: candidate > baseline,
  };
}
