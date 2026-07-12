// SPDX-License-Identifier: MIT
/**
 * Priority banding for a self-upgrade review queue.
 *
 * When a release reconciles its shipped defaults against a running install, most outcomes are safe and
 * automatic (adopt a default nobody touched, publish a new one). What remains — a locally customised
 * default, a genuine both-sides conflict, a namespace collision — needs a human, and not all of it is
 * equally urgent. This module assigns each leftover a priority band so a queue can surface the dangerous
 * things first and so bulk actions can be gated ("never bulk-resolve the top band").
 *
 * It is deliberately a MECHANISM, not a policy: the mapping from a config *family* to a band is the
 * consuming product's decision (its own guardrails vs skills vs pricing), so the family→band map is
 * injected. The one rule the mechanism keeps is that a collision or a real both-sides conflict is always
 * the top band regardless of family — losing an operator's edit or colliding a namespace is the most
 * dangerous thing an upgrade can do. Pure and dependency-free.
 */

/** A review-item priority band, P1 (most urgent) to P5 (least). */
export type UpgradePriority = 'P1' | 'P2' | 'P3' | 'P4' | 'P5';

/**
 * What a reconcile/merge pass decided about one record. The first six are the realm engine's
 * classification (`in_sync | customized | stale | diverged | new | removed`); the rest are the actions a
 * run records and the merge/queue outcomes a later step produces.
 */
export type UpgradeDisposition =
  | 'in_sync'
  | 'customized'
  | 'stale'
  | 'diverged'
  | 'new'
  | 'removed'
  | 'adopted'
  | 'published'
  | 'auto_merged'
  | 'conflict'
  | 'collision'
  | 'deferred';

/** Tuning for {@link bandFor}. */
export interface BandForOptions {
  /** Band a collision/conflict is forced to, regardless of family. Default 'P1'. */
  readonly conflictBand?: UpgradePriority;
  /** Band for a family not present in the injected map. Default 'P3'. */
  readonly defaultBand?: UpgradePriority;
}

/**
 * The priority band for one review item.
 *
 * @param family the config family string (the product's own — e.g. 'guardrails', 'pricing').
 * @param disposition what the pass decided about the record.
 * @param familyBands the product's family→band policy map (injected; the mechanism has no built-in policy).
 * @param opts optional overrides for the conflict band (default 'P1') and the default band (default 'P3').
 * @returns the band. A `collision`/`conflict` is always the conflict band; otherwise the family's band, or
 *   the default band when the family is not in the map. Own-property lookup, so a family string arriving
 *   from untrusted input can never resolve an inherited key like `constructor` off the map's prototype.
 */
export function bandFor(
  family: string,
  disposition: UpgradeDisposition,
  familyBands: Readonly<Record<string, UpgradePriority>>,
  opts?: BandForOptions,
): UpgradePriority {
  if (disposition === 'collision' || disposition === 'conflict') return opts?.conflictBand ?? 'P1';
  if (Object.hasOwn(familyBands, family)) return familyBands[family]!;
  return opts?.defaultBand ?? 'P3';
}

/**
 * True if this disposition is one a human still needs to act on (versus a safe, already-applied move).
 * @param disposition the outcome to classify.
 * @returns whether it belongs in the review queue.
 */
export function needsReview(disposition: UpgradeDisposition): boolean {
  return (
    disposition === 'customized' ||
    disposition === 'diverged' ||
    disposition === 'conflict' ||
    disposition === 'collision' ||
    disposition === 'removed' ||
    disposition === 'deferred'
  );
}
