#!/usr/bin/env node
// scripts/e2e-phase4-model-cascade.mjs
//
// E2E for Cost Governor Phase 4: prove that the model-cascade lever
// round-trips through the cost_policies REST API and persists into
// `cost_policies.levers_json`. Covers: register → promote → login →
// CSRF → POST cost-policy with cascade levers → GET back → PUT update
// → final GET → DELETE.
//
// Usage: zsh> set +H && node scripts/e2e-phase4-model-cascade.mjs
//
// Requires server running at http://localhost:3500 (examples/12-geneweave.ts).

import { BASE, DB_PATH, makeOk, jfetch } from './e2e-helpers.mjs';

const ok = makeOk();
const ts = Date.now();
const email = `e2e-phase4-${ts}@example.com`;
const password = 'P@ssw0rd123';

console.log(`\n=== Phase 4 E2E (cascade round-trip) — ${BASE} ===\n`);

// 1. Register
console.log('1. Register');
const reg = await jfetch('POST', '/api/auth/register', { body: { email, password, name: 'phase4' } });
ok(reg.status === 201 || reg.status === 200, `register status=${reg.status}`);

// 2. Promote (direct sqlite — outside the API)
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
ok(typeof csrf === 'string' && csrf.length > 0, 'csrf token present in login body');
ok(cookie.length > 0, 'session cookie present');

// 4. POST cost-policy with cascade levers
console.log('4. POST cost-policy with modelCascade levers');
const policyKey = `e2e_cascade_${ts}`;
const cascadeLevers = {
  modelCascade: {
    cheap: { provider: 'openai', modelId: 'gpt-4o-mini' },
    expensive: { provider: 'openai', modelId: 'gpt-4o' },
    escalateOn: [
      { kind: 'tool_call_failed_count', threshold: 3 },
      { kind: 'json_parse_failed_count', threshold: 2 },
      { kind: 'step_kind', stepKinds: ['final_answer'] },
    ],
  },
};
const create = await jfetch('POST', '/api/admin/cost-policies', {
  cookie, csrf,
  body: {
    key: policyKey,
    tier: 'balanced',
    description: 'Phase 4 E2E cascade test',
    levers_json: JSON.stringify(cascadeLevers),
    enabled: true,
  },
});
ok(create.status === 201, `create status=${create.status} (body=${JSON.stringify(create.body).slice(0,200)})`);
const id = create.body?.policy?.id ?? create.body?.id;
ok(typeof id === 'string', `policy id present: ${id}`);

// 5. GET back and verify shape
console.log('5. GET back');
const got = await jfetch('GET', `/api/admin/cost-policies/${id}`, { cookie });
ok(got.status === 200, `get status=${got.status}`);
const policy = got.body?.policy ?? got.body;
ok(policy.key === policyKey, `key roundtrip: ${policy.key}`);
ok(policy.tier === 'balanced', `tier roundtrip: ${policy.tier}`);
const parsed = typeof policy.levers_json === 'string' ? JSON.parse(policy.levers_json) : policy.levers_json;
ok(parsed.modelCascade?.cheap?.modelId === 'gpt-4o-mini', 'cascade.cheap roundtrip');
ok(parsed.modelCascade?.expensive?.modelId === 'gpt-4o', 'cascade.expensive roundtrip');
ok(Array.isArray(parsed.modelCascade?.escalateOn) && parsed.modelCascade.escalateOn.length === 3, 'escalateOn array roundtrip');

// 6. PUT update — change threshold
console.log('6. PUT update threshold');
const updatedLevers = {
  ...parsed,
  modelCascade: {
    ...parsed.modelCascade,
    escalateOn: [
      { kind: 'tool_call_failed_count', threshold: 5 },
    ],
  },
};
const upd = await jfetch('PUT', `/api/admin/cost-policies/${id}`, {
  cookie, csrf,
  body: { levers_json: JSON.stringify(updatedLevers) },
});
ok(upd.status === 200, `update status=${upd.status}`);

const got2 = await jfetch('GET', `/api/admin/cost-policies/${id}`, { cookie });
const policy2 = got2.body?.policy ?? got2.body;
const parsed2 = typeof policy2.levers_json === 'string' ? JSON.parse(policy2.levers_json) : policy2.levers_json;
ok(parsed2.modelCascade.escalateOn.length === 1, 'escalateOn shrunk to 1');
ok(parsed2.modelCascade.escalateOn[0].threshold === 5, 'threshold updated to 5');

// 7. DELETE
console.log('7. DELETE');
const del = await jfetch('DELETE', `/api/admin/cost-policies/${id}`, { cookie, csrf });
ok(del.status === 200 || del.status === 204, `delete status=${del.status}`);

const got3 = await jfetch('GET', `/api/admin/cost-policies/${id}`, { cookie });
ok(got3.status === 404, `404 after delete: ${got3.status}`);

console.log(`\n✓ Phase 4 E2E passed: ${ok.count()} assertions.\n`);
