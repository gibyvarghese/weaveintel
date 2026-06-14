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

import { createHmac, randomBytes } from 'node:crypto';
import { newUUIDv7 } from '@weaveintel/core';
import type { AuditEmitter, EncryptionAuditEvent, EncryptionAuditKind } from './audit.js';
import { decryptValue, encryptValue, isEncrypted, parseSentinel } from './envelope.js';
import { KeyNotFoundError } from './errors.js';
import {
  noopMetricsEmitter,
  startTimer,
  type MetricsEmitter,
  type MetricLabels,
  type MetricName,
} from './metrics.js';
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

/**
 * Per-tenant KMS resolver. Returns the `KmsProvider` instance to use for the
 * given tenant. Phase 7 enables a different KMS backend per tenant by reading
 * `tenant_encryption_policy.kms_provider_id` + `kms_config` and constructing
 * the matching provider via the registry. Implementations should cache the
 * built provider — the manager calls this on every wrap/unwrap path.
 */
export type KmsResolver = (tenantId: string) => Promise<KmsProvider>;

export interface TenantKeyManagerOptions {
  readonly store: EncryptionStore;
  /**
   * Default KmsProvider used when `kmsResolver` is not supplied OR when a
   * resolver returns null/undefined. Backwards compatible with pre-Phase 7
   * single-provider deployments.
   */
  readonly kms?: KmsProvider;
  /**
   * Phase 7: per-tenant KMS resolver. When supplied, takes precedence over
   * `kms` for every wrap/unwrap. Falls back to `kms` if the resolver throws
   * `KmsUnavailableError` and a default is provided.
   */
  readonly kmsResolver?: KmsResolver;
  readonly audit?: AuditEmitter;
  /**
   * Phase 9 — fire-and-forget metrics sink. Hosts plug an aggregator (e.g.
   * `InMemoryMetricsEmitter`) for the admin dashboard. Defaults to a no-op
   * so existing callers don't change behaviour.
   */
  readonly metrics?: MetricsEmitter;
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
  readonly #defaultKms: KmsProvider | null;
  readonly #resolver: KmsResolver | null;
  readonly #audit: AuditEmitter;
  readonly #metrics: MetricsEmitter;
  readonly #ttl: number;
  readonly #now: () => number;
  readonly #dekCache = new Map<string, CachedKey>();
  readonly #kekCache = new Map<string, CachedKey>();
  readonly #bikCache = new Map<string, CachedKey>();

  constructor(opts: TenantKeyManagerOptions) {
    if (!opts.kms && !opts.kmsResolver) {
      throw new Error('TenantKeyManager requires either `kms` (default provider) or `kmsResolver`');
    }
    this.#store = opts.store;
    this.#defaultKms = opts.kms ?? null;
    this.#resolver = opts.kmsResolver ?? null;
    this.#audit = opts.audit ?? { async emit() {} };
    this.#metrics = opts.metrics ?? noopMetricsEmitter;
    this.#ttl = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.#now = opts.now ?? (() => Date.now());
  }

  /**
   * Resolve the KMS provider for `tenantId`. Resolver wins; falls back to
   * the default provider if the resolver is missing OR returns null.
   * The resolver is responsible for its own caching — `TenantKeyManager`
   * caches plaintext KEK/DEK material, not provider instances.
   */
  async #resolveKms(tenantId: string): Promise<KmsProvider> {
    if (this.#resolver) {
      try {
        const p = await this.#resolver(tenantId);
        if (p) return p;
      } catch (err) {
        if (!this.#defaultKms) throw err;
      }
    }
    if (!this.#defaultKms) {
      throw new KeyNotFoundError(`no KMS provider available for tenant ${tenantId}`);
    }
    return this.#defaultKms;
  }

  // ---- public API -------------------------------------------------------

