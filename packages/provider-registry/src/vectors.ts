// SPDX-License-Identifier: MIT
/**
 * Vector arithmetic the registry applies so every embedding it hands back is
 * comparable: unit length, and the size that was asked for.
 */

/** Scale a vector to length 1. A zero vector is returned unchanged. */
export function normalizeVector(v: readonly number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const len = Math.sqrt(sum);
  if (len === 0 || !Number.isFinite(len)) return [...v];
  return v.map((x) => x / len);
}

/** True when the vector is already length 1 (within floating-point noise). */
export function isUnitLength(v: readonly number[]): boolean {
  let sum = 0;
  for (const x of v) sum += x * x;
  return Math.abs(sum - 1) < 1e-3;
}

/**
 * Keep the first `size` numbers and re-normalise. Only meaningful for models
 * trained so that a prefix of the vector is itself a good embedding
 * (Matryoshka-style); the model's descriptor says whether that is so.
 */
export function truncateVector(v: readonly number[], size: number): number[] {
  return normalizeVector(v.slice(0, size));
}
