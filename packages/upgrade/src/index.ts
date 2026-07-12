// SPDX-License-Identifier: MIT
/**
 * @weaveintel/upgrade — engine-generic primitives for a product's self-upgrade flow.
 *
 * The reconcile engine itself (compare shipped defaults against operator edits, classify drift, adopt the
 * safe moves) lives in `@weaveintel/realm`. This package holds the brand-neutral pieces that surround it:
 *   • priority banding for the review queue of what the reconcile couldn't auto-resolve;
 *   • pre-upgrade database snapshots (SQLite / Postgres) for atomic rollback;
 *   • a structured id-keyed three-way merge for list-shaped config (workflow nodes, policy rules, …).
 *
 * Consuming products supply their own policy (which family maps to which band, which tables to snapshot,
 * which fields are id-keyed lists); this package supplies the mechanism.
 */
export {
  type UpgradePriority,
  type UpgradeDisposition,
  type BandForOptions,
  bandFor,
  needsReview,
} from './priority.js';

export {
  type SnapshotHandle,
  snapshotSqliteFile,
  snapshotPgDump,
} from './snapshot.js';

export {
  type KeyedItem,
  type KeyedMergeResult,
  parseList,
  mergeKeyedList,
} from './structured-merge.js';
