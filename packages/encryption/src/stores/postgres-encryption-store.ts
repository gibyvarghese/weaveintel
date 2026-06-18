/**
 * Postgres-backed EncryptionStore.
 *
 * Schema mirrors the SQLite adapter. JSON columns are JSONB; timestamps are
 * BIGINT (ms epoch). Pool is caller-supplied so app-side connection management
 * stays out of the package.
 */
import type { Pool } from 'pg';
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
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  kms_provider_id TEXT NOT NULL,
  kms_config JSONB,
  active_kek_id TEXT,
  active_dek_id TEXT,
  active_bik_id TEXT,
  rotation_schedule TEXT NOT NULL DEFAULT 'manual',
  blind_index_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  field_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  shred_requested_at BIGINT,
  shred_completed_at BIGINT
);
CREATE TABLE IF NOT EXISTS tenant_keks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  wrapped JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  rotated_at BIGINT,
  revoked_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_tenant_keks_tenant ON tenant_keks(tenant_id, version DESC);
CREATE TABLE IF NOT EXISTS tenant_deks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  kek_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  status TEXT NOT NULL,
  wrapped JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  rotated_at BIGINT,
  revoked_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_tenant_deks_tenant ON tenant_deks(tenant_id, epoch DESC);
CREATE TABLE IF NOT EXISTS tenant_biks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  status TEXT NOT NULL,
  wrapped JSONB NOT NULL,
  created_at BIGINT NOT NULL,
  revoked_at BIGINT,
  kek_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tenant_biks_tenant ON tenant_biks(tenant_id, epoch DESC);
