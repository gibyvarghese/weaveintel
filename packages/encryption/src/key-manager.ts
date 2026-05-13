/**
 * @weaveintel/encryption — TenantKeyManager.
 *
 * Per-tenant orchestrator. Resolves the active KEK + DEK for a tenant,
 * encrypts/decrypts values via the AEAD envelope, and bootstraps new
 * tenants. All persistence flows through the injected EncryptionStore;
 * key wrap/unwrap flows through the injected KmsProvider; lifecycle
 * events flow through the injected AuditEmitter.
 *
 * Caches unwrapped DEKs (keyed by `dekId`) and KEKs (keyed by `kekId`)
 * with a TTL so steady-state encryption is one in-process AES-GCM call
 * per value.
 */

import { randomBytes } from 'node:crypto';
import { newUUIDv7 } from '@weaveintel/core';
import type { AuditEmitter, EncryptionAuditEvent, EncryptionAuditKind } from './audit.js';
import { decryptValue, encryptValue, isEncrypted, parseSentinel } from './envelope.js';
import { KeyNotFoundError } from './errors.js';
import { deserializeWrappedKey, serializeWrappedKey } from './kms.js';
import type { KmsProvider } from './kms.js';
import type {
  BikRecord,
  DekRecord,
  EncryptionStore,
  KekRecord,
  TenantPolicyRecord,
} from './store.js';
import { mergeFieldPolicy } from './field-policy.js';

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

export interface TenantKeyManagerOptions {
  readonly store: EncryptionStore;
  readonly kms: KmsProvider;
  readonly audit?: AuditEmitter;
  /** Unwrapped-key cache TTL. Default 5 minutes. */
  readonly cacheTtlMs?: number;
  /** Clock injection for tests. */
  readonly now?: () => number;
}

export interface EncryptOptions {
  readonly tenantId: string;
  readonly table: string;
  readonly column: string;
  readonly rowId: string;
  readonly plaintext: string | Buffer;
}

export interface DecryptOptions {
  readonly tenantId: string;
  readonly table: string;
  readonly column: string;
  readonly rowId: string;
  /** Sentinel-prefixed ciphertext. Plaintext passes through unchanged. */
  readonly value: string;
}

export interface BootstrapTenantOptions {
  readonly tenantId: string;
  readonly enable?: boolean;
  readonly actor?: string;
}

interface CachedKey {
  readonly key: Buffer;
  readonly expiresAt: number;
}

export class TenantKeyManager {
  readonly #store: EncryptionStore;
  readonly #kms: KmsProvider;
  readonly #audit: AuditEmitter;
  readonly #ttl: number;
  readonly #now: () => number;
  readonly #dekCache = new Map<string, CachedKey>();
  readonly #kekCache = new Map<string, CachedKey>();

  constructor(opts: TenantKeyManagerOptions) {
    this.#store = opts.store;
    this.#kms = opts.kms;
    this.#audit = opts.audit ?? { async emit() {} };
    this.#ttl = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.#now = opts.now ?? (() => Date.now());
  }

  // ---- public API -------------------------------------------------------

  async encrypt(opts: EncryptOptions): Promise<string> {
    const policy = await this.#requirePolicy(opts.tenantId);
    const dekId = policy.activeDekId;
    if (!dekId) throw new KeyNotFoundError(`no active DEK for tenant ${opts.tenantId}`);
    const dekRow = await this.#getDekRow(opts.tenantId, dekId);
    const dek = await this.#unwrapDek(opts.tenantId, dekRow);
    const pt = typeof opts.plaintext === 'string' ? Buffer.from(opts.plaintext, 'utf8') : opts.plaintext;
    return encryptValue({
      plaintext: pt,
      dek,
      aad: {
        tenantId: opts.tenantId,
        table: opts.table,
        column: opts.column,
        rowId: opts.rowId,
        epoch: dekRow.epoch,
      },
    });
  }

