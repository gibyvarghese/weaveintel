#!/usr/bin/env node
// scripts/e2e-phase8-intent-rag.mjs
//
// E2E for Cost Governor Phase 8: prove the intent-RAG tool-subset strategy
// + topK + minSimilarity + includeAlways round-trip through the cost_policies
// REST API and persist into `cost_policies.levers_json.toolSubset`.
// Also verifies the seeded `kaggle_intent_rag` row is present after server boot.
//
// Usage: zsh> set +H && node scripts/e2e-phase8-intent-rag.mjs
//
// Requires server running at http://localhost:3500 (examples/12-geneweave.ts).

import { BASE, DB_PATH, makeOk, jfetch } from './e2e-helpers.mjs';

const ok = makeOk();
const ts = Date.now();
const email = `e2e_phase8_${ts}@example.com`;
const password = 'P@ssw0rd123';

console.log(`\n=== Phase 8 E2E (intent-RAG tool retrieval) — ${BASE} ===\n`);

// 1. Register
console.log('1. Register');
const reg = await jfetch('POST', '/api/auth/register', { body: { email, password, name: 'phase8' } });
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

// 4. Verify seeded kaggle_intent_rag row
console.log('4. List cost policies — verify seeded kaggle_intent_rag');
const list = await jfetch('GET', '/api/admin/cost-policies', { cookie });
ok(list.status === 200, `list status=${list.status}`);
const rows = list.body?.policies ?? list.body ?? [];
const seeded = rows.find((r) => r.key === 'kaggle_intent_rag');
ok(seeded !== undefined, 'kaggle_intent_rag is seeded');
ok(seeded.tier === 'balanced', `seeded.tier === 'balanced' (got ${seeded.tier})`);
const seededLevers = typeof seeded.levers_json === 'string' ? JSON.parse(seeded.levers_json) : seeded.levers_json;
ok(seededLevers?.toolSubset?.strategy === 'intent-rag', `seeded.toolSubset.strategy === 'intent-rag'`);
ok(seededLevers?.toolSubset?.topK === 6, `seeded.toolSubset.topK === 6`);
ok(seededLevers?.toolSubset?.minSimilarity === 0.15, `seeded.toolSubset.minSimilarity === 0.15`);
ok(Array.isArray(seededLevers?.toolSubset?.includeAlways), 'seeded.toolSubset.includeAlways is array');

// 5. POST a new intent-rag policy
console.log('5. POST custom intent-rag cost policy');
const key = `e2e_intent_rag_${ts}`;
const newLevers = {
  toolSubset: {
    strategy: 'intent-rag',
    topK: 8,
    minSimilarity: 0.2,
    includeAlways: ['final_answer', 'submit_prediction'],
  },
};
const created = await jfetch('POST', '/api/admin/cost-policies', {
  cookie, csrf,
  body: { key, tier: 'balanced', description: 'phase 8 e2e', levers_json: newLevers, enabled: 1 },
});
ok(created.status === 201, `create status=${created.status}`);
const id = created.body?.policy?.id ?? created.body?.id;
ok(typeof id === 'string' && id.length > 0, `created id present (${id})`);

// 6. GET roundtrip
console.log('6. GET roundtrip');
const got = await jfetch('GET', `/api/admin/cost-policies/${id}`, { cookie });
ok(got.status === 200, `get status=${got.status}`);
const gotPolicy = got.body?.policy ?? got.body;
ok(gotPolicy.key === key, 'key roundtrip');
const gotLevers = typeof gotPolicy.levers_json === 'string' ? JSON.parse(gotPolicy.levers_json) : gotPolicy.levers_json;
ok(gotLevers.toolSubset.strategy === 'intent-rag', 'strategy roundtrip');
ok(gotLevers.toolSubset.topK === 8, 'topK roundtrip');
ok(gotLevers.toolSubset.minSimilarity === 0.2, 'minSimilarity roundtrip');
ok(Array.isArray(gotLevers.toolSubset.includeAlways) && gotLevers.toolSubset.includeAlways.length === 2, 'includeAlways roundtrip');

// 7. PUT update
console.log('7. PUT update topK + minSimilarity');
const updated = await jfetch('PUT', `/api/admin/cost-policies/${id}`, {
  cookie, csrf,
  body: {
    levers_json: {
      toolSubset: {
        strategy: 'intent-rag',
        topK: 12,
        minSimilarity: 0.3,
        includeAlways: ['submit_prediction'],
      },
    },
  },
});
ok(updated.status === 200, `update status=${updated.status}`);
const got2 = await jfetch('GET', `/api/admin/cost-policies/${id}`, { cookie });
const got2Levers = typeof got2.body?.policy?.levers_json === 'string'
  ? JSON.parse(got2.body.policy.levers_json)
  : (got2.body?.policy?.levers_json ?? got2.body?.levers_json);
ok(got2Levers.toolSubset.topK === 12, `topK updated to 12`);
ok(got2Levers.toolSubset.minSimilarity === 0.3, `minSimilarity updated to 0.3`);
ok(got2Levers.toolSubset.includeAlways.length === 1, 'includeAlways shrank to 1');

// 8. DELETE + verify 404
console.log('8. DELETE + verify 404');
const del = await jfetch('DELETE', `/api/admin/cost-policies/${id}`, { cookie, csrf });
ok(del.status === 200 || del.status === 204, `delete status=${del.status}`);
const after = await jfetch('GET', `/api/admin/cost-policies/${id}`, { cookie });
ok(after.status === 404, `after delete status=${after.status}`);

console.log(`\n✅ Phase 8 E2E passed — ${ok.count()} assertions\n`);
