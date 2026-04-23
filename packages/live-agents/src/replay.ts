import type {
  ExecutionContext,
  RunLog,
  StepLog,
} from '@weaveintel/core';
import { createReplayEngine, type ReplayResult } from '@weaveintel/replay';
import type {
  LiveAgentsRunLogger,
  ReplayLiveAgentsRunOptions,
} from './types.js';

interface MutableRunLog {
  executionId: string;
  startTime: number;
  endTime?: number;
  status: RunLog['status'];
  steps: StepLog[];
}

export class InMemoryLiveAgentsRunLogger implements LiveAgentsRunLogger {
  private readonly runs = new Map<string, MutableRunLog>();

  startRun(executionId: string, startTime = Date.now()): void {
    if (!this.runs.has(executionId)) {
      this.runs.set(executionId, {
        executionId,
        startTime,
        status: 'running',
        steps: [],
      });
    }
  }

  recordStep(executionId: string, step: Omit<StepLog, 'index'>): void {
    const run = this.runs.get(executionId);
    if (!run) {
      this.startRun(executionId, step.startTime);
    }
    const current = this.runs.get(executionId);
    if (!current) {
      return;
    }
    current.steps.push({
      ...step,
      index: current.steps.length,
    });
  }

  completeRun(executionId: string, status: RunLog['status'], endTime = Date.now()): void {
    const run = this.runs.get(executionId);
    if (!run) {
      this.startRun(executionId);
    }
    const current = this.runs.get(executionId);
    if (!current) {
      return;
    }
    current.status = status;
    current.endTime = endTime;
  }

  getRunLog(executionId: string): RunLog | null {
    const run = this.runs.get(executionId);
    if (!run) {
      return null;
    }
    const totalTokens = 0;
    return {
      executionId: run.executionId,
      startTime: run.startTime,
      endTime: run.endTime,
      status: run.status,
      steps: [...run.steps],
      totalTokens,
      totalCostUsd: 0,
    };
  }

  listRunLogs(): RunLog[] {
    return [...this.runs.keys()]
      .map((executionId) => this.getRunLog(executionId))
      .filter((log): log is RunLog => log !== null);
  }
}

export function createLiveAgentsRunLogger(): LiveAgentsRunLogger {
  return new InMemoryLiveAgentsRunLogger();
}

export async function replayLiveAgentsRun(
  ctx: ExecutionContext,
  runLog: RunLog,
  opts: ReplayLiveAgentsRunOptions = {},
): Promise<ReplayResult> {
  const engine = createReplayEngine({
    model: opts.model,
    preserveTiming: opts.preserveTiming,
    timeoutMs: opts.timeoutMs,
  });
  return engine.replay(ctx, runLog);
}
