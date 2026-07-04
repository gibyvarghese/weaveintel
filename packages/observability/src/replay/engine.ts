import type { ExecutionContext, SpanRecord, RunLog, StepLog, Model, ModelRequest, ModelResponse } from '@weaveintel/core';

export interface ReplayOptions {
  readonly model?: Model;
  readonly preserveTiming?: boolean;
  readonly timeoutMs?: number;
  readonly onStep?: (step: ReplayStep) => void;
}

export interface ReplayStep {
  readonly index: number;
  readonly name: string;
  readonly original: { input?: Record<string, unknown>; output?: Record<string, unknown>; durationMs: number };
  readonly replayed: { output?: Record<string, unknown>; durationMs: number; error?: string };
  readonly match: boolean;
}

export interface ReplayResult {
  readonly executionId: string;
  readonly originalRunLog: RunLog;
  readonly steps: readonly ReplayStep[];
  readonly totalDurationMs: number;
  readonly matchRate: number;
  readonly status: 'completed' | 'failed' | 'timeout';
}

export class ReplayEngine {
  private readonly opts: ReplayOptions;
  constructor(opts: ReplayOptions = {}) { this.opts = opts; }

  async replay(ctx: ExecutionContext, runLog: RunLog): Promise<ReplayResult> {
    const start = Date.now();
    const steps: ReplayStep[] = [];
    let matches = 0;

    for (const step of runLog.steps) {
      if (ctx.signal?.aborted) break;

      const stepStart = Date.now();
      let replayedOutput: Record<string, unknown> | undefined;
      let error: string | undefined;

      try {
        if (this.opts.model && step.type === 'model') {
          const request = step.input as unknown as ModelRequest;
          const response = await this.opts.model.generate(ctx, request);
          replayedOutput = { content: response.content, finishReason: response.finishReason, usage: response.usage };
        } else {
          replayedOutput = step.output;
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }

      const replayedDuration = Date.now() - stepStart;
      const match = !error && JSON.stringify(replayedOutput) === JSON.stringify(step.output);
      if (match) matches++;

      const replayStep: ReplayStep = {
        index: step.index,
        name: step.name,
        original: { input: step.input, output: step.output, durationMs: step.endTime - step.startTime },
        replayed: { output: replayedOutput, durationMs: replayedDuration, error },
        match,
      };

      steps.push(replayStep);
      this.opts.onStep?.(replayStep);

      if (this.opts.preserveTiming && step.index < runLog.steps.length - 1) {
        const nextStep = runLog.steps[step.index + 1];
        if (nextStep) {
          const gap = nextStep.startTime - step.endTime;
          if (gap > 0) await new Promise(r => setTimeout(r, Math.min(gap, 1000)));
        }
      }
    }

    return {
      executionId: runLog.executionId,
      originalRunLog: runLog,
      steps,
      totalDurationMs: Date.now() - start,
      matchRate: steps.length > 0 ? matches / steps.length : 0,
      status: ctx.signal?.aborted ? 'timeout' : steps.some(s => s.replayed.error) ? 'failed' : 'completed',
    };
  }
}

export function createReplayEngine(opts?: ReplayOptions): ReplayEngine {
  return new ReplayEngine(opts);
}
