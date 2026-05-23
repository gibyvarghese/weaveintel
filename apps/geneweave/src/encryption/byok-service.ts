/**
 * GeneWeave — Phase 10 BYOK / HYOK / break-glass / attestation service.
 *
 * Thin host glue around the package-level primitives in
 * `@weaveintel/encryption/byok/*`. All policy state lives in the database
 * (`tenant_byok_config`, `tenant_break_glass_request`, `tenant_attestation_log`,
 * `system_attestation_signing_key`) — nothing is hardcoded.
 *
 * Responsibilities:
 *   - Mirror BYOK config rows into `tenant_encryption_policy` so the existing
 *     CachedKmsResolver picks them up without bespoke wiring.
 *   - Lazy-seed (and reuse) the platform Ed25519 attestation signing key.
 *   - Build/sign attestations from current store state + audit chain.
 *   - Run the break-glass evaluator against the request table.
 *
 * Reusability invariant: this file is geneweave-specific because it touches
 * `DatabaseAdapter`, but the heavy lifting lives in `@weaveintel/encryption`
 * — other apps can write their own ~150-line mirror of this file against
 * their own adapter without copying any cryptographic logic.
 */

import { createHash } from 'node:crypto';
import {
  approveBreakGlass,
  buildAndSignAttestation,
  buildAuditChain,
  canonicalize,
  denyBreakGlass,
  fingerprintEd25519PublicKey,
  findActiveGrant,
  generateAttestationSigningKey,
  loadAttestationSigningKey,
  loadByokPublicKey,
  fingerprintPublicKey,
  reapExpiredBreakGlass,
  validateNewBreakGlassRequest,
  type AttestationSigningKey,
  type AuditEventLike,
  type BreakGlassRequest,
  type SignedAttestation,
  type TenantAttestationFieldEntry,
  type TenantAttestationKeyState,
  type TenantAttestationKmsInfo,
} from '@weaveintel/encryption';
import type {
  DatabaseAdapter,
  TenantBreakGlassRequestRow,
  TenantByokConfigRow,
} from '../db-types.js';

// ── Signing key (lazy singleton, persisted to DB) ─────────────────────

let cachedSigningKey: AttestationSigningKey | null = null;

/**
 * Idempotent: returns the platform's Ed25519 signing key, generating + persisting
 * it on first call. Subsequent calls in the same process reuse the cached value;
 * a fresh process re-loads from `system_attestation_signing_key`.
 */
export async function getOrCreateAttestationSigningKey(db: DatabaseAdapter): Promise<AttestationSigningKey> {
  if (cachedSigningKey) return cachedSigningKey;
  const existing = await db.getSystemAttestationSigningKey();
  if (existing) {
    cachedSigningKey = loadAttestationSigningKey(existing.private_key_pem);
    return cachedSigningKey;
  }
  const fresh = generateAttestationSigningKey();
  const privPem = fresh.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const pubPem = fresh.publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const inserted = await db.insertSystemAttestationSigningKeyIfMissing({
    key: 'default',
    private_key_pem: privPem,
    public_key_pem: pubPem,
    fingerprint: fresh.fingerprint,
  });
  if (!inserted) {
    // Race: another worker beat us. Re-read.
    const reread = await db.getSystemAttestationSigningKey();
    if (!reread) throw new Error('attestation signing key insert returned 0 changes but reread is null');
    cachedSigningKey = loadAttestationSigningKey(reread.private_key_pem);
    return cachedSigningKey;
  }
  cachedSigningKey = fresh;
  return fresh;
}

// ── BYOK config ↔ tenant_encryption_policy bridge ─────────────────────

export interface UpsertByokConfigInput {
  tenantId: string;
  publicKeyPem: string;
  mode?: 'byok' | 'hyok';
  hyokEndpoint?: string | null;
  hyokBearerSecretId?: string | null;
  hyokTimeoutMs?: number | null;
  /** DEV ONLY — never use in production. */
  privateKeyPemDev?: string | null;
  createdBy?: string | null;
}

export interface UpsertByokConfigResult {
  config: TenantByokConfigRow;
  fingerprint: string;
  mirroredPolicy: boolean;
}

/**
 * Persist a BYOK/HYOK config and mirror it into `tenant_encryption_policy`
 * so the resolver routes that tenant through `byok-pem`. Validates the
 * customer's public key (RSA-4096+) before write.
 */