`;

export interface WeavePostgresEncryptionStoreOptions {
  pool: Pool;
  ensureSchema?: boolean;
}

function num(v: unknown): number {
  return typeof v === 'string' ? Number(v) : (v as number);
}

function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  return num(v);
}

interface PolicyRow {
  tenant_id: string;
  enabled: boolean;
  kms_provider_id: string;
  kms_config: Record<string, unknown> | null;
  active_kek_id: string | null;
  active_dek_id: string | null;
  active_bik_id: string | null;
  rotation_schedule: string;
  blind_index_enabled: boolean;
  field_policy: FieldPolicy;
  shred_requested_at: string | number | null;
  shred_completed_at: string | number | null;
}

interface KekRow {
  id: string;
  tenant_id: string;
  version: number;
  status: string;
  wrapped: SerializedWrappedKey;
  created_at: string | number;
  rotated_at: string | number | null;
  revoked_at: string | number | null;
}

interface DekRow {
  id: string;
  tenant_id: string;
  kek_id: string;
  epoch: number;
  status: string;
  wrapped: SerializedWrappedKey;
  created_at: string | number;
  rotated_at: string | number | null;
  revoked_at: string | number | null;
}

interface BikRow {
  id: string;
  tenant_id: string;
  epoch: number;
  status: string;
  wrapped: SerializedWrappedKey;
  created_at: string | number;
  revoked_at: string | number | null;
  kek_id: string;
}

function rowToPolicy(r: PolicyRow): TenantPolicyRecord {
  return {
    tenantId: r.tenant_id,
    enabled: r.enabled,
    kmsProviderId: r.kms_provider_id,
    kmsConfig: r.kms_config,
    activeKekId: r.active_kek_id,
    activeDekId: r.active_dek_id,
    activeBikId: r.active_bik_id,
    rotationSchedule: r.rotation_schedule,
    blindIndexEnabled: r.blind_index_enabled,
    fieldPolicy: r.field_policy ?? {},
    shredRequestedAt: numOrNull(r.shred_requested_at),
    shredCompletedAt: numOrNull(r.shred_completed_at),
  };
}

function rowToKek(r: KekRow): KekRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    version: r.version,
    status: r.status as KeyStatus,
    wrapped: r.wrapped,
    createdAt: num(r.created_at),
    rotatedAt: numOrNull(r.rotated_at),
    revokedAt: numOrNull(r.revoked_at),
  };
}

function rowToDek(r: DekRow): DekRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    kekId: r.kek_id,
    epoch: r.epoch,
    status: r.status as KeyStatus,
    wrapped: r.wrapped,
    createdAt: num(r.created_at),
    rotatedAt: numOrNull(r.rotated_at),
    revokedAt: numOrNull(r.revoked_at),
  };
}

function rowToBik(r: BikRow): BikRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    epoch: r.epoch,
    status: r.status as KeyStatus,
    wrapped: r.wrapped,
    createdAt: num(r.created_at),
    revokedAt: numOrNull(r.revoked_at),
    kekId: r.kek_id,
  };
}

export async function weavePostgresEncryptionStore(
  opts: WeavePostgresEncryptionStoreOptions,
): Promise<EncryptionStore> {
  const { pool, ensureSchema = true } = opts;
  if (ensureSchema) {
    await pool.query(MIGRATIONS_SQL);
  }

  return {
    async getPolicy(tenantId) {
      const res = await pool.query<PolicyRow>('SELECT * FROM tenant_encryption_policy WHERE tenant_id = $1', [tenantId]);
      const row = res.rows[0];
      return row ? rowToPolicy(row) : null;
    },
    async upsertPolicy(p) {
      await pool.query(
        `INSERT INTO tenant_encryption_policy
          (tenant_id, enabled, kms_provider_id, kms_config, active_kek_id, active_dek_id, active_bik_id,
           rotation_schedule, blind_index_enabled, field_policy, shred_requested_at, shred_completed_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)
         ON CONFLICT (tenant_id) DO UPDATE SET
           enabled = EXCLUDED.enabled,
           kms_provider_id = EXCLUDED.kms_provider_id,
           kms_config = EXCLUDED.kms_config,
           active_kek_id = EXCLUDED.active_kek_id,
           active_dek_id = EXCLUDED.active_dek_id,
           active_bik_id = EXCLUDED.active_bik_id,
           rotation_schedule = EXCLUDED.rotation_schedule,
           blind_index_enabled = EXCLUDED.blind_index_enabled,
           field_policy = EXCLUDED.field_policy,
           shred_requested_at = EXCLUDED.shred_requested_at,
           shred_completed_at = EXCLUDED.shred_completed_at`,
        [
          p.tenantId,
          p.enabled,
          p.kmsProviderId,
          p.kmsConfig ? JSON.stringify(p.kmsConfig) : null,
          p.activeKekId,
          p.activeDekId,
          p.activeBikId,
          p.rotationSchedule,
          p.blindIndexEnabled,
          JSON.stringify(p.fieldPolicy ?? {}),
          p.shredRequestedAt,
          p.shredCompletedAt,
        ],
      );
    },
    async listKeks(tenantId) {
      const res = await pool.query<KekRow>(
        'SELECT * FROM tenant_keks WHERE tenant_id = $1 ORDER BY version ASC, id ASC',
        [tenantId],
      );
      return res.rows.map(rowToKek);
    },
    async getKekById(tenantId, kekId) {
      const res = await pool.query<KekRow>('SELECT * FROM tenant_keks WHERE tenant_id = $1 AND id = $2', [tenantId, kekId]);
      return res.rows[0] ? rowToKek(res.rows[0]) : null;
    },
    async insertKek(k) {
      await pool.query(
        `INSERT INTO tenant_keks (id, tenant_id, version, status, wrapped, created_at, rotated_at, revoked_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`,
        [k.id, k.tenantId, k.version, k.status, JSON.stringify(k.wrapped), k.createdAt, k.rotatedAt, k.revokedAt],
      );
    },
    async updateKekStatus(id, status, ts) {
      await pool.query(
        `UPDATE tenant_keks SET status = $1,
           rotated_at = CASE WHEN $1 = 'previous' THEN $2 ELSE rotated_at END,
           revoked_at = CASE WHEN $1 = 'revoked' THEN $2 ELSE revoked_at END
         WHERE id = $3`,
        [status, ts, id],
      );
    },
    async listDeks(tenantId) {
      const res = await pool.query<DekRow>(
        'SELECT * FROM tenant_deks WHERE tenant_id = $1 ORDER BY epoch ASC, id ASC',
        [tenantId],
      );
      return res.rows.map(rowToDek);
    },
    async getDekById(tenantId, dekId) {
      const res = await pool.query<DekRow>('SELECT * FROM tenant_deks WHERE tenant_id = $1 AND id = $2', [tenantId, dekId]);
      return res.rows[0] ? rowToDek(res.rows[0]) : null;
    },
    async getMaxDekEpoch(tenantId) {
      const res = await pool.query<{ max_epoch: number | null }>(
        `SELECT MAX(epoch) AS max_epoch FROM tenant_deks WHERE tenant_id = $1 AND status = 'active'`,
        [tenantId],
      );
      return res.rows[0]?.max_epoch ?? null;
    },
    async insertDek(d) {
      await pool.query(
        `INSERT INTO tenant_deks (id, tenant_id, kek_id, epoch, status, wrapped, created_at, rotated_at, revoked_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)`,
        [d.id, d.tenantId, d.kekId, d.epoch, d.status, JSON.stringify(d.wrapped), d.createdAt, d.rotatedAt, d.revokedAt],
      );
    },
    async updateDekStatus(id, status, ts) {
      await pool.query(
        `UPDATE tenant_deks SET status = $1,
           rotated_at = CASE WHEN $1 = 'previous' THEN $2 ELSE rotated_at END,
           revoked_at = CASE WHEN $1 = 'revoked' THEN $2 ELSE revoked_at END
         WHERE id = $3`,
        [status, ts, id],
      );
    },
    async listBiks(tenantId) {
      const res = await pool.query<BikRow>(
        'SELECT * FROM tenant_biks WHERE tenant_id = $1 ORDER BY epoch ASC, id ASC',
        [tenantId],
      );
      return res.rows.map(rowToBik);
    },
    async insertBik(b) {
      await pool.query(
        `INSERT INTO tenant_biks (id, tenant_id, epoch, status, wrapped, created_at, revoked_at, kek_id)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)`,
        [b.id, b.tenantId, b.epoch, b.status, JSON.stringify(b.wrapped), b.createdAt, b.revokedAt, b.kekId],
      );
    },
    async updateBikStatus(id, status, ts) {
      await pool.query(
        `UPDATE tenant_biks SET status = $1,
           revoked_at = CASE WHEN $1 = 'revoked' THEN $2 ELSE revoked_at END
         WHERE id = $3`,
        [status, ts, id],
      );
    },
    async deletePolicy(tenantId) {
      await pool.query('DELETE FROM tenant_encryption_policy WHERE tenant_id = $1', [tenantId]);
    },
    async deleteAllWrappedMaterial(tenantId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const k = await client.query('DELETE FROM tenant_keks WHERE tenant_id = $1', [tenantId]);
        const d = await client.query('DELETE FROM tenant_deks WHERE tenant_id = $1', [tenantId]);
        const b = await client.query('DELETE FROM tenant_biks WHERE tenant_id = $1', [tenantId]);
        await client.query('COMMIT');
        return { keks: k.rowCount ?? 0, deks: d.rowCount ?? 0, biks: b.rowCount ?? 0 };
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
  };
}
