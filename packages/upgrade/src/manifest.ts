// SPDX-License-Identifier: MIT
/**
 * The release manifest — the signed description of one release that a running instance discovers, verifies,
 * and acts on.
 *
 * A publisher builds this at release time (see manifest-builder.ts), signs it (signature.ts), and attaches
 * it to the release. A client fetches it (release-source.ts), verifies it, and — if it's newer, valid, and
 * for this edition — plans the upgrade from its layers. The whole document is one zod schema so a malformed
 * or hostile manifest is rejected at the boundary, before any of its declared work is trusted.
 *
 * The four layers mirror how an upgrade actually applies: L1 npm packages, L2 application code, L3 schema
 * migrations, L4 seeded content. The manifest only *declares* them; applying is a later phase.
 */
import { z } from 'zod';

/** A short, safe identifier (family names, batch ids, task tags): no control chars, bounded length. */
const ident = z.string().min(1).max(200);
/** An SRI-style integrity string, e.g. `sha512-…base64…` (node:crypto computes/verifies these). */
const integrity = z.string().regex(/^sha(256|384|512)-[A-Za-z0-9+/]+={0,2}$/, 'must be an SRI hash (shaNNN-<base64>)');

/** L1 — a platform package pinned by the release, with the range it requires and its integrity. */
export const ManifestPackageSchema = z.object({
  name: ident,
  /** The exact version this release pins the package to. */
  version: z.string().min(1).max(100),
  /** The semver range the release REQUIRES to be installed (the preflight gate compares against this). */
  requires: z.string().min(1).max(100).optional(),
  integrity: integrity.optional(),
});

/** L2 — the application code layer: which upstream tag, and a digest of the per-file source manifest. */
export const ManifestCodeSchema = z.object({
  repoTag: z.string().min(1).max(200),
  /** Digest over the release's `source_baselines` file manifest (per-file ssri), for L2 classification. */
  fileManifestDigest: integrity,
});

/** L3 — one schema migration batch, with its content hash and cross-layer dependency metadata. */
export const ManifestSchemaBatchSchema = z.object({
  batchId: ident,
  contentHash: z.string().min(1).max(200),
  /** L2 code paths this batch depends on (deferral holds it until they're merged). */
  dependsOn: z.array(z.string().max(400)).default([]),
  /** Realm family / logical keys this batch provides (powers content-layer ordering). */
  provides: z.array(ident).default([]),
});

/** L4 — one changed seeded default this release ships, with its note and (optional) review priority. */
export const ManifestContentSchema = z.object({
  family: ident,
  logicalKey: ident,
  /** The content hash of the shipped default — the reconcile's Remote leg. */
  remoteHash: z.string().min(1).max(200),
  /** REQUIRED human note for every changed content entry (the publisher lint enforces non-empty). */
  releaseNote: z.string().min(1).max(2000),
  priority: z.enum(['P1', 'P2', 'P3', 'P4', 'P5']).optional(),
});

/** A downloadable release artifact (a package tarball, a code bundle), addressed by path + integrity. */
export const ManifestArtifactSchema = z.object({
  path: z.string().min(1).max(400),
  integrity,
  size: z.number().int().nonnegative(),
});

/** The detached Ed25519 signature over the canonical manifest body (everything except this field). */
export const ManifestSignatureSchema = z.object({
  alg: z.literal('Ed25519'),
  /** Fingerprint of the signing public key — the verifier looks this up in its trusted set. */
  keyFingerprint: z.string().min(1).max(200),
  /** base64url signature bytes. */
  value: z.string().min(1).max(400),
});

/** The signed BODY of the manifest — everything the signature covers. */
export const ManifestBodySchema = z.object({
  /** Manifest format version — lets the client refuse a format it doesn't understand. */
  manifestVersion: z.literal(1),
  /** The product name this release is for (e.g. the app package name). */
  name: ident,
  /** The release version (semver). Anti-rollback compares this against what's installed. */
  version: z.string().min(1).max(100),
  /** Optional human codename for a fabric-version major. */
  codename: z.string().max(200).optional(),
  /** Release channel (stable, beta, …). */
  channel: z.string().min(1).max(50).default('stable'),
  /** Which EDITION this release targets — a client refuses a manifest for another edition. */
  edition: z.string().min(1).max(50),
  /** ISO 8601 publish time. */
  publishedAt: z.string().datetime(),
  /** ISO 8601 expiry — a client refuses a manifest past this (stale-manifest defence). Optional = no expiry. */
  expiresAt: z.string().datetime().optional(),
  /** Platform requirements the preflight gate checks. */
  requires: z.object({
    weaveintel: z.string().max(100).optional(),
    node: z.string().max(100).optional(),
  }).default({}),
  /** The four upgrade layers this release declares. */
  layers: z.object({
    packages: z.array(ManifestPackageSchema).default([]),
    code: ManifestCodeSchema.optional(),
    schema: z.array(ManifestSchemaBatchSchema).default([]),
    content: z.array(ManifestContentSchema).default([]),
  }).default({ packages: [], schema: [], content: [] }),
  artifacts: z.array(ManifestArtifactSchema).default([]),
});

/** A full, signed manifest = the body + its detached signature. */
export const UpgradeManifestSchema = ManifestBodySchema.extend({
  signature: ManifestSignatureSchema,
});

export type ManifestPackage = z.infer<typeof ManifestPackageSchema>;
export type ManifestCode = z.infer<typeof ManifestCodeSchema>;
export type ManifestSchemaBatch = z.infer<typeof ManifestSchemaBatchSchema>;
export type ManifestContent = z.infer<typeof ManifestContentSchema>;
export type ManifestArtifact = z.infer<typeof ManifestArtifactSchema>;
export type ManifestSignature = z.infer<typeof ManifestSignatureSchema>;
export type ManifestBody = z.infer<typeof ManifestBodySchema>;
export type UpgradeManifest = z.infer<typeof UpgradeManifestSchema>;

/**
 * Parse + validate an untrusted manifest object (from JSON). Throws a zod error listing every problem if it
 * doesn't match the schema — the single boundary where a malformed/hostile manifest is rejected.
 * @param value the parsed-JSON object to validate.
 * @returns the typed, validated manifest.
 */
export function parseManifest(value: unknown): UpgradeManifest {
  return UpgradeManifestSchema.parse(value);
}

/**
 * The BODY of a manifest — the manifest without its `signature` field. This is exactly what the signature
 * covers, so signing and verifying both canonicalize THIS, never the whole document (which includes the
 * signature and so can't cover itself).
 * @param manifest a full manifest (or a body).
 * @returns the body object (no `signature` key).
 */
export function manifestBody(manifest: UpgradeManifest | ManifestBody): ManifestBody {
  const { signature: _omit, ...body } = manifest as UpgradeManifest;
  return body;
}
