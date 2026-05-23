/**
 * @weaveintel/encryption — Phase 9 metrics + alert evaluator unit tests.
 */

import { describe, expect, it } from 'vitest';
import {
  InMemoryMetricsEmitter,
  noopMetricsEmitter,
  startTimer,
  type MetricsSnapshot,
} from './metrics.js';
import { evaluateAlerts, type AlertRule, type RotationStatus } from './alert-evaluator.js';

describe('InMemoryMetricsEmitter', () => {
  it('record() accepts arbitrary metric names without throwing', () => {
    const m = new InMemoryMetricsEmitter();
    expect(() =>
      m.record({ name: 'totally.fake' as never, kind: 'counter', value: 1, labels: {}, at: Date.now() }),
    ).not.toThrow();
  });

  it('aggregates histogram percentiles deterministically', () => {
    const m = new InMemoryMetricsEmitter();
    const at = 1_000;
    for (let v = 1; v <= 100; v++) {
      m.record({
        name: 'encryption.encrypt.duration_ms',
        kind: 'histogram',
        value: v,
        labels: { tenantId: 't1', table: 'tt', column: 'cc' },
        at,
      });
    }
    const snap = m.snapshot(at);
    const series = snap.series.find((s) => s.name === 'encryption.encrypt.duration_ms');
    expect(series).toBeDefined();
    expect(series!.histogram!.count).toBe(100);
    expect(series!.histogram!.p50).toBeGreaterThanOrEqual(50);
    expect(series!.histogram!.p50).toBeLessThanOrEqual(51);
    expect(series!.histogram!.p95).toBeGreaterThanOrEqual(95);
    expect(series!.histogram!.p99).toBeGreaterThanOrEqual(99);
  });

  it('counter values accumulate across record() calls', () => {
    const m = new InMemoryMetricsEmitter();
    for (let i = 0; i < 5; i++) {
      m.record({ name: 'encryption.cache.hit', kind: 'counter', value: 1, labels: { tenantId: 't', cache: 'kek' }, at: Date.now() });
    }
    const snap = m.snapshot();
    const s = snap.series.find((s) => s.name === 'encryption.cache.hit');
    expect(s?.counter?.count).toBe(5);
  });

  it('series count is bounded — high-cardinality labels do not blow memory', () => {
    const m = new InMemoryMetricsEmitter({ maxSeries: 10 });
    for (let i = 0; i < 50; i++) {
      m.record({
        name: 'encryption.cache.hit',
        kind: 'counter',
        value: 1,
        labels: { tenantId: `t-${i}`, cache: 'kek' },
        at: Date.now(),
      });
    }
    expect(m.snapshot().series.length).toBeLessThanOrEqual(10);
  });
});

describe('noopMetricsEmitter', () => {
  it('record() is a no-op', () => {
    expect(() => noopMetricsEmitter.record({ name: 'encryption.encrypt.duration_ms', kind: 'histogram', value: 1, labels: {}, at: 0 })).not.toThrow();
  });
});

describe('startTimer', () => {
  it('returns a positive elapsed value', async () => {
    const stop = startTimer();
    await new Promise((r) => setTimeout(r, 5));
    const dt = stop();
    expect(dt).toBeGreaterThan(0);
  });
});

describe('evaluateAlerts', () => {
  const baseSnap: MetricsSnapshot = { takenAt: 1_000_000, series: [] };

  it('rotation_overdue fires when last rotation older than threshold', () => {
    const now = 100 * 86_400_000;
    const rotation: RotationStatus[] = [
      { tenantId: 't1', lastRotationAt: now - 120 * 86_400_000, cadenceDays: 90 },
    ];
    const rules: AlertRule[] = [
      { id: 'r1', tenantId: null, kind: 'rotation_overdue', threshold: 100, enabled: true },
    ];
    const firings = evaluateAlerts({ rules, snapshot: baseSnap, rotationStatus: rotation, now });
    expect(firings).toHaveLength(1);
    expect(firings[0]!.kind).toBe('rotation_overdue');
    expect(firings[0]!.observed).toBeGreaterThanOrEqual(120);
  });

  it('rotation_overdue does NOT fire when rotation is fresh', () => {
    const now = 100 * 86_400_000;
    const rotation: RotationStatus[] = [
      { tenantId: 't1', lastRotationAt: now - 5 * 86_400_000, cadenceDays: 90 },
    ];
    const rules: AlertRule[] = [
      { id: 'r1', tenantId: null, kind: 'rotation_overdue', threshold: 100, enabled: true },
    ];
    expect(evaluateAlerts({ rules, snapshot: baseSnap, rotationStatus: rotation, now })).toHaveLength(0);
  });

  it('cache_hit_rate fires when below threshold (lower-is-worse)', () => {
    const m = new InMemoryMetricsEmitter();
    m.record({ name: 'encryption.cache.hit', kind: 'counter', value: 1, labels: { tenantId: 't', cache: 'dek' }, at: 1 });
    for (let i = 0; i < 9; i++) {
      m.record({ name: 'encryption.cache.miss', kind: 'counter', value: 1, labels: { tenantId: 't', cache: 'dek' }, at: 1 });
    }
    const snap = m.snapshot();
    const rules: AlertRule[] = [{ id: 'r', tenantId: null, kind: 'cache_hit_rate', threshold: 0.8, enabled: true }];
    const firings = evaluateAlerts({ rules, snapshot: snap });
    expect(firings).toHaveLength(1);
    expect(firings[0]!.observed).toBeLessThan(0.8);
  });

  it('disabled rules never fire', () => {
    const rules: AlertRule[] = [{ id: 'r', tenantId: null, kind: 'kms_error_rate', threshold: 0, enabled: false }];
    expect(evaluateAlerts({ rules, snapshot: baseSnap })).toHaveLength(0);
  });
});
