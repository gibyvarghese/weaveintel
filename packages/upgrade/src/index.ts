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
 *
 * It also holds the release-discovery half: a signed release MANIFEST schema, Ed25519 signing/verification,
 * pluggable release SOURCES (public + authenticated GitHub), and an UPDATE CHECKER that verifies a manifest
 * (signature, edition, freshness, anti-rollback) before an instance trusts it.
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

// ── Release tooling + update discovery ────────────────────────────────────────────────────────────────
export {
  type ManifestPackage,
  type ManifestCode,
  type ManifestSchemaBatch,
  type ManifestContent,
  type ManifestArtifact,
  type ManifestSignature,
  type ManifestBody,
  type UpgradeManifest,
  ManifestBodySchema,
  UpgradeManifestSchema,
  parseManifest,
  manifestBody,
} from './manifest.js';

export {
  type SignatureResult,
  type SignatureVerifier,
  signManifest,
  createEd25519Verifier,
  verifyManifestSignature,
} from './signature.js';

export {
  type HttpResponse,
  type HttpGetter,
  type ReleaseSource,
  type GitHubReleaseSourceOptions,
  createGitHubReleaseSource,
  createAuthenticatedGitHubReleaseSource,
} from './release-source.js';

export {
  type RejectReason,
  type CheckOutcome,
  type UpdateCheckerOptions,
  type UpdateChecker,
  createUpdateChecker,
} from './update-checker.js';

export {
  computeIntegrity,
  verifyIntegrity,
  buildManifest,
} from './manifest-builder.js';

export {
  type LintIssue,
  type LintResult,
  lintManifest,
} from './manifest-lint.js';
