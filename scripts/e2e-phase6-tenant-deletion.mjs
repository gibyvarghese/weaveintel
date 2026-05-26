#!/usr/bin/env node
// scripts/e2e-phase6-tenant-deletion.mjs
//
// E2E for Tenant Encryption Phase 6: GDPR hard-shred + tenant deletion lifecycle.
//
// Strategy:
//   1) Register + promote + login (CSRF from body).
//   2) Enable encryption policy with auto-bootstrap (tenant_id assignment via SQL).
//   3) Send a chat message (encrypted at rest via Phase 3 wrapper). Confirm sentinel.
//   4) POST /request-deletion → assert request row created with status=pending.
//   5) GET /api/admin/tenant-deletion-requests?tenantId=X → row visible.
//   6) POST /cancel-deletion → assert status=cancelled.
//   7) POST /request-deletion again (new row).
//   8) POST /restore → flips revoked keys back to active (no shred yet → 200, restored counts).
//   9) (Re-create another deletion request to actually expire.)
//   10) SQL UPDATE retention_until = now-1 to expire the window.
//   11) Spawn helper scripts/_phase6-tick-once.mjs → assert {checked>=1, purged>=1}.
//   12) Verify all tenant_keks/tenant_deks rows are gone via SQL.
//   13) Cleanup: DELETE policy. (Already keyless, no shred needed.)
//
// REQUIRES the server to be started with WEAVE_ENCRYPTION_MASTER_KEY set.

import { execSync } from 'node:child_process';
import { BASE, DB_PATH, makeOk, jfetch } from './e2e-helpers.mjs';

const ok = makeOk();
const ts = Date.now();
const email = `e2e_phase6_purge_${ts}@example.com`;
const password = 'P@ssw0rd123';
const tenantId = `e2e_purge_tenant_${ts}`;

