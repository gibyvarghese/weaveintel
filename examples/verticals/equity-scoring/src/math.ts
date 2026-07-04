/**
 * Pure math utilities for cross-sectional factor scoring.
 * All functions are deterministic and side-effect-free.
 */

/** Population z-score of value within an array of values. */
export function zScore(value: number, values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return (value - mean) / std;
}

/** Squash z-score to [-1, +1] using tanh. */
export function squash(z: number): number {
  return Math.tanh(z * 0.5);  // scale so z=2 → ~0.76, z=4 → ~0.96
}

/** Cross-sectional median of an array. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

/** Compute the linear regression slope (least-squares) over an array. */
export function slope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = values.reduce((s, v) => s + v, 0) / n;
  const num = values.reduce((s, v, i) => s + (i - xMean) * (v - yMean), 0);
  const den = values.reduce((s, _, i) => s + (i - xMean) ** 2, 0);
  return den === 0 ? 0 : num / den;
}

/**
 * CAGR from first to last value over n periods.
 * Returns null if either value is null/non-positive or n < 1.
 */
export function cagr(first: number | null, last: number | null, n: number): number | null {
  if (first === null || last === null || first <= 0 || last <= 0 || n < 1) return null;
  return (last / first) ** (1 / n) - 1;
}

/** Annualised realized volatility of daily log returns. */
export function annualizedVol(closePrices: number[]): number {
  if (closePrices.length < 2) return 0;
  const logReturns = closePrices.slice(1).map((p, i) => Math.log(p / (closePrices[i]!)));
  const mean = logReturns.reduce((s, r) => s + r, 0) / logReturns.length;
  const variance = logReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / logReturns.length;
  return Math.sqrt(variance * 252);
}

/** Maximum drawdown over a series of prices (returns negative fraction). */
export function maxDrawdown(prices: number[]): number {
  if (prices.length < 2) return 0;
  let peak = prices[0]!;
  let dd = 0;
  for (const p of prices) {
    if (p > peak) peak = p;
    const cur = (p - peak) / peak;
    if (cur < dd) dd = cur;
  }
  return dd;
}

/**
 * Collect non-null values and compute their z-scores.
 * Missing values are imputed with the cross-sectional median.
 * Returns: { z, coverage, imputed }.
 */
export function crossSectionalZ(
  selfValue: number | null,
  peerValues: Array<number | null>,
): { z: number; coverage: number; imputed: boolean } {
  const allRaw = [selfValue, ...peerValues];
  const present = allRaw.filter((v): v is number => v !== null && isFinite(v));
  const coverage = selfValue !== null && isFinite(selfValue) ? 1 : 0;
  const effectiveValue = coverage === 1 ? selfValue! : median(present);
  const allForZ = present.length > 0 ? present : [0];
  return { z: zScore(effectiveValue, allForZ), coverage, imputed: coverage === 0 };
}

/** Clip a value to [min, max]. */
export function clip(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
