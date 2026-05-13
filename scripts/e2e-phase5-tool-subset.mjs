#!/usr/bin/env node
// scripts/e2e-phase5-tool-subset.mjs
//
// E2E for Cost Governor Phase 5: prove the toolSubset lever round-trips
// through the cost_policies REST API and persists into
// `cost_policies.levers_json`. Also verifies the seeded
// `kaggle_phase_subset` row is present after server boot.
//
// Usage: zsh> set +H && node scripts/e2e-phase5-tool-subset.mjs
//
// Requires server running at http://localhost:3500 (examples/12-geneweave.ts).

import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL ?? 'http://localhost:3500';
const ts = Date.now();
const email = `e2e_phase5_${ts}@example.com`;
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

console.log(`\n=== Phase 5 E2E (tool-subset round-trip) — ${BASE} ===\n`);

// 1. Register
console.log('1. Register');
const reg = await jfetch('POST', '/api/auth/register', { body: { email, password, name: 'phase5' } });
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
ok(cookie.length > 0, 'session cookie present');

// 4. Verify seeded kaggle_phase_subset row
console.log('4. Verify seeded kaggle_phase_subset');
const list = await jfetch('GET', '/api/admin/cost-policies', { cookie });
ok(list.status === 200, `list status=${list.status}`);
const policies = list.body?.policies ?? list.body?.items ?? list.body ?? [];
const seeded = (Array.isArray(policies) ? policies : []).find(p => p.key === 'kaggle_phase_subset');
ok(seeded, 'kaggle_phase_subset row seeded at boot');
const seededLevers = typeof seeded.levers_json === 'string' ? JSON.parse(seeded.levers_json) : seeded.levers_json;
ok(seededLevers.toolSubset?.strategy === 'phase', `seed strategy=phase`);
ok(Array.isArray(seededLevers.toolSubset?.phases?.discovery), 'seed has discovery phase');
ok(Array.isArray(seededLevers.toolSubset?.phases?.kernel), 'seed has kernel phase');
ok(Array.isArray(seededLevers.toolSubset?.phases?.improvement), 'seed has improvement phase');

// 5. POST a custom toolSubset policy
console.log('5. POST custom tool-subset policy');
const policyKey = `e2e_subset_${ts}`;
const subsetLevers = {
  toolSubset: {
    strategy: 'phase',
    phases: {
      explore: ['web_search', 'http_get'],
      execute: ['shell_exec', 'file_write'],
    },
  },
};
const create = await jfetch('POST', '/api/admin/cost-policies', {
  cookie, csrf,
  body: {
    key: policyKey,
    tier: 'balanced',
    description: 'Phase 5 E2E tool-subset test',
    levers_json: JSON.stringify(subsetLevers),
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
ok(policy.tier === 'balanced', `tier roundtrip: ${policy.tier}`);
const parsed = typeof policy.levers_json === 'string' ? JSON.parse(policy.levers_json) : policy.levers_json;
ok(parsed.toolSubset?.strategy === 'phase', 'subset strategy roundtrip');
ok(parsed.toolSubset.phases.explore.length === 2, 'explore phase has 2 keys');
ok(parsed.toolSubset.phases.execute.length === 2, 'execute phase has 2 keys');

// 7. PUT update — add a third phase
console.log('7. PUT update — add a third phase');
const updatedLevers = {
  toolSubset: {
    ...parsed.toolSubset,
    phases: {
      ...parsed.toolSubset.phases,
      finalize: ['db_write'],
    },
  },
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
ok(parsed2.toolSubset.phases.finalize?.length === 1, 'finalize phase added');
ok(Object.keys(parsed2.toolSubset.phases).length === 3, 'phases now total 3');

// 8. DELETE
console.log('8. DELETE');
const del = await jfetch('DELETE', `/api/admin/cost-policies/${id}`, { cookie, csrf });
ok(del.status === 200 || del.status === 204, `delete status=${del.status}`);

const got3 = await jfetch('GET', `/api/admin/cost-policies/${id}`, { cookie });
ok(got3.status === 404, `404 after delete: ${got3.status}`);

console.log(`\n✓ Phase 5 E2E passed: ${assertions} assertions.\n`);
