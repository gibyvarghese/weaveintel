#!/usr/bin/env node
// scripts/e2e-phase5-rotation-scheduler.mjs
//
// E2E for Tenant Encryption Phase 5: automated DEK rotation scheduler.
//
// Strategy:
//   1) Create a tenant with rotation_schedule='monthly' + auto-bootstrap a KEK+DEK.
//   2) Use raw SQL to age the active DEK's created_at by 31 days (> 30 day threshold).
//   3) Spawn helper script `scripts/_phase5-tick-once.mjs` which boots the manager and
//      invokes scheduler.tickNow() once (cannot reuse the long-running server's manager
//      from a separate process, so the helper opens its own DB handle).
//   4) Read GET /keys + /audit to verify the new active DEK at epoch=2,
//      old DEK now status='previous', and audit recorded a 'dek_rotate' event
//      with actor='system:rotation-scheduler'.
//   5) Cleanup: shred (with confirm) then DELETE.
//
// REQUIRES the server to be started with WEAVE_ENCRYPTION_MASTER_KEY set, e.g.:
//
//   export WEAVE_ENCRYPTION_MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
//   npx tsc -b apps/geneweave   # MUST rebuild dist before running
//   npx tsx examples/12-geneweave.ts &
//   set +H && node scripts/e2e-phase5-rotation-scheduler.mjs

import { execSync } from 'node:child_process';
import { BASE, DB_PATH, makeOk, jfetch } from './e2e-helpers.mjs';

const ok = makeOk();
const ts = Date.now();
const email = `e2e_phase5_sched_${ts}@example.com`;
const password = 'P@ssw0rd123';
const tenantId = `e2e_sched_tenant_${ts}`;

console.log(`\n=== Phase 5 E2E (rotation scheduler) — ${BASE} ===\n`);

// 1. Register
console.log('1. Register');
const reg = await jfetch('POST', '/api/auth/register', { body: { email, password, name: 'enc-phase5' } });
ok(reg.status === 201 || reg.status === 200, `register status=${reg.status}`);

// 2. Promote to tenant_admin
console.log('2. Promote to tenant_admin');
execSync(`sqlite3 ${DB_PATH} "UPDATE users SET persona='tenant_admin' WHERE email='${email}';"`);
ok(true, 'promoted via sqlite');

// 3. Login + capture csrf
console.log('3. Login');
const login = await jfetch('POST', '/api/auth/login', { body: { email, password } });
ok(login.status === 200, `login status=${login.status}`);
const setCookie = login.headers.get('set-cookie') ?? '';
const cookie = setCookie.split(',').map(c => c.trim().split(';')[0]).join('; ');
const csrf = login.body?.csrfToken;
ok(typeof csrf === 'string' && csrf.length > 0, 'csrf token present');

// 4. Verify manager_available (required for scheduler)
console.log('4. Verify manager_available');
const list = await jfetch('GET', '/api/admin/tenant-encryption-policies', { cookie });
ok(list.status === 200, `list status=${list.status}`);
if (list.body?.manager_available !== true) {
  console.log('\n⚠️  Encryption manager not bootstrapped. Set WEAVE_ENCRYPTION_MASTER_KEY and restart server.');
  process.exit(2);
}
ok(true, 'manager available');

// 5. POST policy with rotation_schedule='monthly' + auto-bootstrap
console.log('5. POST policy rotation_schedule=monthly enabled=1');
const created = await jfetch('POST', '/api/admin/tenant-encryption-policies', {
  cookie, csrf,
  body: {
    tenant_id: tenantId,
    enabled: true,
    kms_provider_id: 'local',
    kms_config: { provider: 'local' },
    rotation_schedule: 'monthly',
    blind_index_enabled: false,
    field_policy: { messages: { columns: ['content'] } },
  },
});
ok(created.status === 201, `create status=${created.status}`);
ok(created.body?.bootstrapped === true, 'bootstrapped=true');
ok(created.body?.policy?.rotation_schedule === 'monthly', 'rotation_schedule=monthly persisted');

