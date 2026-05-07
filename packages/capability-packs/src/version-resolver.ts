import type { PackStatus } from './manifest.js';

/**
 * Minimal row shape the resolver works against. Apps can extend this on
 * their DB rows; the resolver only depends on these fields.
 */
export interface PackVersionRow {
  packKey: string;
  version: string;
  status: PackStatus;
  /** Higher = newer. The resolver uses semver comparison, not this field. */
  publishedAt?: string;
}

export interface ResolvePackContext {
  /** When set, the resolver returns this exact version regardless of status. */
  versionOverride?: string;
}

/**
 * Pick the active version for a pack key.
 *
 * Precedence (matches `@weaveintel/prompts` Phase 5):
 *   1. ctx.versionOverride (any status, exact match)
 *   2. The highest semver among status === 'published'
 *   3. The highest semver among any status (fallback for dev environments)
 *   4. null
 */
export function resolveActivePackVersion(
  rows: ReadonlyArray<PackVersionRow>,
  packKey: string,
  ctx: ResolvePackContext = {},
): PackVersionRow | null {
  const candidates = rows.filter((r) => r.packKey === packKey);
  if (candidates.length === 0) return null;

  if (ctx.versionOverride) {
    const exact = candidates.find((r) => r.version === ctx.versionOverride);
    if (exact) return exact;
  }

  const published = candidates.filter((r) => r.status === 'published');
  if (published.length > 0) return pickHighestSemver(published);

  return pickHighestSemver(candidates);
}

function pickHighestSemver<R extends { version: string }>(rows: ReadonlyArray<R>): R {
  return rows.slice().sort((a, b) => compareSemver(b.version, a.version))[0]!;
}

/** Lexicographic semver compare on MAJOR.MINOR.PATCH (ignores pre-release). */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('-')[0]!.split('.').map((n) => Number.parseInt(n, 10));
  const pb = b.split('-')[0]!.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai !== bi) return ai - bi;
  }
  return 0;
}
