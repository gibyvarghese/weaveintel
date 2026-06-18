import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { weaveTenantKeyManager } from './key-manager.js';
import { LocalKmsProvider } from './providers/local.js';
import { weaveDekRotator } from './rotator.js';
import { InMemoryRewriteJobStore } from './rewrite-store.js';
import { weaveRewriteScheduler, type RewritableTableSpec, type SentinelRow } from './rewrite-scheduler.js';
import { parseSentinel } from './envelope.js';
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

/** In-memory single-(table,column) spec backed by a Map. */
class FakeSpec implements RewritableTableSpec {
  readonly tableName: string;
  readonly columnName: string;
  rows = new Map<string, string>();

  constructor(tableName: string, columnName: string) {
    this.tableName = tableName;
    this.columnName = columnName;
  }

  async listSentinelRows(opts: { tenantId: string; afterRowId: string | null; limit: number }): Promise<ReadonlyArray<SentinelRow>> {
    // Deterministic order by rowId.
    const all = Array.from(this.rows.entries())
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([rowId, ciphertext]) => ({ rowId, ciphertext }));
    const start = opts.afterRowId === null ? 0 : all.findIndex((r) => r.rowId === opts.afterRowId) + 1;
    return all.slice(start, start + opts.limit);
  }

  async updateRow(opts: { tenantId: string; rowId: string; ciphertext: string }): Promise<void> {
    this.rows.set(opts.rowId, opts.ciphertext);
  }
}

describe('weaveRewriteScheduler', () => {
  it('rewrites all rows from old epoch to new epoch across multiple ticks', async () => {
    const { km, audit } = makeManager();
    await km.bootstrapTenant({ tenantId: 't1' });

    const spec = new FakeSpec('messages', 'content');
    // Encrypt 250 rows at epoch 1.
    const ROW_COUNT = 250;
    for (let i = 0; i < ROW_COUNT; i++) {
      const rowId = `r${String(i).padStart(4, '0')}`;
      const ct = await km.encrypt({
        tenantId: 't1', table: 'messages', column: 'content', rowId, plaintext: `payload-${i}`,
      });
      spec.rows.set(rowId, ct);
      expect(ct).toMatch(/^enc:v1:1:/);
    }

    // Rotate DEK to epoch 2.
    await weaveDekRotator({ manager: km }).rotate('t1');

    const jobStore = new InMemoryRewriteJobStore();
    const now = Date.now();
    await jobStore.upsert({
      id: 'job-1', tenantId: 't1', tableName: 'messages', columnName: 'content',
      fromEpoch: 1, toEpoch: 2, lastRowId: null, rowsRewritten: 0, status: 'pending',
      createdAt: now, updatedAt: now, completedAt: null,
    });

    const scheduler = weaveRewriteScheduler({
      manager: km, store: jobStore, specs: [spec], audit,
      batchSize: 100, throttleMs: 0, maxJobsPerTick: 4,
    });

    // Loop ticks until job is complete (3 ticks at batchSize=100 for 250 rows).
    let totalRewritten = 0;
    for (let i = 0; i < 10; i++) {
      const res = await scheduler.tickOnce();
      totalRewritten += res.rowsRewritten;
      const job = await jobStore.get('job-1');
      if (job?.status === 'complete') break;
    }

    const job = await jobStore.get('job-1');
    expect(job?.status).toBe('complete');
    expect(job?.rowsRewritten).toBe(ROW_COUNT);
    expect(totalRewritten).toBe(ROW_COUNT);

    // Every row should now be at epoch 2 and still decrypt.
    for (const [rowId, ct] of spec.rows.entries()) {
      expect(parseSentinel(ct).epoch).toBe(2);
      const pt = await km.decrypt({ tenantId: 't1', table: 'messages', column: 'content', rowId, value: ct });
      const idx = parseInt(rowId.slice(1), 10);
      expect(pt).toBe(`payload-${idx}`);
    }

    // Audit emitted on completion.
    expect(audit.events.some((e) => e.eventKind === 'rewrite_progress')).toBe(true);
  });

  it('marks job failed when no spec is registered for the (table, column)', async () => {
    const { km } = makeManager();
    await km.bootstrapTenant({ tenantId: 't1' });
    const jobStore = new InMemoryRewriteJobStore();
    const now = Date.now();
    await jobStore.upsert({
      id: 'job-orphan', tenantId: 't1', tableName: 'unknown_table', columnName: 'col',
      fromEpoch: 1, toEpoch: 2, lastRowId: null, rowsRewritten: 0, status: 'pending',
      createdAt: now, updatedAt: now, completedAt: null,
    });

    const scheduler = weaveRewriteScheduler({
      manager: km, store: jobStore, specs: [], throttleMs: 0,
    });
    const res = await scheduler.tickOnce();
    expect(res.jobsFailed).toBe(1);
    const job = await jobStore.get('job-orphan');
    expect(job?.status).toBe('failed');
    expect(job?.errorMessage).toMatch(/unknown_table\.col/);
  });

  it('processes empty job list as no-op', async () => {
    const { km } = makeManager();
    await km.bootstrapTenant({ tenantId: 't1' });
    const jobStore = new InMemoryRewriteJobStore();
    const scheduler = weaveRewriteScheduler({
      manager: km, store: jobStore, specs: [], throttleMs: 0,
    });
    const res = await scheduler.tickOnce();
    expect(res.jobsProcessed).toBe(0);
    expect(res.rowsRewritten).toBe(0);
  });

  it('skips rows already at target epoch', async () => {
    const { km } = makeManager();
    await km.bootstrapTenant({ tenantId: 't1' });
    const spec = new FakeSpec('messages', 'content');
    // Write one row at epoch 1, then rotate, then write one row at epoch 2.
    const ct1 = await km.encrypt({
      tenantId: 't1', table: 'messages', column: 'content', rowId: 'r-old', plaintext: 'old',
    });
    spec.rows.set('r-old', ct1);
    await weaveDekRotator({ manager: km }).rotate('t1');
    const ct2 = await km.encrypt({
      tenantId: 't1', table: 'messages', column: 'content', rowId: 'r-new', plaintext: 'new',
    });
    spec.rows.set('r-new', ct2);
    expect(parseSentinel(ct2).epoch).toBe(2);

    const jobStore = new InMemoryRewriteJobStore();
    const now = Date.now();
    await jobStore.upsert({
      id: 'job-mixed', tenantId: 't1', tableName: 'messages', columnName: 'content',
      fromEpoch: 1, toEpoch: 2, lastRowId: null, rowsRewritten: 0, status: 'pending',
      createdAt: now, updatedAt: now, completedAt: null,
    });

    const scheduler = weaveRewriteScheduler({
      manager: km, store: jobStore, specs: [spec], throttleMs: 0,
    });
    const res = await scheduler.tickOnce();
    expect(res.rowsRewritten).toBe(1); // only r-old was rewritten
    const job = await jobStore.get('job-mixed');
    expect(job?.status).toBe('complete');
    // Both rows are now at epoch 2.
    expect(parseSentinel(spec.rows.get('r-old')!).epoch).toBe(2);
    expect(parseSentinel(spec.rows.get('r-new')!).epoch).toBe(2);
  });
});
