import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { weaveTenantKeyManager } from './key-manager.js';
import { LocalKmsProvider } from './providers/local.js';
import { DEFAULT_FIELD_POLICY } from './field-policy.js';
import { isEncrypted } from './envelope.js';
import { maybeEncryptField, maybeDecryptField, type TenantEncryptionState } from './adapter-helpers.js';
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
    this.keks = this.keks.map((k) =>
      k.id === id ? { ...k, status: s, rotatedAt: s === 'previous' ? ts : k.rotatedAt, revokedAt: s === 'revoked' ? ts : k.revokedAt } : k);
  }
  async listDeks() { return [...this.deks]; }
  async insertDek(d: DekRecord) { this.deks.push(d); }
  async updateDekStatus(id: string, s: KeyStatus, ts: number) {
    this.deks = this.deks.map((d) =>
      d.id === id ? { ...d, status: s, rotatedAt: s === 'previous' ? ts : d.rotatedAt, revokedAt: s === 'revoked' ? ts : d.revokedAt } : d);
  }
  async listBiks() { return [...this.biks]; }
  async insertBik(b: BikRecord) { this.biks.push(b); }
  async updateBikStatus(id: string, s: KeyStatus, ts: number) {
    this.biks = this.biks.map((b) =>
      b.id === id ? { ...b, status: s, revokedAt: s === 'revoked' ? ts : b.revokedAt } : b);
  }
  async deletePolicy() { this.policy = null; }
  async deleteAllWrappedMaterial() {
    const counts = { keks: this.keks.length, deks: this.deks.length, biks: this.biks.length };
    this.keks = []; this.deks = []; this.biks = [];
    return counts;
  }
}

async function makeReadyManager() {
  const store = new InMemoryStore();
  const kms = new LocalKmsProvider({ masterKey: randomBytes(32) });
  const km = weaveTenantKeyManager({ store, kms });
  await km.bootstrapTenant({ tenantId: 'tenant-a', enable: true });
  return km;
}

const ctx = { table: 'messages', column: 'content', rowId: 'msg-1' };

describe('maybeEncryptField', () => {
  it('passes through when manager is null', async () => {
    const state: TenantEncryptionState = {
      manager: null,
      tenantId: 'tenant-a',
      enabled: true,
      policy: DEFAULT_FIELD_POLICY,
    };
    expect(await maybeEncryptField(state, ctx, 'hello')).toBe('hello');
  });

  it('passes through null/undefined', async () => {
    const km = await makeReadyManager();
    const state: TenantEncryptionState = {
      manager: km, tenantId: 'tenant-a', enabled: true, policy: DEFAULT_FIELD_POLICY,
    };
    expect(await maybeEncryptField(state, ctx, null)).toBeNull();
    expect(await maybeEncryptField(state, ctx, undefined)).toBeUndefined();
  });

  it('passes through when tenantId is null', async () => {
    const km = await makeReadyManager();
    const state: TenantEncryptionState = {
      manager: km, tenantId: null, enabled: true, policy: DEFAULT_FIELD_POLICY,
    };
    expect(await maybeEncryptField(state, ctx, 'hello')).toBe('hello');
  });

  it('passes through when policy disabled', async () => {
    const km = await makeReadyManager();
    const state: TenantEncryptionState = {
      manager: km, tenantId: 'tenant-a', enabled: false, policy: DEFAULT_FIELD_POLICY,
    };
    expect(await maybeEncryptField(state, ctx, 'hello')).toBe('hello');
  });

  it('passes through when (table, column) not in policy', async () => {
    const km = await makeReadyManager();
    const state: TenantEncryptionState = {
      manager: km, tenantId: 'tenant-a', enabled: true, policy: DEFAULT_FIELD_POLICY,
    };
    const out = await maybeEncryptField(state, { table: 'messages', column: 'role', rowId: 'm1' }, 'user');
    expect(out).toBe('user');
  });

  it('encrypts when policy enabled and column present', async () => {
    const km = await makeReadyManager();
    const state: TenantEncryptionState = {
      manager: km, tenantId: 'tenant-a', enabled: true, policy: DEFAULT_FIELD_POLICY,
    };
    const out = await maybeEncryptField(state, ctx, 'hello world');
    expect(typeof out).toBe('string');
    expect(isEncrypted(out as string)).toBe(true);
  });

  it('is idempotent on already-sentinel values', async () => {
    const km = await makeReadyManager();
    const state: TenantEncryptionState = {
      manager: km, tenantId: 'tenant-a', enabled: true, policy: DEFAULT_FIELD_POLICY,
    };
    const first = await maybeEncryptField(state, ctx, 'hello world');
    const second = await maybeEncryptField(state, ctx, first as string);
    expect(second).toBe(first); // unchanged, not re-encrypted
  });
});

describe('maybeDecryptField', () => {
  it('passes through when manager is null', async () => {
    const state: TenantEncryptionState = {
      manager: null, tenantId: 'tenant-a', enabled: true, policy: DEFAULT_FIELD_POLICY,
    };
    expect(await maybeDecryptField(state, ctx, 'enc:v1:1:aa:bb')).toBe('enc:v1:1:aa:bb');
  });

  it('passes through plaintext (lazy-upgrade)', async () => {
    const km = await makeReadyManager();
    const state: TenantEncryptionState = {
      manager: km, tenantId: 'tenant-a', enabled: true, policy: DEFAULT_FIELD_POLICY,
    };
    expect(await maybeDecryptField(state, ctx, 'legacy plaintext')).toBe('legacy plaintext');
  });

  it('passes through null/undefined', async () => {
    const km = await makeReadyManager();
    const state: TenantEncryptionState = {
      manager: km, tenantId: 'tenant-a', enabled: true, policy: DEFAULT_FIELD_POLICY,
    };
    expect(await maybeDecryptField(state, ctx, null)).toBeNull();
    expect(await maybeDecryptField(state, ctx, undefined)).toBeUndefined();
  });

  it('decrypts a sentinel produced by maybeEncryptField', async () => {
    const km = await makeReadyManager();
    const state: TenantEncryptionState = {
      manager: km, tenantId: 'tenant-a', enabled: true, policy: DEFAULT_FIELD_POLICY,
    };
    const enc = await maybeEncryptField(state, ctx, 'secret payload');
    expect(isEncrypted(enc as string)).toBe(true);
    const dec = await maybeDecryptField(state, ctx, enc as string);
    expect(dec).toBe('secret payload');
  });

  it('decrypts even when policy.enabled was flipped off after write', async () => {
    const km = await makeReadyManager();
    const writeState: TenantEncryptionState = {
      manager: km, tenantId: 'tenant-a', enabled: true, policy: DEFAULT_FIELD_POLICY,
    };
    const enc = await maybeEncryptField(writeState, ctx, 'kept readable');
    const readState: TenantEncryptionState = {
      manager: km, tenantId: 'tenant-a', enabled: false, policy: DEFAULT_FIELD_POLICY,
    };
    expect(await maybeDecryptField(readState, ctx, enc as string)).toBe('kept readable');
  });
});
