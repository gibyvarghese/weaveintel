/**
 * Unit tests — createRunMetrics (client observability rollup).
 * Positive · derivation · negative · stress.
 */
import { describe, it, expect } from 'vitest';
import { createRunMetrics } from './metrics.js';
import { emptyRunViewModel, type UsageView, type RunViewModel } from './reducer.js';

const usage = (u: Partial<UsageView>): UsageView => ({ kind: 'usage', ...u });
const vmWith = (u?: UsageView): RunViewModel => ({ ...emptyRunViewModel(), ...(u ? { usage: u } : {}) });

describe('createRunMetrics', () => {
  it('starts empty', () => {
    const s = createRunMetrics({ startedAt: 'T0' }).snapshot();
    expect(s).toMatchObject({ runs: 0, completed: 0, failed: 0, cancelled: 0, errorRate: 0, costUsd: 0, startedAt: 'T0' });
    expect(s.tokens).toEqual({ prompt: 0, completion: 0, total: 0 });
  });

  it('counts outcomes and computes error rate', () => {
    const m = createRunMetrics();
    m.recordRun('completed');
    m.recordRun('completed');
    m.recordRun('failed');
    m.recordRun('cancelled');
    const s = m.snapshot();
    expect(s).toMatchObject({ runs: 4, completed: 2, failed: 1, cancelled: 1 });
    expect(s.errorRate).toBeCloseTo(1 / 4, 5);
  });

  it('aggregates tokens and cost from usage', () => {
    const m = createRunMetrics();
    m.recordRun('completed', usage({ promptTokens: 100, completionTokens: 40, totalTokens: 140, costUsd: 0.002, latencyMs: 1200 }));
    m.recordRun('completed', usage({ promptTokens: 50, completionTokens: 10, totalTokens: 60, costUsd: 0.001, latencyMs: 800 }));
    const s = m.snapshot();
    expect(s.tokens).toEqual({ prompt: 150, completion: 50, total: 200 });
    expect(s.costUsd).toBeCloseTo(0.003, 6);
    expect(s.avgLatencyMs).toBeCloseTo(1000, 5);
    expect(s.avgCostPerRun).toBeCloseTo(0.0015, 6);
  });

  it('derives total from prompt+completion when totalTokens is absent', () => {
    const m = createRunMetrics();
    m.recordRun('completed', usage({ promptTokens: 30, completionTokens: 20 }));
    expect(m.snapshot().tokens.total).toBe(50);
  });

  it('recordSession maps ready→completed and error→failed (folding vm.usage)', () => {
    const m = createRunMetrics();
    m.recordSession('ready', vmWith(usage({ totalTokens: 10, costUsd: 0.001 })));
    m.recordSession('error', vmWith());
    m.recordSession('streaming', vmWith()); // non-terminal → ignored
    m.recordSession('submitted', vmWith()); // ignored
    const s = m.snapshot();
    expect(s).toMatchObject({ runs: 2, completed: 1, failed: 1 });
    expect(s.tokens.total).toBe(10);
  });

  it('ignores negative / NaN / non-finite usage values', () => {
    const m = createRunMetrics();
    m.recordRun('completed', usage({ promptTokens: -5, completionTokens: NaN, costUsd: Infinity, latencyMs: -1 }));
    const s = m.snapshot();
    expect(s.tokens).toEqual({ prompt: 0, completion: 0, total: 0 });
    expect(s.costUsd).toBe(0);
    expect(s.avgLatencyMs).toBe(0);
  });

  it('reset clears all counters but keeps startedAt', () => {
    const m = createRunMetrics({ startedAt: 'T0' });
    m.recordRun('completed', usage({ totalTokens: 100, costUsd: 1 }));
    m.reset();
    const s = m.snapshot();
    expect(s).toMatchObject({ runs: 0, completed: 0, costUsd: 0, startedAt: 'T0' });
  });

  it('handles a large volume of runs (stress)', () => {
    const m = createRunMetrics();
    for (let i = 0; i < 50_000; i++) {
      m.recordRun(i % 10 === 0 ? 'failed' : 'completed', usage({ totalTokens: 2, costUsd: 0.0001 }));
    }
    const s = m.snapshot();
    expect(s.runs).toBe(50_000);
    expect(s.failed).toBe(5_000);
    expect(s.errorRate).toBeCloseTo(0.1, 5);
    expect(s.tokens.total).toBe(100_000);
    expect(s.costUsd).toBeCloseTo(5, 4);
  });
});
