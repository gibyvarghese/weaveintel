import { describe, it, expect } from 'vitest';
import { evaluateAlerts, DEFAULT_ALERT_RULES, type AlertRule, type RotationStatus } from './alert-evaluator.js';
import type { MetricsSnapshot, MetricSeriesSnapshot } from './metrics.js';

const NOW = 1_700_000_000_000;

function emptySnapshot(): MetricsSnapshot {
  return { takenAt: NOW, series: [] };
}

function makeRule(overrides: Partial<AlertRule> = {}): AlertRule {
  return {
    id: 'rule-1',
    tenantId: 'tenant-1',
    kind: 'rotation_overdue',
    threshold: 90,
    windowMs: null,
    enabled: true,
    ...overrides,
  };
}

function counterSeries(
  name: MetricSeriesSnapshot['name'],
  count: number,
  tenantId: string,
  lastAt = NOW,
): MetricSeriesSnapshot {
  return {
    name,
    kind: 'counter',
    labels: { tenantId },
    counter: { count },
    lastAt,
  };
}

function histogramSeries(
  name: MetricSeriesSnapshot['name'],
  p95: number,
  tenantId: string,
): MetricSeriesSnapshot {
  return {
    name,
    kind: 'histogram',
    labels: { tenantId },
    histogram: { p50: p95 * 0.5, p95, p99: p95 * 1.1, min: 1, max: p95 + 10, count: 100, sum: p95 * 100 },
    lastAt: NOW,
  };
}

// ── disabled rules ─────────────────────────────────────────────

describe('evaluateAlerts — disabled rules', () => {
  it('skips disabled rules', () => {
    const rule = makeRule({ kind: 'rotation_overdue', enabled: false });
    const rotationStatus: RotationStatus[] = [
      { tenantId: 'tenant-1', lastRotationAt: null, cadenceDays: 90 },
    ];
    const result = evaluateAlerts({ rules: [rule], snapshot: emptySnapshot(), rotationStatus, now: NOW });
    expect(result).toHaveLength(0);
  });
});

// ── rotation_overdue ───────────────────────────────────────────

describe('evaluateAlerts — rotation_overdue', () => {
  it('fires when rotation age exceeds threshold days', () => {
    const rule = makeRule({ kind: 'rotation_overdue', threshold: 90 });
    const rotationStatus: RotationStatus[] = [
      { tenantId: 'tenant-1', lastRotationAt: NOW - 95 * 86_400_000, cadenceDays: 90 },
    ];
    const result = evaluateAlerts({ rules: [rule], snapshot: emptySnapshot(), rotationStatus, now: NOW });
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe('rotation_overdue');
    expect(result[0]!.observed).toBeGreaterThanOrEqual(95);
  });

  it('fires when tenant has never rotated (cadence + 1 days)', () => {
    const rule = makeRule({ kind: 'rotation_overdue', threshold: 90, tenantId: 'tenant-1' });
    const rotationStatus: RotationStatus[] = [
      { tenantId: 'tenant-1', lastRotationAt: null, cadenceDays: 90 },
    ];
    const result = evaluateAlerts({ rules: [rule], snapshot: emptySnapshot(), rotationStatus, now: NOW });
    expect(result).toHaveLength(1);
    expect(result[0]!.observed).toBe(91);
  });

  it('does not fire when rotation is recent', () => {
    const rule = makeRule({ kind: 'rotation_overdue', threshold: 90 });
    const rotationStatus: RotationStatus[] = [
      { tenantId: 'tenant-1', lastRotationAt: NOW - 30 * 86_400_000, cadenceDays: 90 },
    ];
    const result = evaluateAlerts({ rules: [rule], snapshot: emptySnapshot(), rotationStatus, now: NOW });
    expect(result).toHaveLength(0);
  });

  it('returns null observed when no rotation data provided', () => {
    const rule = makeRule({ kind: 'rotation_overdue', threshold: 1 });
    const result = evaluateAlerts({ rules: [rule], snapshot: emptySnapshot(), now: NOW });
    expect(result).toHaveLength(0);
  });
});

// ── kms_error_rate ─────────────────────────────────────────────