  async encrypt(opts: EncryptOptions): Promise<string> {
    const stop = startTimer();
    const policy = await this.#requirePolicy(opts.tenantId);
    const dekId = policy.activeDekId;
    if (!dekId) throw new KeyNotFoundError(`no active DEK for tenant ${opts.tenantId}`);
    const dekRow = await this.#getDekRow(opts.tenantId, dekId);
    const dek = await this.#unwrapDek(opts.tenantId, dekRow);
    const pt = typeof opts.plaintext === 'string' ? Buffer.from(opts.plaintext, 'utf8') : opts.plaintext;
    const ct = encryptValue({
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
    this.#histogram('encryption.encrypt.duration_ms', stop(), {
      tenantId: opts.tenantId,
      table: opts.table,
      column: opts.column,
    });
    return ct;
  }

  async decrypt(opts: DecryptOptions): Promise<string> {
    if (!isEncrypted(opts.value)) return opts.value;
    const stop = startTimer();
    const parsed = parseSentinel(opts.value);
    try {
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
      this.#histogram('encryption.decrypt.duration_ms', stop(), {
        tenantId: opts.tenantId,
        table: opts.table,
        column: opts.column,
      });
      return buf.toString('utf8');
    } catch (err) {
      this.#counter('encryption.aead.error', {
        tenantId: opts.tenantId,
        table: opts.table,
        column: opts.column,
        kind: (err as Error).name ?? 'Error',
      });
      throw err;
    }
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
    const kms = await this.#resolveKms(opts.tenantId);
    const rootKeyId = await kms.rootKeyId(opts.tenantId);
    const kekPlain = randomBytes(32);
    const wrappedKek = await kms.wrap(rootKeyId, kekPlain);
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
      kekId,
    };
    await this.#store.insertBik(bik);
    await this.#emit(opts.tenantId, 'bik_create', opts.actor ?? null, { bikId });

    // Cache freshly minted plaintexts.
    this.#kekCache.set(kekId, { key: kekPlain, expiresAt: now + this.#ttl });
    this.#dekCache.set(dekId, { key: dekPlain, expiresAt: now + this.#ttl });

    const policy: TenantPolicyRecord = {
      tenantId: opts.tenantId,
      enabled: enable,
      kmsProviderId: existing?.kmsProviderId ?? kms.id,
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

  /** Mint a new KEK (version+1), re-wrap the active DEK and active BIK under it. */
  async rotateKek(tenantId: string, actor: string | null = null): Promise<KekRecord> {
    const policy = await this.#requirePolicy(tenantId);
    const keks = await this.#store.listKeks(tenantId);
    const maxVer = keks.reduce((m, k) => (k.version > m ? k.version : m), 0);
    const kms = await this.#resolveKms(tenantId);
    const rootKeyId = await kms.rootKeyId(tenantId);
    const newKekPlain = randomBytes(32);
    const wrapped = await kms.wrap(rootKeyId, newKekPlain);
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
    let newDekId = policy.activeDekId;
    if (policy.activeDekId) {
      const dek = await this.#getDekRow(tenantId, policy.activeDekId);
      const dekPlain = await this.#unwrapDek(tenantId, dek);
      const rewrapped = await this.#wrapUnderKek(newKekPlain, dekPlain, tenantId);
      newDekId = newUUIDv7();
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
      this.#dekCache.set(newDekId, { key: dekPlain, expiresAt: now + this.#ttl });
    }

    // Re-wrap the active BIK under the new KEK so the old KEK can be fully
    // retired without losing blind-index capability. Without this, existing BIKs
    // remain bound to the old KEK indefinitely, blocking its revocation.
    let newBikId = policy.activeBikId;
    if (policy.activeBikId && policy.blindIndexEnabled) {
      const bikRow = await this.#getBikRow(tenantId, policy.activeBikId);
      const bikPlain = await this.#unwrapBik(tenantId, bikRow);
      const rewrappedBik = await this.#wrapUnderKek(newKekPlain, bikPlain, tenantId);
      newBikId = newUUIDv7();
      const biks = await this.#store.listBiks(tenantId);
      const maxEpoch = biks.reduce((m, b) => (b.epoch > m ? b.epoch : m), 0);
      await this.#store.insertBik({
        id: newBikId,
        tenantId,
        epoch: maxEpoch + 1,
        status: 'active',
        wrapped: rewrappedBik,
        createdAt: now,
        revokedAt: null,
        kekId: id,
      });
      await this.#store.updateBikStatus(bikRow.id, 'previous', now);
      this.#bikCache.set(newBikId, { key: bikPlain, expiresAt: now + this.#ttl });
      await this.#emit(tenantId, 'bik_rotate', actor, {
        bikId: newBikId,
        epoch: maxEpoch + 1,
        reason: 'kek_rotation',
      });
    }

    await this.#store.upsertPolicy({
      ...policy,
      activeKekId: id,
      ...(newDekId !== policy.activeDekId ? { activeDekId: newDekId ?? null } : {}),
      ...(newBikId !== policy.activeBikId ? { activeBikId: newBikId ?? null } : {}),
    });

    if (policy.activeKekId) {
      await this.#store.updateKekStatus(policy.activeKekId, 'previous', now);
    }
    this.#kekCache.set(id, { key: newKekPlain, expiresAt: now + this.#ttl });
    await this.#emit(tenantId, 'kek_rotate', actor, { kekId: id, version: newKek.version });
    return newKek;
  }

  /**
   * Phase 8 — compute a deterministic, tenant-scoped blind index for an
   * equality-lookup column. Returns 24 hex chars (96 bits) of HMAC-SHA-256
   * keyed by the tenant's active BIK. Inputs to the HMAC are domain-separated
   * by `${table}|${column}|${value}` so the same value in different columns
   * never collides.
   *
   * Throws when the tenant has no policy / no active BIK / blind-index toggle
   * is disabled. Callers should use `policy.blindIndexEnabled` to gate writes
   * AND use `maybeBlindIndex` (adapter helper) to short-circuit cleanly.
   */
  async computeBlindIndex(opts: {
    readonly tenantId: string;
    readonly table: string;
    readonly column: string;
    readonly value: string;
  }): Promise<string> {
    const stop = startTimer();
    const policy = await this.#requirePolicy(opts.tenantId);
    if (!policy.blindIndexEnabled) {
      throw new KeyNotFoundError(
        `blind-index disabled for tenant ${opts.tenantId} (policy.blindIndexEnabled=false)`,
      );
    }
    const bikId = policy.activeBikId;
    if (!bikId) throw new KeyNotFoundError(`no active BIK for tenant ${opts.tenantId}`);
    const bikRow = await this.#getBikRow(opts.tenantId, bikId);
    const bik = await this.#unwrapBik(opts.tenantId, bikRow);
    const mac = createHmac('sha256', bik)
      .update(`${opts.table}|${opts.column}|${opts.value}`)
      .digest('hex')
      .slice(0, 24);
    // Audit is fire-and-forget and rate-limited at the host level — cheap path
    // emits per-call. Hosts that want sampling wrap the manager.
    await this.#emit(opts.tenantId, 'bidx_compute', null, {
      table: opts.table,
      column: opts.column,
      bikId,
    });
    this.#histogram('encryption.blind_index.duration_ms', stop(), {
      tenantId: opts.tenantId,
      table: opts.table,
      column: opts.column,
    });
    return mac;
  }

  /**
   * Phase 8 — mint a new BIK (epoch+1), mark previous as `previous`. Existing
   * blind-index columns become STALE — operators MUST run a bidx rebuild after
   * this call (the admin endpoint records the rebuild progress in audit).
   */
  async rotateBik(tenantId: string, actor: string | null = null): Promise<BikRecord> {
    const policy = await this.#requirePolicy(tenantId);
    if (!policy.activeKekId) throw new KeyNotFoundError(`no active KEK for tenant ${tenantId}`);
    const kekRow = await this.#getKekRow(tenantId, policy.activeKekId);
    const kekPlain = await this.#unwrapKek(kekRow);
    const biks = await this.#store.listBiks(tenantId);
    const maxEpoch = biks.reduce((m, b) => (b.epoch > m ? b.epoch : m), 0);
    const newPlain = randomBytes(32);
    const wrapped = await this.#wrapUnderKek(kekPlain, newPlain, tenantId);
    const id = newUUIDv7();
    const now = this.#now();
    const newBik: BikRecord = {
      id,
      tenantId,
      epoch: maxEpoch + 1,
      status: 'active',
      wrapped,
      createdAt: now,
      revokedAt: null,
      kekId: policy.activeKekId,
    };
    await this.#store.insertBik(newBik);
    if (policy.activeBikId) {
      await this.#store.updateBikStatus(policy.activeBikId, 'previous', now);
    }
    await this.#store.upsertPolicy({ ...policy, activeBikId: id });
    this.#bikCache.set(id, { key: newPlain, expiresAt: now + this.#ttl });
    await this.#emit(tenantId, 'bik_rotate', actor, { bikId: id, epoch: newBik.epoch });
    return newBik;
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
    this.#bikCache.clear();
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
    this.#bikCache.clear();
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
    if (cached && cached.expiresAt > now) {
      this.#counter('encryption.cache.hit', { tenantId: row.tenantId, cache: 'kek' });
      return cached.key;
    }
    this.#counter('encryption.cache.miss', { tenantId: row.tenantId, cache: 'kek' });
    const kms = await this.#resolveKms(row.tenantId);
    const stop = startTimer();
    let key: Buffer;
    try {
      key = await kms.unwrap(deserializeWrappedKey(row.wrapped));
    } catch (err) {
      this.#counter('encryption.kms.error', {
        tenantId: row.tenantId,
        provider: kms.id,
        kind: (err as Error).name ?? 'Error',
      });
      throw err;
    }
    this.#histogram('encryption.kms.unwrap.duration_ms', stop(), {
      tenantId: row.tenantId,
      provider: kms.id,
    });
    this.#kekCache.set(row.id, { key, expiresAt: now + this.#ttl });
    return key;
  }

  async #unwrapDek(tenantId: string, row: DekRecord): Promise<Buffer> {
    const cached = this.#dekCache.get(row.id);
    const now = this.#now();
    if (cached && cached.expiresAt > now) {
      this.#counter('encryption.cache.hit', { tenantId, cache: 'dek' });
      return cached.key;
    }
    this.#counter('encryption.cache.miss', { tenantId, cache: 'dek' });
    const kekRow = await this.#getKekRow(tenantId, row.kekId);
    const kekPlain = await this.#unwrapKek(kekRow);
    const dek = await this.#unwrapWithKek(kekPlain, row.wrapped, tenantId);
    this.#dekCache.set(row.id, { key: dek, expiresAt: now + this.#ttl });
    return dek;
  }

  async #getBikRow(tenantId: string, bikId: string): Promise<BikRecord> {
    const all = await this.#store.listBiks(tenantId);
    const row = all.find((b) => b.id === bikId);
    if (!row) throw new KeyNotFoundError(`BIK ${bikId} not found for tenant ${tenantId}`);
    return row;
  }

  async #unwrapBik(tenantId: string, row: BikRecord): Promise<Buffer> {
    const cached = this.#bikCache.get(row.id);
    const now = this.#now();
    if (cached && cached.expiresAt > now) {
      this.#counter('encryption.cache.hit', { tenantId, cache: 'bik' });
      return cached.key;
    }
    this.#counter('encryption.cache.miss', { tenantId, cache: 'bik' });
    // Each BIK records the KEK that wrapped it, enabling correct unwrap across KEK rotations.
    const kekRow = await this.#getKekRow(tenantId, row.kekId);
    const kekPlain = await this.#unwrapKek(kekRow);
    const bik = await this.#unwrapWithKek(kekPlain, row.wrapped, tenantId);
    this.#bikCache.set(row.id, { key: bik, expiresAt: now + this.#ttl });
    return bik;
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

  #histogram(name: MetricName, value: number, labels: MetricLabels): void {
    try {
      this.#metrics.record({ name, kind: 'histogram', value, labels, at: this.#now() });
    } catch {
      // metrics are fire-and-forget
    }
  }

  #counter(name: MetricName, labels: MetricLabels, value = 1): void {
    try {
      this.#metrics.record({ name, kind: 'counter', value, labels, at: this.#now() });
    } catch {
      // metrics are fire-and-forget
    }
  }
}

/** Convenience factory mirroring the `weave*` naming convention. */
export function weaveTenantKeyManager(opts: TenantKeyManagerOptions): TenantKeyManager {
  return new TenantKeyManager(opts);
}
