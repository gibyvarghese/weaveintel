/**
 * Example 14 — Tenant Encryption Phase 2.
 *
 * Builds on Example 13. Demonstrates the full key lifecycle that Phase 2's
 * admin routes expose:
 *   - bootstrap on enable
 *   - encrypt / decrypt round-trip
 *   - rotateDek (old ciphertext still decrypts via epoch lookup)
 *   - rotateKek (re-wraps existing DEKs under a new KEK; ciphertext untouched)
 *   - shred (revokes all keys; subsequent decrypt fails)
 *
 * No DB, no LLM, no external services. The package is reusable — any app
 * supplies its own EncryptionStore + KmsProvider implementations.
 *
 * Run: npx tsx examples/14-encryption-phase2.ts
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
      Object.assign(r, {
        status,
        ...(status === 'previous' ? { rotatedAt: at } : status === 'revoked' ? { revokedAt: at } : {}),
      });
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
      Object.assign(r, {
        status,
        ...(status === 'previous' ? { rotatedAt: at } : status === 'revoked' ? { revokedAt: at } : {}),
      });
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
  console.log('--- Tenant Encryption Phase 2 demo ---\n');

  const loaded = loadMasterKeyFromEnv({ devGenerateIfMissing: true });
  console.log(`[boot] master key source: ${loaded.source}`);

  const store = createInMemoryStore();
  const kms = new LocalKmsProvider({ masterKey: loaded.key });
  const km = weaveTenantKeyManager({ store, kms, audit: noopAuditEmitter });

  // 1. Bootstrap is idempotent — admin POST with enabled=true calls this.
  const tenantId = 'phase2-tenant';
  const p1 = await km.bootstrapTenant({ tenantId, enable: true, actor: 'admin-1' });
  console.log(`[bootstrap] enabled=${p1.enabled} kek=${p1.activeKekId} dek=${p1.activeDekId}`);
  const p1Again = await km.bootstrapTenant({ tenantId, enable: true, actor: 'admin-1' });
  if (p1Again.activeKekId !== p1.activeKekId) throw new Error('bootstrap not idempotent on KEK');
  if (p1Again.activeDekId !== p1.activeDekId) throw new Error('bootstrap not idempotent on DEK');
  console.log(`[bootstrap] re-bootstrap returned same active ids (idempotent)`);

  // 2. Encrypt / decrypt round-trip.
  const ctx = { tenantId, table: 'messages', column: 'content', rowId: 'msg-1' };
  const ct1 = await km.encrypt({ ...ctx, plaintext: 'hello world' });
  const pt1 = await km.decrypt({ ...ctx, value: ct1 });
  if (pt1 !== 'hello world') throw new Error('round-trip mismatch');
  console.log(`[encrypt+decrypt] '${pt1}' OK`);

  // 3. rotateDek — old ct still decrypts via epoch lookup in the store.
  const newDek = await km.rotateDek(tenantId, 'admin-1');
  console.log(`[rotate-dek] new active dek=${newDek.id} epoch=${newDek.epoch}`);
  const pt1AfterDekRot = await km.decrypt({ ...ctx, value: ct1 });
  if (pt1AfterDekRot !== 'hello world') throw new Error('decrypt after rotateDek failed');
  console.log(`[decrypt-old-ct] still decodes via retired DEK at older epoch`);

  // 4. rotateKek — re-wraps existing DEKs under a new KEK. Ciphertext is
  //    untouched (it's encrypted with the DEK, not the KEK); only the
  //    wrapped-DEK record changes. Decrypt must still work.
  const newKek = await km.rotateKek(tenantId, 'admin-1');
  console.log(`[rotate-kek] new active kek=${newKek.id}`);
  const pt1AfterKekRot = await km.decrypt({ ...ctx, value: ct1 });
  if (pt1AfterKekRot !== 'hello world') throw new Error('decrypt after rotateKek failed');
  console.log(`[decrypt-old-ct] still decodes after KEK rotation (DEK re-wrapped, ct unchanged)`);

  // 5. Shred — revokes all keys for the tenant. With LocalKmsProvider the
  //    in-process master key is still available so decrypt mechanics still
  //    work; cryptographic shred takes effect when a real KMS (Azure Key
  //    Vault, AWS KMS, GCP KMS) destroys the wrapping key out-of-band.
  //    The shred operation always marks every key record `revoked` so
  //    operators have an audit-grade signal for retention/compliance.
  await km.shred(tenantId, 'admin-1');
  console.log(`[shred] all keys revoked for tenant=${tenantId}`);

  // 6. Final policy state — all keys revoked, audit trail intact.
  const finalKeks = await store.listKeks(tenantId);
  const finalDeks = await store.listDeks(tenantId);
  const allRevoked =
    finalKeks.every((k) => k.status === 'revoked') && finalDeks.every((d) => d.status === 'revoked');
  if (!allRevoked) throw new Error('expected all keys revoked after shred');
  console.log(`[final-state] keks=${finalKeks.length} deks=${finalDeks.length} (all revoked)`);

  console.log('\n--- All assertions passed. ---');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
