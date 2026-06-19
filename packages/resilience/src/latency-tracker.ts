/**
 * @weaveintel/resilience — Per-endpoint latency percentile tracker
 *
 * Maintains a sliding-window of observed request durations per endpoint and
 * exposes P50/P95/P99 statistics. These statistics serve two purposes:
 *
 *   1. Dynamic timeout fallback — `composeRequestSignal` in each provider uses
 *      `P95 × 2` as the fallback AbortSignal timeout so background calls adapt
 *      to actual observed latency instead of a hard-coded 5-minute constant.
 *
 *   2. Degradation detection — callers can compare the current call's latency
 *      against `P99 × DEGRADATION_MULTIPLIER` (3) to detect a provider that
 *      is still responding but taking 3× longer than its P99 baseline.
 *
 * Only successful call durations are recorded. Failures (auth errors, network
 * errors) are excluded so the baseline reflects healthy-state latency.
 *
 * Design choices aligned with mid-2026 production patterns:
 *  - 60-second sliding time window (LiteLLM TTL default)
 *  - 100-sample hard cap per endpoint
 *  - Minimum 10 samples before percentiles are trusted (LiteLLM: 5, industry: 10–20)
 *  - P95 × 2 for dynamic timeout; P99 × 3 for degradation detection
 */

export interface LatencySnapshot {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly sampleCount: number;
  readonly windowMs: number;
}

export interface LatencyTracker {
  /** Record one successful call duration for an endpoint. */
  record(endpointId: string, latencyMs: number): void;
  /** Returns percentile snapshot, or undefined if fewer than minSamples exist. */
  getSnapshot(endpointId: string): LatencySnapshot | undefined;
  /** Convenience: P50 or undefined if too few samples. */
  getP50(endpointId: string): number | undefined;
  /** Convenience: P95 or undefined if too few samples. */
  getP95(endpointId: string): number | undefined;
  /** Convenience: P99 or undefined if too few samples. */
  getP99(endpointId: string): number | undefined;
  /** Reset a specific endpoint (test-only). */
  _reset(endpointId?: string): void;
}

export interface LatencyTrackerOptions {
  /** Max number of samples to retain per endpoint. Default: 100 */
  windowSize?: number;
  /** Samples older than this are discarded. Default: 60_000 ms (60 s) */
  windowMs?: number;
  /** Minimum samples required before returning a percentile. Default: 10 */
  minSamples?: number;
}

export function createLatencyTracker(opts?: LatencyTrackerOptions): LatencyTracker {
  const windowSize = opts?.windowSize ?? 100;
  const windowMs   = opts?.windowMs   ?? 60_000;
  const minSamples = opts?.minSamples ?? 10;

  // Map<endpointId, [latencyMs, timestamp][]> — stored as pairs for memory efficiency
  const store = new Map<string, Array<[number, number]>>();

  function getOrCreate(endpointId: string): Array<[number, number]> {
    let arr = store.get(endpointId);
    if (!arr) { arr = []; store.set(endpointId, arr); }
    return arr;
  }

  function trim(arr: Array<[number, number]>): void {
    const cutoff = Date.now() - windowMs;
    // arr is insertion-ordered; expired entries are at the front
    let start = 0;
    while (start < arr.length && arr[start]![1] < cutoff) start++;
    if (start > 0) arr.splice(0, start);
    // Hard cap — keep only the most recent windowSize entries
    if (arr.length > windowSize) arr.splice(0, arr.length - windowSize);
  }

  function percentile(sorted: number[], p: number): number {
    if (!sorted.length) return 0;
    const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
    return sorted[idx]!;
  }

  return {
    record(endpointId, latencyMs) {
      const arr = getOrCreate(endpointId);
      arr.push([latencyMs, Date.now()]);
      trim(arr);
    },

    getSnapshot(endpointId) {
      const arr = getOrCreate(endpointId);
      trim(arr);
      if (arr.length < minSamples) return undefined;
      const sorted = arr.map(([ms]) => ms).sort((a, b) => a - b);
      return {
        p50:         percentile(sorted, 0.50),
        p95:         percentile(sorted, 0.95),
        p99:         percentile(sorted, 0.99),
        sampleCount: sorted.length,
        windowMs,
      };
    },

    getP50(endpointId) {
      return this.getSnapshot(endpointId)?.p50;
    },

    getP95(endpointId) {
      return this.getSnapshot(endpointId)?.p95;
    },

    getP99(endpointId) {
      return this.getSnapshot(endpointId)?.p99;
    },

    _reset(endpointId) {
      if (endpointId) store.delete(endpointId);
      else store.clear();
    },
  };
}

// ─── Process-wide singleton ───────────────────────────────────────────────────

let _global: LatencyTracker | undefined;

/** Returns the process-global LatencyTracker singleton (lazy-init). */
export function getGlobalLatencyTracker(): LatencyTracker {
  if (!_global) _global = createLatencyTracker();
  return _global;
}

/** Record one successful call latency in the process-global tracker. */
export function recordLatency(endpointId: string, latencyMs: number): void {
  getGlobalLatencyTracker().record(endpointId, latencyMs);
}

/** Returns P95 for an endpoint from the global tracker, or undefined if cold. */
export function getP95Latency(endpointId: string): number | undefined {
  return getGlobalLatencyTracker().getP95(endpointId);
}

/** Returns P99 for an endpoint from the global tracker, or undefined if cold. */
export function getP99Latency(endpointId: string): number | undefined {
  return getGlobalLatencyTracker().getP99(endpointId);
}

