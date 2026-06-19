import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  createLatencyTracker,
  getGlobalLatencyTracker,
  recordLatency,
  getP95Latency,
  getP99Latency,
  getLatencySnapshot,
  _setGlobalLatencyTracker,
  DEGRADATION_MULTIPLIER,
  MIN_DEGRADATION_LATENCY_MS,
  createThroughputTracker,
  getP50MsPerToken,
  recordThroughput,
  _setGlobalThroughputTracker,
  ADAPTIVE_BUDGET_SAFETY_FACTOR,
  ADAPTIVE_BUDGET_MIN_MS,
} from './latency-tracker.js';

describe('LatencyTracker — createLatencyTracker', () => {
  it('returns undefined when fewer than minSamples exist', () => {
    const t = createLatencyTracker({ minSamples: 10 });
    for (let i = 0; i < 9; i++) t.record('ep', 100);
    expect(t.getSnapshot('ep')).toBeUndefined();
    expect(t.getP95('ep')).toBeUndefined();
    expect(t.getP99('ep')).toBeUndefined();
  });

  it('returns percentile snapshot once minSamples reached', () => {
    const t = createLatencyTracker({ minSamples: 5 });
    // Record 5 samples: [10, 20, 30, 40, 50]
    [10, 20, 30, 40, 50].forEach(ms => t.record('ep', ms));
    const snap = t.getSnapshot('ep');
    expect(snap).toBeDefined();
    expect(snap!.sampleCount).toBe(5);
    // P50 of [10,20,30,40,50] at index floor(5*0.5)=2 → 30
    expect(snap!.p50).toBe(30);
    // P95 of 5 samples at index min(floor(5*0.95),4)=4 → 50
    expect(snap!.p95).toBe(50);
    // P99 at index min(floor(5*0.99),4)=4 → 50
    expect(snap!.p99).toBe(50);
  });

  it('correctly computes P95 with 100 samples', () => {
    const t = createLatencyTracker({ minSamples: 10 });
    // 100 samples: 1..100 ms
    for (let i = 1; i <= 100; i++) t.record('ep', i);
    const snap = t.getSnapshot('ep');
    expect(snap!.sampleCount).toBe(100);
    // P95 at index floor(100*0.95)=95, value 96
    expect(snap!.p95).toBe(96);
    // P99 at index floor(100*0.99)=99, value 100
    expect(snap!.p99).toBe(100);
    // P50 at index floor(100*0.5)=50, value 51
    expect(snap!.p50).toBe(51);
  });

  it('caps at windowSize — older entries are dropped when full', () => {
    const t = createLatencyTracker({ windowSize: 5, minSamples: 5 });
    // Record 8 samples — first 3 (1,2,3) should be evicted
    for (let i = 1; i <= 8; i++) t.record('ep', i);
    const snap = t.getSnapshot('ep');
    expect(snap!.sampleCount).toBe(5);
    // Remaining should be [4,5,6,7,8], min=4
    expect(snap!.p50).toBe(6);
  });

  it('evicts time-expired samples', () => {
    vi.useFakeTimers();
    const t = createLatencyTracker({ windowSize: 100, windowMs: 1000, minSamples: 3 });

    t.record('ep', 500);
    t.record('ep', 500);
    t.record('ep', 500);

    // Advance past window
    vi.advanceTimersByTime(1001);

    // These fresh samples replace the expired ones
    t.record('ep', 100);
    t.record('ep', 100);
    // Only 2 samples now — below minSamples=3
    expect(t.getSnapshot('ep')).toBeUndefined();

    t.record('ep', 100);
    const snap = t.getSnapshot('ep');
    expect(snap!.sampleCount).toBe(3);
    expect(snap!.p50).toBe(100);

    vi.useRealTimers();
  });

  it('isolates separate endpoints', () => {
    const t = createLatencyTracker({ minSamples: 3 });
    [100, 200, 300].forEach(ms => t.record('ep-a', ms));
    [10, 20, 30].forEach(ms => t.record('ep-b', ms));
    expect(t.getP99('ep-a')).toBe(300);
    expect(t.getP99('ep-b')).toBe(30);
  });

  it('_reset clears a specific endpoint', () => {
    const t = createLatencyTracker({ minSamples: 3 });
    [100, 200, 300].forEach(ms => t.record('ep', ms));
    expect(t.getP99('ep')).toBeDefined();
    t._reset('ep');
    expect(t.getP99('ep')).toBeUndefined();
  });

  it('_reset with no arg clears all endpoints', () => {
    const t = createLatencyTracker({ minSamples: 3 });
    [100, 200, 300].forEach(ms => t.record('a', ms));
    [100, 200, 300].forEach(ms => t.record('b', ms));
    t._reset();
    expect(t.getP99('a')).toBeUndefined();
    expect(t.getP99('b')).toBeUndefined();
  });
});