// 6. Capture initial DEK state
console.log('6. GET /keys — capture initial DEK');
const initial = await jfetch('GET', `/api/admin/tenant-encryption-policies/${tenantId}/keys`, { cookie });
ok(initial.status === 200, `keys status=${initial.status}`);
ok(initial.body?.deks?.length === 1, `initial deks.length === 1 (got ${initial.body?.deks?.length})`);
const initialDek = initial.body.deks[0];
ok(initialDek.epoch === 1, `initial epoch === 1 (got ${initialDek.epoch})`);
ok(initialDek.status === 'active', `initial status === 'active'`);
const initialDekId = initialDek.id;

// 7. Age the DEK by 31 days via raw SQL
console.log('7. Age active DEK by 31 days via raw SQL');
const agedAt = Date.now() - (31 * 24 * 3600 * 1000);
execSync(`sqlite3 ${DB_PATH} "UPDATE tenant_deks SET created_at=${agedAt} WHERE id='${initialDekId}';"`);
ok(true, `set created_at=${agedAt} on dek ${initialDekId.slice(0, 8)}…`);

// 8. Spawn helper to tick scheduler once
console.log('8. Spawn _phase5-tick-once.mjs helper');
const masterKey = process.env.WEAVE_ENCRYPTION_MASTER_KEY;
if (!masterKey) {
  console.error('  ✗ WEAVE_ENCRYPTION_MASTER_KEY missing in this shell — needed to spawn helper');
  process.exit(2);
}
const helperOut = execSync('node scripts/_phase5-tick-once.mjs', {
  env: { ...process.env, WEAVE_ENCRYPTION_MASTER_KEY: masterKey },
  encoding: 'utf8',
});
const tickResult = JSON.parse(helperOut.trim().split('\n').pop());
ok(typeof tickResult === 'object' && tickResult !== null, 'helper returned JSON');
ok(tickResult.checked >= 1, `tick checked >= 1 (got ${tickResult.checked})`);
ok(tickResult.rotated >= 1, `tick rotated >= 1 (got ${tickResult.rotated})`);
ok(tickResult.errors === 0, `tick errors === 0 (got ${tickResult.errors})`);

// 9. Verify post-rotation state
console.log('9. GET /keys post-rotation — verify epoch advance + previous status');
const post = await jfetch('GET', `/api/admin/tenant-encryption-policies/${tenantId}/keys`, { cookie });
ok(post.status === 200, `post-keys status=${post.status}`);
ok(post.body?.deks?.length === 2, `post deks.length === 2 (got ${post.body?.deks?.length})`);
const newActive = post.body.deks.find((d) => d.status === 'active');
const oldDek = post.body.deks.find((d) => d.id === initialDekId);
ok(newActive !== undefined, 'new active DEK present');
ok(newActive?.epoch === 2, `new active epoch === 2 (got ${newActive?.epoch})`);
ok(oldDek !== undefined, 'old DEK still in store');
ok(oldDek?.status === 'previous', `old DEK status === 'previous' (got ${oldDek?.status})`);

// 10. Verify audit trail
console.log('10. GET /audit — verify dek_rotate event with scheduler actor');
const audit = await jfetch('GET', `/api/admin/tenant-encryption-policies/${tenantId}/audit`, { cookie });
ok(audit.status === 200, `audit status=${audit.status}`);
const events = audit.body?.events ?? [];
const schedulerRotates = events.filter(
  (e) => e.event_kind === 'dek_rotate' && e.actor === 'system:rotation-scheduler',
);
ok(schedulerRotates.length >= 1, `>=1 dek_rotate event from system:rotation-scheduler (got ${schedulerRotates.length})`);

// 11. Cleanup — shred then delete (HARD ordering)
console.log('11. POST /shred (correct confirm)');
const shred = await jfetch('POST', `/api/admin/tenant-encryption-policies/${tenantId}/shred`, {
  cookie, csrf, body: { confirm: tenantId },
});
ok(shred.status === 200, `shred status=${shred.status}`);

console.log('12. DELETE policy');
const del = await jfetch('DELETE', `/api/admin/tenant-encryption-policies/${tenantId}`, { cookie, csrf });
ok(del.status === 200 || del.status === 204, `delete status=${del.status}`);
const after = await jfetch('GET', `/api/admin/tenant-encryption-policies/${tenantId}`, { cookie });
ok(after.status === 404, 'GET after delete = 404');

console.log(`\n✅ All ${ok.count()} assertions passed.\n`);