  async decrypt(opts: DecryptOptions): Promise<string> {
    if (!isEncrypted(opts.value)) return opts.value;
    const parsed = parseSentinel(opts.value);
    const dekRow = await this.#findDekByEpoch(opts.tenantId, parsed.epoch);
    const dek = await this.#unwrapDek(opts.tenantId, dekRow);
    const buf = decryptValue({
      ciphertext: opts.value,
      dek,
      aad: {
        tenantId: opts.tenantId,
        table: opts.table,
        column: opts.column,
        rowId: opts.rowId,
      },
    });
    return buf.toString('utf8');
  }

  /**
   * Provision the first KEK + DEK (and BIK) for a tenant. Idempotent: if
   * the tenant already has an active KEK and DEK, returns the existing
   * policy unchanged.
   */
  async bootstrapTenant(opts: BootstrapTenantOptions): Promise<TenantPolicyRecord> {
    const existing = await this.#store.getPolicy(opts.tenantId);
    const enable = opts.enable ?? true;
    if (existing && existing.activeKekId && existing.activeDekId) {
      // Already bootstrapped. Optionally flip enabled.
      if (enable && !existing.enabled) {
        const updated: TenantPolicyRecord = { ...existing, enabled: true };
        await this.#store.upsertPolicy(updated);
        await this.#emit(opts.tenantId, 'policy_change', opts.actor ?? null, { enabled: true });
        return updated;
      }
      return existing;
    }

    // Create KEK.
    const rootKeyId = await this.#kms.rootKeyId(opts.tenantId);
    const kekPlain = randomBytes(32);
    const wrappedKek = await this.#kms.wrap(rootKeyId, kekPlain);
    const kekId = newUUIDv7();
    const now = this.#now();
    const kek: KekRecord = {
      id: kekId,
      tenantId: opts.tenantId,
      version: 1,
      status: 'active',
      wrapped: serializeWrappedKey(wrappedKek),
      createdAt: now,
      rotatedAt: null,
      revokedAt: null,
    };
    await this.#store.insertKek(kek);
    await this.#emit(opts.tenantId, 'kek_create', opts.actor ?? null, { kekId, version: 1 });

    // Create DEK wrapped under KEK (we use the KEK as the wrap key).
    const dekPlain = randomBytes(32);
    const wrappedDek = await this.#wrapUnderKek(kekPlain, dekPlain, opts.tenantId);
    const dekId = newUUIDv7();
    const dek: DekRecord = {
      id: dekId,
      tenantId: opts.tenantId,
      kekId,
      epoch: 1,
      status: 'active',
      wrapped: wrappedDek,
      createdAt: now,
      rotatedAt: null,
      revokedAt: null,
    };
    await this.#store.insertDek(dek);
    await this.#emit(opts.tenantId, 'dek_create', opts.actor ?? null, { dekId, epoch: 1 });

    // Create BIK (forward-compat — not consumed in Phase 1).
    const bikPlain = randomBytes(32);
    const wrappedBik = await this.#wrapUnderKek(kekPlain, bikPlain, opts.tenantId);
    const bikId = newUUIDv7();
    const bik: BikRecord = {
      id: bikId,
      tenantId: opts.tenantId,
      epoch: 1,
      status: 'active',
      wrapped: wrappedBik,
      createdAt: now,
      revokedAt: null,
    };
    await this.#store.insertBik(bik);
    await this.#emit(opts.tenantId, 'bik_create', opts.actor ?? null, { bikId });

    // Cache freshly minted plaintexts.
    this.#kekCache.set(kekId, { key: kekPlain, expiresAt: now + this.#ttl });
    this.#dekCache.set(dekId, { key: dekPlain, expiresAt: now + this.#ttl });

    const policy: TenantPolicyRecord = {
      tenantId: opts.tenantId,
      enabled: enable,
      kmsProviderId: this.#kms.id,
      kmsConfig: existing?.kmsConfig ?? null,
      activeKekId: kekId,
      activeDekId: dekId,
      activeBikId: bikId,
      rotationSchedule: existing?.rotationSchedule ?? '90d',
      blindIndexEnabled: existing?.blindIndexEnabled ?? false,
      fieldPolicy: mergeFieldPolicy(existing?.fieldPolicy ?? null),
      shredRequestedAt: null,
      shredCompletedAt: null,
    };
    await this.#store.upsertPolicy(policy);
    await this.#emit(opts.tenantId, 'tenant_bootstrap', opts.actor ?? null, { kekId, dekId, bikId });
    return policy;
  }