describe('LatencyTracker — process-global singleton', () => {
  beforeEach(() => _setGlobalLatencyTracker(createLatencyTracker({ minSamples: 3 })));
  afterEach(() => _setGlobalLatencyTracker(undefined));

  it('recordLatency + getP95Latency round-trip', () => {
    [100, 200, 300].forEach(ms => recordLatency('test:ep', ms));
    expect(getP95Latency('test:ep')).toBe(300);
  });

  it('getP99Latency returns undefined when cold', () => {
    expect(getP99Latency('cold:ep')).toBeUndefined();
  });

  it('getLatencySnapshot returns full snapshot', () => {
    [100, 200, 300].forEach(ms => recordLatency('test:ep', ms));
    const snap = getLatencySnapshot('test:ep');
    expect(snap?.sampleCount).toBe(3);
    expect(snap?.windowMs).toBeGreaterThan(0);
  });

  it('getGlobalLatencyTracker is the same instance across calls', () => {
    expect(getGlobalLatencyTracker()).toBe(getGlobalLatencyTracker());
  });
});

describe('LatencyTracker — degradation constants', () => {
  it('DEGRADATION_MULTIPLIER is 3', () => {
    expect(DEGRADATION_MULTIPLIER).toBe(3);
  });

  it('MIN_DEGRADATION_LATENCY_MS is ≥ 10000', () => {
    expect(MIN_DEGRADATION_LATENCY_MS).toBeGreaterThanOrEqual(10_000);
  });
});

// ─── ThroughputTracker ───────────────────────────────────────────────────────

describe('ThroughputTracker — createThroughputTracker', () => {
  it('returns undefined when fewer than minSamples exist', () => {
    const t = createThroughputTracker({ minSamples: 5 });
    // Only 4 samples
    for (let i = 0; i < 4; i++) t.record('ep', 10_000, 200);
    expect(t.getP50MsPerToken('ep')).toBeUndefined();
  });

  it('returns P50 ms/token once minSamples reached', () => {
    const t = createThroughputTracker({ minSamples: 5 });
    // 5 calls: each 10s / 200 tokens = 50 ms/token
    for (let i = 0; i < 5; i++) t.record('ep', 10_000, 200);
    const p50 = t.getP50MsPerToken('ep');
    expect(p50).toBeCloseTo(50, 0);
  });

  it('ignores samples with 0 output tokens', () => {
    const t = createThroughputTracker({ minSamples: 3 });
    // 3 real samples + 2 zero-token samples
    for (let i = 0; i < 3; i++) t.record('ep', 9_000, 300);
    t.record('ep', 5_000, 0);
    t.record('ep', 5_000, 0);
    const p50 = t.getP50MsPerToken('ep');
    expect(p50).toBeCloseTo(30, 0); // 9000/300 = 30 ms/token
  });

  it('computes correct P50 from mixed latencies', () => {
    const t = createThroughputTracker({ minSamples: 5 });
    // ms/token values: [10, 20, 30, 40, 50]
    [[1000,100],[2000,100],[3000,100],[4000,100],[5000,100]].forEach(
      ([dur, tok]) => t.record('ep', dur!, tok!)
    );
    const p50 = t.getP50MsPerToken('ep');
    // P50 index = floor(5*0.5) = 2 → 30
    expect(p50).toBeCloseTo(30, 0);
  });

  it('evicts old samples past windowMs', () => {
    vi.useFakeTimers();
    const t = createThroughputTracker({ minSamples: 3, windowMs: 1_000 });
    for (let i = 0; i < 3; i++) t.record('ep', 5_000, 100);
    expect(t.getP50MsPerToken('ep')).toBeDefined();
    vi.advanceTimersByTime(2_000);
    // All samples now older than 1s window → evicted
    expect(t.getP50MsPerToken('ep')).toBeUndefined();
    vi.useRealTimers();
  });

  it('_reset clears specific endpoint', () => {
    const t = createThroughputTracker({ minSamples: 3 });
    for (let i = 0; i < 3; i++) {
      t.record('ep-a', 5_000, 100);
      t.record('ep-b', 5_000, 100);
    }
    t._reset('ep-a');
    expect(t.getP50MsPerToken('ep-a')).toBeUndefined();
    expect(t.getP50MsPerToken('ep-b')).toBeDefined();
  });

  it('_reset with no arg clears all endpoints', () => {
    const t = createThroughputTracker({ minSamples: 3 });
    for (let i = 0; i < 3; i++) t.record('ep', 5_000, 100);
    t._reset();
    expect(t.getP50MsPerToken('ep')).toBeUndefined();
  });
});

describe('ThroughputTracker — global singleton', () => {
  beforeEach(() => { _setGlobalThroughputTracker(undefined); });
  afterEach(() => { _setGlobalThroughputTracker(undefined); });

  it('recordThroughput + getP50MsPerToken round-trip', () => {
    for (let i = 0; i < 5; i++) recordThroughput('openai:rest', 6_000, 200);
    const p50 = getP50MsPerToken('openai:rest');
    expect(p50).toBeCloseTo(30, 0); // 6000/200 = 30
  });

  it('returns undefined for cold endpoint', () => {
    expect(getP50MsPerToken('cold:ep')).toBeUndefined();
  });
});

describe('Phase 5 — adaptive budget constants', () => {
  it('ADAPTIVE_BUDGET_SAFETY_FACTOR is 1.5', () => {
    expect(ADAPTIVE_BUDGET_SAFETY_FACTOR).toBe(1.5);
  });

  it('ADAPTIVE_BUDGET_MIN_MS is at least 30 s', () => {
    expect(ADAPTIVE_BUDGET_MIN_MS).toBeGreaterThanOrEqual(30_000);
  });
});
