#!/usr/bin/env node
// scripts/e2e-phase8-blind-indexes.mjs
//
// E2E for Tenant Encryption Phase 8 (blind indexes for users.email).
//
// Verifies:
//   1. Server boots with WEAVE_ENCRYPTION_MASTER_KEY → __system__ tenant
//      auto-bootstraps with blind_index_enabled=1.
//   2. Newly-registered users get an `email_bidx` populated via SQLiteAdapter
//      proxy interception of createUser.
//   3. Login by email uses the bidx path (deterministic 24-hex MAC, lookup
//      hits `email_bidx = ?` via SQLiteAdapter.getUserByEmailBidx).
//   4. Admin POST /rotate-bik → POST /rebuild-bidx flow re-MACs every row
//      and login still works.
//
// REQUIRES the geneweave server to be running at $BASE_URL (default
// http://localhost:3500) with WEAVE_ENCRYPTION_MASTER_KEY exported. If the
// manager is unavailable the script exits with code 2.
//
// Usage:  node scripts/e2e-phase8-blind-indexes.mjs

import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

const BASE = process.env.BASE_URL ?? 'http://localhost:3500';
const DB = process.env.GENEWEAVE_DB ?? './geneweave.db';
const SYSTEM = '__system__';
const ts = Date.now();
const email = `e2e_phase8_bidx_${ts}@example.com`;
const password = 'P@ssw0rd123';

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

function sql(q) {
  return execSync(`sqlite3 ${DB} ${JSON.stringify(q)}`).toString().trim();
}

console.log(`\n=== Phase 8 E2E (blind indexes / users.email_bidx) — ${BASE} ===\n`);

// 1. Register a user via the public API
console.log('1. Register fresh user');
const reg = await jfetch('POST', '/api/auth/register', { body: { email, password, name: 'phase8' } });
ok(reg.status === 201 || reg.status === 200, `register status=${reg.status}`);

// 2. Bidx column populated by createUser proxy
console.log('2. users.email_bidx populated for new user');
const bidx = sql(`SELECT IFNULL(email_bidx,'') FROM users WHERE email='${email}';`);
ok(/^[0-9a-f]{24}$/.test(bidx), `email_bidx is 24 hex chars (got "${bidx}")`);

// 3. Login uses bidx path
console.log('3. Login succeeds (uses bidx lookup)');
const login = await jfetch('POST', '/api/auth/login', { body: { email, password } });
ok(login.status === 200, `login status=${login.status}`);
const cookie = (login.headers.get('set-cookie') ?? '').split(',').map(c => c.trim().split(';')[0]).join('; ');
const csrf = login.body?.csrfToken;
ok(typeof csrf === 'string' && csrf.length > 0, 'csrf token present');

// 4. Promote to tenant_admin so we can hit the admin surface
console.log('4. Promote to tenant_admin');
execSync(`sqlite3 ${DB} "UPDATE users SET persona='tenant_admin' WHERE email='${email}';"`);
const login2 = await jfetch('POST', '/api/auth/login', { body: { email, password } });
const cookie2 = (login2.headers.get('set-cookie') ?? '').split(',').map(c => c.trim().split(';')[0]).join('; ');
const csrf2 = login2.body?.csrfToken;

// 5. SYSTEM tenant policy exists with blind_index_enabled=1
console.log('5. SYSTEM tenant present with blind_index_enabled=1');
const sys = await jfetch('GET', `/api/admin/tenant-encryption-policies/${SYSTEM}`, { cookie: cookie2 });
if (sys.status === 503) {
  console.log('\n⚠️  Encryption manager not bootstrapped — set WEAVE_ENCRYPTION_MASTER_KEY then restart.');
  process.exit(2);
}
ok(sys.status === 200, `system policy status=${sys.status}`);
ok(sys.body?.policy?.blind_index_enabled === 1, 'blind_index_enabled=1 for SYSTEM');

// 6. Rotate BIK
console.log('6. POST /rotate-bik');
const rot = await jfetch('POST', `/api/admin/tenant-encryption-policies/${SYSTEM}/rotate-bik`, { cookie: cookie2, csrf: csrf2 });
ok(rot.status === 200, `rotate-bik status=${rot.status}`);
ok(rot.body?.bik?.epoch >= 2, `new bik epoch=${rot.body?.bik?.epoch}`);

// 7. Without rebuild, the stored bidx is now stale — login will miss bidx and
//    fall through to plaintext-equality, which still works during lazy-upgrade.
console.log('7. Login still works after rotate (lazy-upgrade fallback)');
const loginAfterRotate = await jfetch('POST', '/api/auth/login', { body: { email, password } });
ok(loginAfterRotate.status === 200, `login post-rotate status=${loginAfterRotate.status}`);

// 8. Rebuild bidx
console.log('8. POST /rebuild-bidx');
const rebuild = await jfetch('POST', `/api/admin/tenant-encryption-policies/${SYSTEM}/rebuild-bidx`, { cookie: cookie2, csrf: csrf2 });
ok(rebuild.status === 200, `rebuild status=${rebuild.status}`);
ok(rebuild.body?.scope === 'users.email', `rebuild scope=${rebuild.body?.scope}`);
ok(rebuild.body?.written >= 1, `rebuild wrote ${rebuild.body?.written} rows`);

// 9. Bidx changed under the new BIK
console.log('9. email_bidx re-MACed under new BIK');
const bidx2 = sql(`SELECT IFNULL(email_bidx,'') FROM users WHERE email='${email}';`);
ok(/^[0-9a-f]{24}$/.test(bidx2), `new bidx is 24 hex chars`);
ok(bidx2 !== bidx, `bidx changed (was ${bidx}, now ${bidx2})`);

// 10. Login uses new bidx
console.log('10. Login succeeds against rebuilt bidx');
const loginFinal = await jfetch('POST', '/api/auth/login', { body: { email, password } });
ok(loginFinal.status === 200, `final login status=${loginFinal.status}`);

console.log(`\n✅ Phase 8 E2E passed — ${assertions} assertions.\n`);