  /** Mint a new DEK (epoch+1), mark previous as `previous`. Existing ciphertext stays readable. */
  async rotateDek(tenantId: string, actor: string | null = null): Promise<DekRecord> {
    const policy = await this.#requirePolicy(tenantId);
    if (!policy.activeKekId) throw new KeyNotFoundError(`no active KEK for tenant ${tenantId}`);
    const kekRow = await this.#getKekRow(tenantId, policy.activeKekId);
    const kekPlain = await this.#unwrapKek(kekRow);
    const deks = await this.#store.listDeks(tenantId);
    const maxEpoch = deks.reduce((m, d) => (d.epoch > m ? d.epoch : m), 0);
    const newPlain = randomBytes(32);
    const wrapped = await this.#wrapUnderKek(kekPlain, newPlain, tenantId);
    const id = newUUIDv7();
    const now = this.#now();
    const newDek: DekRecord = {
      id,
      tenantId,
      kekId: kekRow.id,
      epoch: maxEpoch + 1,
      status: 'active',
      wrapped,
      createdAt: now,
      rotatedAt: null,
      revokedAt: null,
    };
    await this.#store.insertDek(newDek);
    if (policy.activeDekId) {
      await this.#store.updateDekStatus(policy.activeDekId, 'previous', now);
    }
    await this.#store.upsertPolicy({ ...policy, activeDekId: id });
    this.#dekCache.set(id, { key: newPlain, expiresAt: now + this.#ttl });
    await this.#emit(tenantId, 'dek_rotate', actor, { dekId: id, epoch: newDek.epoch });
    return newDek;
  }

