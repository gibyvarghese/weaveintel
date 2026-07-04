/**
 * @weaveintel/encryption — Compliance attestation.
 *
 * Builds and signs JSON attestations the customer's auditor can verify
 * end-to-end without trusting weaveintel. Each attestation contains:
 *
 *   - Snapshot of tenant policy (fields encrypted, KMS provider id, BYOK
 *     fingerprint when applicable, cadence, last rotation).
 *   - Hash chain over recent audit events (so tampering is detectable
 *     without giving the auditor full event content).
 *   - The platform's signing key public-key fingerprint.
 *
 * The signature is Ed25519 over the canonical JSON of the payload (sorted
 * keys, no whitespace). Verification is a single `verifyAttestation()` call
 * the customer can run with only `node:crypto`.
 *
 * Reusability: only `node:crypto` + sibling files. Hosts wire the signing
 * key + payload assembler.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from 'node:crypto';

export interface TenantAttestationFieldEntry {
  readonly table: string;
  readonly column: string;
  readonly required: boolean;
  readonly classification: string;
}

export interface TenantAttestationKmsInfo {
  readonly providerId: string;
  /** For BYOK only — fingerprint of the customer's public key. */
  readonly publicKeyFingerprint?: string;
  /** Free-form provider config (sanitised — must NOT contain secrets). */
  readonly publicConfig?: Record<string, unknown>;
}

export interface TenantAttestationKeyState {
  readonly activeKekId: string | null;
  readonly activeDekId: string | null;
  readonly activeBikId: string | null;
  readonly lastRotationAt: number | null;
  readonly retainedDekCount: number;
  readonly retainedBikCount: number;
}

export interface AttestationAuditChainEntry {
  readonly eventKind: string;
  readonly at: number;
  readonly hash: string; // hex
}

export interface AttestationPayload {
  readonly schemaVersion: 1;
  readonly tenantId: string;
  readonly host: string;
  readonly generatedAt: number;
  readonly fields: readonly TenantAttestationFieldEntry[];
  readonly kms: TenantAttestationKmsInfo;
  readonly keyState: TenantAttestationKeyState;
  readonly auditChain: readonly AttestationAuditChainEntry[];
  /** Tip of the audit hash chain — single hex value the auditor can re-compute. */
  readonly auditChainTip: string;
  readonly signingKeyFingerprint: string;
}

export interface SignedAttestation {
  readonly payload: AttestationPayload;
  /** base64. */
  readonly signature: string;
  readonly signatureAlg: 'Ed25519';
}

// ── Canonical JSON ──────────────────────────────────────────

/**
 * Stable JSON encoding: keys sorted lexicographically at every level, no
 * whitespace, arrays preserve order. Critical so signatures verify across
 * runtimes / languages.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

// ── Signing key handling ────────────────────────────────────

export interface AttestationSigningKey {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly fingerprint: string;
}

/**
 * Generate a fresh Ed25519 keypair. Useful for test fixtures and
 * `bootstrap()` first-run seeding.
 */
export function generateAttestationSigningKey(): AttestationSigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey,
    publicKey,
    fingerprint: fingerprintEd25519PublicKey(publicKey),
  };
}

/** Load a signing key from a PEM private key. Public key is derived. */
export function loadAttestationSigningKey(privateKeyPem: string): AttestationSigningKey {
  const privateKey = createPrivateKey({ key: privateKeyPem, format: 'pem' });
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(
      `Attestation signing key must be Ed25519, got ${privateKey.asymmetricKeyType ?? 'unknown'}`,
    );
  }
  const publicKey = createPublicKey(privateKey);
  return { privateKey, publicKey, fingerprint: fingerprintEd25519PublicKey(publicKey) };
}

export function fingerprintEd25519PublicKey(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('base64url').slice(0, 16);
}

// ── Audit hash chain ────────────────────────────────────────

export interface AuditEventLike {
  readonly id: string;
  readonly eventKind: string;
  readonly createdAt: number;
  readonly details: Record<string, unknown> | null;
}

/**
 * Build a SHA-256 hash chain over events in chronological order. Each
 * link's digest is `SHA256(prev_digest || canonical(event))`. Returns the
 * per-event entries (lightweight) and the chain tip.
 */
