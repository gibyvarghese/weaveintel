#!/usr/bin/env node
// scripts/e2e-phaseJ-workflows.mjs
//
// Phase J — Workflow package full integration end-to-end.
//
// Verifies the workflow engine wiring against a running geneweave server:
//   1. The 3 example workflows are auto-seeded (`wf-greet-subflow`,
//      `wf-greet-parent`, `wf-tool-calc`).
//   2. The handler-kind catalog advertises the new resolvers
//      (`subworkflow` is always present; `prompt` is present because
//      `promptDeps` is wired at boot).
//   3. POST /api/admin/workflows/:id/run runs `wf-greet-parent`
//      synchronously to terminal — proves the parent → subflow path
//      runs end-to-end through the wired stores.
//   4. POST /api/admin/workflows/:id/run runs `wf-tool-calc` which
//      invokes the `calculator` built-in via the tool resolver.
//   5. The DB-backed `workflow_runs` table contains a row for each
//      run, proving the run repository is plumbed (not in-memory).
//
// Usage: zsh> set +H && node scripts/e2e-phaseJ-workflows.mjs
// Requires server running at http://localhost:3500.
import { execSync } from 'node:child_process';
import { BASE, DB_PATH, makeOk, jfetch } from './e2e-helpers.mjs';

const ok = makeOk();
const ts = Date.now();
const email = `e2e_phaseJ_${ts}@example.com`;
const password = 'P@ssw0rd123';

console.log(`\n=== Phase J E2E (workflow integration) — ${BASE} ===\n`);

// 1. Auth quartet
console.log('1. Register + promote + login');
await jfetch('POST', '/api/auth/register', { body: { email, password, name: 'phaseJ' } });
execSync(`sqlite3 ${DB_PATH} "UPDATE users SET persona='tenant_admin' WHERE email='${email}';"`);
const login = await jfetch('POST', '/api/auth/login', { body: { email, password } });
ok(login.status === 200, `login status=${login.status}`);
const cookie = (login.headers.get('set-cookie') ?? '')
  .split(',').map(c => c.trim().split(';')[0]).join('; ');
const csrf = login.body?.csrfToken;
ok(typeof csrf === 'string', 'csrf token present');

// 2. Verify seeded workflows
console.log('\n2. GET /api/admin/workflows — seeds present');
const list = await jfetch('GET', '/api/admin/workflows', { cookie, csrf });
ok(list.status === 200, `list status=${list.status}`);
const ids = (list.body?.workflows ?? []).map((w) => w.id);
ok(ids.includes('wf-greet-subflow'), 'wf-greet-subflow seeded');
ok(ids.includes('wf-greet-parent'), 'wf-greet-parent seeded');
ok(ids.includes('wf-tool-calc'), 'wf-tool-calc seeded');

// 3. Verify handler-kind catalog includes new resolvers
console.log('\n3. Verify handler-kind catalog (workflow_handler_kinds)');
const kinds = execSync(
  `sqlite3 ${DB_PATH} "SELECT kind FROM workflow_handler_kinds ORDER BY kind;"`,
).toString().trim().split('\n').filter(Boolean);
ok(kinds.includes('subworkflow'), `subworkflow resolver registered (got ${kinds.join(',')})`);
ok(kinds.includes('prompt'), `prompt resolver registered (got ${kinds.join(',')})`);

// 4. Run the parent workflow (proves subflow path)
console.log('\n4. POST /api/admin/workflows/wf-greet-parent/run');
const runParent = await fetch(`${BASE}/api/admin/workflows/wf-greet-parent/run`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
  body: JSON.stringify({ variables: { name: 'WeaveIntel' } }),
});
const runParentBody = await runParent.json();
ok(runParent.status === 201, `parent run status=${runParent.status}`);
ok(runParentBody?.run?.status === 'completed', `parent run completed (got ${runParentBody?.run?.status})`);
const parentRunId = runParentBody?.run?.id;
ok(typeof parentRunId === 'string', 'parent run id present');

// 5. Run the tool workflow
console.log('\n5. POST /api/admin/workflows/wf-tool-calc/run');
const runTool = await fetch(`${BASE}/api/admin/workflows/wf-tool-calc/run`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrf },
  body: JSON.stringify({ variables: { expression: '7 * 6' } }),
});
const runToolBody = await runTool.json();
ok(runTool.status === 201, `tool run status=${runTool.status}`);
ok(runToolBody?.run?.status === 'completed', `tool run completed (got ${runToolBody?.run?.status})`);

// 6. Verify DB-backed run repository wrote rows
console.log('\n6. Verify workflow_runs DB rows (durable repository)');
const parentRowCount = execSync(
  `sqlite3 ${DB_PATH} "SELECT COUNT(*) FROM workflow_runs WHERE workflow_id='wf-greet-parent';"`,
).toString().trim();
ok(Number(parentRowCount) >= 1, `workflow_runs has parent row (count=${parentRowCount})`);

const subRowCount = execSync(
  `sqlite3 ${DB_PATH} "SELECT COUNT(*) FROM workflow_runs WHERE workflow_id='wf-greet-subflow';"`,
).toString().trim();
ok(Number(subRowCount) >= 1, `workflow_runs has subflow row (count=${subRowCount}) — proves parent invoked subflow`);

const toolRowCount = execSync(
  `sqlite3 ${DB_PATH} "SELECT COUNT(*) FROM workflow_runs WHERE workflow_id='wf-tool-calc';"`,
).toString().trim();
ok(Number(toolRowCount) >= 1, `workflow_runs has tool row (count=${toolRowCount})`);

// 7. Cleanup
console.log('\n7. Cleanup');
execSync(`sqlite3 ${DB_PATH} "DELETE FROM users WHERE email='${email}';"`);
ok(true, 'cleanup done');

console.log(`\n✅ Phase J E2E passed — ${ok.count()} assertions\n`);