export async function upsertByokConfig(
  db: DatabaseAdapter,
  input: UpsertByokConfigInput,
): Promise<UpsertByokConfigResult> {
  if (!input.tenantId) throw new Error('tenantId required');
  const pub = loadByokPublicKey(input.publicKeyPem);
  const fp = fingerprintPublicKey(pub);
  const mode: 'byok' | 'hyok' = input.mode ?? (input.hyokEndpoint ? 'hyok' : 'byok');

  // Production guard: only emit a warning — DEV use is explicit and
  // operator-controlled. The bootstrap log surfaces this prominently.
  if (input.privateKeyPemDev && process.env['NODE_ENV'] === 'production') {
    console.warn(
      `[byok] tenant ${input.tenantId}: privateKeyPemDev is set in production — refusing to mirror; populate hyokEndpoint instead`,
    );
  }

  await db.upsertTenantByokConfig({
    tenant_id: input.tenantId,
    mode,
    public_key_pem: input.publicKeyPem,
    public_key_fingerprint: fp,
    hyok_endpoint: input.hyokEndpoint ?? null,
    hyok_bearer_secret_id: input.hyokBearerSecretId ?? null,
    hyok_timeout_ms: input.hyokTimeoutMs ?? null,
    private_key_pem_dev: input.privateKeyPemDev ?? null,
    status: 'active',
    created_by: input.createdBy ?? null,
  });

  // Mirror into the encryption policy so the existing resolver path picks it up.
  const kmsConfig: Record<string, unknown> = {
    tenantId: input.tenantId,
    publicKeyPem: input.publicKeyPem,
    mode,
  };
  if (input.hyokEndpoint) {
    kmsConfig['hyokEndpoint'] = input.hyokEndpoint;
    if (input.hyokTimeoutMs) kmsConfig['hyokTimeoutMs'] = input.hyokTimeoutMs;
    if (input.hyokBearerSecretId) {
      // Resolve the bearer token from process env at config time. The actual
      // secret never lives in the DB.
      const tok = process.env[input.hyokBearerSecretId];
      if (tok) kmsConfig['hyokBearerToken'] = tok;
    }
  } else if (input.privateKeyPemDev && process.env['NODE_ENV'] !== 'production') {
    kmsConfig['privateKeyPemForLocalDev'] = input.privateKeyPemDev;
  }
  let mirrored = false;
  try {
    const existing = await db.getTenantEncryptionPolicy(input.tenantId);
    await db.upsertTenantEncryptionPolicy({
      tenant_id: input.tenantId,
      enabled: 1,
      kms_provider_id: 'byok-pem',
      kms_config: JSON.stringify(kmsConfig),
      active_kek_id: existing?.active_kek_id ?? null,
      active_dek_id: existing?.active_dek_id ?? null,
      active_bik_id: existing?.active_bik_id ?? null,
      rotation_schedule: existing?.rotation_schedule ?? 'monthly',
      blind_index_enabled: existing?.blind_index_enabled ?? 0,
      field_policy: existing?.field_policy ?? '{}',
      shred_requested_at: existing?.shred_requested_at ?? null,
      shred_completed_at: existing?.shred_completed_at ?? null,
    });
    mirrored = true;
  } catch (err) {
    console.warn(`[byok] failed to mirror policy for tenant ${input.tenantId}: ${(err as Error).message}`);
  }

  const config = await db.getTenantByokConfig(input.tenantId);
  if (!config) throw new Error('byok config disappeared after upsert');
  return { config, fingerprint: fp, mirroredPolicy: mirrored };
}

export async function revokeByokConfig(db: DatabaseAdapter, tenantId: string, by: string | null): Promise<boolean> {
  const ok = await db.revokeTenantByokConfig(tenantId, Date.now());
  if (ok) {
    await db.insertEncryptionAudit({
      id: cryptoRandomId('audit'),
      tenant_id: tenantId,
      event_kind: 'byok_revoke', actor: by,
      created_at: Date.now(),
      details: JSON.stringify({ by }),
    });
  }
  return ok;
}

// ── Break-glass orchestration ─────────────────────────────────────────

export interface RequestBreakGlassInput {
  tenantId: string;
  requestedBy: string;
  reason: string;
  windowMs?: number;
}

export async function requestBreakGlass(db: DatabaseAdapter, input: RequestBreakGlassInput): Promise<TenantBreakGlassRequestRow> {
  const v = validateNewBreakGlassRequest({
    tenantId: input.tenantId,
    requestedBy: input.requestedBy,
    reason: input.reason,
    ...(input.windowMs !== undefined ? { windowMs: input.windowMs } : {}),
  });
  const id = cryptoRandomId('bg');
  const now = Date.now();
  await db.insertBreakGlassRequest({
    id,
    tenant_id: input.tenantId,
    requested_by: input.requestedBy,
    reason: input.reason,
    status: 'pending',
    customer_approver: null,
    approved_at: null,
    expires_at: v.expiresAt,
    consume_count: 0,
    denial_reason: null,
    created_at: now,
  });
  await db.insertEncryptionAudit({
    id: cryptoRandomId('audit'),
    tenant_id: input.tenantId,
    event_kind: 'break_glass_request', actor: input.requestedBy,
    created_at: now,
    details: JSON.stringify({ id, requestedBy: input.requestedBy, reason: input.reason, expiresAt: v.expiresAt }),
  });
  const row = await db.getBreakGlassRequest(id);
  if (!row) throw new Error('break-glass insert vanished');
  return row;
}

