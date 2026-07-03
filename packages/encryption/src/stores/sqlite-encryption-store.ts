/**
 * SQLite-backed EncryptionStore.
 *
 * Self-contained — owns its own 4 tables (policy / KEKs / DEKs / BIKs).
 * Wrapped key material stored as JSON text. KMS config + field policy stored
 * as JSON text. Timestamps stored as INTEGER (ms epoch) except for the policy
 * row which uses no created_at/updated_at at this layer (host hosts may add).
 *
 * Drop-in replacement for the reference-app adapter when an app does
 * not want to ship its own DB layer.
 */
import Database from 'better-sqlite3';
import type {
  EncryptionStore,
  TenantPolicyRecord,
  KekRecord,
  DekRecord,
  BikRecord,
  KeyStatus,
} from '../store.js';
import type { FieldPolicy } from '../field-policy.js';
import type { SerializedWrappedKey } from '../kms.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS tenant_encryption_policy (
  tenant_id TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  kms_provider_id TEXT NOT NULL,
  kms_config TEXT,
  active_kek_id TEXT,
  active_dek_id TEXT,
  active_bik_id TEXT,
  rotation_schedule TEXT NOT NULL DEFAULT 'manual',
  blind_index_enabled INTEGER NOT NULL DEFAULT 0,
  field_policy TEXT NOT NULL DEFAULT '{}',
  shred_requested_at INTEGER,
  shred_completed_at INTEGER
);
CREATE TABLE IF NOT EXISTS tenant_keks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  wrapped TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  rotated_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tenant_keks_tenant ON tenant_keks(tenant_id, version DESC);
CREATE TABLE IF NOT EXISTS tenant_deks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  kek_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  status TEXT NOT NULL,
  wrapped TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  rotated_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tenant_deks_tenant ON tenant_deks(tenant_id, epoch DESC);
CREATE TABLE IF NOT EXISTS tenant_biks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  status TEXT NOT NULL,
  wrapped TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  kek_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tenant_biks_tenant ON tenant_biks(tenant_id, epoch DESC);
