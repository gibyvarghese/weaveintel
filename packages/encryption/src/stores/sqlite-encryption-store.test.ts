import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { weaveSqliteEncryptionStore } from './sqlite-encryption-store.js';
import type {
  TenantPolicyRecord,
  KekRecord,
  DekRecord,
  BikRecord,
} from '../store.js';
import type { SerializedWrappedKey } from '../kms.js';

function mkWrapped(seed: string): SerializedWrappedKey {
  return { ciphertext: `ct-${seed}`, algorithm: 'test', metadata: { seed } } as unknown as SerializedWrappedKey;
}

function mkPolicy(tenantId: string, overrides: Partial<TenantPolicyRecord> = {}): TenantPolicyRecord {
  return {
    tenantId,
    enabled: true,
    kmsProviderId: 'local',
    kmsConfig: { keyId: 'master' },
    activeKekId: null,
    activeDekId: null,
    activeBikId: null,
    rotationSchedule: 'monthly',
    blindIndexEnabled: false,
    fieldPolicy: { messages: { columns: ['content'] } },
    shredRequestedAt: null,
    shredCompletedAt: null,
    ...overrides,
  };
}

function mkKek(id: string, tenantId: string, version: number): KekRecord {
  return {
    id,
    tenantId,
    version,
    status: 'active',
    wrapped: mkWrapped(id),
    createdAt: 100 + version,
    rotatedAt: null,
    revokedAt: null,
  };
}

function mkDek(id: string, tenantId: string, kekId: string, epoch: number): DekRecord {
  return {
    id,
    tenantId,
    kekId,
    epoch,
    status: 'active',
    wrapped: mkWrapped(id),
    createdAt: 200 + epoch,
    rotatedAt: null,
    revokedAt: null,
  };
}

function mkBik(id: string, tenantId: string, kekId: string, epoch: number): BikRecord {
  return {
    id,
    tenantId,
    kekId,
    epoch,
    status: 'active',
    wrapped: mkWrapped(id),
    createdAt: 300 + epoch,
    revokedAt: null,
  };
}

describe('weaveSqliteEncryptionStore', () => {
  it('upserts and reads policy round-trip including JSON fields', async () => {
    const db = new Database(':memory:');
    const store = weaveSqliteEncryptionStore({ database: db });
    const p = mkPolicy('t1');
    await store.upsertPolicy(p);
    const got = await store.getPolicy('t1');
    expect(got).toEqual(p);
    expect(await store.getPolicy('missing')).toBeNull();
  });

  it('updates policy via upsert', async () => {
    const db = new Database(':memory:');
    const store = weaveSqliteEncryptionStore({ database: db });
    await store.upsertPolicy(mkPolicy('t1'));
    await store.upsertPolicy(mkPolicy('t1', { enabled: false, activeKekId: 'k1' }));
    const got = await store.getPolicy('t1');
    expect(got?.enabled).toBe(false);
    expect(got?.activeKekId).toBe('k1');
  });

  it('lists KEKs and rotates status', async () => {
    const db = new Database(':memory:');
    const store = weaveSqliteEncryptionStore({ database: db });
    await store.insertKek(mkKek('k1', 't1', 1));
    await store.insertKek(mkKek('k2', 't1', 2));
    const keks = await store.listKeks('t1');
    expect(keks.map((k) => k.id).sort()).toEqual(['k1', 'k2']);
    await store.updateKekStatus('k1', 'previous', 999);
    const after = await store.listKeks('t1');
    const k1 = after.find((k) => k.id === 'k1')!;
    expect(k1.status).toBe('previous');
    expect(k1.rotatedAt).toBe(999);
    expect(k1.revokedAt).toBeNull();
    await store.updateKekStatus('k2', 'revoked', 1000);
    const final = await store.listKeks('t1');
    const k2 = final.find((k) => k.id === 'k2')!;
    expect(k2.status).toBe('revoked');
    expect(k2.revokedAt).toBe(1000);
  });

  it('lists DEKs and rotates status', async () => {
    const db = new Database(':memory:');
    const store = weaveSqliteEncryptionStore({ database: db });
    await store.insertKek(mkKek('k1', 't1', 1));
    await store.insertDek(mkDek('d1', 't1', 'k1', 1));
    await store.insertDek(mkDek('d2', 't1', 'k1', 2));
    const deks = await store.listDeks('t1');
    expect(deks.map((d) => d.id).sort()).toEqual(['d1', 'd2']);
    await store.updateDekStatus('d1', 'previous', 555);
    const after = await store.listDeks('t1');
    expect(after.find((d) => d.id === 'd1')?.rotatedAt).toBe(555);
  });

  it('lists BIKs and revokes', async () => {
    const db = new Database(':memory:');
    const store = weaveSqliteEncryptionStore({ database: db });
    await store.insertKek(mkKek('k1', 't1', 1));
    await store.insertBik(mkBik('b1', 't1', 'k1', 1));
    await store.insertBik(mkBik('b2', 't1', 'k1', 2));
    const biks = await store.listBiks('t1');
    expect(biks.map((b) => b.id).sort()).toEqual(['b1', 'b2']);
    await store.updateBikStatus('b1', 'revoked', 777);
    const after = await store.listBiks('t1');
    expect(after.find((b) => b.id === 'b1')?.revokedAt).toBe(777);
  });

  it('deleteAllWrappedMaterial wipes all three key tables and returns counts', async () => {
    const db = new Database(':memory:');
    const store = weaveSqliteEncryptionStore({ database: db });
    await store.upsertPolicy(mkPolicy('t1'));
    await store.insertKek(mkKek('k1', 't1', 1));
    await store.insertKek(mkKek('k2', 't1', 2));
    await store.insertDek(mkDek('d1', 't1', 'k1', 1));
    await store.insertBik(mkBik('b1', 't1', 'k1', 1));
    // Other tenant — must NOT be deleted
    await store.insertKek(mkKek('k99', 't2', 1));
    const counts = await store.deleteAllWrappedMaterial('t1');
    expect(counts).toEqual({ keks: 2, deks: 1, biks: 1 });
    expect(await store.listKeks('t1')).toEqual([]);
    expect(await store.listDeks('t1')).toEqual([]);
    expect(await store.listBiks('t1')).toEqual([]);
    // Policy survives (only key material is wiped)
    expect(await store.getPolicy('t1')).not.toBeNull();
    // Other tenant survives
    expect((await store.listKeks('t2')).map((k) => k.id)).toEqual(['k99']);
  });

  it('deletePolicy removes the policy row', async () => {
    const db = new Database(':memory:');
    const store = weaveSqliteEncryptionStore({ database: db });
    await store.upsertPolicy(mkPolicy('t1'));
    await store.deletePolicy('t1');
    expect(await store.getPolicy('t1')).toBeNull();
  });
});
