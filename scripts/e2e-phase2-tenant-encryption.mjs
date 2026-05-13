#!/usr/bin/env node
// scripts/e2e-phase2-tenant-encryption.mjs
//
// E2E for Tenant Encryption Phase 2: admin REST surface + auto-bootstrap-on-enable
// + rotate-dek + rotate-kek + audit + shred (with confirm).
//
// REQUIRES the server to be started with WEAVE_ENCRYPTION_MASTER_KEY set, e.g.:
//
//   export WEAVE_ENCRYPTION_MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
//   npx tsx examples/12-geneweave.ts &
//   node scripts/e2e-phase2-tenant-encryption.mjs
//
// If the manager is not bootstrapped (env var missing) the script exits with
// code 2 and prints instructions — operator must set the env var to validate
// the rotate/shred paths.
//
// Usage: zsh> set +H && node scripts/e2e-phase2-tenant-encryption.mjs

import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

const BASE = process.env.BASE_URL ?? 'http://localhost:3500';
const ts = Date.now();
const email = `e2e_phase2_enc_${ts}@example.com`;
const password = 'P@ssw0rd123';
const tenantId = `e2e_enc_tenant_${ts}`;

let assertions = 0;
const ok = (cond, msg) => { assertions++; assert(cond, msg); console.log(`  ✓ ${msg}`); };

async function jfetch(method, path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.csrf ? { 'x-csrf-token': opts.csrf } : {}),
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let body = null; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}

console.log(`\n=== Phase 2 E2E (tenant encryption admin surface) — ${BASE} ===\n`);

// 1. Register
console.log('1. Register');
const reg = await jfetch('POST', '/api/auth/register', { body: { email, password, name: 'enc-phase2' } });
ok(reg.status === 201 || reg.status === 200, `register status=${reg.status}`);

// 2. Promote to tenant_admin (only persona that can hit /api/admin/*)
console.log('2. Promote to tenant_admin');
execSync(`sqlite3 ./geneweave.db "UPDATE users SET persona='tenant_admin' WHERE email='${email}';"`);
ok(true, 'promoted via sqlite');

// 3. Login + capture csrf
console.log('3. Login');
const login = await jfetch('POST', '/api/auth/login', { body: { email, password } });
ok(login.status === 200, `login status=${login.status}`);
const setCookie = login.headers.get('set-cookie') ?? '';
const cookie = setCookie.split(',').map(c => c.trim().split(';')[0]).join('; ');
const csrf = login.body?.csrfToken;
ok(typeof csrf === 'string' && csrf.length > 0, 'csrf token present');

// 4. Verify the seeded demo-encrypted-tenant row is present
console.log('4. List tenant encryption policies — verify seed');
const list = await jfetch('GET', '/api/admin/tenant-encryption-policies', { cookie });
ok(list.status === 200, `list status=${list.status}`);
const seedRow = (list.body?.policies ?? []).find((p) => p.tenant_id === 'demo-encrypted-tenant');
ok(seedRow !== undefined, 'demo-encrypted-tenant seed row present');
ok(seedRow.enabled === 0, 'seed enabled=0 (operators opt-in per tenant)');
const seedFp = typeof seedRow.field_policy === 'string' ? JSON.parse(seedRow.field_policy) : seedRow.field_policy;
ok(seedFp?.messages?.columns?.includes('content'), 'seed field_policy includes messages.content');

// 5. manager_available check — required for rotate/shred
const managerAvailable = list.body?.manager_available === true;
if (!managerAvailable) {
  console.log('\n⚠️  Encryption manager not bootstrapped. To validate rotate/shred paths:');
  console.log('  export WEAVE_ENCRYPTION_MASTER_KEY=$(node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))")');
  console.log('  Then restart the server and rerun this script.\n');
  console.log(`Partial run: ${assertions} assertions passed (read-only path only).`);
  process.exit(2);
}
ok(managerAvailable, 'encryption manager is available');

// 6. POST a new policy with enabled=1 — server auto-bootstraps KEK+DEK
console.log('6. POST policy enabled=1 — expect auto-bootstrap');
const created = await jfetch('POST', '/api/admin/tenant-encryption-policies', {
  cookie, csrf,
  body: {
    tenant_id: tenantId,
    enabled: true,
    kms_provider_id: 'local',
    kms_config: { provider: 'local' },
    rotation_schedule: 'manual',
    blind_index_enabled: false,
    field_policy: { messages: { columns: ['content'] } },
  },
});
ok(created.status === 201, `create status=${created.status}`);
ok(created.body?.bootstrapped === true, 'bootstrapped=true after enabled=1 POST');
const createdPolicy = created.body?.policy;
ok(createdPolicy?.tenant_id === tenantId, 'tenant_id roundtrip');
ok(typeof createdPolicy?.active_kek_id === 'string' && createdPolicy.active_kek_id.length > 0, 'active_kek_id assigned');
ok(typeof createdPolicy?.active_dek_id === 'string' && createdPolicy.active_dek_id.length > 0, 'active_dek_id assigned');

