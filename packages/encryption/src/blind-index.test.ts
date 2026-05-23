import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { weaveTenantKeyManager } from './key-manager.js';
import { LocalKmsProvider } from './providers/local.js';
import {
  bidxColumnName,
  computeRowBlindIndices,
  DEFAULT_BLIND_INDEX_SPECS,
  findBlindIndexSpec,
  maybeBlindIndex,
  mergeBlindIndexSpecs,
  type BlindIndexSpec,
  type BlindIndexState,
} from './blind-index.js';
import type { AuditEmitter, EncryptionAuditEvent } from './audit.js';
import type {
  BikRecord,
  DekRecord,
  EncryptionStore,
  KekRecord,
  KeyStatus,
  TenantPolicyRecord,
} from './store.js';

class InMemoryStore implements EncryptionStore {
  policy: TenantPolicyRecord | null = null;
  keks: KekRecord[] = [];
  deks: DekRecord[] = [];
  biks: BikRecord[] = [];
  async getPolicy() {
    return this.policy;
  }
  async upsertPolicy(p: TenantPolicyRecord) {
    this.policy = p;
  }
  async listKeks() {
    return [...this.keks];
  }
  async insertKek(k: KekRecord) {
    this.keks.push(k);
  }
  async updateKekStatus(id: string, s: KeyStatus, ts: number) {
    this.keks = this.keks.map((k) =>
      k.id === id ? { ...k, status: s, rotatedAt: s === 'previous' ? ts : k.rotatedAt, revokedAt: s === 'revoked' ? ts : k.revokedAt } : k,
    );
  }
  async listDeks() {
    return [...this.deks];
  }
  async insertDek(d: DekRecord) {
    this.deks.push(d);
  }
  async updateDekStatus(id: string, s: KeyStatus, ts: number) {
    this.deks = this.deks.map((d) =>
      d.id === id ? { ...d, status: s, rotatedAt: s === 'previous' ? ts : d.rotatedAt, revokedAt: s === 'revoked' ? ts : d.revokedAt } : d,
    );
  }
  async listBiks() {
    return [...this.biks];
  }
  async insertBik(b: BikRecord) {
    this.biks.push(b);
  }
  async updateBikStatus(id: string, s: KeyStatus, ts: number) {
    this.biks = this.biks.map((b) =>
      b.id === id ? { ...b, status: s, revokedAt: s === 'revoked' ? ts : b.revokedAt } : b,
    );
  }
  async deletePolicy() {
    this.policy = null;
  }
  async deleteAllWrappedMaterial() {
    const c = { keks: this.keks.length, deks: this.deks.length, biks: this.biks.length };
    this.keks = [];
    this.deks = [];
    this.biks = [];
    return c;
  }
}

class CapturingAudit implements AuditEmitter {
  events: EncryptionAuditEvent[] = [];
  async emit(e: EncryptionAuditEvent) {
    this.events.push(e);
  }
}

function makeManager() {
  const store = new InMemoryStore();
  const kms = new LocalKmsProvider({ masterKey: randomBytes(32) });
  const audit = new CapturingAudit();
  const km = weaveTenantKeyManager({ store, kms, audit });
  return { km, store, audit };
}

describe('blind-index spec helpers', () => {
  it('bidxColumnName defaults to <column>_bidx', () => {
    expect(bidxColumnName({ table: 'users', column: 'email' })).toBe('email_bidx');
    expect(bidxColumnName({ table: 'users', column: 'email', bidxColumn: 'email_idx' })).toBe('email_idx');
  });

  it('mergeBlindIndexSpecs deduplicates by table.column with later wins', () => {
    const a: BlindIndexSpec[] = [{ table: 'users', column: 'email' }];
    const b: BlindIndexSpec[] = [{ table: 'users', column: 'email', bidxColumn: 'override' }];
    const merged = mergeBlindIndexSpecs(a, b);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.bidxColumn).toBe('override');
  });

  it('findBlindIndexSpec returns undefined for unknown', () => {
    expect(findBlindIndexSpec(DEFAULT_BLIND_INDEX_SPECS, 'users', 'email')).toBeDefined();
    expect(findBlindIndexSpec(DEFAULT_BLIND_INDEX_SPECS, 'users', 'name')).toBeUndefined();
  });

  it('default specs include users.email', () => {
    const s = findBlindIndexSpec(DEFAULT_BLIND_INDEX_SPECS, 'users', 'email');
    expect(s).toBeDefined();
  });
});