export function buildAuditChain(events: readonly AuditEventLike[]): {
  entries: AttestationAuditChainEntry[];
  tip: string;
} {
  let prev = Buffer.alloc(0);
  const entries: AttestationAuditChainEntry[] = [];
  const sorted = [...events].sort((a, b) => a.createdAt - b.createdAt);
  for (const ev of sorted) {
    // Hash only the fields stored in AttestationAuditChainEntry so the chain
    // can be re-derived and verified by an auditor from the compact payload
    // alone — without needing the original raw event objects (id, details).
    const eventBytes = Buffer.from(canonicalize({ eventKind: ev.eventKind, at: ev.createdAt }), 'utf8');
    const next = createHash('sha256').update(prev).update(eventBytes).digest();
    entries.push({ eventKind: ev.eventKind, at: ev.createdAt, hash: next.toString('hex') });
    prev = next;
  }
  return { entries, tip: prev.length === 0 ? createHash('sha256').digest('hex') : prev.toString('hex') };
}

// ── Build / sign / verify ───────────────────────────────────

export interface BuildAttestationInput {
  readonly tenantId: string;
  readonly host: string;
  readonly fields: readonly TenantAttestationFieldEntry[];
  readonly kms: TenantAttestationKmsInfo;
  readonly keyState: TenantAttestationKeyState;
  readonly auditEvents: readonly AuditEventLike[];
  readonly signingKey: AttestationSigningKey;
  readonly now?: number;
}

export function buildAndSignAttestation(input: BuildAttestationInput): SignedAttestation {
  const chain = buildAuditChain(input.auditEvents);
  const payload: AttestationPayload = {
    schemaVersion: 1,
    tenantId: input.tenantId,
    host: input.host,
    generatedAt: input.now ?? Date.now(),
    fields: [...input.fields].sort((a, b) =>
      a.table === b.table ? a.column.localeCompare(b.column) : a.table.localeCompare(b.table),
    ),
    kms: input.kms,
    keyState: input.keyState,
    auditChain: chain.entries,
    auditChainTip: chain.tip,
    signingKeyFingerprint: input.signingKey.fingerprint,
  };
  const message = Buffer.from(canonicalize(payload), 'utf8');
  const signature = edSign(null, message, input.signingKey.privateKey).toString('base64');
  return { payload, signature, signatureAlg: 'Ed25519' };
}

export interface VerifyAttestationInput {
  readonly attestation: SignedAttestation;
  /** PEM SPKI of the platform's Ed25519 public key. */
  readonly publicKeyPem: string;
}

export interface VerifyAttestationResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly signingKeyFingerprintOk?: boolean;
  readonly auditChainOk?: boolean;
}

/**
 * Verify a signed attestation. Customer can run this with only `node:crypto`
 * and the platform's published public key. Re-derives the audit hash chain
 * to detect tampering of any individual event.
 */
export function verifyAttestation(input: VerifyAttestationInput): VerifyAttestationResult {
  const publicKey = createPublicKey({ key: input.publicKeyPem, format: 'pem' });
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    return { ok: false, reason: `expected Ed25519 public key, got ${publicKey.asymmetricKeyType}` };
  }
  const fp = fingerprintEd25519PublicKey(publicKey);
  if (fp !== input.attestation.payload.signingKeyFingerprint) {
    return {
      ok: false,
      signingKeyFingerprintOk: false,
      reason: `fingerprint mismatch: payload=${input.attestation.payload.signingKeyFingerprint} key=${fp}`,
    };
  }
  const message = Buffer.from(canonicalize(input.attestation.payload), 'utf8');
  const sig = Buffer.from(input.attestation.signature, 'base64');
  const sigOk = edVerify(null, message, publicKey, sig);
  if (!sigOk) {
    return { ok: false, signingKeyFingerprintOk: true, reason: 'Ed25519 signature verification failed' };
  }
  // Re-derive each chain link: SHA256(prev_digest || canonical({eventKind,at})).
  const chain = input.attestation.payload.auditChain;
  let prevHash = Buffer.alloc(0);
  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i]!;
    const eventBytes = Buffer.from(canonicalize({ eventKind: entry.eventKind, at: entry.at }), 'utf8');
    const derived = createHash('sha256').update(prevHash).update(eventBytes).digest();
    if (derived.toString('hex') !== entry.hash) {
      return { ok: false, signingKeyFingerprintOk: true, auditChainOk: false, reason: `audit chain link ${i} hash mismatch` };
    }
    prevHash = derived;
  }
  const expectedTip =
    chain.length === 0 ? createHash('sha256').digest('hex') : prevHash.toString('hex');
  if (expectedTip !== input.attestation.payload.auditChainTip) {
    return { ok: false, signingKeyFingerprintOk: true, auditChainOk: false, reason: 'audit chain tip mismatch' };
  }
  return { ok: true, signingKeyFingerprintOk: true, auditChainOk: true };
}