`;

export interface WeaveSqliteEncryptionStoreOptions {
  database?: Database.Database;
  databasePath?: string;
}

interface PolicyRow {
  tenant_id: string;
  enabled: number;
  kms_provider_id: string;
  kms_config: string | null;
  active_kek_id: string | null;
  active_dek_id: string | null;
  active_bik_id: string | null;
  rotation_schedule: string;
  blind_index_enabled: number;
  field_policy: string;
  shred_requested_at: number | null;
  shred_completed_at: number | null;
}

interface KekRow {
  id: string;
  tenant_id: string;
  version: number;
  status: string;
  wrapped: string;
  created_at: number;
  rotated_at: number | null;
  revoked_at: number | null;
}

interface DekRow {
  id: string;
  tenant_id: string;
  kek_id: string;
  epoch: number;
  status: string;
  wrapped: string;
  created_at: number;
  rotated_at: number | null;
  revoked_at: number | null;
}

interface BikRow {
  id: string;
  tenant_id: string;
  epoch: number;
  status: string;
  wrapped: string;
  created_at: number;
  revoked_at: number | null;
  kek_id: string;
}

function rowToPolicy(r: PolicyRow): TenantPolicyRecord {
  let kmsConfig: Record<string, unknown> | null = null;
  if (r.kms_config) {
    try { kmsConfig = JSON.parse(r.kms_config) as Record<string, unknown>; } catch { kmsConfig = null; }
  }
  let fieldPolicy: FieldPolicy = {};
  try { fieldPolicy = JSON.parse(r.field_policy || '{}') as FieldPolicy; } catch { fieldPolicy = {}; }
  return {
    tenantId: r.tenant_id,
    enabled: r.enabled === 1,
    kmsProviderId: r.kms_provider_id,
    kmsConfig,
    activeKekId: r.active_kek_id,
    activeDekId: r.active_dek_id,
    activeBikId: r.active_bik_id,
    rotationSchedule: r.rotation_schedule,
    blindIndexEnabled: r.blind_index_enabled === 1,
    fieldPolicy,
    shredRequestedAt: r.shred_requested_at,
    shredCompletedAt: r.shred_completed_at,
  };
}

function rowToKek(r: KekRow): KekRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    version: r.version,
    status: r.status as KeyStatus,
    wrapped: JSON.parse(r.wrapped) as SerializedWrappedKey,
    createdAt: r.created_at,
    rotatedAt: r.rotated_at,
    revokedAt: r.revoked_at,
  };
}

function rowToDek(r: DekRow): DekRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    kekId: r.kek_id,
    epoch: r.epoch,
    status: r.status as KeyStatus,
    wrapped: JSON.parse(r.wrapped) as SerializedWrappedKey,
    createdAt: r.created_at,
    rotatedAt: r.rotated_at,
    revokedAt: r.revoked_at,
  };
}

function rowToBik(r: BikRow): BikRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    epoch: r.epoch,
    status: r.status as KeyStatus,
    wrapped: JSON.parse(r.wrapped) as SerializedWrappedKey,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
    kekId: r.kek_id,
  };
}

export function weaveSqliteEncryptionStore(opts: WeaveSqliteEncryptionStoreOptions = {}): EncryptionStore {
  const db = opts.database ?? new Database(opts.databasePath ?? ':memory:');
  db.exec(MIGRATIONS_SQL);

  const upsertPolicyStmt = db.prepare(`
    INSERT INTO tenant_encryption_policy
      (tenant_id, enabled, kms_provider_id, kms_config, active_kek_id, active_dek_id, active_bik_id,
       rotation_schedule, blind_index_enabled, field_policy, shred_requested_at, shred_completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id) DO UPDATE SET
      enabled = excluded.enabled,
      kms_provider_id = excluded.kms_provider_id,
      kms_config = excluded.kms_config,
      active_kek_id = excluded.active_kek_id,
      active_dek_id = excluded.active_dek_id,
      active_bik_id = excluded.active_bik_id,
      rotation_schedule = excluded.rotation_schedule,
      blind_index_enabled = excluded.blind_index_enabled,
      field_policy = excluded.field_policy,
      shred_requested_at = excluded.shred_requested_at,
      shred_completed_at = excluded.shred_completed_at
  `);
  const getPolicyStmt = db.prepare('SELECT * FROM tenant_encryption_policy WHERE tenant_id = ?');
  const deletePolicyStmt = db.prepare('DELETE FROM tenant_encryption_policy WHERE tenant_id = ?');

  const insertKekStmt = db.prepare(
    'INSERT INTO tenant_keks (id, tenant_id, version, status, wrapped, created_at, rotated_at, revoked_at) VALUES (?,?,?,?,?,?,?,?)',
  );
  const listKeksStmt = db.prepare('SELECT * FROM tenant_keks WHERE tenant_id = ? ORDER BY version ASC, id ASC');
  // H-13: prepared statements for O(1) point lookups.
  const getKekByIdStmt = db.prepare('SELECT * FROM tenant_keks WHERE tenant_id = ? AND id = ?');
  const updateKekStatusStmt = db.prepare(
    "UPDATE tenant_keks SET status = ?, rotated_at = CASE WHEN ? = 'previous' THEN ? ELSE rotated_at END, revoked_at = CASE WHEN ? = 'revoked' THEN ? ELSE revoked_at END WHERE id = ?",
  );

  const insertDekStmt = db.prepare(
    'INSERT INTO tenant_deks (id, tenant_id, kek_id, epoch, status, wrapped, created_at, rotated_at, revoked_at) VALUES (?,?,?,?,?,?,?,?,?)',
  );
  const listDeksStmt = db.prepare('SELECT * FROM tenant_deks WHERE tenant_id = ? ORDER BY epoch ASC, id ASC');
  const getDekByIdStmt = db.prepare('SELECT * FROM tenant_deks WHERE tenant_id = ? AND id = ?');
  const getMaxDekEpochStmt = db.prepare(`SELECT MAX(epoch) AS max_epoch FROM tenant_deks WHERE tenant_id = ? AND status = 'active'`);
  const updateDekStatusStmt = db.prepare(
    "UPDATE tenant_deks SET status = ?, rotated_at = CASE WHEN ? = 'previous' THEN ? ELSE rotated_at END, revoked_at = CASE WHEN ? = 'revoked' THEN ? ELSE revoked_at END WHERE id = ?",
  );

  const insertBikStmt = db.prepare(
    'INSERT INTO tenant_biks (id, tenant_id, epoch, status, wrapped, created_at, revoked_at, kek_id) VALUES (?,?,?,?,?,?,?,?)',
  );
  const listBiksStmt = db.prepare('SELECT * FROM tenant_biks WHERE tenant_id = ? ORDER BY epoch ASC, id ASC');
  const updateBikStatusStmt = db.prepare(
    "UPDATE tenant_biks SET status = ?, revoked_at = CASE WHEN ? = 'revoked' THEN ? ELSE revoked_at END WHERE id = ?",
  );

  const deleteKeksStmt = db.prepare('DELETE FROM tenant_keks WHERE tenant_id = ?');
  const deleteDeksStmt = db.prepare('DELETE FROM tenant_deks WHERE tenant_id = ?');
  const deleteBiksStmt = db.prepare('DELETE FROM tenant_biks WHERE tenant_id = ?');

  return {
    async getPolicy(tenantId) {
      const row = getPolicyStmt.get(tenantId) as PolicyRow | undefined;
      return row ? rowToPolicy(row) : null;
    },
    async upsertPolicy(p) {
      upsertPolicyStmt.run(
        p.tenantId,
        p.enabled ? 1 : 0,
        p.kmsProviderId,
        p.kmsConfig ? JSON.stringify(p.kmsConfig) : null,
        p.activeKekId,
        p.activeDekId,
        p.activeBikId,
        p.rotationSchedule,
        p.blindIndexEnabled ? 1 : 0,
        JSON.stringify(p.fieldPolicy ?? {}),
        p.shredRequestedAt,
        p.shredCompletedAt,
      );
    },
    async listKeks(tenantId) {
      return (listKeksStmt.all(tenantId) as KekRow[]).map(rowToKek);
    },
    async getKekById(tenantId, kekId) {
      const row = getKekByIdStmt.get(tenantId, kekId) as KekRow | undefined;
      return row ? rowToKek(row) : null;
    },
    async insertKek(k) {
      insertKekStmt.run(k.id, k.tenantId, k.version, k.status, JSON.stringify(k.wrapped), k.createdAt, k.rotatedAt, k.revokedAt);
    },
    async updateKekStatus(id, status, ts) {
      updateKekStatusStmt.run(status, status, ts, status, ts, id);
    },
    async listDeks(tenantId) {
      return (listDeksStmt.all(tenantId) as DekRow[]).map(rowToDek);
    },
    async getDekById(tenantId, dekId) {
      const row = getDekByIdStmt.get(tenantId, dekId) as DekRow | undefined;
      return row ? rowToDek(row) : null;
    },
    async getMaxDekEpoch(tenantId) {
      const row = getMaxDekEpochStmt.get(tenantId) as { max_epoch: number | null } | undefined;
      return row?.max_epoch ?? null;
    },
    async insertDek(d) {
      insertDekStmt.run(d.id, d.tenantId, d.kekId, d.epoch, d.status, JSON.stringify(d.wrapped), d.createdAt, d.rotatedAt, d.revokedAt);
    },
    async updateDekStatus(id, status, ts) {
      updateDekStatusStmt.run(status, status, ts, status, ts, id);
    },
    async listBiks(tenantId) {
      return (listBiksStmt.all(tenantId) as BikRow[]).map(rowToBik);
    },
    async insertBik(b) {
      insertBikStmt.run(b.id, b.tenantId, b.epoch, b.status, JSON.stringify(b.wrapped), b.createdAt, b.revokedAt, b.kekId);
    },
    async updateBikStatus(id, status, ts) {
      updateBikStatusStmt.run(status, status, ts, id);
    },
    async deletePolicy(tenantId) {
      deletePolicyStmt.run(tenantId);
    },
    async deleteAllWrappedMaterial(tenantId) {
      const tx = db.transaction((tid: string) => {
        const k = deleteKeksStmt.run(tid).changes;
        const d = deleteDeksStmt.run(tid).changes;
        const b = deleteBiksStmt.run(tid).changes;
        return { keks: k, deks: d, biks: b };
      });
      return tx(tenantId);
    },
  };
}
