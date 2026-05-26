/**
 * @weaveintel/encryption — persistence interface.
 *
 * The package never imports a DB adapter directly; hosts implement this
 * interface over their own store (SQLite, Postgres, etc.). All blobs are
 * pre-serialized as JSON strings so the package can stay storage-agnostic.
 */

import type { SerializedWrappedKey } from './kms.js';

export type KeyStatus = 'active' | 'previous' | 'revoked';

export interface TenantPolicyRecord {
  readonly tenantId: string;
  readonly enabled: boolean;
  readonly kmsProviderId: string;
  readonly kmsConfig: Record<string, unknown> | null;
  readonly activeKekId: string | null;
  readonly activeDekId: string | null;
  readonly activeBikId: string | null;
  readonly rotationSchedule: string;
  readonly blindIndexEnabled: boolean;
  readonly fieldPolicy: import('./field-policy.js').FieldPolicy;
  readonly shredRequestedAt: number | null;
  readonly shredCompletedAt: number | null;
}

export interface KekRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly version: number;
  readonly status: KeyStatus;
  readonly wrapped: SerializedWrappedKey;
  readonly createdAt: number;
  readonly rotatedAt: number | null;
  readonly revokedAt: number | null;
}

export interface DekRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly kekId: string;
  readonly epoch: number;
  readonly status: KeyStatus;
  readonly wrapped: SerializedWrappedKey;
  readonly createdAt: number;
  readonly rotatedAt: number | null;
  readonly revokedAt: number | null;
}

export interface BikRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly epoch: number;
  readonly status: KeyStatus;
  readonly wrapped: SerializedWrappedKey;
  readonly createdAt: number;
  readonly revokedAt: number | null;
  /** ID of the KEK that wraps this BIK — required for correct per-BIK unwrap during KEK rotation. */
  readonly kekId: string;
}

export interface EncryptionStore {
  getPolicy(tenantId: string): Promise<TenantPolicyRecord | null>;
  upsertPolicy(p: TenantPolicyRecord): Promise<void>;

  listKeks(tenantId: string): Promise<KekRecord[]>;
  insertKek(k: KekRecord): Promise<void>;
  updateKekStatus(id: string, status: KeyStatus, ts: number): Promise<void>;

  listDeks(tenantId: string): Promise<DekRecord[]>;
  insertDek(d: DekRecord): Promise<void>;
  updateDekStatus(id: string, status: KeyStatus, ts: number): Promise<void>;

  listBiks(tenantId: string): Promise<BikRecord[]>;
  insertBik(b: BikRecord): Promise<void>;
  updateBikStatus(id: string, status: KeyStatus, ts: number): Promise<void>;

  /**
   * Phase 6 — hard-shred / tenant deletion.
   *
   * Hosts that support GDPR right-to-be-forgotten flows must implement these
   * two methods. Hosts that only support soft-shred (status='revoked') may
   * leave them as no-ops or throw — `weaveTenantKeyManager.hardShred()` is
   * the only caller and it is opt-in per deployment.
   */
  deletePolicy(tenantId: string): Promise<void>;
  deleteAllWrappedMaterial(tenantId: string): Promise<{ keks: number; deks: number; biks: number }>;
}