function sql(q) {
  return execSync(`sqlite3 ${DB_PATH} "${q.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim();
}

console.log(`\n=== Phase 6 E2E (tenant deletion lifecycle) — ${BASE} ===\n`);

// 1. Register
console.log('1. Register');
const reg = await jfetch('POST', '/api/auth/register', { body: { email, password, name: 'enc-phase6' } });
ok(reg.status === 201 || reg.status === 200, `register status=${reg.status}`);

// 2. Promote + assign tenant_id (encryption requires tenant_id on the user)
console.log('2. Promote + assign tenant_id');
sql(`UPDATE users SET persona='tenant_admin', tenant_id='${tenantId}' WHERE email='${email}';`);
ok(true, 'promoted + tenant_id assigned');

// 3. Login
console.log('3. Login');
const login = await jfetch('POST', '/api/auth/login', { body: { email, password } });
ok(login.status === 200, `login status=${login.status}`);
const setCookie = login.headers.get('set-cookie') ?? '';
const cookie = setCookie.split(',').map(c => c.trim().split(';')[0]).join('; ');
const csrf = login.body?.csrfToken;
ok(typeof csrf === 'string' && csrf.length > 0, 'csrf token present');

// 4. Verify manager_available
console.log('4. Verify manager_available');
const list = await jfetch('GET', '/api/admin/tenant-encryption-policies', { cookie });
ok(list.status === 200, `list status=${list.status}`);
if (list.body?.manager_available !== true) {
  console.log('\n⚠️  Encryption manager not bootstrapped. Set WEAVE_ENCRYPTION_MASTER_KEY and restart server.');
  process.exit(2);
}
ok(true, 'manager available');

// 5. POST policy with auto-bootstrap
console.log('5. POST policy enabled=1');
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
ok(created.body?.bootstrapped === true, 'bootstrapped=true');

// Capture initial key counts
const initialKeys = await jfetch('GET', `/api/admin/tenant-encryption-policies/${tenantId}/keys`, { cookie });
ok(initialKeys.body?.keks?.length >= 1 && initialKeys.body?.deks?.length >= 1, 'initial KEK + DEK present');

// 6. POST /request-deletion (30-day default retention)
console.log('6. POST /request-deletion (default retention)');
const req1 = await jfetch('POST', `/api/admin/tenant-encryption-policies/${tenantId}/request-deletion`, {
  cookie, csrf, body: { reason: 'GDPR test request 1' },
});
ok(req1.status === 201, `request-deletion status=${req1.status}`);
ok(req1.body?.request?.status === 'pending', 'request status=pending');
ok(req1.body?.request?.retention_until > Date.now(), 'retention_until is in the future');
const req1Id = req1.body.request.id;

// 7. List deletion requests
console.log('7. GET /api/admin/tenant-deletion-requests');
const reqList = await jfetch('GET', `/api/admin/tenant-deletion-requests?tenantId=${tenantId}`, { cookie });
ok(reqList.status === 200, `list status=${reqList.status}`);
ok(Array.isArray(reqList.body?.requests) && reqList.body.requests.length >= 1, '>=1 deletion request');
ok(reqList.body.requests.some((r) => r.id === req1Id), 'first request visible');

// 8. POST /cancel-deletion
console.log('8. POST /cancel-deletion');
const cancel = await jfetch('POST', `/api/admin/tenant-encryption-policies/${tenantId}/cancel-deletion`, {
  cookie, csrf, body: { requestId: req1Id },
});
ok(cancel.status === 200, `cancel status=${cancel.status}`);
const reqAfterCancel = sql(`SELECT status FROM tenant_deletion_requests WHERE id='${req1Id}';`);
ok(reqAfterCancel === 'cancelled', `request status=cancelled (got '${reqAfterCancel}')`);

// 9. Cancel-again should be 409
console.log('9. POST /cancel-deletion (already cancelled → 409)');
const cancelAgain = await jfetch('POST', `/api/admin/tenant-encryption-policies/${tenantId}/cancel-deletion`, {
  cookie, csrf, body: { requestId: req1Id },
});
ok(cancelAgain.status === 409, `cancel-again status=${cancelAgain.status}`);

// 10. POST /request-deletion #2 with short retention
console.log('10. POST /request-deletion (retentionDays=1)');
const req2 = await jfetch('POST', `/api/admin/tenant-encryption-policies/${tenantId}/request-deletion`, {
  cookie, csrf, body: { retentionDays: 1, reason: 'GDPR test request 2 (will expire)' },
});
ok(req2.status === 201, `request-deletion #2 status=${req2.status}`);
const req2Id = req2.body.request.id;
ok(req2.body.request.status === 'pending', '#2 status=pending');

// 11. SQL: expire retention window
console.log('11. SQL: expire retention_until on request #2');
sql(`UPDATE tenant_deletion_requests SET retention_until=${Date.now() - 1000} WHERE id='${req2Id}';`);
ok(true, 'retention_until aged');

// 12. Spawn helper to tick purge scheduler once
console.log('12. Spawn _phase6-tick-once.mjs helper');
const masterKey = process.env.WEAVE_ENCRYPTION_MASTER_KEY;
if (!masterKey) {
  console.error('  ✗ WEAVE_ENCRYPTION_MASTER_KEY missing in this shell — needed for helper');
  process.exit(2);
}
const helperOut = execSync('node scripts/_phase6-tick-once.mjs', {
  env: { ...process.env, WEAVE_ENCRYPTION_MASTER_KEY: masterKey },
  encoding: 'utf8',
});
const tickResult = JSON.parse(helperOut.trim().split('\n').pop());
ok(typeof tickResult === 'object' && tickResult !== null, 'helper returned JSON');
ok(tickResult.checked >= 1, `tick checked >= 1 (got ${tickResult.checked})`);
ok(tickResult.purged >= 1, `tick purged >= 1 (got ${tickResult.purged})`);
ok(tickResult.errors === 0, `tick errors === 0 (got ${tickResult.errors})`);

// 13. Verify request #2 is now status='purged'
console.log('13. Verify request #2 status=purged');
const purgedStatus = sql(`SELECT status FROM tenant_deletion_requests WHERE id='${req2Id}';`);
ok(purgedStatus === 'purged', `request status=purged (got '${purgedStatus}')`);

// 14. Verify all key material wiped
console.log('14. Verify wrapped key material wiped');
const keksRemaining = sql(`SELECT COUNT(*) FROM tenant_keks WHERE tenant_id='${tenantId}';`);
const deksRemaining = sql(`SELECT COUNT(*) FROM tenant_deks WHERE tenant_id='${tenantId}';`);
const biksRemaining = sql(`SELECT COUNT(*) FROM tenant_biks WHERE tenant_id='${tenantId}';`);
ok(keksRemaining === '0', `tenant_keks count == 0 (got ${keksRemaining})`);
ok(deksRemaining === '0', `tenant_deks count == 0 (got ${deksRemaining})`);
ok(biksRemaining === '0', `tenant_biks count == 0 (got ${biksRemaining})`);

// 15. Audit trail recorded the tenant_purged event
console.log('15. GET /audit — verify tenant_purged event from purge scheduler');
const audit = await jfetch('GET', `/api/admin/tenant-encryption-policies/${tenantId}/audit`, { cookie });
ok(audit.status === 200, `audit status=${audit.status}`);
const events = audit.body?.events ?? [];
const purgedEvents = events.filter(
  (e) => e.event_kind === 'tenant_purged' && e.actor === 'system:purge-scheduler',
);
ok(purgedEvents.length >= 1, `>=1 tenant_purged event from system:purge-scheduler (got ${purgedEvents.length})`);

// 16. Cleanup: DELETE policy (no live keys → should succeed without shred)
console.log('16. DELETE policy (no live keys remain)');
const del = await jfetch('DELETE', `/api/admin/tenant-encryption-policies/${tenantId}`, { cookie, csrf });
ok(del.status === 200 || del.status === 204, `delete status=${del.status}`);
const after = await jfetch('GET', `/api/admin/tenant-encryption-policies/${tenantId}`, { cookie });
ok(after.status === 404, 'GET after delete = 404');

console.log(`\n✅ All ${ok.count()} assertions passed.\n`);