describe('TenantKeyManager.computeBlindIndex', () => {
  it('returns 24 hex chars and is deterministic for same value', async () => {
    const { km, store } = makeManager();
    await km.bootstrapTenant({ tenantId: 't1' });
    await store.upsertPolicy({ ...store.policy!, blindIndexEnabled: true });
    const a = await km.computeBlindIndex({ tenantId: 't1', table: 'users', column: 'email', value: 'a@b.co' });
    const b = await km.computeBlindIndex({ tenantId: 't1', table: 'users', column: 'email', value: 'a@b.co' });
    expect(a).toMatch(/^[0-9a-f]{24}$/);
    expect(a).toBe(b);
  });

  it('different tenants produce different macs for same value', async () => {
    const { km, store } = makeManager();
    await km.bootstrapTenant({ tenantId: 't1' });
    await store.upsertPolicy({ ...store.policy!, blindIndexEnabled: true });
    const m1 = await km.computeBlindIndex({ tenantId: 't1', table: 'users', column: 'email', value: 'a@b.co' });
    // fresh tenant on a fresh store/manager — different BIK
    const setup2 = makeManager();
    await setup2.km.bootstrapTenant({ tenantId: 't2' });
    await setup2.store.upsertPolicy({ ...setup2.store.policy!, blindIndexEnabled: true });
    const m2 = await setup2.km.computeBlindIndex({ tenantId: 't2', table: 'users', column: 'email', value: 'a@b.co' });
    expect(m1).not.toBe(m2);
  });

  it('different (table, column) produce different macs (domain separation)', async () => {
    const { km, store } = makeManager();
    await km.bootstrapTenant({ tenantId: 't1' });
    await store.upsertPolicy({ ...store.policy!, blindIndexEnabled: true });
    const a = await km.computeBlindIndex({ tenantId: 't1', table: 'users', column: 'email', value: 'x@y.co' });
    const b = await km.computeBlindIndex({ tenantId: 't1', table: 'orders', column: 'email', value: 'x@y.co' });
    expect(a).not.toBe(b);
  });

  it('throws when blind-index is disabled in policy', async () => {
    const { km } = makeManager();
    await km.bootstrapTenant({ tenantId: 't1' }); // default blindIndexEnabled=false
    await expect(
      km.computeBlindIndex({ tenantId: 't1', table: 'users', column: 'email', value: 'x@y.co' }),
    ).rejects.toThrow(/blind-index disabled/);
  });

  it('rotateBik mints a new BIK and changes the mac', async () => {
    const { km, store } = makeManager();
    await km.bootstrapTenant({ tenantId: 't1' });
    await store.upsertPolicy({ ...store.policy!, blindIndexEnabled: true });
    const before = await km.computeBlindIndex({ tenantId: 't1', table: 'users', column: 'email', value: 'a@b.co' });
    const newBik = await km.rotateBik('t1', 'admin');
    expect(newBik.epoch).toBe(2);
    expect(store.biks.find((b) => b.status === 'active')?.id).toBe(newBik.id);
    expect(store.biks.find((b) => b.status === 'previous')).toBeDefined();
    const after = await km.computeBlindIndex({ tenantId: 't1', table: 'users', column: 'email', value: 'a@b.co' });
    expect(after).not.toBe(before);
  });
});

describe('blind-index adapter helpers', () => {
  it('maybeBlindIndex skips when manager null', async () => {
    const state: BlindIndexState = { manager: null, tenantId: 't1', enabled: true, specs: DEFAULT_BLIND_INDEX_SPECS };
    expect(await maybeBlindIndex(state, 'users', 'email', 'x@y.co')).toBeNull();
  });

  it('maybeBlindIndex skips when disabled', async () => {
    const { km, store } = makeManager();
    await km.bootstrapTenant({ tenantId: 't1' });
    await store.upsertPolicy({ ...store.policy!, blindIndexEnabled: true });
    const state: BlindIndexState = { manager: km, tenantId: 't1', enabled: false, specs: DEFAULT_BLIND_INDEX_SPECS };
    expect(await maybeBlindIndex(state, 'users', 'email', 'x@y.co')).toBeNull();
  });

  it('maybeBlindIndex skips columns not in specs', async () => {
    const { km, store } = makeManager();
    await km.bootstrapTenant({ tenantId: 't1' });
    await store.upsertPolicy({ ...store.policy!, blindIndexEnabled: true });
    const state: BlindIndexState = { manager: km, tenantId: 't1', enabled: true, specs: DEFAULT_BLIND_INDEX_SPECS };
    expect(await maybeBlindIndex(state, 'users', 'name', 'Bob')).toBeNull();
  });

  it('maybeBlindIndex computes for known specs', async () => {
    const { km, store } = makeManager();
    await km.bootstrapTenant({ tenantId: 't1' });
    await store.upsertPolicy({ ...store.policy!, blindIndexEnabled: true });
    const state: BlindIndexState = { manager: km, tenantId: 't1', enabled: true, specs: DEFAULT_BLIND_INDEX_SPECS };
    const m = await maybeBlindIndex(state, 'users', 'email', 'x@y.co');
    expect(m).toMatch(/^[0-9a-f]{24}$/);
  });

  it('computeRowBlindIndices returns empty when disabled', async () => {
    const { km, store } = makeManager();
    await km.bootstrapTenant({ tenantId: 't1' });
    await store.upsertPolicy({ ...store.policy!, blindIndexEnabled: true });
    const state: BlindIndexState = { manager: km, tenantId: 't1', enabled: false, specs: DEFAULT_BLIND_INDEX_SPECS };
    const out = await computeRowBlindIndices(state, 'users', { email: 'x@y.co' });
    expect(out).toEqual({});
  });

  it('computeRowBlindIndices computes only spec-matched columns present in row', async () => {
    const { km, store } = makeManager();
    await km.bootstrapTenant({ tenantId: 't1' });
    await store.upsertPolicy({ ...store.policy!, blindIndexEnabled: true });
    const specs = mergeBlindIndexSpecs(DEFAULT_BLIND_INDEX_SPECS, [{ table: 'users', column: 'phone' }]);
    const state: BlindIndexState = { manager: km, tenantId: 't1', enabled: true, specs };
    const out = await computeRowBlindIndices(state, 'users', { email: 'x@y.co', name: 'Bob' });
    expect(Object.keys(out)).toEqual(['email_bidx']);
    expect(out['email_bidx']).toMatch(/^[0-9a-f]{24}$/);
  });
});
