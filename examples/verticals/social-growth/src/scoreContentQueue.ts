export interface SgQueueScoreWeights {
  freshnessWeight: number;
  kpiWeight: number;
  campaignWeight: number;
}

export interface SgQueueItemInput {
  id: string;
  title: string;
  status: 'draft' | 'ready' | 'approved' | 'scheduled' | 'published' | 'failed';
  campaignPriority?: number;
  expectedCtr?: number;
  expectedEngagementRate?: number;
  daysSinceLastSimilarPost?: number;
}

export interface SgQueueItemScored extends SgQueueItemInput {
  score: number;
}

const DEFAULT_WEIGHTS: SgQueueScoreWeights = {
  freshnessWeight: 0.3,
  kpiWeight: 0.5,
  campaignWeight: 0.2,
};

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

export function scoreContentQueue(
  items: SgQueueItemInput[],
  weights: Partial<SgQueueScoreWeights> = {},
): SgQueueItemScored[] {
  const resolved: SgQueueScoreWeights = {
    ...DEFAULT_WEIGHTS,
    ...weights,
  };

  const statusBonus: Record<SgQueueItemInput['status'], number> = {
    draft: 0.2,
    ready: 0.7,
    approved: 0.9,
    scheduled: 0.4,
    published: 0,
    failed: 0.1,
  };

  const scored = items.map((item) => {
    const freshness = clamp((item.daysSinceLastSimilarPost ?? 0) / 14);
    const kpi = clamp(((item.expectedCtr ?? 0) * 0.6) + ((item.expectedEngagementRate ?? 0) * 0.4));
    const campaign = clamp((item.campaignPriority ?? 0) / 10);

    const weighted =
      (freshness * resolved.freshnessWeight)
      + (kpi * resolved.kpiWeight)
      + (campaign * resolved.campaignWeight);

    const score = clamp(weighted + statusBonus[item.status]);

    return {
      ...item,
      score: Number(score.toFixed(4)),
    };
  });

  return scored.sort((a, b) => b.score - a.score);
}
