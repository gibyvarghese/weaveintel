#!/usr/bin/env node
// scripts/e2e-phase6-intel-history.mjs
//
// E2E for Cost Governor Phase 6: prove the intelGating + historyCompaction
// levers round-trip through the cost_policies REST API and persist into
// `cost_policies.levers_json`. Also verifies the seeded `kaggle_intel_aware`
// row is present after server boot.
//
// Usage: zsh> set +H && node scripts/e2e-phase6-intel-history.mjs
//
// Requires server running at http://localhost:3500 (examples/12-geneweave.ts).

import { BASE, DB_PATH, makeOk, jfetch } from './e2e-helpers.mjs';

const ok = makeOk();
const ts = Date.now();
const email = `e2e_phase6_${ts}@example.com`;
const password = 'P@ssw0rd123';

console.log(`\n=== Phase 6 E2E (intel-gating + history-compaction round-trip) — ${BASE} ===\n`);

// 1. Register
console.log('1. Register');
const reg = await jfetch('POST', '/api/auth/register', { body: { email, password, name: 'phase6' } });
ok(reg.status === 201 || reg.status === 200, `register status=${reg.status}`);

// 2. Promote
console.log('2. Promote to tenant_admin');
const { execSync } = await import('node:child_process');
execSync(`sqlite3 ${DB_PATH} "UPDATE users SET persona='tenant_admin' WHERE email='${email}';"`);
ok(true, 'promoted via sqlite');

// 3. Login
console.log('3. Login');
const login = await jfetch('POST', '/api/auth/login', { body: { email, password } });
ok(login.status === 200, `login status=${login.status}`);
const setCookie = login.headers.get('set-cookie') ?? '';
const cookie = setCookie.split(',').map(c => c.trim().split(';')[0]).join('; ');
const csrf = login.body?.csrfToken;
ok(typeof csrf === 'string' && csrf.length > 0, 'csrf token present');
ok(cookie.length > 0, 'session cookie present');

// 4. Verify seeded kaggle_intel_aware row
console.log('4. Verify seeded kaggle_intel_aware');
const list = await jfetch('GET', '/api/admin/cost-policies', { cookie });
ok(list.status === 200, `list status=${list.status}`);
const policies = list.body?.policies ?? list.body?.items ?? list.body ?? [];
const seeded = (Array.isArray(policies) ? policies : []).find(p => p.key === 'kaggle_intel_aware');
ok(seeded, 'kaggle_intel_aware row seeded at boot');
const seededLevers = typeof seeded.levers_json === 'string' ? JSON.parse(seeded.levers_json) : seeded.levers_json;
ok(seededLevers.intelGating?.enabled === true, 'seed intelGating.enabled=true');
ok(seededLevers.intelGating?.thresholds?.low === 0.4, 'seed thresholds.low=0.4');
ok(seededLevers.intelGating?.thresholds?.high === 0.7, 'seed thresholds.high=0.7');
ok(seededLevers.historyCompaction?.strategy === 'sliding', 'seed compaction.strategy=sliding');
ok(seededLevers.historyCompaction?.windowTurns === 12, 'seed windowTurns=12');

// 5. POST a custom intel+history policy
console.log('5. POST custom intel+history policy');
const policyKey = `e2e_intelhist_${ts}`;
const customLevers = {
  intelGating: {
    enabled: true,
    thresholds: { low: 0.3, high: 0.8 },
  },
  historyCompaction: {
    strategy: 'summary',
    windowTurns: 6,
  },
};
const create = await jfetch('POST', '/api/admin/cost-policies', {
  cookie, csrf,
  body: {
    key: policyKey,
    tier: 'balanced',
    description: 'Phase 6 E2E intel+history',
    levers_json: JSON.stringify(customLevers),
    enabled: true,
  },
});
ok(create.status === 201, `create status=${create.status} (body=${JSON.stringify(create.body).slice(0,200)})`);
const id = create.body?.policy?.id ?? create.body?.id;
ok(typeof id === 'string', `policy id present: ${id}`);

// 6. GET back and verify shape
console.log('6. GET back');
const got = await jfetch('GET', `/api/admin/cost-policies/${id}`, { cookie });
ok(got.status === 200, `get status=${got.status}`);
const policy = got.body?.policy ?? got.body;
ok(policy.key === policyKey, `key roundtrip: ${policy.key}`);
const parsed = typeof policy.levers_json === 'string' ? JSON.parse(policy.levers_json) : policy.levers_json;
ok(parsed.intelGating?.thresholds?.low === 0.3, 'intel.low roundtrip');
ok(parsed.intelGating?.thresholds?.high === 0.8, 'intel.high roundtrip');
ok(parsed.historyCompaction?.strategy === 'summary', 'compaction.strategy roundtrip');
ok(parsed.historyCompaction?.windowTurns === 6, 'compaction.windowTurns roundtrip');

// 7. PUT update — disable intel-gating, switch compaction to sliding
console.log('7. PUT update — disable intel, switch to sliding');
const updatedLevers = {
  intelGating: { enabled: false, thresholds: { low: 0.3, high: 0.8 } },
  historyCompaction: { strategy: 'sliding', windowTurns: 20 },
};
const upd = await jfetch('PUT', `/api/admin/cost-policies/${id}`, {
  cookie, csrf,
  body: { levers_json: JSON.stringify(updatedLevers) },
});
ok(upd.status === 200, `update status=${upd.status}`);

const got2 = await jfetch('GET', `/api/admin/cost-policies/${id}`, { cookie });
const parsed2 = typeof got2.body.policy.levers_json === 'string'
  ? JSON.parse(got2.body.policy.levers_json)
  : got2.body.policy.levers_json;
ok(parsed2.intelGating.enabled === false, 'intel disabled after update');
ok(parsed2.historyCompaction.strategy === 'sliding', 'compaction strategy updated');
ok(parsed2.historyCompaction.windowTurns === 20, 'windowTurns updated to 20');

// 8. DELETE
console.log('8. DELETE');
const del = await jfetch('DELETE', `/api/admin/cost-policies/${id}`, { cookie, csrf });
ok(del.status === 200 || del.status === 204, `delete status=${del.status}`);

const got3 = await jfetch('GET', `/api/admin/cost-policies/${id}`, { cookie });
ok(got3.status === 404, `404 after delete: ${got3.status}`);

console.log(`\n✓ Phase 6 E2E passed: ${ok.count()} assertions.\n`);
