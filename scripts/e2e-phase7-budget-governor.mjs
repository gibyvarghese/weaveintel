#!/usr/bin/env node
// scripts/e2e-phase7-budget-governor.mjs
//
// E2E for Cost Governor Phase 7: prove the maxStepsCap + reasoningEffort +
// toolOutputTruncation + budgetCeilingUsd levers round-trip through the
// cost_policies REST API and persist into `cost_policies.levers_json`.
// Also verifies the seeded `kaggle_full_governor` row is present after server boot.
//
// Usage: zsh> set +H && node scripts/e2e-phase7-budget-governor.mjs
//
// Requires server running at http://localhost:3500 (examples/12-geneweave.ts).

import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL ?? 'http://localhost:3500';
const ts = Date.now();
const email = `e2e_phase7_${ts}@example.com`;
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

console.log(`\n=== Phase 7 E2E (maxSteps + reasoning + truncation + budget) — ${BASE} ===\n`);

// 1. Register
console.log('1. Register');
const reg = await jfetch('POST', '/api/auth/register', { body: { email, password, name: 'phase7' } });
ok(reg.status === 201 || reg.status === 200, `register status=${reg.status}`);

// 2. Promote
console.log('2. Promote to tenant_admin');
const { execSync } = await import('node:child_process');
execSync(`sqlite3 ./geneweave.db "UPDATE users SET persona='tenant_admin' WHERE email='${email}';"`);
ok(true, 'promoted via sqlite');

// 3. Login
console.log('3. Login');
const login = await jfetch('POST', '/api/auth/login', { body: { email, password } });
ok(login.status === 200, `login status=${login.status}`);
const setCookie = login.headers.get('set-cookie') ?? '';
const cookie = setCookie.split(',').map(c => c.trim().split(';')[0]).join('; ');
const csrf = login.body?.csrfToken;
ok(typeof csrf === 'string' && csrf.length > 0, 'csrf token present');

// 4. Verify seeded kaggle_full_governor row
console.log('4. Verify seeded kaggle_full_governor');
const list = await jfetch('GET', '/api/admin/cost-policies', { cookie });
ok(list.status === 200, `list status=${list.status}`);
const policies = list.body?.policies ?? list.body?.items ?? list.body ?? [];
const seeded = (Array.isArray(policies) ? policies : []).find(p => p.key === 'kaggle_full_governor');
ok(seeded, 'kaggle_full_governor row seeded at boot');
const seededLevers = typeof seeded.levers_json === 'string' ? JSON.parse(seeded.levers_json) : seeded.levers_json;
ok(seededLevers.maxStepsCap === 30, 'seed maxStepsCap=30');
ok(seededLevers.reasoningEffort === 'low', 'seed reasoningEffort=low');
ok(seededLevers.toolOutputTruncation?.maxBytesPerTurn === 2048, 'seed truncation.maxBytesPerTurn=2048');
ok(seededLevers.toolOutputTruncation?.keepLastN === 3, 'seed truncation.keepLastN=3');
ok(seededLevers.budgetCeilingUsd === 2.5, 'seed budgetCeilingUsd=2.5');

// 5. POST a custom Phase 7 policy
console.log('5. POST custom Phase 7 policy');
const policyKey = `e2e_phase7_${ts}`;
const customLevers = {
  maxStepsCap: 12,
  reasoningEffort: 'high',
  toolOutputTruncation: { maxBytesPerTurn: 1024, keepLastN: 2 },
  budgetCeilingUsd: 0.75,
};
const create = await jfetch('POST', '/api/admin/cost-policies', {
  cookie, csrf,
  body: {
    key: policyKey,
    tier: 'custom',
    description: 'Phase 7 E2E full envelope',
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
ok(parsed.maxStepsCap === 12, 'maxStepsCap roundtrip');
ok(parsed.reasoningEffort === 'high', 'reasoningEffort roundtrip');
ok(parsed.toolOutputTruncation?.maxBytesPerTurn === 1024, 'truncation bytes roundtrip');
ok(parsed.toolOutputTruncation?.keepLastN === 2, 'truncation keepLastN roundtrip');
ok(parsed.budgetCeilingUsd === 0.75, 'budgetCeilingUsd roundtrip');

// 7. PUT update — relax cap, raise ceiling
console.log('7. PUT update');
const updatedLevers = {
  maxStepsCap: 50,
  reasoningEffort: 'medium',
  toolOutputTruncation: { maxBytesPerTurn: 4096, keepLastN: 4 },
  budgetCeilingUsd: 5.0,
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
ok(parsed2.maxStepsCap === 50, 'maxStepsCap updated to 50');
ok(parsed2.reasoningEffort === 'medium', 'reasoningEffort updated to medium');
ok(parsed2.toolOutputTruncation.maxBytesPerTurn === 4096, 'truncation bytes updated');
ok(parsed2.budgetCeilingUsd === 5.0, 'ceiling updated to $5');

// 8. DELETE
console.log('8. DELETE');
const del = await jfetch('DELETE', `/api/admin/cost-policies/${id}`, { cookie, csrf });
ok(del.status === 200 || del.status === 204, `delete status=${del.status}`);

const got3 = await jfetch('GET', `/api/admin/cost-policies/${id}`, { cookie });
ok(got3.status === 404, `404 after delete: ${got3.status}`);

console.log(`\n✓ Phase 7 E2E passed: ${assertions} assertions.\n`);
