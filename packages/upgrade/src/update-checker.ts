// SPDX-License-Identifier: MIT
/**
 * The client side of update discovery: fetch the latest manifest from a release source and decide, safely,
 * whether it is a real, trustworthy update for THIS instance.
 *
 * A manifest is trusted only after passing, in order: signature (is it signed by a key we trust, and
 * unmodified?), edition (is it for our edition?), freshness (not past its expiry), and anti-rollback (not
 * older than what we already have — the defence against replaying an old, validly-signed manifest to force
 * a downgrade). Each failure returns a DISTINCT reason so the operator and the audit log can tell a stale
 * manifest from a downgrade attack from a wrong-edition release.
 *
 * This is pure decision logic — no persistence, no HTTP of its own (the source injects that). The consuming
 * app records the outcome (e.g. to `upgrade_releases`) and drives the `check` command from it.
 */
import { compare as semverCompare, valid as semverValid } from 'semver';
import type { UpgradeManifest } from './manifest.js';
import type { ReleaseSource } from './release-source.js';
import { verifyManifestSignature, type SignatureVerifier } from './signature.js';

/** Why a manifest was rejected — one distinct reason per failure mode. */
export type RejectReason =
  | 'unsupported_format'   // manifest version we don't understand, or a non-semver release version
  | 'untrusted_key'        // signed by a key not in our trust set
  | 'bad_signature'        // tampered / invalid signature
  | 'edition_mismatch'     // a release for a different edition
  | 'expired'              // past its expiresAt (stale-manifest defence)
  | 'downgrade';           // older than what we already have (anti-rollback)

/** The outcome of a check. `update_available`/`up_to_date` mean the manifest is fully trusted. */
export type CheckOutcome =
  | { readonly status: 'none' }
  | { readonly status: 'up_to_date'; readonly manifest: UpgradeManifest }
  | { readonly status: 'update_available'; readonly manifest: UpgradeManifest }
  | { readonly status: 'rejected'; readonly reason: RejectReason; readonly manifest: UpgradeManifest };

/** How to build an UpdateChecker. */
export interface UpdateCheckerOptions {
  /** Where to fetch the manifest. */
  readonly source: ReleaseSource;
  /** The signature trust policy. */
  readonly verifier: SignatureVerifier;
  /** This instance's edition — a manifest for another edition is rejected. */
  readonly edition: string;
  /**
   * The version floor for anti-rollback: the highest version already installed/seen. A manifest must be
   * strictly newer to be an update, equal to be up-to-date, and older is a downgrade (rejected). The app
   * passes `max(installedVersion, highestSeenReleaseVersion)`.
   */
  readonly currentVersion: string;
  /** Clock injection for expiry checks (tests). Defaults to the real clock. */
  readonly now?: () => Date;
}

/** Checks a release source for a trustworthy update for this instance. */
export interface UpdateChecker {
  /**
   * Fetch the latest manifest and classify it.
   * @returns `none` (no release), `rejected` with a distinct reason, or `up_to_date` / `update_available`
   *   for a fully-trusted manifest. Throws only on a malformed manifest (schema) or transport error from
   *   the source — every *policy* failure is a `rejected` outcome, not an exception.
   */
  check(): Promise<CheckOutcome>;
}

/**
 * Build an UpdateChecker.
 * @param opts source, verifier, this instance's edition + version floor, and an optional clock.
 * @returns the checker.
 */
export function createUpdateChecker(opts: UpdateCheckerOptions): UpdateChecker {
  const now = opts.now ?? (() => new Date());
  const floor = semverValid(opts.currentVersion);
  return {
    async check(): Promise<CheckOutcome> {
      const manifest = await opts.source.latest();
      if (!manifest) return { status: 'none' };

      // 1) Signature FIRST — nothing about an unverified manifest is trusted, including its edition/version.
      const sig = verifyManifestSignature(manifest, opts.verifier);
      if (!sig.ok) return { status: 'rejected', reason: sig.reason ?? 'bad_signature', manifest };

      // 2) Edition — a validly-signed release for another edition is not for us.
      if (manifest.edition !== opts.edition) return { status: 'rejected', reason: 'edition_mismatch', manifest };

      // 3) Freshness — refuse a manifest past its stated expiry.
      if (manifest.expiresAt && now().getTime() > Date.parse(manifest.expiresAt)) {
        return { status: 'rejected', reason: 'expired', manifest };
      }

      // 4) Anti-rollback — compare release version to our floor. Both must be valid semver.
      const version = semverValid(manifest.version);
      if (!version || !floor) return { status: 'rejected', reason: 'unsupported_format', manifest };
      const cmp = semverCompare(version, floor);
      if (cmp < 0) return { status: 'rejected', reason: 'downgrade', manifest };
      if (cmp === 0) return { status: 'up_to_date', manifest };
      return { status: 'update_available', manifest };
    },
  };
}