// 7. GET single
console.log('7. GET single tenant');
const single = await jfetch('GET', `/api/admin/tenant-encryption-policies/${tenantId}`, { cookie });
ok(single.status === 200, `single status=${single.status}`);
ok(single.body?.policy?.tenant_id === tenantId, 'single tenant_id');
ok(single.body?.key_counts?.keks === 1, 'key_counts.keks === 1');
ok(single.body?.key_counts?.deks === 1, 'key_counts.deks === 1');

// 8. POST /rotate-dek
console.log('8. POST /rotate-dek');
const rotDek = await jfetch('POST', `/api/admin/tenant-encryption-policies/${tenantId}/rotate-dek`, { cookie, csrf });
ok(rotDek.status === 200, `rotate-dek status=${rotDek.status}`);
ok(rotDek.body?.ok === true, 'rotate-dek ok=true');
ok(rotDek.body?.dek?.wrapped === undefined, 'rotate-dek response does NOT expose wrapped');

// 9. POST /rotate-kek
console.log('9. POST /rotate-kek');
const rotKek = await jfetch('POST', `/api/admin/tenant-encryption-policies/${tenantId}/rotate-kek`, { cookie, csrf });
ok(rotKek.status === 200, `rotate-kek status=${rotKek.status}`);
ok(rotKek.body?.ok === true, 'rotate-kek ok=true');
ok(rotKek.body?.kek?.wrapped === undefined, 'rotate-kek response does NOT expose wrapped');

// 10. GET /keys — verify all key counts, never expose wrapped
console.log('10. GET /keys — verify counts + sanitization');
const keys = await jfetch('GET', `/api/admin/tenant-encryption-policies/${tenantId}/keys`, { cookie });
ok(keys.status === 200, `keys status=${keys.status}`);
ok(keys.body?.keks?.length === 2, `keks.length === 2 (got ${keys.body?.keks?.length})`);
ok(keys.body?.deks?.length === 3, `deks.length === 3 (got ${keys.body?.deks?.length})`);
ok(keys.body.keks.every((k) => k.wrapped === undefined), '/keys never exposes wrapped on KEKs');
ok(keys.body.deks.every((d) => d.wrapped === undefined), '/keys never exposes wrapped on DEKs');

// 11. GET /audit — at least 3 events (bootstrap + rotate-dek + rotate-kek)
console.log('11. GET /audit');
const audit = await jfetch('GET', `/api/admin/tenant-encryption-policies/${tenantId}/audit`, { cookie });
ok(audit.status === 200, `audit status=${audit.status}`);
ok(Array.isArray(audit.body?.events) && audit.body.events.length >= 3, `audit events >= 3 (got ${audit.body?.events?.length})`);

// 12. POST /shred — requires { confirm: tenantId }
console.log('12. POST /shred — bad confirm rejected');
const badShred = await jfetch('POST', `/api/admin/tenant-encryption-policies/${tenantId}/shred`, {
  cookie, csrf, body: { confirm: 'wrong' },
});
ok(badShred.status === 400, `bad-confirm shred status=${badShred.status}`);

console.log('13. POST /shred — correct confirm');
const shred = await jfetch('POST', `/api/admin/tenant-encryption-policies/${tenantId}/shred`, {
  cookie, csrf, body: { confirm: tenantId },
});
ok(shred.status === 200, `shred status=${shred.status}`);
ok(shred.body?.ok === true, 'shred ok=true');

// 14. GET /keys post-shred — all status='revoked'
console.log('14. GET /keys post-shred — all revoked');
const keysFinal = await jfetch('GET', `/api/admin/tenant-encryption-policies/${tenantId}/keys`, { cookie });
ok(keysFinal.body.keks.every((k) => k.status === 'revoked'), 'all KEKs revoked');
ok(keysFinal.body.deks.every((d) => d.status === 'revoked'), 'all DEKs revoked');

// 15. DELETE — cleanup
console.log('15. DELETE policy');
const del = await jfetch('DELETE', `/api/admin/tenant-encryption-policies/${tenantId}`, { cookie, csrf });
ok(del.status === 200 || del.status === 204, `delete status=${del.status}`);

const after = await jfetch('GET', `/api/admin/tenant-encryption-policies/${tenantId}`, { cookie });
ok(after.status === 404, 'GET after delete = 404');

console.log(`\n✅ All ${assertions} assertions passed.\n`);