/** Returns full snapshot for an endpoint from the global tracker. */
export function getLatencySnapshot(endpointId: string): LatencySnapshot | undefined {
  return getGlobalLatencyTracker().getSnapshot(endpointId);
}

/** Replace the process-global tracker (test-only). */
export function _setGlobalLatencyTracker(t: LatencyTracker | undefined): void {
  _global = t;
}

// ─── Degradation constants ────────────────────────────────────────────────────

/** P99 multiplier that, when exceeded by a single call, signals degradation. */
export const DEGRADATION_MULTIPLIER = 3;

/** Minimum latency in ms for degradation detection to fire.
 *  Prevents false positives on very short P99 baselines (e.g. P99=1 s → 3 s threshold). */
export const MIN_DEGRADATION_LATENCY_MS = 15_000;

/** Duration of the soft block applied when degradation is detected. */
export const DEGRADATION_BLOCK_MS = 30_000;

/** Multiplier applied to P95 to compute a dynamic provider-level fallback timeout.
 *  Never below MIN_DYNAMIC_TIMEOUT_MS; never above the static DEFAULT. */
export const DYNAMIC_TIMEOUT_MULTIPLIER = 2;

/** Floor for the dynamic timeout — providers won't be given less than 30 s regardless of P95. */
export const MIN_DYNAMIC_TIMEOUT_MS = 30_000;

// ─── Throughput tracker (Phase 5 — token-aware adaptive budget) ──────────────

/**
 * Tracks observed milliseconds-per-output-token per endpoint.
 * Feeds `selectStreamBudget` with a P50 ms/token value so the context
 * deadline can be tightened to `estimated_tokens × p50MsPerToken × 1.5`
 * rather than always using the static 2/5/10 minute caps.
 *
 * Only successful completions with > 0 output tokens are recorded.
 * Rate-limited or errored calls are excluded so the baseline reflects
 * healthy throughput, not degraded-state throughput.
 */
export interface ThroughputTracker {
  /** Record one successful completion: total duration and number of output tokens. */
  record(endpointId: string, durationMs: number, outputTokens: number): void;
  /** P50 milliseconds-per-output-token, or undefined if fewer than minSamples. */
  getP50MsPerToken(endpointId: string): number | undefined;
  /** Reset (test-only). */
  _reset(endpointId?: string): void;
}

export interface ThroughputTrackerOptions {
  /** Max samples per endpoint. Default: 100 */
  windowSize?: number;
  /** Discard samples older than this. Default: 60_000 ms */
  windowMs?: number;
  /** Minimum samples before returning a value. Default: 5 */
  minSamples?: number;
}

export function createThroughputTracker(opts?: ThroughputTrackerOptions): ThroughputTracker {
  const windowSize = opts?.windowSize ?? 100;
  const windowMs   = opts?.windowMs   ?? 60_000;
  const minSamples = opts?.minSamples ?? 5;

  // Map<endpointId, [msPerToken, timestamp][]>
  const store = new Map<string, Array<[number, number]>>();

  function getOrCreate(endpointId: string): Array<[number, number]> {
    let arr = store.get(endpointId);
    if (!arr) { arr = []; store.set(endpointId, arr); }
    return arr;
  }

  function trim(arr: Array<[number, number]>): void {
    const cutoff = Date.now() - windowMs;
    let start = 0;
    while (start < arr.length && arr[start]![1] < cutoff) start++;
    if (start > 0) arr.splice(0, start);
    if (arr.length > windowSize) arr.splice(0, arr.length - windowSize);
  }

  return {
    record(endpointId, durationMs, outputTokens) {
      if (outputTokens <= 0) return;
      const arr = getOrCreate(endpointId);
      arr.push([durationMs / outputTokens, Date.now()]);
      trim(arr);
    },

    getP50MsPerToken(endpointId) {
      const arr = getOrCreate(endpointId);
      trim(arr);
      if (arr.length < minSamples) return undefined;
      const sorted = arr.map(([ms]) => ms).sort((a, b) => a - b);
      const idx = Math.min(Math.floor(sorted.length * 0.5), sorted.length - 1);
      return sorted[idx];
    },

    _reset(endpointId) {
      if (endpointId) store.delete(endpointId);
      else store.clear();
    },
  };
}

// ─── Throughput process-global singleton ─────────────────────────────────────

let _globalThroughput: ThroughputTracker | undefined;

export function getGlobalThroughputTracker(): ThroughputTracker {
  if (!_globalThroughput) _globalThroughput = createThroughputTracker();
  return _globalThroughput;
}

/** Record one successful completion in the process-global tracker. */
export function recordThroughput(endpointId: string, durationMs: number, outputTokens: number): void {
  getGlobalThroughputTracker().record(endpointId, durationMs, outputTokens);
}

/** P50 ms/token for an endpoint from the global tracker, or undefined if cold. */
export function getP50MsPerToken(endpointId: string): number | undefined {
  return getGlobalThroughputTracker().getP50MsPerToken(endpointId);
}

/** Replace the global throughput tracker (test-only). */
export function _setGlobalThroughputTracker(t: ThroughputTracker | undefined): void {
  _globalThroughput = t;
}

// ─── Adaptive budget constants (Phase 5) ─────────────────────────────────────

/** Safety multiplier applied on top of estimated_tokens × p50MsPerToken. */
export const ADAPTIVE_BUDGET_SAFETY_FACTOR = 1.5;

/** Never shrink the deadline below this floor regardless of token estimate. */
export const ADAPTIVE_BUDGET_MIN_MS = 30_000;
