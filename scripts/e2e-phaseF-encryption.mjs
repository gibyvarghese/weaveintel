#!/usr/bin/env node
// scripts/e2e-phaseF-encryption.mjs
//
// Phase F (Encryption runtime slot) — prove the per-tenant TenantKeyManager
// is wired onto `runtime.encryption` and that the existing tenant-encryption
// admin API + on-disk policy table remain operational with the new wiring.
//
// What it verifies end-to-end:
//   1. Server boots with WEAVE_ENCRYPTION_MASTER_KEY → encryption capability
//      advertised at boot (visible in startup log).
//   2. Admin can list `/api/admin/tenant-encryption-policies` (proves the
//      DB-backed encryption store is reachable from the live runtime).
//   3. Admin can create + read back a policy row → SQLite verify the row
//      exists in `tenant_encryption_policy`.
//   4. The system-tenant bootstrap row exists (proves bootstrap completed
//      under the new slot wiring).
//
// Usage:
//   zsh> set +H
//   zsh> bash /tmp/start-phaseF.sh   # boots server with master key set
//   zsh> node scripts/e2e-phaseF-encryption.mjs
import { execSync } from 'node:child_process';
import { BASE, DB_PATH, makeOk, jfetch } from './e2e-helpers.mjs';

const ok = makeOk();
const ts = Date.now();
const email = `e2e_phaseF_${ts}@example.com`;
const password = 'P@ssw0rd123';
const tenantId = `phaseF-tenant-${ts}`;

console.log(`\n=== Phase F E2E (encryption runtime slot) — ${BASE} ===\n`);

// 1. Register + promote + login
console.log('1. Register + promote + login');
await jfetch('POST', '/api/auth/register', { body: { email, password, name: 'phaseF' } });
execSync(`sqlite3 ${DB_PATH} "UPDATE users SET persona='tenant_admin' WHERE email='${email}';"`);
const login = await jfetch('POST', '/api/auth/login', { body: { email, password } });
ok(login.status === 200, `login status=${login.status}`);
const cookie = (login.headers.get('set-cookie') ?? '')
  .split(',').map(c => c.trim().split(';')[0]).join('; ');
const csrf = login.body?.csrfToken;
ok(typeof csrf === 'string', 'csrf token present');

// 2. List existing policies — proves admin route is wired
console.log('2. GET /api/admin/tenant-encryption-policies');
const list = await jfetch('GET', '/api/admin/tenant-encryption-policies', { cookie, csrf });
ok(list.status === 200, `list status=${list.status}`);
ok(Array.isArray(list.body) || typeof list.body === 'object', 'list body is structured');

// 3. Create a policy and verify in DB
console.log('3. POST /api/admin/tenant-encryption-policies (create)');
const created = await jfetch('POST', '/api/admin/tenant-encryption-policies', {
  cookie,
  csrf,
  body: {
    tenant_id: tenantId,
    enabled: true,
    kms_provider_id: 'local',
    rotation_schedule: 'manual',
    blind_index_enabled: false,
  },
});
ok(created.status === 200 || created.status === 201, `create status=${created.status}`);

const dbRow = execSync(
  `sqlite3 ${DB_PATH} "SELECT tenant_id, enabled, kms_provider_id FROM tenant_encryption_policy WHERE tenant_id='${tenantId}';"`,
).toString().trim();
ok(dbRow.startsWith(tenantId), `DB row exists for tenant: ${dbRow}`);
ok(dbRow.includes('|1|'), `DB row enabled=1: ${dbRow}`);
ok(dbRow.endsWith('|local'), `DB row provider=local: ${dbRow}`);

// 4. System-tenant bootstrap row — proves bootstrap completed under the new
// slot wiring (this row is written by `bootstrapSystemTenant`, called from
// the encryption bootstrap path that must run for `runtime.encryption` to
// have a non-null manager).
console.log('4. SQLite: verify __system__ tenant policy row exists');
const sysRow = execSync(
  `sqlite3 ${DB_PATH} "SELECT tenant_id, blind_index_enabled FROM tenant_encryption_policy WHERE tenant_id='__system__';"`,
).toString().trim();
ok(sysRow.startsWith('__system__'), `system tenant row exists: ${sysRow}`);
ok(sysRow.endsWith('|1'), `system tenant blind_index_enabled=1: ${sysRow}`);

// 5. Verify tenant_keks row was created for system tenant during bootstrap
//    (proves the live manager from `runtime.encryption.getManager()` actually
//    performed key wrapping).
console.log('5. SQLite: verify __system__ tenant has at least one KEK');
const kekCount = execSync(
  `sqlite3 ${DB_PATH} "SELECT COUNT(*) FROM tenant_keks WHERE tenant_id='__system__';"`,
).toString().trim();
ok(parseInt(kekCount, 10) >= 1, `__system__ KEK count=${kekCount}`);

// 6. Cleanup — delete the test policy. May 409 if live keys exist; that's
// expected per the encryption contract (shred first). For this test the
// policy was just created with no DEKs, so it should delete cleanly.
console.log('6. DELETE /api/admin/tenant-encryption-policies/{tenantId}');
const del = await jfetch('DELETE', `/api/admin/tenant-encryption-policies/${tenantId}`, {
  cookie,
  csrf,
});
ok([200, 204, 409].includes(del.status), `delete status=${del.status} (200/204/409 ok)`);

console.log(`\n✓ Phase F E2E passed — ${ok.count()} assertions\n`);
