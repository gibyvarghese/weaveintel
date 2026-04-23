import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { EvalSuiteResult, SpanRecord, WorkflowCheckpoint } from '@weaveintel/core';
import { weaveContext } from '@weaveintel/core';
import { createPhase7RuntimePersistence } from './phase7-runtime-persistence.js';

function sampleSpan(executionId: string, traceId: string, spanId: string): SpanRecord {
  return {
    traceId,
    spanId,
    parentSpanId: undefined,
    name: `span-${spanId}`,
    startTime: 1,
    endTime: 2,
    status: 'ok',
    attributes: { executionId },
    events: [],
  };
}

function sampleCheckpoint(runId: string, stepId: string): WorkflowCheckpoint {
  return {
    id: `checkpoint-${runId}-${stepId}`,
    runId,
    workflowId: 'workflow-phase7',
    stepId,
    createdAt: new Date().toISOString(),
    state: {
      currentStepId: stepId,
      variables: { k: 'v' },
      history: [],
    },
  };
}

function sampleEval(name: string): EvalSuiteResult {
  return {
    name,
    totalCases: 2,
    passed: 2,
    failed: 0,
    avgScore: 1,
    avgDurationMs: 12,
    results: [],
  };
}

describe('phase7 runtime persistence', () => {
  it('persists trace spans, replay checkpoints, and eval suite runs in-memory', async () => {
    const store = createPhase7RuntimePersistence({ backend: 'in-memory' });
    const ctx = weaveContext({ tenantId: 't1', userId: 'u1' });

    await store.saveTraceSpan(ctx, {
      executionId: 'exec-1',
      traceId: 'trace-1',
      span: sampleSpan('exec-1', 'trace-1', 'span-1'),
    });
    await store.saveTraceSpan(ctx, {
      executionId: 'exec-1',
      traceId: 'trace-1',
      span: sampleSpan('exec-1', 'trace-1', 'span-2'),
    });

    const spans = await store.listTraceSpans(ctx, { traceId: 'trace-1' });
    expect(spans).toHaveLength(2);

    await store.saveReplayCheckpoint(ctx, {
      runId: 'run-1',
      checkpoint: sampleCheckpoint('run-1', 'step-a'),
    });
    await store.saveReplayCheckpoint(ctx, {
      runId: 'run-1',
      checkpoint: sampleCheckpoint('run-1', 'step-b'),
    });

    const latest = await store.loadLatestReplayCheckpoint(ctx, 'run-1');
    expect(latest?.checkpoint.stepId).toBe('step-b');

    await store.saveEvalSuiteRun(ctx, {
      executionId: 'exec-1',
      evalName: 'phase7-suite',
      result: sampleEval('phase7-suite'),
    });

    const evalRuns = await store.listEvalSuiteRuns(ctx, { executionId: 'exec-1' });
    expect(evalRuns).toHaveLength(1);
    expect(evalRuns[0]?.evalName).toBe('phase7-suite');

    await store.close();
  });

  it('retains phase7 records across sqlite restarts', async () => {
    const sqlitePath = join(tmpdir(), `phase7-persistence-${Date.now()}.db`);
    rmSync(sqlitePath, { force: true });
    const ctx = weaveContext({ tenantId: 't2', userId: 'u2' });

    const first = createPhase7RuntimePersistence({
      backend: 'sqlite',
      sqlitePath,
      namespace: 'phase7-restart',
    });

    await first.saveEvalSuiteRun(ctx, {
      executionId: 'exec-restart',
      evalName: 'restart-suite',
      result: sampleEval('restart-suite'),
    });
    await first.close();

    const second = createPhase7RuntimePersistence({
      backend: 'sqlite',
      sqlitePath,
      namespace: 'phase7-restart',
    });

    const rows = await second.listEvalSuiteRuns(ctx, { executionId: 'exec-restart' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.result.name).toBe('restart-suite');

    await second.close();
    rmSync(sqlitePath, { force: true });
  });
});
