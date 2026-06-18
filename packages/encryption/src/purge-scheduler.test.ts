import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { weaveTenantKeyManager, type TenantKeyManager } from './key-manager.js';
import { LocalKmsProvider } from './providers/local.js';
import { weavePurgeScheduler, type DueTenantPurge } from './purge-scheduler.js';
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
  policies = new Map<string, TenantPolicyRecord>();
  keks: KekRecord[] = [];
  deks: DekRecord[] = [];
  biks: BikRecord[] = [];

  async getPolicy(t: string) {
    return this.policies.get(t) ?? null;
  }
  async upsertPolicy(p: TenantPolicyRecord) {
    this.policies.set(p.tenantId, p);
  }
  async listKeks(t: string) {
    return this.keks.filter((k) => k.tenantId === t);
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
  async listDeks(t: string) {
    return this.deks.filter((d) => d.tenantId === t);
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
  async listBiks(t: string) {
    return this.biks.filter((b) => b.tenantId === t);
  }
  async insertBik(b: BikRecord) {
    this.biks.push(b);
  }
  async updateBikStatus(id: string, s: KeyStatus, ts: number) {
    this.biks = this.biks.map((b) =>
      b.id === id ? { ...b, status: s, revokedAt: s === 'revoked' ? ts : b.revokedAt } : b,
    );
  }
  async deletePolicy(t: string) {
    this.policies.delete(t);
  }
  async deleteAllWrappedMaterial(t: string) {
    const counts = {
      keks: this.keks.filter((k) => k.tenantId === t).length,
      deks: this.deks.filter((d) => d.tenantId === t).length,
      biks: this.biks.filter((b) => b.tenantId === t).length,
    };
    this.keks = this.keks.filter((k) => k.tenantId !== t);
    this.deks = this.deks.filter((d) => d.tenantId !== t);
    this.biks = this.biks.filter((b) => b.tenantId !== t);
    return counts;
  }
}

class CapturingAudit implements AuditEmitter {
  events: EncryptionAuditEvent[] = [];
  async emit(e: EncryptionAuditEvent) {
    this.events.push(e);
  }
}

function makeManager(): { km: TenantKeyManager; store: InMemoryStore; audit: CapturingAudit } {
  const store = new InMemoryStore();
  const kms = new LocalKmsProvider({ masterKey: randomBytes(32) });
  const audit = new CapturingAudit();
  const km = weaveTenantKeyManager({ store, kms, audit });
  return { km, store, audit };
}

describe('weavePurgeScheduler.tickNow', () => {
  it('returns skipped marker when manager is unavailable', async () => {
    const sched = weavePurgeScheduler({
      getManager: () => null,
      listDuePurges: async () => [],
      markPurged: async () => {},
    });
    const r = await sched.tickNow();
    expect(r.skipped).toBe('manager_unavailable');
    expect(r.checked).toBe(0);
    sched.stop();
  });

  it('purges all due tenants and calls markPurged exactly once each', async () => {
    const { km, store } = makeManager();
    await km.bootstrapTenant({ tenantId: 'a' });
    await km.bootstrapTenant({ tenantId: 'b' });
    const due: DueTenantPurge[] = [
      { id: 'req-a', tenantId: 'a', requestedAt: 0, retentionUntil: 1 },
      { id: 'req-b', tenantId: 'b', requestedAt: 0, retentionUntil: 1 },
    ];
    const marked: string[] = [];
    const sched = weavePurgeScheduler({
      getManager: () => km,
      listDuePurges: async () => due,
      markPurged: async (id) => {
        marked.push(id);
      },
    });
    const r = await sched.tickNow();
    expect(r).toEqual({ checked: 2, purged: 2, errors: 0 });
    expect(marked.sort()).toEqual(['req-a', 'req-b']);
    expect(store.keks.length).toBe(0);
    expect(store.deks.length).toBe(0);
    sched.stop();
  });

  it('isolates per-tenant errors (one failure does not block others)', async () => {
    const { km } = makeManager();
    await km.bootstrapTenant({ tenantId: 'good' });
    // 'missing' has no policy → hardShred → shred → no policy update path is fine,
    // but deleteAllWrappedMaterial returns zeros. To force an error we make markPurged throw for one id.
    const due: DueTenantPurge[] = [
      { id: 'req-good', tenantId: 'good', requestedAt: 0, retentionUntil: 1 },
      { id: 'req-bad', tenantId: 'good', requestedAt: 0, retentionUntil: 1 },
    ];
    let calls = 0;
    const sched = weavePurgeScheduler({
      getManager: () => km,
      listDuePurges: async () => due,
      markPurged: async () => {
        calls += 1;
        if (calls === 2) throw new Error('boom');
      },
    });
    const r = await sched.tickNow();
    expect(r.checked).toBe(2);
    expect(r.purged).toBe(1);
    expect(r.errors).toBe(1);
    sched.stop();
  });

  it('emits exactly one tenant_purged audit per tenant (no double-emit)', async () => {
    const { km, audit } = makeManager();
    await km.bootstrapTenant({ tenantId: 't1' });
    const sched = weavePurgeScheduler({
      getManager: () => km,
      listDuePurges: async () => [
        { id: 'req-1', tenantId: 't1', requestedAt: 0, retentionUntil: 1 },
      ],
      markPurged: async () => {},
    });
    await sched.tickNow();
    const purgedEvents = audit.events.filter((e) => e.eventKind === 'tenant_purged');
    expect(purgedEvents.length).toBe(1);
    sched.stop();
  });

  it('returns checked=0 when no due requests', async () => {
    const { km } = makeManager();
    await km.bootstrapTenant({ tenantId: 't1' });
    const sched = weavePurgeScheduler({
      getManager: () => km,
      listDuePurges: async () => [],
      markPurged: async () => {},
    });
    const r = await sched.tickNow();
    expect(r).toEqual({ checked: 0, purged: 0, errors: 0 });
    sched.stop();
  });
});