describe('evaluateAlerts — kms_error_rate', () => {
  it('fires when kms error count/min exceeds threshold', () => {
    const rule = makeRule({ kind: 'kms_error_rate', threshold: 5, windowMs: 60_000, tenantId: null });
    const snap: MetricsSnapshot = {
      takenAt: NOW,
      series: [counterSeries('encryption.kms.error', 60, 'tenant-1')],
    };
    const result = evaluateAlerts({ rules: [rule], snapshot: snap, now: NOW });
    expect(result).toHaveLength(1);
    expect(result[0]!.observed).toBeGreaterThanOrEqual(5);
  });

  it('returns 0 observed when no kms errors', () => {
    const rule = makeRule({ kind: 'kms_error_rate', threshold: 1, tenantId: null });
    const result = evaluateAlerts({ rules: [rule], snapshot: emptySnapshot(), now: NOW });
    expect(result).toHaveLength(0);
  });

  it('does not include stale series outside window', () => {
    const rule = makeRule({ kind: 'kms_error_rate', threshold: 1, windowMs: 60_000, tenantId: null });
    const snap: MetricsSnapshot = {
      takenAt: NOW,
      series: [counterSeries('encryption.kms.error', 100, 'tenant-1', NOW - 120_000)],
    };
    const result = evaluateAlerts({ rules: [rule], snapshot: snap, now: NOW });
    expect(result).toHaveLength(0);
  });
});

// ── decrypt_latency_p95 ────────────────────────────────────────

describe('evaluateAlerts — decrypt_latency_p95', () => {
  it('fires when p95 exceeds threshold', () => {
    const rule = makeRule({ kind: 'decrypt_latency_p95', threshold: 50, tenantId: null });
    const snap: MetricsSnapshot = {
      takenAt: NOW,
      series: [histogramSeries('encryption.decrypt.duration_ms', 80, 'tenant-1')],
    };
    const result = evaluateAlerts({ rules: [rule], snapshot: snap, now: NOW });
    expect(result).toHaveLength(1);
    expect(result[0]!.observed).toBe(80);
  });

  it('does not fire when p95 is below threshold', () => {
    const rule = makeRule({ kind: 'decrypt_latency_p95', threshold: 100, tenantId: null });
    const snap: MetricsSnapshot = {
      takenAt: NOW,
      series: [histogramSeries('encryption.decrypt.duration_ms', 30, 'tenant-1')],
    };
    expect(evaluateAlerts({ rules: [rule], snapshot: snap, now: NOW })).toHaveLength(0);
  });

  it('returns no firing when no histogram data', () => {
    const rule = makeRule({ kind: 'decrypt_latency_p95', threshold: 1, tenantId: null });
    expect(evaluateAlerts({ rules: [rule], snapshot: emptySnapshot(), now: NOW })).toHaveLength(0);
  });
});

// ── cache_hit_rate ─────────────────────────────────────────────

describe('evaluateAlerts — cache_hit_rate', () => {
  it('fires when hit rate falls below threshold', () => {
    const rule = makeRule({ kind: 'cache_hit_rate', threshold: 0.8, tenantId: null });
    const snap: MetricsSnapshot = {
      takenAt: NOW,
      series: [
        counterSeries('encryption.cache.hit', 10, 'tenant-1'),
        counterSeries('encryption.cache.miss', 90, 'tenant-1'),
      ],
    };
    const result = evaluateAlerts({ rules: [rule], snapshot: snap, now: NOW });
    expect(result).toHaveLength(1);
    expect(result[0]!.observed).toBeCloseTo(0.1, 2);
  });

  it('does not fire when hit rate meets threshold', () => {
    const rule = makeRule({ kind: 'cache_hit_rate', threshold: 0.8, tenantId: null });
    const snap: MetricsSnapshot = {
      takenAt: NOW,
      series: [
        counterSeries('encryption.cache.hit', 90, 'tenant-1'),
        counterSeries('encryption.cache.miss', 10, 'tenant-1'),
      ],
    };
    expect(evaluateAlerts({ rules: [rule], snapshot: snap, now: NOW })).toHaveLength(0);
  });

  it('returns no firing when no cache data', () => {
    const rule = makeRule({ kind: 'cache_hit_rate', threshold: 0.8, tenantId: null });
    expect(evaluateAlerts({ rules: [rule], snapshot: emptySnapshot(), now: NOW })).toHaveLength(0);
  });
});

// ── DEFAULT_ALERT_RULES ────────────────────────────────────────

describe('DEFAULT_ALERT_RULES', () => {
  it('has 5 entries', () => {
    expect(DEFAULT_ALERT_RULES).toHaveLength(5);
  });

  it('has all expected rule kinds', () => {
    const kinds = DEFAULT_ALERT_RULES.map((r) => r.kind);
    expect(kinds).toContain('rotation_overdue');
    expect(kinds).toContain('kms_error_rate');
    expect(kinds).toContain('aead_error_rate');
    expect(kinds).toContain('decrypt_latency_p95');
    expect(kinds).toContain('cache_hit_rate');
  });
});
