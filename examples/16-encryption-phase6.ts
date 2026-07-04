/**
 * Example 16 — Tenant Encryption Phase 6 (GDPR hard-shred + tenant deletion).
 *
 * Demonstrates the reusable `weavePurgeScheduler` helper from
 * `@weaveintel/encryption` against a tiny in-memory adapter. Verifies the
 * Phase 6 invariants:
 *
 *   1. `manager.hardShred(tenantId)` cascades into
 *      `store.deleteAllWrappedMaterial(tenantId)` and zeroes out KEK/DEK/BIK
 *      counts.
 *   2. The purge scheduler is graceful: missing manager → tick is a no-op
 *      with `skipped: 'manager_unavailable'`. List-callback failure → tick
 *      records errors but never throws.
 *   3. `manager.restoreFromShred(tenantId)` flips the highest-version
 *      revoked KEK + highest-epoch revoked DEK back to 'active' AND clears
 *      the policy's shred timestamps. Restore after hardShred fails fast.
 *   4. The scheduler tags every purge with actor `system:purge-scheduler`
 *      and emits `tenant_purged` audit events.
 *
 * Run: npx tsx examples/16-encryption-phase6.ts
 */

import {
  LocalKmsProvider,
  PURGE_SCHEDULER_ACTOR,
  loadMasterKeyFromEnv,
  weavePurgeScheduler,
  weaveTenantKeyManager,
  type AuditEmitter,
  type BikRecord,
  type DekRecord,
  type DueTenantPurge,
  type EncryptionAuditEvent,
  type EncryptionStore,
  type KekRecord,
  type TenantPolicyRecord,
} from '@weaveintel/encryption';

// ─── In-memory EncryptionStore ────────────────────────────────────────
function createInMemoryStore(): EncryptionStore {
  const policies = new Map<string, TenantPolicyRecord>();
  let keks: KekRecord[] = [];
  let deks: DekRecord[] = [];
  let biks: BikRecord[] = [];
  return {
    async getPolicy(t) {
      return policies.get(t) ?? null;
    },
    async upsertPolicy(p) {
      policies.set(p.tenantId, p);
    },
    async deletePolicy(t) {
      policies.delete(t);
    },
    async listKeks(t) {
      return keks.filter((k) => k.tenantId === t);
    },
    async insertKek(k) {
      keks.push(k);
    },
    async updateKekStatus(id, status, at) {
      const r = keks.find((k) => k.id === id);
      if (!r) return;
      (r as { status: KekRecord['status'] }).status = status;
      (r as { rotatedAt: number | null }).rotatedAt = at ?? null;
    },
    async getKekById(t, kekId) {
      return keks.find((k) => k.tenantId === t && k.id === kekId) ?? null;
    },
    async listDeks(t) {
      return deks.filter((d) => d.tenantId === t);
    },
    async insertDek(d) {
      deks.push(d);
    },
    async updateDekStatus(id, status, at) {
      const r = deks.find((d) => d.id === id);
      if (!r) return;
      (r as { status: DekRecord['status'] }).status = status;
      (r as { rotatedAt: number | null }).rotatedAt = at ?? null;
    },
    async getDekById(t, dekId) {
      return deks.find((d) => d.tenantId === t && d.id === dekId) ?? null;
    },
    async getMaxDekEpoch(t) {
      const active = deks.filter((d) => d.tenantId === t && d.status === 'active');
      if (active.length === 0) return null;
      return active.reduce((max, d) => Math.max(max, d.epoch), 0);
    },
    async listBiks(t) {
      return biks.filter((b) => b.tenantId === t);
    },
    async insertBik(b) {
      biks.push(b);
    },
    async updateBikStatus(id, status, at) {
      const r = biks.find((b) => b.id === id);
      if (!r) return;
      (r as { status: BikRecord['status'] }).status = status;
      (r as { revokedAt: number | null }).revokedAt = at ?? null;
    },
    async deleteAllWrappedMaterial(tenantId) {
      const k = keks.filter((x) => x.tenantId === tenantId).length;
      const d = deks.filter((x) => x.tenantId === tenantId).length;
      const b = biks.filter((x) => x.tenantId === tenantId).length;
      keks = keks.filter((x) => x.tenantId !== tenantId);
      deks = deks.filter((x) => x.tenantId !== tenantId);
      biks = biks.filter((x) => x.tenantId !== tenantId);
      return { keks: k, deks: d, biks: b };
    },
  };
}

