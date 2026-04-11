import type { ExecutionContext, RunLog } from '@weaveintel/core';
import type { ReplayResult, ReplayOptions } from './engine.js';
import { ReplayEngine } from './engine.js';

export interface ScenarioDefinition {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly runLogs: readonly RunLog[];
  readonly tags?: readonly string[];
}

export interface BenchmarkConfig {
  readonly scenarios: readonly ScenarioDefinition[];
  readonly replayOptions?: ReplayOptions;
  readonly concurrency?: number;
}

export interface BenchmarkResult {
  readonly startTime: number;
  readonly endTime: number;
  readonly scenarioResults: readonly ScenarioResult[];
  readonly overallMatchRate: number;
  readonly overallStatus: 'passed' | 'failed' | 'partial';
}

export interface ScenarioResult {
  readonly scenarioId: string;
  readonly scenarioName: string;
  readonly replays: readonly ReplayResult[];
  readonly avgMatchRate: number;
  readonly status: 'passed' | 'failed';
}

export async function runBenchmark(ctx: ExecutionContext, config: BenchmarkConfig): Promise<BenchmarkResult> {
  const engine = new ReplayEngine(config.replayOptions);
  const startTime = Date.now();
  const scenarioResults: ScenarioResult[] = [];

  for (const scenario of config.scenarios) {
    const replays: ReplayResult[] = [];
    for (const runLog of scenario.runLogs) {
      if (ctx.signal?.aborted) break;
      const result = await engine.replay(ctx, runLog);
      replays.push(result);
    }
    const avgMatchRate = replays.length > 0
      ? replays.reduce((s, r) => s + r.matchRate, 0) / replays.length
      : 0;
    scenarioResults.push({
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      replays,
      avgMatchRate,
      status: avgMatchRate >= 0.8 ? 'passed' : 'failed',
    });
  }

  const overallMatchRate = scenarioResults.length > 0
    ? scenarioResults.reduce((s, r) => s + r.avgMatchRate, 0) / scenarioResults.length
    : 0;

  return {
    startTime,
    endTime: Date.now(),
    scenarioResults,
    overallMatchRate,
    overallStatus: scenarioResults.every(s => s.status === 'passed') ? 'passed'
      : scenarioResults.some(s => s.status === 'passed') ? 'partial' : 'failed',
  };
}
