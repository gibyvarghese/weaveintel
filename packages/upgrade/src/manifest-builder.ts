// SPDX-License-Identifier: MIT
/**
 * Release-time construction of a signed manifest — the publisher side.
 *
 * A CI release step assembles the manifest body (the packages/code/schema/content/artifacts this release
 * ships), validates it against the schema, and signs it. This module is that build step plus the small
 * integrity helper artifacts use. It is intentionally thin: gathering the inputs (changeset diff, file
 * manifest, batch list) is the CI's job; this turns validated inputs into a signed, publishable manifest.
 */
import { createHash } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { ManifestBodySchema, type ManifestBody, type UpgradeManifest } from './manifest.js';
import { signManifest } from './signature.js';

/**
 * Compute an SRI-form integrity string over some bytes — the format the manifest's `integrity` fields use
 * and `node:crypto` can re-verify. (Replaces an `ssri` dependency with two lines of built-in crypto.)
 * @param data the artifact bytes.
 * @param alg the hash algorithm; defaults to sha512.
 * @returns `"<alg>-<base64 digest>"`, e.g. `sha512-…`.
 */
export function computeIntegrity(data: Buffer | Uint8Array, alg: 'sha256' | 'sha384' | 'sha512' = 'sha512'): string {
  return `${alg}-${createHash(alg).update(data).digest('base64')}`;
}

/**
 * Verify some bytes against an SRI integrity string.
 * @param data the bytes to check.
 * @param integrity an SRI string (`<alg>-<base64>`).
 * @returns true if the recomputed digest matches. False on a malformed integrity string (never throws).
 */
export function verifyIntegrity(data: Buffer | Uint8Array, integrity: string): boolean {
  const m = /^(sha256|sha384|sha512)-(.+)$/.exec(integrity);
  if (!m) return false;
  const alg = m[1] as 'sha256' | 'sha384' | 'sha512';
  return `${alg}-${createHash(alg).update(data).digest('base64')}` === integrity;
}

/**
 * Build + sign a manifest from a manifest body.
 * @param body the assembled manifest body (validated here against the schema — a bad body throws before it
 *   can be signed, so a malformed manifest is never published).
 * @param signingKey the Ed25519 private key (KeyObject or PEM).
 * @returns the signed, publishable manifest.
 */
export function buildManifest(body: ManifestBody, signingKey: KeyObject | string): UpgradeManifest {
  const validated = ManifestBodySchema.parse(body); // applies defaults + rejects anything malformed
  return signManifest(validated, signingKey);
}