// ─── Tiny in-memory deletion-request store ───────────────────────────
interface DeletionRow {
  id: string;
  tenantId: string;
  requestedAt: number;
  retentionUntil: number;
  status: 'pending' | 'cancelled' | 'purged';
  purgedAt: number | null;
}
function createDeletionStore() {
  const rows: DeletionRow[] = [];
  return {
    request(tenantId: string, retentionUntil: number) {
      const id = `del-${rows.length + 1}`;
      rows.push({
        id,
        tenantId,
        requestedAt: Date.now(),
        retentionUntil,
        status: 'pending',
        purgedAt: null,
      });
      return id;
    },
    listDuePurges(now: number): DueTenantPurge[] {
      return rows
        .filter((r) => r.status === 'pending' && r.retentionUntil <= now)
        .map((r) => ({
          id: r.id,
          tenantId: r.tenantId,
          requestedAt: r.requestedAt,
          retentionUntil: r.retentionUntil,
        }));
    },
    markPurged(id: string, now: number) {
      const r = rows.find((x) => x.id === id);
      if (r) {
        r.status = 'purged';
        r.purgedAt = now;
      }
    },
    get(id: string) {
      return rows.find((r) => r.id === id) ?? null;
    },
    snapshot() {
      return rows.map((r) => ({ ...r }));
    },
  };
}