export async function approveBreakGlassById(
  db: DatabaseAdapter,
  id: string,
  customerApprover: string,
): Promise<TenantBreakGlassRequestRow | null> {
  const row = await db.getBreakGlassRequest(id);
  if (!row) return null;
  const req = rowToRequest(row);
  const out = approveBreakGlass({ request: req, customerApprover });
  await db.updateBreakGlassRequest(id, {
    status: out.approved.status,
    customer_approver: out.approved.customerApprover,
    approved_at: out.approved.approvedAt,
    expires_at: out.approved.expiresAt,
  });
  await db.insertEncryptionAudit({
    id: cryptoRandomId('audit'),
    tenant_id: row.tenant_id,
    event_kind: 'break_glass_approve', actor: customerApprover,
    created_at: Date.now(),
    details: JSON.stringify({ id, customerApprover, expiresAt: out.approved.expiresAt }),
  });
  return await db.getBreakGlassRequest(id);
}

export async function denyBreakGlassById(
  db: DatabaseAdapter,
  id: string,
  deniedBy: string,
  note: string,
): Promise<TenantBreakGlassRequestRow | null> {
  const row = await db.getBreakGlassRequest(id);
  if (!row) return null;
  const req = rowToRequest(row);
  const out = denyBreakGlass({ request: req, deniedBy, note });
  await db.updateBreakGlassRequest(id, {
    status: out.denied.status,
    denial_reason: note,
  });
  await db.insertEncryptionAudit({
    id: cryptoRandomId('audit'),
    tenant_id: row.tenant_id,
    event_kind: 'break_glass_deny', actor: deniedBy,
    created_at: Date.now(),
    details: JSON.stringify({ id, deniedBy, note }),
  });
  return await db.getBreakGlassRequest(id);
}

/**
 * Sweep approved-but-expired requests, transitioning them to `expired` and
 * emitting a single audit row per sweep. Safe to call on a timer.
 */
export async function reapExpiredBreakGlassRequests(db: DatabaseAdapter, nowMs = Date.now()): Promise<number> {
  const due = await db.listExpiredApprovedBreakGlassRequests(nowMs);
  if (due.length === 0) return 0;
  const reqs = due.map(rowToRequest);
  const transitions = reapExpiredBreakGlass(reqs, nowMs);
  for (const t of transitions) {
    await db.updateBreakGlassRequest(t.id, { status: 'expired' });
  }
  if (transitions.length > 0) {
    await db.insertEncryptionAudit({
      id: cryptoRandomId('audit'),
      tenant_id: '__system__',
      event_kind: 'break_glass_reap', actor: null,
      created_at: nowMs,
      details: JSON.stringify({ count: transitions.length, ids: transitions.map((t) => t.id) }),
    });
  }
  return transitions.length;
}

/**
 * Returns the active grant (status='approved', not expired) for a tenant, or
 * null. Used by routes that report whether an unwrap could succeed without
 * customer round-trip.
 */
export async function getActiveBreakGlassGrant(
  db: DatabaseAdapter,
  tenantId: string,
): Promise<TenantBreakGlassRequestRow | null> {
  const rows = await db.listBreakGlassRequests({ tenantId, status: 'approved' });
  const reqs = rows.map(rowToRequest);
  const grant = findActiveGrant({ requests: reqs, tenantId });
  if (!grant) return null;
  return rows.find((r) => r.id === grant.id) ?? null;
}

// ── Attestation export ────────────────────────────────────────────────

export interface BuildAttestationInput {
  tenantId: string;
  host: string;
  requestedBy?: string | null;
  /** When omitted, queries the audit table for the most recent N events (default 200). */
  auditEventsLimit?: number;
}

export interface BuildAttestationResult {
  attestation: SignedAttestation;
  payloadHash: string;
  storedId: string;
}

/**
 * Build, sign, and persist an attestation for a tenant. Reads the current
 * encryption policy + KMS config + audit chain from the DB so the result
 * is a snapshot of *now*, not a parameterised guess.
 */
