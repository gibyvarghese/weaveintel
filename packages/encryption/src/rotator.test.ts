import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { weaveTenantKeyManager } from './key-manager.js';
import { LocalKmsProvider } from './providers/local.js';
import { weaveDekRotator, weaveKekRotator } from './rotator.js';
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
  async getPolicy() { return this.policy; }
  async upsertPolicy(p: TenantPolicyRecord) { this.policy = p; }
  async listKeks() { return [...this.keks]; }
  async insertKek(k: KekRecord) { this.keks.push(k); }
  async updateKekStatus(id: string, s: KeyStatus, ts: number) {
    this.keks = this.keks.map((k) => k.id === id ? { ...k, status: s, rotatedAt: s === 'previous' ? ts : k.rotatedAt, revokedAt: s === 'revoked' ? ts : k.revokedAt } : k);
  }

  async getKekById(_t: string, id: string) { return this.keks.find((k) => k.id === id) ?? null; }
  async listDeks() { return [...this.deks]; }
  async insertDek(d: DekRecord) { this.deks.push(d); }
  async updateDekStatus(id: string, s: KeyStatus, ts: number) {
    this.deks = this.deks.map((d) => d.id === id ? { ...d, status: s, rotatedAt: s === 'previous' ? ts : d.rotatedAt, revokedAt: s === 'revoked' ? ts : d.revokedAt } : d);
  }

  async getDekById(_t: string, id: string) { return this.deks.find((d) => d.id === id) ?? null; }
  async getMaxDekEpoch(_t: string) {
    const active = this.deks.filter((d) => d.status === 'active');
    return active.length ? Math.max(...active.map((d) => d.epoch)) : null;
  }
  async listBiks() { return [...this.biks]; }
  async insertBik(b: BikRecord) { this.biks.push(b); }
  async updateBikStatus(id: string, s: KeyStatus, ts: number) {
    this.biks = this.biks.map((b) => b.id === id ? { ...b, status: s, revokedAt: s === 'revoked' ? ts : b.revokedAt } : b);
  }
  async deletePolicy() { this.policy = null; }
  async deleteAllWrappedMaterial() {
    const counts = { keks: this.keks.length, deks: this.deks.length, biks: this.biks.length };
    this.keks = []; this.deks = []; this.biks = [];
    return counts;
  }
}

class CapturingAudit implements AuditEmitter {
  events: EncryptionAuditEvent[] = [];
  async emit(e: EncryptionAuditEvent) { this.events.push(e); }
}

function makeManager() {
  const store = new InMemoryStore();
  const kms = new LocalKmsProvider({ masterKey: randomBytes(32) });
  const audit = new CapturingAudit();
  const km = weaveTenantKeyManager({ store, kms, audit });
  return { km, store, audit };
}

describe('weaveDekRotator', () => {
  it('rotates DEK and reports new epoch', async () => {
    const { km, audit } = makeManager();
    await km.bootstrapTenant({ tenantId: 't1' });
    const rotator = weaveDekRotator({ manager: km });
    const r = await rotator.rotate('t1', 'admin@x');
    expect(r.tenantId).toBe('t1');
    expect(r.epoch).toBe(2); // first DEK is epoch 1
    expect(audit.events.some((e) => e.eventKind === 'dek_rotate')).toBe(true);
  });

  it('still allows decrypting old ciphertext after rotation', async () => {
    const { km } = makeManager();
    await km.bootstrapTenant({ tenantId: 't1' });
    const ct = await km.encrypt({
      tenantId: 't1', table: 'messages', column: 'content', rowId: 'r1', plaintext: 'before-rotate',
    });
    expect(ct).toMatch(/^enc:v1:1:/);
    await weaveDekRotator({ manager: km }).rotate('t1');
    const pt = await km.decrypt({
      tenantId: 't1', table: 'messages', column: 'content', rowId: 'r1', value: ct,
    });
    expect(pt).toBe('before-rotate');
    const ct2 = await km.encrypt({
      tenantId: 't1', table: 'messages', column: 'content', rowId: 'r2', plaintext: 'after-rotate',
    });
    expect(ct2).toMatch(/^enc:v1:2:/);
  });
});

describe('weaveKekRotator', () => {
  it('rotates KEK and re-wraps active DEK', async () => {
    const { km, store, audit } = makeManager();
    await km.bootstrapTenant({ tenantId: 't1' });
    const initialKek = store.keks[0]!;
    const r = await weaveKekRotator({ manager: km }).rotate('t1', 'admin@x');
    expect(r.tenantId).toBe('t1');
    expect(r.kekId).not.toBe(initialKek.id);
    expect(audit.events.some((e) => e.eventKind === 'kek_rotate')).toBe(true);
    // active DEK still decrypts after KEK rotation
    const ct = await km.encrypt({ tenantId: 't1', table: 'm', column: 'c', rowId: 'r', plaintext: 'x' });
    const pt = await km.decrypt({ tenantId: 't1', table: 'm', column: 'c', rowId: 'r', value: ct });
    expect(pt).toBe('x');
  });
});
