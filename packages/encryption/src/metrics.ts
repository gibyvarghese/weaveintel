/**
 * @weaveintel/encryption — metrics emitter contract (Phase 9).
 *
 * Mirrors the AuditEmitter pattern: a fire-and-forget interface that the
 * package calls from hot paths (encrypt/decrypt/blind-index/wrap/unwrap)
 * without ever blocking on it. Hosts plug an in-memory aggregator (shipped
 * here as `InMemoryMetricsEmitter`), an OTel exporter, or a no-op.
 *
 * Design invariants:
 *   - Synchronous interface: `record(...)` returns `void` so the manager
 *     never awaits inside crypto. Aggregators MUST swallow their own errors.
 *   - No external deps. The package depends only on `@weaveintel/core` +
 *     `node:crypto`. Observability backends are wired by the host.
 *   - Stable metric names (see `MetricName`) so dashboards survive code
 *     reorganisation.
 *
 * Naming convention follows the design doc: `encryption.<group>.<verb>_<unit>`.
 */

export type MetricName =
  | 'encryption.encrypt.duration_ms'
  | 'encryption.decrypt.duration_ms'
  | 'encryption.blind_index.duration_ms'
  | 'encryption.kms.wrap.duration_ms'
  | 'encryption.kms.unwrap.duration_ms'
  | 'encryption.cache.hit'
  | 'encryption.cache.miss'
  | 'encryption.aead.error'
  | 'encryption.kms.error'
  | 'encryption.rotation.rewritten_rows';

export type MetricKind = 'histogram' | 'counter';

export interface MetricLabels {
  /** Tenant context. `'__system__'` for cross-tenant, `null` for unattributed. */
  readonly tenantId?: string | null;
  readonly table?: string | null;
  readonly column?: string | null;
  readonly provider?: string | null;
  /** For cache.hit/miss: `'kek' | 'dek' | 'bik' | 'kms'`. */
  readonly cache?: 'kek' | 'dek' | 'bik' | 'kms' | null;
  /** Free-form discriminator (e.g. error class name). */
  readonly kind?: string | null;
}

export interface MetricRecord {
  readonly name: MetricName;
  readonly kind: MetricKind;
  /** For histograms: duration in ms. For counters: increment (default 1). */
  readonly value: number;
  readonly labels: MetricLabels;
  readonly at: number;
}

export interface MetricsEmitter {
  record(rec: MetricRecord): void;
}

export const noopMetricsEmitter: MetricsEmitter = {
  record(): void {
    /* no-op */
  },
};

// ─── In-memory aggregator (dashboard backing) ────────────────────────────────

export interface HistogramSnapshot {
  readonly count: number;
  readonly sum: number;
  readonly min: number;
  readonly max: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

export interface CounterSnapshot {
  readonly count: number;
}

export interface MetricSeriesSnapshot {
  readonly name: MetricName;
  readonly kind: MetricKind;
  readonly labels: MetricLabels;
  readonly histogram?: HistogramSnapshot;
  readonly counter?: CounterSnapshot;
  readonly lastAt: number;
}

export interface MetricsSnapshot {
  readonly takenAt: number;
  readonly series: readonly MetricSeriesSnapshot[];
}

interface SeriesState {
  readonly name: MetricName;
  readonly kind: MetricKind;
  readonly labels: MetricLabels;
  /** Bounded ring buffer of histogram observations. */
  values: number[];
  count: number;
  sum: number;
  min: number;
  max: number;
  lastAt: number;
}

export interface InMemoryMetricsEmitterOptions {
  /**
   * Cap on retained histogram samples per series. Older samples are evicted
   * FIFO once the cap is reached. Default 1024 — enough for stable p95/p99
   * estimates while bounding memory.
   */
  readonly maxSamplesPerSeries?: number;
  /**
   * Cap on total series tracked. Once reached, new label combinations are
   * dropped (logged via `onOverflow` if provided). Default 256.
   */
  readonly maxSeries?: number;
  readonly onOverflow?: (name: MetricName, labels: MetricLabels) => void;
}

/**
 * In-memory metrics aggregator used by the admin dashboard. Cardinality is
 * bounded — labels collapse to `(name, tenantId, table, provider, cache, kind)`
 * tuples, and excess series are dropped rather than ballooning memory.
 *
 * NOT thread-safe across worker threads — geneweave runs single-process today.
 * If you need multi-process aggregation, swap this for a Redis-backed impl.
 */
export class InMemoryMetricsEmitter implements MetricsEmitter {
  readonly #maxSamples: number;
  readonly #maxSeries: number;
  readonly #onOverflow?: (name: MetricName, labels: MetricLabels) => void;
  readonly #series = new Map<string, SeriesState>();

