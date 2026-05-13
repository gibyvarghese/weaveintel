/**
 * Example 13 — Tenant Encryption Phase 1.
 *
 * Demonstrates the @weaveintel/encryption package end-to-end with no DB,
 * no LLM, no external services. An in-memory EncryptionStore keeps the
 * package generic; LocalKmsProvider wraps tenant keys under a randomly-
 * generated dev master key.
 *
 * Run: npx tsx examples/13-encryption-phase1.ts
 */

import {
  LocalKmsProvider,
  loadMasterKeyFromEnv,
  noopAuditEmitter,
  weaveTenantKeyManager,
  type BikRecord,
  type DekRecord,
  type EncryptionStore,
  type KekRecord,
  type TenantPolicyRecord,
} from '@weaveintel/encryption';

// ─── In-memory EncryptionStore ─────────────────────────────────────────
function createInMemoryStore(): EncryptionStore {
  const policies = new Map<string, TenantPolicyRecord>();
  const keks: KekRecord[] = [];
  const deks: DekRecord[] = [];
  const biks: BikRecord[] = [];
  return {
    async getPolicy(tenantId) {
      return policies.get(tenantId) ?? null;
    },
    async upsertPolicy(p) {
      policies.set(p.tenantId, p);
    },
    async listKeks(tenantId) {
      return keks.filter((k) => k.tenantId === tenantId);
    },
    async insertKek(k) {
      keks.push(k);
    },
    async updateKekStatus(id, status, at) {
      const r = keks.find((k) => k.id === id);
      if (!r) return;
      Object.assign(r, { status, ...(status === 'previous' ? { rotatedAt: at } : status === 'revoked' ? { revokedAt: at } : {}) });
    },
    async listDeks(tenantId) {
      return deks.filter((d) => d.tenantId === tenantId);
    },
    async insertDek(d) {
      deks.push(d);
    },
    async updateDekStatus(id, status, at) {
      const r = deks.find((d) => d.id === id);
      if (!r) return;
      Object.assign(r, { status, ...(status === 'previous' ? { rotatedAt: at } : status === 'revoked' ? { revokedAt: at } : {}) });
    },
    async listBiks(tenantId) {
      return biks.filter((b) => b.tenantId === tenantId);
    },
    async insertBik(b) {
      biks.push(b);
    },
    async updateBikStatus(id, status, at) {
      const r = biks.find((b) => b.id === id);
      if (!r) return;
      Object.assign(r, { status, revokedAt: at });
    },
  };
}

async function main(): Promise<void> {
  console.log('--- Tenant Encryption Phase 1 demo ---\n');

  // 1. Load (or generate) a dev master key.
  const loaded = loadMasterKeyFromEnv({ devGenerateIfMissing: true });
  console.log(`[boot] master key source: ${loaded.source} (${loaded.key.length} bytes)`);

  // 2. Wire LocalKmsProvider + InMemoryStore + no-op audit emitter into the manager.
  const store = createInMemoryStore();
  const kms = new LocalKmsProvider({ masterKey: loaded.key });
  const km = weaveTenantKeyManager({ store, kms, audit: noopAuditEmitter });

  // 3. Bootstrap a tenant — materialises policy + KEK + DEK + BIK.
  const tenantId = 'demo-tenant';
  const policy = await km.bootstrapTenant({ tenantId, enable: true, actor: 'example-13' });
  console.log(`[bootstrap] tenant=${tenantId} kek=${policy.activeKekId} dek=${policy.activeDekId}`);

  // 4. Encrypt a column value.
  const ct1 = await km.encrypt({
    tenantId,
    table: 'users',
    column: 'email',
    rowId: 'user-1',
    plaintext: 'alice@example.com',
  });
  console.log(`[encrypt] ${ct1.slice(0, 40)}...`);

  // 5. Decrypt round-trip.
  const pt1 = await km.decrypt({
    tenantId,
    table: 'users',
    column: 'email',
    rowId: 'user-1',
    value: ct1,
  });
  console.log(`[decrypt] ${pt1}`);
  if (pt1 !== 'alice@example.com') throw new Error('round-trip mismatch');

  // 6. Rotate the DEK. Old ciphertext must still decrypt (parses old epoch
  //    from the sentinel). New encrypts use the new active epoch.
  const newDek = await km.rotateDek(tenantId, 'example-13');
  console.log(`[rotate-dek] new active dek=${newDek.id} epoch=${newDek.epoch}`);

  const pt1Again = await km.decrypt({
    tenantId,
    table: 'users',
    column: 'email',
    rowId: 'user-1',
    value: ct1,
  });
  if (pt1Again !== 'alice@example.com') throw new Error('post-rotation old-ct decrypt mismatch');
  console.log(`[decrypt-old-ct] ${pt1Again} (decrypted with retired DEK by epoch lookup)`);

  const ct2 = await km.encrypt({
    tenantId,
    table: 'users',
    column: 'email',
    rowId: 'user-2',
    plaintext: 'bob@example.com',
  });
  // Sentinel format: enc:v1:<epoch>:<iv>:<ct>
  const epoch2 = ct2.split(':')[2];
  console.log(`[encrypt-after-rotate] new epoch=${epoch2} (${ct2.slice(0, 40)}...)`);
  if (epoch2 === undefined || Number(epoch2) !== newDek.epoch) {
    throw new Error(`expected new ct to use epoch ${newDek.epoch}, got ${epoch2}`);
  }

  console.log('\n--- All assertions passed. ---');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