export async function buildAttestationForTenant(
  db: DatabaseAdapter,
  input: BuildAttestationInput,
): Promise<BuildAttestationResult> {
  const signing = await getOrCreateAttestationSigningKey(db);
  const policy = (await db.listTenantEncryptionPolicies()).find((p) => p.tenant_id === input.tenantId);
  if (!policy) throw new Error(`no encryption policy for tenant ${input.tenantId}`);
  const byok = await db.getTenantByokConfig(input.tenantId);
  const fields: TenantAttestationFieldEntry[] = []; // hosts wire field metadata if exposed; left empty here.
  const kms: TenantAttestationKmsInfo = {
    providerId: policy.kms_provider_id ?? 'local',
    ...(byok ? { publicKeyFingerprint: byok.public_key_fingerprint } : {}),
    publicConfig: sanitisePublicConfig(policy.kms_config),
  };
  const keks = await db.listTenantKeks(input.tenantId);
  const deks = await db.listTenantDeks(input.tenantId);
  const biks = await db.listTenantBiks(input.tenantId);
  const activeKek = keks.find((k) => k.status === 'active') ?? null;
  const activeDek = deks.find((d) => d.status === 'active') ?? null;
  const activeBik = biks.find((b) => b.status === 'active') ?? null;
  const lastRotationAt = Math.max(
    activeKek?.created_at ?? 0,
    activeDek?.created_at ?? 0,
    activeBik?.created_at ?? 0,
    0,
  ) || null;
  const keyState: TenantAttestationKeyState = {
    activeKekId: activeKek?.id ?? null,
    activeDekId: activeDek?.id ?? null,
    activeBikId: activeBik?.id ?? null,
    lastRotationAt,
    retainedDekCount: deks.filter((d) => d.status === 'retained').length,
    retainedBikCount: biks.filter((b) => b.status === 'retained').length,
  };
  const auditRows = await db.listEncryptionAudit(input.tenantId, { limit: input.auditEventsLimit ?? 200 });
  const auditEvents: AuditEventLike[] = auditRows.map((r) => ({
    id: r.id,
    eventKind: r.event_kind,
    createdAt: r.created_at,
    details: r.details ? safeJsonParse(r.details) : null,
  }));
  const attestation = buildAndSignAttestation({
    tenantId: input.tenantId,
    host: input.host,
    fields,
    kms,
    keyState,
    auditEvents,
    signingKey: signing,
  });
  const payloadJson = canonicalize(attestation.payload);
  const payloadHash = createHash('sha256').update(payloadJson).digest('hex');
  const id = cryptoRandomId('att');
  await db.insertAttestationLog({
    id,
    tenant_id: input.tenantId,
    generated_at: attestation.payload.generatedAt,
    signature_alg: attestation.signatureAlg,
    signature: attestation.signature,
    signing_key_fingerprint: attestation.payload.signingKeyFingerprint,
    payload_hash: payloadHash,
    payload_json: payloadJson,
    requested_by: input.requestedBy ?? null,
  });
  await db.insertEncryptionAudit({
    id: cryptoRandomId('audit'),
    tenant_id: input.tenantId,
    event_kind: 'attestation_export', actor: input.requestedBy ?? null,
    created_at: Date.now(),
    details: JSON.stringify({ id, payloadHash, fingerprint: attestation.payload.signingKeyFingerprint }),
  });
  return { attestation, payloadHash, storedId: id };
}

/** Returns the public key (PEM) clients verify attestations against. */
export async function getAttestationPublicKey(db: DatabaseAdapter): Promise<{ pem: string; fingerprint: string }> {
  const sk = await getOrCreateAttestationSigningKey(db);
  return {
    pem: sk.publicKey.export({ type: 'spki', format: 'pem' }) as string,
    fingerprint: fingerprintEd25519PublicKey(sk.publicKey),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────

function rowToRequest(row: TenantBreakGlassRequestRow): BreakGlassRequest {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    requestedBy: row.requested_by,
    reason: row.reason,
    status: row.status,
    customerApprover: row.customer_approver,
    approvedAt: row.approved_at,
    expiresAt: row.expires_at,
    consumeCount: row.consume_count,
    createdAt: row.created_at,
  };
}

function safeJsonParse(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function sanitisePublicConfig(raw: string | null | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  const parsed = safeJsonParse(raw);
  if (!parsed) return undefined;
  // Strip anything that smells like a secret. Keep public identifiers
  // (endpoints, fingerprints, key names).
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (/token|secret|password|private/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

function cryptoRandomId(prefix: string): string {
  // Avoid bringing in another helper; use a 16-byte random + prefix.
  const buf = Buffer.alloc(16);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  return `${prefix}_${buf.toString('hex')}`;
}

/** Visible for tests. */
export function __resetSigningKeyCache(): void {
  cachedSigningKey = null;
}

// Re-export the audit chain helpers for ergonomic admin/debug use.
export { buildAuditChain, canonicalize };
