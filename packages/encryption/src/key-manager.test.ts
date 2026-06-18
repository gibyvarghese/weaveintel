import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { weaveTenantKeyManager } from './key-manager.js';
import { LocalKmsProvider } from './providers/local.js';
import type {
  AuditEmitter,
  EncryptionAuditEvent,
} from './audit.js';
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

  async getPolicy(_t: string) {
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

  async getKekById(_t: string, id: string) { return this.keks.find((k) => k.id === id) ?? null; }
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

  async getDekById(_t: string, id: string) { return this.deks.find((d) => d.id === id) ?? null; }
  async getMaxDekEpoch(_t: string) {
    const active = this.deks.filter((d) => d.status === 'active');
    return active.length ? Math.max(...active.map((d) => d.epoch)) : null;
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
    const counts = { keks: this.keks.length, deks: this.deks.length, biks: this.biks.length };
    this.keks = [];
    this.deks = [];
    this.biks = [];
    return counts;
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

describe('TenantKeyManager.bootstrapTenant', () => {
  it('creates KEK + DEK + BIK and emits 4 audits', async () => {
    const { km, store, audit } = makeManager();
    const policy = await km.bootstrapTenant({ tenantId: 't1' });
    expect(policy.activeKekId).toBeDefined();
    expect(policy.activeDekId).toBeDefined();
    expect(policy.activeBikId).toBeDefined();
    expect(policy.enabled).toBe(true);
    expect(store.keks.length).toBe(1);
    expect(store.deks.length).toBe(1);
    expect(store.biks.length).toBe(1);
    const kinds = audit.events.map((e) => e.eventKind).sort();
    expect(kinds).toEqual(['bik_create', 'dek_create', 'kek_create', 'tenant_bootstrap']);
  });

  it('is idempotent', async () => {
    const { km, store } = makeManager();
    const a = await km.bootstrapTenant({ tenantId: 't1' });
    const b = await km.bootstrapTenant({ tenantId: 't1' });
    expect(a.activeKekId).toBe(b.activeKekId);
    expect(store.keks.length).toBe(1);
  });
});

describe('TenantKeyManager encrypt/decrypt', () => {
  it('round-trips through the active DEK', async () => {
    const { km } = makeManager();
    await km.bootstrapTenant({ tenantId: 't1' });
    const ct = await km.encrypt({
      tenantId: 't1',
      table: 'messages',
      column: 'content',
      rowId: 'r1',
      plaintext: 'hello',
    });
    expect(ct.startsWith('enc:v1:')).toBe(true);
    const pt = await km.decrypt({
      tenantId: 't1',
      table: 'messages',
      column: 'content',
      rowId: 'r1',
      value: ct,
    });
    expect(pt).toBe('hello');
  });

  it('passes plaintext through decrypt unchanged', async () => {
    const { km } = makeManager();
    await km.bootstrapTenant({ tenantId: 't1' });
    const out = await km.decrypt({
      tenantId: 't1',
      table: 'messages',
      column: 'content',
      rowId: 'r1',
      value: 'plain text',
    });
    expect(out).toBe('plain text');
  });
});

describe('TenantKeyManager.rotateDek', () => {
  it('mints epoch+1 and old ciphertext stays decryptable', async () => {
    const { km, store } = makeManager();
    await km.bootstrapTenant({ tenantId: 't1' });
    const ct1 = await km.encrypt({
      tenantId: 't1', table: 'messages', column: 'content', rowId: 'r1', plaintext: 'old',
    });
    const newDek = await km.rotateDek('t1');
    expect(newDek.epoch).toBe(2);
    expect(store.deks.length).toBe(2);
    const previous = store.deks.find((d) => d.epoch === 1);
    expect(previous?.status).toBe('previous');

    // Old ciphertext (epoch=1) still decrypts.
    const out = await km.decrypt({
      tenantId: 't1', table: 'messages', column: 'content', rowId: 'r1', value: ct1,
    });
    expect(out).toBe('old');

    // New encrypts use epoch=2.
    const ct2 = await km.encrypt({
      tenantId: 't1', table: 'messages', column: 'content', rowId: 'r2', plaintext: 'new',
    });
    expect(ct2).toMatch(/^enc:v1:2:/);
  });
});

describe('TenantKeyManager.rotateKek', () => {
  it('mints a new KEK and re-wraps active DEK', async () => {
    const { km, store } = makeManager();
    await km.bootstrapTenant({ tenantId: 't1' });
    const ct = await km.encrypt({
      tenantId: 't1', table: 'messages', column: 'content', rowId: 'r1', plaintext: 'before-kek-rotate',
    });
    const newKek = await km.rotateKek('t1');
    expect(newKek.version).toBe(2);
    expect(store.keks.length).toBe(2);
    // Existing ciphertext still decrypts (new active DEK was re-wrapped).
    const out = await km.decrypt({
      tenantId: 't1', table: 'messages', column: 'content', rowId: 'r1', value: ct,
    });
    expect(out).toBe('before-kek-rotate');
  });
});

describe('TenantKeyManager.shred', () => {
  it('revokes all keys and disables tenant', async () => {
    const { km, store } = makeManager();
    await km.bootstrapTenant({ tenantId: 't1' });
    await km.shred('t1');
    expect(store.policy?.enabled).toBe(false);
    expect(store.policy?.activeKekId).toBeNull();
    expect(store.policy?.activeDekId).toBeNull();
    expect(store.keks.every((k) => k.status === 'revoked')).toBe(true);
    expect(store.deks.every((d) => d.status === 'revoked')).toBe(true);
  });
});

describe('TenantKeyManager.hardShred (Phase 6)', () => {
  it('revokes + physically deletes all wrapped material and emits tenant_purged', async () => {
    const { km, store, audit } = makeManager();
    await km.bootstrapTenant({ tenantId: 't1' });
    await km.encrypt({ tenantId: 't1', table: 'm', column: 'c', rowId: 'r1', plaintext: 'x' });
    const counts = await km.hardShred('t1', 'tester');
    expect(counts).toEqual({ keks: 1, deks: 1, biks: 1 });
    expect(store.keks.length).toBe(0);
    expect(store.deks.length).toBe(0);
    expect(store.biks.length).toBe(0);
    const kinds = audit.events.map((e) => e.eventKind);
    expect(kinds).toContain('shred');
    expect(kinds).toContain('tenant_purged');
  });
});

describe('TenantKeyManager.restoreFromShred (Phase 6)', () => {
  it('flips highest-version revoked KEK + highest-epoch DEK back to active', async () => {
    const { km, store, audit } = makeManager();
    await km.bootstrapTenant({ tenantId: 't1' });
    await km.shred('t1', 'tester');
    // Simulate a pending shred request marker on the policy.
    store.policy = { ...store.policy!, shredRequestedAt: 1000 };
    const out = await km.restoreFromShred('t1', 'tester');
    expect(out.kekId).toBe(store.keks[0]!.id);
    expect(out.dekId).toBe(store.deks[0]!.id);
    expect(store.keks[0]!.status).toBe('active');
    expect(store.deks[0]!.status).toBe('active');
    expect(store.policy?.enabled).toBe(true);
    expect(store.policy?.shredRequestedAt).toBeNull();
    expect(audit.events.map((e) => e.eventKind)).toContain('tenant_restored');
  });

  it('throws when no pending shred is set', async () => {
    const { km } = makeManager();
    await km.bootstrapTenant({ tenantId: 't1' });
    await expect(km.restoreFromShred('t1')).rejects.toThrow(/no pending shred/);
  });

  it('throws after hardShred (wrapped material is gone)', async () => {
    const { km, store } = makeManager();
    await km.bootstrapTenant({ tenantId: 't1' });
    await km.hardShred('t1');
    // Even if a request marker is set, restore must fail because rows are gone.
    if (store.policy) store.policy = { ...store.policy, shredRequestedAt: 1000 };
    await expect(km.restoreFromShred('t1')).rejects.toThrow(/wrapped key material is gone/);
  });
});