// ─── Audit collector ────────────────────────────────────────────────
function createCollectingAudit(): AuditEmitter & { events: EncryptionAuditEvent[] } {
  const events: EncryptionAuditEvent[] = [];
  return {
    events,
    async emit(e) {
      events.push(e);
    },
  };
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function main() {
  console.log('\n=== Example 16 — Tenant Encryption Phase 6 ===\n');

  const store = createInMemoryStore();
  const deletions = createDeletionStore();
  const audit = createCollectingAudit();
  const { key } = loadMasterKeyFromEnv({ devGenerateIfMissing: true });
  const kms = new LocalKmsProvider({ masterKey: key });
  const manager = weaveTenantKeyManager({ store, kms, audit });

  // ── Tenant A: full lifecycle (bootstrap → request → purge) ──
  console.log('1. Bootstrap tenant A and write a sentinel');
  await manager.bootstrapTenant({ tenantId: 'tenant-A', enable: true, actor: 'admin' });
  const ct = await manager.encrypt({
    tenantId: 'tenant-A',
    table: 'messages',
    column: 'content',
    rowId: 'row-1',
    plaintext: 'hello phase 6',
  });
  assert(ct.startsWith('enc:v1:'), 'wrote a sentinel');

  console.log('\n2. Submit a deletion request that has already expired');
  const reqId = deletions.request('tenant-A', Date.now() - 1_000);
  assert(deletions.get(reqId)?.status === 'pending', 'request status=pending');

  console.log('\n3. Spin up purge scheduler with a long interval and tick once');
  const scheduler = weavePurgeScheduler({
    getManager: () => manager,
    listDuePurges: async (now) => deletions.listDuePurges(now),
    markPurged: async (id, now) => deletions.markPurged(id, now),
    intervalMs: 999_999_999,
    log: () => {},
  });
  try {
    const result = await scheduler.tickNow();
    assert(result.checked === 1, `tick checked=1 (got ${result.checked})`);
    assert(result.purged === 1, `tick purged=1 (got ${result.purged})`);
    assert(result.errors === 0, `tick errors=0 (got ${result.errors})`);
  } finally {
    scheduler.stop();
  }
  assert(deletions.get(reqId)?.status === 'purged', 'request status=purged');

  console.log('\n4. Verify wrapped key material wiped');
  const keksA = await store.listKeks('tenant-A');
  const deksA = await store.listDeks('tenant-A');
  const biksA = await store.listBiks('tenant-A');
  assert(keksA.length === 0, `tenant_keks wiped (got ${keksA.length})`);
  assert(deksA.length === 0, `tenant_deks wiped (got ${deksA.length})`);
  assert(biksA.length === 0, `tenant_biks wiped (got ${biksA.length})`);

  console.log('\n5. Audit trail recorded tenant_purged from system:purge-scheduler');
  const purgedEvents = audit.events.filter(
    (e) => e.eventKind === 'tenant_purged' && e.actor === PURGE_SCHEDULER_ACTOR,
  );
  assert(purgedEvents.length === 1, `>=1 tenant_purged event from scheduler (got ${purgedEvents.length})`);

  // ── Tenant B: graceful degradation paths ──
  console.log('\n6. Manager-unavailable tick is a graceful no-op');
  const sched2 = weavePurgeScheduler({
    getManager: () => null,
    listDuePurges: async () => [],
    markPurged: async () => {},
    intervalMs: 999_999_999,
  });
  try {
    const skipped = await sched2.tickNow();
    assert(skipped.skipped === 'manager_unavailable', 'skipped=manager_unavailable');
    assert(skipped.checked === 0 && skipped.purged === 0 && skipped.errors === 0, 'all counts zero');
  } finally {
    sched2.stop();
  }

  console.log('\n7. listDuePurges throw is captured into errors count, never propagated');
  const sched3 = weavePurgeScheduler({
    getManager: () => manager,
    listDuePurges: async () => {
      throw new Error('db down');
    },
    markPurged: async () => {},
    intervalMs: 999_999_999,
    log: () => {},
  });
  try {
    const errResult = await sched3.tickNow();
    assert(errResult.errors === 1, `errors=1 (got ${errResult.errors})`);
    assert(errResult.purged === 0, `purged=0 (got ${errResult.purged})`);
  } finally {
    sched3.stop();
  }

  // ── Tenant C: restoreFromShred vs hardShred ──
  console.log('\n8. Bootstrap tenant C, soft-shred, then restoreFromShred succeeds');
  await manager.bootstrapTenant({ tenantId: 'tenant-C', enable: true, actor: 'admin' });
  await manager.shred('tenant-C', 'admin'); // soft shred → status='revoked' but rows remain
  const beforeRestoreKeks = await store.listKeks('tenant-C');
  assert(
    beforeRestoreKeks.every((k) => k.status === 'revoked'),
    'after shred all KEKs status=revoked',
  );
  const restored = await manager.restoreFromShred('tenant-C', 'admin');
  assert(typeof restored.kekId === 'string' && typeof restored.dekId === 'string', 'restore returned ids');
  const afterRestoreKeks = await store.listKeks('tenant-C');
  assert(
    afterRestoreKeks.some((k) => k.id === restored.kekId && k.status === 'active'),
    'restored KEK is now active',
  );

  console.log('\n9. After hardShred, restoreFromShred fails fast (no key material left)');
  await manager.hardShred('tenant-C', 'admin');
  let threw = false;
  try {
    await manager.restoreFromShred('tenant-C', 'admin');
  } catch (err) {
    threw = true;
    assert(String(err).includes('purged') || String(err).includes('cannot be restored'), 'error mentions purge');
  }
  assert(threw, 'restoreFromShred threw after hardShred');

  console.log(`\n✅ All assertions passed.\n`);
}

main().catch((err) => {
  console.error('\n❌ Example failed:', err);
  process.exit(1);
});
