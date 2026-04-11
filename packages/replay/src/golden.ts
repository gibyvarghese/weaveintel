import type { ExecutionContext, RunLog } from '@weaveintel/core';
import type { ReplayResult, ReplayOptions } from './engine.js';
import { ReplayEngine } from './engine.js';

export interface GoldenCase {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly runLog: RunLog;
  readonly acceptanceCriteria: GoldenCriteria;
  readonly createdAt: number;
  readonly tags?: readonly string[];
}

export interface GoldenCriteria {
  readonly minMatchRate: number;
  readonly maxDurationMs?: number;
  readonly requiredStepMatches?: readonly number[];
}

export interface GoldenResult {
  readonly caseId: string;
  readonly caseName: string;
  readonly replay: ReplayResult;
  readonly passed: boolean;
  readonly violations: readonly string[];
}

export async function evaluateGolden(
  ctx: ExecutionContext,
  goldenCase: GoldenCase,
  opts?: ReplayOptions,
): Promise<GoldenResult> {
  const engine = new ReplayEngine(opts);
  const replay = await engine.replay(ctx, goldenCase.runLog);

  const violations: string[] = [];
  const criteria = goldenCase.acceptanceCriteria;

  if (replay.matchRate < criteria.minMatchRate) {
    violations.push(`Match rate ${(replay.matchRate * 100).toFixed(1)}% below minimum ${(criteria.minMatchRate * 100).toFixed(1)}%`);
  }
  if (criteria.maxDurationMs && replay.totalDurationMs > criteria.maxDurationMs) {
    violations.push(`Duration ${replay.totalDurationMs}ms exceeds max ${criteria.maxDurationMs}ms`);
  }
  if (criteria.requiredStepMatches) {
    for (const idx of criteria.requiredStepMatches) {
      const step = replay.steps[idx];
      if (step && !step.match) {
        violations.push(`Required step ${idx} ("${step.name}") did not match`);
      }
    }
  }

  return {
    caseId: goldenCase.id,
    caseName: goldenCase.name,
    replay,
    passed: violations.length === 0,
    violations,
  };
}
