// SPDX-License-Identifier: MIT
/**
 * Manifest signing + verification — Ed25519 over the canonical manifest body.
 *
 * A release manifest is only trustworthy if it's signed by a key the client trusts. This is the same
 * Ed25519 construction `@weaveintel/skills` uses for package signing and `@weaveintel/encryption` uses for
 * attestations — canonical JSON of the payload, signed with a detached Ed25519 signature — so there is NO
 * new crypto here: it reuses `canonicalize` + `fingerprintEd25519PublicKey` from `@weaveintel/encryption`
 * and `node:crypto`'s Ed25519 sign/verify.
 *
 * Verification is behind the `SignatureVerifier` interface (the design's hardening seam: a TUF-backed
 * verifier can drop in later). The shipped verifier holds a set of TRUSTED public keys by fingerprint; a
 * signature is accepted only if its key is trusted AND the bytes verify — so a manifest carrying its own
 * key cannot self-authorize.
 */
import { sign as edSign, verify as edVerify, createPublicKey, createPrivateKey, type KeyObject } from 'node:crypto';
import { canonicalize, fingerprintEd25519PublicKey } from '@weaveintel/encryption';
import { manifestBody, type ManifestBody, type ManifestSignature, type UpgradeManifest } from './manifest.js';

/** The result of a signature check — a boolean plus a machine-readable reason when it fails. */
export interface SignatureResult {
  readonly ok: boolean;
  /** Why it failed: the signing key isn't trusted, or the bytes don't verify. Absent on success. */
  readonly reason?: 'untrusted_key' | 'bad_signature';
}

/** Verifies a manifest's signature against a trust policy. The seam a TUF verifier drops into later. */
export interface SignatureVerifier {
  /**
   * Verify `signature` over `body`.
   * @param body the manifest body the signature is supposed to cover.
   * @param signature the detached signature to check.
   * @returns whether it's valid, and why not if not.
   */
  verify(body: ManifestBody, signature: ManifestSignature): SignatureResult;
}

/** The exact bytes that are signed/verified: the canonical JSON of the body. Deterministic (sorted keys). */
function signedBytes(body: ManifestBody): Buffer {
  return Buffer.from(canonicalize(body), 'utf8');
}

/**
 * Sign a manifest body, producing a full manifest with a detached Ed25519 signature.
 * @param body the manifest body to sign (no `signature` field).
 * @param signingKey the Ed25519 private key (a KeyObject or PEM string).
 * @returns the body plus its `signature` ({ alg, keyFingerprint, value }). Pure aside from the crypto.
 */
export function signManifest(body: ManifestBody, signingKey: KeyObject | string): UpgradeManifest {
  const privateKey = typeof signingKey === 'string' ? createPrivateKey({ key: signingKey, format: 'pem' }) : signingKey;
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error(`signing key must be Ed25519, got ${privateKey.asymmetricKeyType ?? 'unknown'}`);
  // Derive the public key to fingerprint it (the verifier looks the manifest up by this fingerprint).
  const publicKey = createPublicKey(privateKey);
  const signature: ManifestSignature = {
    alg: 'Ed25519',
    keyFingerprint: fingerprintEd25519PublicKey(publicKey),
    value: edSign(null, signedBytes(body), privateKey).toString('base64url'),
  };
  return { ...body, signature };
}

/**
 * An Ed25519 `SignatureVerifier` over a fixed set of trusted public keys.
 *
 * @param trustedPublicKeys the keys the client trusts — PEM SPKI strings or KeyObjects. A manifest is only
 *   accepted if its signature's `keyFingerprint` matches one of these AND the bytes verify under it.
 * @returns a verifier. Its trust set is fixed at construction (an offline root; rotation = a new verifier).
 */
export function createEd25519Verifier(trustedPublicKeys: ReadonlyArray<KeyObject | string>): SignatureVerifier {
  // Index the trusted keys by fingerprint so a lookup is O(1) and a hostile key can't be used just by
  // being present in the manifest — only a fingerprint in this map is trusted.
  const byFingerprint = new Map<string, KeyObject>();
  for (const k of trustedPublicKeys) {
    const key = typeof k === 'string' ? createPublicKey({ key: k, format: 'pem' }) : k;
    byFingerprint.set(fingerprintEd25519PublicKey(key), key);
  }
  return {
    verify(body: ManifestBody, signature: ManifestSignature): SignatureResult {
      const key = byFingerprint.get(signature.keyFingerprint);
      if (!key) return { ok: false, reason: 'untrusted_key' };
      let ok = false;
      try {
        ok = edVerify(null, signedBytes(body), key, Buffer.from(signature.value, 'base64url'));
      } catch {
        ok = false; // a malformed signature value (bad base64, wrong length) is just an invalid signature
      }
      return ok ? { ok: true } : { ok: false, reason: 'bad_signature' };
    },
  };
}

/**
 * Verify a full manifest's signature with a verifier.
 * @param manifest the signed manifest.
 * @param verifier the trust policy.
 * @returns the signature result over the manifest's body.
 */
export function verifyManifestSignature(manifest: UpgradeManifest, verifier: SignatureVerifier): SignatureResult {
  return verifier.verify(manifestBody(manifest), manifest.signature);
}
