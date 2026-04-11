import type { ExecutionContext, RunLog, Model } from '@weaveintel/core';
import type { ReplayResult } from './engine.js';
import { ReplayEngine } from './engine.js';

export interface ComparisonConfig {
  readonly name: string;
  readonly baselineModel?: Model;
  readonly challengerModel: Model;
  readonly runLogs: readonly RunLog[];
}

export interface ComparisonResult {
  readonly name: string;
  readonly baseline: readonly ReplayResult[];
  readonly challenger: readonly ReplayResult[];
  readonly baselineAvgMatch: number;
  readonly challengerAvgMatch: number;
  readonly baselineAvgDuration: number;
  readonly challengerAvgDuration: number;
  readonly winner: 'baseline' | 'challenger' | 'tie';
}

export async function runComparison(ctx: ExecutionContext, config: ComparisonConfig): Promise<ComparisonResult> {
  const baselineEngine = new ReplayEngine(config.baselineModel ? { model: config.baselineModel } : {});
  const challengerEngine = new ReplayEngine({ model: config.challengerModel });

  const baselineResults: ReplayResult[] = [];
  const challengerResults: ReplayResult[] = [];

  for (const runLog of config.runLogs) {
    if (ctx.signal?.aborted) break;
    baselineResults.push(await baselineEngine.replay(ctx, runLog));
    challengerResults.push(await challengerEngine.replay(ctx, runLog));
  }

  const avg = (arr: readonly ReplayResult[], key: 'matchRate' | 'totalDurationMs') =>
    arr.length > 0 ? arr.reduce((s, r) => s + r[key], 0) / arr.length : 0;

  const baselineAvgMatch = avg(baselineResults, 'matchRate');
  const challengerAvgMatch = avg(challengerResults, 'matchRate');

  return {
    name: config.name,
    baseline: baselineResults,
    challenger: challengerResults,
    baselineAvgMatch,
    challengerAvgMatch,
    baselineAvgDuration: avg(baselineResults, 'totalDurationMs'),
    challengerAvgDuration: avg(challengerResults, 'totalDurationMs'),
    winner: challengerAvgMatch > baselineAvgMatch + 0.05 ? 'challenger'
      : baselineAvgMatch > challengerAvgMatch + 0.05 ? 'baseline' : 'tie',
  };
}