  constructor(opts: InMemoryMetricsEmitterOptions = {}) {
    this.#maxSamples = opts.maxSamplesPerSeries ?? 1024;
    this.#maxSeries = opts.maxSeries ?? 256;
    if (opts.onOverflow) this.#onOverflow = opts.onOverflow;
  }

  record(rec: MetricRecord): void {
    try {
      const key = seriesKey(rec.name, rec.labels);
      let s = this.#series.get(key);
      if (!s) {
        if (this.#series.size >= this.#maxSeries) {
          this.#onOverflow?.(rec.name, rec.labels);
          return;
        }
        s = {
          name: rec.name,
          kind: rec.kind,
          labels: normaliseLabels(rec.labels),
          values: [],
          count: 0,
          sum: 0,
          min: Number.POSITIVE_INFINITY,
          max: Number.NEGATIVE_INFINITY,
          lastAt: rec.at,
        };
        this.#series.set(key, s);
      }
      s.count += 1;
      s.sum += rec.value;
      s.lastAt = rec.at;
      if (rec.kind === 'histogram') {
        if (rec.value < s.min) s.min = rec.value;
        if (rec.value > s.max) s.max = rec.value;
        s.values.push(rec.value);
        if (s.values.length > this.#maxSamples) s.values.shift();
      }
    } catch {
      // Aggregators MUST never throw upstream.
    }
  }

  snapshot(now: number = Date.now()): MetricsSnapshot {
    const out: MetricSeriesSnapshot[] = [];
    for (const s of this.#series.values()) {
      if (s.kind === 'histogram') {
        const sorted = [...s.values].sort((a, b) => a - b);
        out.push({
          name: s.name,
          kind: 'histogram',
          labels: s.labels,
          histogram: {
            count: s.count,
            sum: s.sum,
            min: s.min === Number.POSITIVE_INFINITY ? 0 : s.min,
            max: s.max === Number.NEGATIVE_INFINITY ? 0 : s.max,
            p50: percentile(sorted, 0.5),
            p95: percentile(sorted, 0.95),
            p99: percentile(sorted, 0.99),
          },
          lastAt: s.lastAt,
        });
      } else {
        out.push({
          name: s.name,
          kind: 'counter',
          labels: s.labels,
          counter: { count: s.count },
          lastAt: s.lastAt,
        });
      }
    }
    return { takenAt: now, series: out };
  }

  /** Reset all series — primarily used for tests. */
  reset(): void {
    this.#series.clear();
  }

  /** Series count — debug/tests. */
  size(): number {
    return this.#series.size;
  }
}

function seriesKey(name: MetricName, labels: MetricLabels): string {
  return [
    name,
    labels.tenantId ?? '',
    labels.table ?? '',
    labels.column ?? '',
    labels.provider ?? '',
    labels.cache ?? '',
    labels.kind ?? '',
  ].join('|');
}

function normaliseLabels(l: MetricLabels): MetricLabels {
  return {
    tenantId: l.tenantId ?? null,
    table: l.table ?? null,
    column: l.column ?? null,
    provider: l.provider ?? null,
    cache: l.cache ?? null,
    kind: l.kind ?? null,
  };
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[idx]!;
}

// ─── Helper: timing wrapper ──────────────────────────────────────────────────

/**
 * Stopwatch used inside crypto hot paths. Returns a thunk that records the
 * elapsed ms when called. Always uses `performance.now()` for monotonic
 * timing; falls back to Date.now() if unavailable (e.g. very old runtimes).
 */
export function startTimer(): () => number {
  const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return () =>
    (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start;
}