  /** Mint a new KEK (version+1) and re-wrap the active DEK under it. */
  async rotateKek(tenantId: string, actor: string | null = null): Promise<KekRecord> {
    const policy = await this.#requirePolicy(tenantId);
    const keks = await this.#store.listKeks(tenantId);
    const maxVer = keks.reduce((m, k) => (k.version > m ? k.version : m), 0);
    const rootKeyId = await this.#kms.rootKeyId(tenantId);
    const newKekPlain = randomBytes(32);
    const wrapped = await this.#kms.wrap(rootKeyId, newKekPlain);
    const id = newUUIDv7();
    const now = this.#now();
    const newKek: KekRecord = {
      id,
      tenantId,
      version: maxVer + 1,
      status: 'active',
      wrapped: serializeWrappedKey(wrapped),
      createdAt: now,
      rotatedAt: null,
      revokedAt: null,
    };
    await this.#store.insertKek(newKek);

    // Re-wrap the currently-active DEK under the new KEK so future encrypts
    // can be unwrapped via the new KEK alone.
    if (policy.activeDekId) {
      const dek = await this.#getDekRow(tenantId, policy.activeDekId);
      const dekPlain = await this.#unwrapDek(tenantId, dek);
      const rewrapped = await this.#wrapUnderKek(newKekPlain, dekPlain, tenantId);
      const newDekId = newUUIDv7();
      await this.#store.insertDek({
        ...dek,
        id: newDekId,
        kekId: id,
        wrapped: rewrapped,
        status: 'active',
        createdAt: now,
        rotatedAt: null,
        revokedAt: null,
      });
      await this.#store.updateDekStatus(dek.id, 'previous', now);
      await this.#store.upsertPolicy({ ...policy, activeKekId: id, activeDekId: newDekId });
      this.#dekCache.set(newDekId, { key: dekPlain, expiresAt: now + this.#ttl });
    } else {
      await this.#store.upsertPolicy({ ...policy, activeKekId: id });
    }

    if (policy.activeKekId) {
      await this.#store.updateKekStatus(policy.activeKekId, 'previous', now);
    }
    this.#kekCache.set(id, { key: newKekPlain, expiresAt: now + this.#ttl });
    await this.#emit(tenantId, 'kek_rotate', actor, { kekId: id, version: newKek.version });
    return newKek;
  }

  /**
   * Crypto-shred: revoke all KEKs/DEKs/BIKs and clear caches. Existing
   * ciphertext becomes permanently undecryptable. Phase 5 will add the
   * deeper rewrite-and-purge job; this Phase 1 entry point performs the
   * key-side action only.
   */
  async shred(tenantId: string, actor: string | null = null): Promise<void> {
    const now = this.#now();
    const [policy, keks, deks, biks] = await Promise.all([
      this.#store.getPolicy(tenantId),
      this.#store.listKeks(tenantId),
      this.#store.listDeks(tenantId),
      this.#store.listBiks(tenantId),
    ]);
    for (const k of keks) await this.#store.updateKekStatus(k.id, 'revoked', now);
    for (const d of deks) await this.#store.updateDekStatus(d.id, 'revoked', now);
    for (const b of biks) await this.#store.updateBikStatus(b.id, 'revoked', now);
    if (policy) {
      await this.#store.upsertPolicy({
        ...policy,
        enabled: false,
        activeKekId: null,
        activeDekId: null,
        activeBikId: null,
        shredRequestedAt: now,
        shredCompletedAt: now,
      });
    }
    this.#dekCache.clear();
    this.#kekCache.clear();
    await this.#emit(tenantId, 'shred', actor, {
      keks: keks.length,
      deks: deks.length,
      biks: biks.length,
    });
  }

  /** Force-clear in-process key caches. */
  clearCaches(): void {
    this.#dekCache.clear();
    this.#kekCache.clear();
  }

  /**
   * Phase 6 — hard-shred. Performs `shred()` (revoke + clear caches) and
   * then physically deletes wrapped key material from the store. After this
   * call, ciphertext is permanently undecryptable EVEN IF the host KMS later
   * recovers the master key, because the wrapped DEK rows themselves are
   * gone. Use only at the end of a tenant-deletion retention window.
   *
   * The store impl is responsible for the cascade (typically a single SQL
   * transaction deleting from tenant_keks/tenant_deks/tenant_biks).
   */
  async hardShred(
    tenantId: string,
    actor: string | null = null,
  ): Promise<{ keks: number; deks: number; biks: number }> {
    await this.shred(tenantId, actor);
    const counts = await this.#store.deleteAllWrappedMaterial(tenantId);
    await this.#emit(tenantId, 'tenant_purged', actor, counts);
    return counts;
  }

  /**
   * Phase 6 — restore from a soft-shred (status='revoked' but rows still
   * present). Picks the highest-version revoked KEK and highest-epoch
   * revoked DEK, flips both back to 'active', clears the policy's shred
   * timestamps, and re-enables encryption. Throws if the tenant has been
   * hard-shredded (no revoked key material remaining).
   */
  async restoreFromShred(
    tenantId: string,
    actor: string | null = null,
  ): Promise<{ kekId: string; dekId: string }> {
    const policy = await this.#store.getPolicy(tenantId);
    if (!policy) {
      throw new Error(`no encryption policy for tenant ${tenantId}`);
    }
    if (policy.shredRequestedAt === null) {
      throw new Error(`tenant ${tenantId} has no pending shred to restore`);
    }
    const [keks, deks] = await Promise.all([
      this.#store.listKeks(tenantId),
      this.#store.listDeks(tenantId),
    ]);
    const revokedKeks = keks.filter((k) => k.status === 'revoked').sort((a, b) => b.version - a.version);
    const revokedDeks = deks.filter((d) => d.status === 'revoked').sort((a, b) => b.epoch - a.epoch);
    if (revokedKeks.length === 0 || revokedDeks.length === 0) {
      throw new Error(`tenant ${tenantId} cannot be restored: wrapped key material is gone (purged)`);
    }
    const kek = revokedKeks[0]!;
    const dek = revokedDeks[0]!;
    const now = this.#now();
    await this.#store.updateKekStatus(kek.id, 'active', now);
    await this.#store.updateDekStatus(dek.id, 'active', now);
    await this.#store.upsertPolicy({
      ...policy,
      enabled: true,
      activeKekId: kek.id,
      activeDekId: dek.id,
      shredRequestedAt: null,
      shredCompletedAt: null,
    });
    await this.#emit(tenantId, 'tenant_restored', actor, { kekId: kek.id, dekId: dek.id });
    return { kekId: kek.id, dekId: dek.id };
  }

  // ---- internals --------------------------------------------------------

  async #requirePolicy(tenantId: string): Promise<TenantPolicyRecord> {
    const p = await this.#store.getPolicy(tenantId);
    if (!p) throw new KeyNotFoundError(`no encryption policy for tenant ${tenantId}`);
    return p;
  }

  async #getKekRow(tenantId: string, kekId: string): Promise<KekRecord> {
    const all = await this.#store.listKeks(tenantId);
    const row = all.find((k) => k.id === kekId);
    if (!row) throw new KeyNotFoundError(`KEK ${kekId} not found for tenant ${tenantId}`);
    return row;
  }

  async #getDekRow(tenantId: string, dekId: string): Promise<DekRecord> {
    const all = await this.#store.listDeks(tenantId);
    const row = all.find((d) => d.id === dekId);
    if (!row) throw new KeyNotFoundError(`DEK ${dekId} not found for tenant ${tenantId}`);
    return row;
  }

  async #findDekByEpoch(tenantId: string, epoch: number): Promise<DekRecord> {
    const all = await this.#store.listDeks(tenantId);
    const row = all.find((d) => d.epoch === epoch);
    if (!row) throw new KeyNotFoundError(`no DEK at epoch ${epoch} for tenant ${tenantId}`);
    return row;
  }

  async #unwrapKek(row: KekRecord): Promise<Buffer> {
    const cached = this.#kekCache.get(row.id);
    const now = this.#now();
    if (cached && cached.expiresAt > now) return cached.key;
    const key = await this.#kms.unwrap(deserializeWrappedKey(row.wrapped));
    this.#kekCache.set(row.id, { key, expiresAt: now + this.#ttl });
    return key;
  }

  async #unwrapDek(tenantId: string, row: DekRecord): Promise<Buffer> {
    const cached = this.#dekCache.get(row.id);
    const now = this.#now();
    if (cached && cached.expiresAt > now) return cached.key;
    const kekRow = await this.#getKekRow(tenantId, row.kekId);
    const kekPlain = await this.#unwrapKek(kekRow);
    const dek = await this.#unwrapWithKek(kekPlain, row.wrapped, tenantId);
    this.#dekCache.set(row.id, { key: dek, expiresAt: now + this.#ttl });
    return dek;
  }

  async #wrapUnderKek(kekPlain: Buffer, plain: Buffer, tenantId: string) {
    // We use a degenerate KmsProvider-shaped operation locally: AES-256-GCM
    // under the KEK with the tenantId as AAD. This keeps the wire format
    // identical to KmsProvider-wrapped keys (so SerializedWrappedKey works
    // for both KEKs and DEKs/BIKs).
    const local = await import('./providers/local.js');
    const kekProvider = new local.LocalKmsProvider({ masterKey: kekPlain, rootKeyId: `kek:${tenantId}` });
    const w = await kekProvider.wrap(`kek:${tenantId}`, plain);
    return serializeWrappedKey(w);
  }

  async #unwrapWithKek(kekPlain: Buffer, wrapped: ReturnType<typeof serializeWrappedKey>, tenantId: string) {
    const local = await import('./providers/local.js');
    const kekProvider = new local.LocalKmsProvider({ masterKey: kekPlain, rootKeyId: `kek:${tenantId}` });
    return kekProvider.unwrap(deserializeWrappedKey(wrapped));
  }

  async #emit(
    tenantId: string,
    eventKind: EncryptionAuditKind,
    actor: string | null,
    details: Record<string, unknown>,
  ): Promise<void> {
    const ev: EncryptionAuditEvent = {
      id: newUUIDv7(),
      tenantId,
      eventKind,
      actor,
      details,
      createdAt: this.#now(),
    };
    try {
      await this.#audit.emit(ev);
    } catch {
      // Best-effort: never block crypto on audit failure.
    }
  }
}

/** Convenience factory mirroring the `weave*` naming convention. */
export function weaveTenantKeyManager(opts: TenantKeyManagerOptions): TenantKeyManager {
  return new TenantKeyManager(opts);
}
