#!/usr/bin/env node
// scripts/e2e-w9b-user-surface.mjs
//
// W9b (audit-gap closure) — live-server end-to-end proof that the four
// user-surface gaps are wired through the real SQLite adapter, router, and
// RBAC gate (not just unit stubs):
//
//   Gap 1  POST/GET/DELETE /api/me/memories          (user-authored memory)
//   Gap 2  GET  /api/me/catalog                      (surface-catalog resolver,
//                                                      role-gated agent kind)
//   Gap 3  POST /api/me/notifications/actions        (idempotent task decision)
//   Gap 4  CRUD /api/admin/mode-labels + RBAC gate   (admin catalog, 403 for
//                                                      tenant_user)
//
// Usage: zsh> set +H && node scripts/e2e-w9b-user-surface.mjs
import { execSync } from 'node:child_process';
import { BASE, DB_PATH, makeOk, jfetch } from './e2e-helpers.mjs';

const ok = makeOk();
const ts = Date.now();
const password = 'P@ssw0rd123';

function cookieFrom(login) {
  return (login.headers.get('set-cookie') ?? '')
    .split(',').map((c) => c.trim().split(';')[0]).join('; ');
}

async function registerLogin(email, { admin = false } = {}) {
  await jfetch('POST', '/api/auth/register', { body: { email, password, name: email.split('@')[0] } });
  if (admin) execSync(`sqlite3 ${DB_PATH} "UPDATE users SET persona='tenant_admin' WHERE email='${email}';"`);
  const login = await jfetch('POST', '/api/auth/login', { body: { email, password } });
  return { cookie: cookieFrom(login), csrf: login.body?.csrfToken, status: login.status };
}

console.log(`\n=== W9b user-surface E2E — ${BASE} | DB=${DB_PATH} ===\n`);

// A plain tenant_user and a tenant_admin.
const userEmail = `e2e_w9b_user_${ts}@example.com`;
const adminEmail = `e2e_w9b_admin_${ts}@example.com`;

console.log('0. Register + login (tenant_user + tenant_admin)');
const user = await registerLogin(userEmail);
ok(user.status === 200 && typeof user.csrf === 'string', 'tenant_user logged in with csrf');
const admin = await registerLogin(adminEmail, { admin: true });
ok(admin.status === 200 && typeof admin.csrf === 'string', 'tenant_admin logged in with csrf');

// ── Gap 1: user-authored memory ───────────────────────────────────────────
console.log('\n1. Gap 1 — POST/GET/DELETE /api/me/memories');
const content = `e2e user fact ${ts}: prefers metric units`;
const created = await jfetch('POST', '/api/me/memories', { cookie: user.cookie, csrf: user.csrf, body: { content } });
ok(created.status === 201 && typeof created.body?.id === 'string', `created memory id=${created.body?.id}`);
ok(created.body?.kind === 'user-authored', 'kind is user-authored');
const memId = created.body.id;

const listed = await jfetch('GET', '/api/me/memories', { cookie: user.cookie, csrf: user.csrf });
ok(listed.status === 200, `list status=${listed.status}`);
const ua = listed.body?.memories?.['user-authored'] ?? [];
ok(ua.some((m) => m.id === memId), 'created memory appears in user-authored list');

// content-length validation is enforced (empty rejected)
const tooShort = await jfetch('POST', '/api/me/memories', { cookie: user.cookie, csrf: user.csrf, body: { content: '' } });
ok(tooShort.status === 400, 'empty content rejected (400)');

const del = await jfetch('DELETE', `/api/me/memories/${memId}`, { cookie: user.cookie, csrf: user.csrf });
ok(del.status === 200 || del.status === 204, `delete status=${del.status}`);

// ── Gap 2: surface catalog + role gating ───────────────────────────────────
console.log('\n2. Gap 2 — GET /api/me/catalog (role-gated agent kind)');
const catUser = await jfetch('GET', '/api/me/catalog?surface=web', { cookie: user.cookie, csrf: user.csrf });
ok(catUser.status === 200, `catalog status=${catUser.status}`);
ok(Array.isArray(catUser.body?.entries), 'entries array present');
ok(Array.isArray(catUser.body?.starterPrompts), 'starterPrompts sibling present');
const userHasMode = (catUser.body.entries ?? []).some((e) => e.kind === 'mode');
ok(userHasMode, 'tenant_user sees mode entries (seeded mode_labels)');
const userHasAgent = (catUser.body.entries ?? []).some((e) => e.kind === 'agent');
ok(!userHasAgent, 'tenant_user does NOT see agent kind (fail-closed access check)');

const catAdmin = await jfetch('GET', '/api/me/catalog?surface=web', { cookie: admin.cookie, csrf: admin.csrf });
ok(catAdmin.status === 200, `admin catalog status=${catAdmin.status}`);
// Admin may or may not see agents depending on seeded live-agents, but must never 500.
ok(Array.isArray(catAdmin.body?.entries), 'admin entries array present (no fault)');

// ── Gap 3: notification action resolution (idempotent) ──────────────────────
console.log('\n3. Gap 3 — POST /api/me/notifications/actions (idempotent task decision)');
const task = await jfetch('POST', '/api/me/tasks', {
  cookie: user.cookie, csrf: user.csrf,
  body: { title: `Approve deploy ${ts}`, actionable: true },
});
ok(task.status === 201 && typeof task.body?.id === 'string', `task created id=${task.body?.id}`);
const taskId = task.body.id;

const approve = await jfetch('POST', '/api/me/notifications/actions', {
  cookie: user.cookie, csrf: user.csrf, body: { taskId, actionId: 'approve' },
});
ok(approve.status === 200 && approve.body?.resolved === true, `approve resolved status=${approve.body?.status}`);
ok(approve.body?.status === 'completed', 'task status is completed after approve');

const again = await jfetch('POST', '/api/me/notifications/actions', {
  cookie: user.cookie, csrf: user.csrf, body: { taskId, actionId: 'approve' },
});
ok(again.status === 200 && again.body?.alreadyResolved === true, 'second approve is idempotent (alreadyResolved)');

const bad = await jfetch('POST', '/api/me/notifications/actions', {
  cookie: user.cookie, csrf: user.csrf, body: { taskId, actionId: 'banana' },
});
ok(bad.status === 400, 'invalid actionId rejected (400)');

const crossPrincipal = await jfetch('POST', '/api/me/notifications/actions', {
  cookie: admin.cookie, csrf: admin.csrf, body: { taskId, actionId: 'approve' },
});
ok(crossPrincipal.status === 404, "another principal's task is hidden behind 404");

// ── Gap 4: admin catalog CRUD + RBAC gate ──────────────────────────────────
console.log('\n4. Gap 4 — admin catalog CRUD + RBAC gate');
// tenant_user must be blocked from the admin route (403).
const forbidden = await jfetch('POST', '/api/admin/mode-labels', {
  cookie: user.cookie, csrf: user.csrf,
  body: { surface_id: 'web', mode_key: `hack_${ts}`, label: 'Hax' },
});
ok(forbidden.status === 403, `tenant_user blocked by RBAC gate (status=${forbidden.status})`);

const modeKey = `e2e_mode_${ts}`;
const createMode = await jfetch('POST', '/api/admin/mode-labels', {
  cookie: admin.cookie, csrf: admin.csrf,
  body: { surface_id: 'web', mode_key: modeKey, label: 'E2E Mode', is_default: false },
});
ok(createMode.status === 201, `admin created mode label (status=${createMode.status})`);
const modeId = createMode.body?.['mode-label']?.id;
ok(typeof modeId === 'string', `mode label id=${modeId}`);

// surfaceId allow-list
const badSurface = await jfetch('POST', '/api/admin/mode-labels', {
  cookie: admin.cookie, csrf: admin.csrf,
  body: { surface_id: 'watch', mode_key: `x_${ts}`, label: 'X' },
});
ok(badSurface.status === 400, 'invalid surface_id rejected (400)');

// duplicate mode_key on same surface
const dup = await jfetch('POST', '/api/admin/mode-labels', {
  cookie: admin.cookie, csrf: admin.csrf,
  body: { surface_id: 'web', mode_key: modeKey, label: 'Dup' },
});
ok(dup.status === 409, 'duplicate mode_key on surface rejected (409)');

const updated = await jfetch('PUT', `/api/admin/mode-labels/${modeId}`, {
  cookie: admin.cookie, csrf: admin.csrf, body: { label: 'E2E Mode v2', enabled: false },
});
ok(updated.status === 200 && updated.body?.['mode-label']?.label === 'E2E Mode v2', 'mode label updated');
ok(updated.body?.['mode-label']?.enabled === 0, 'enabled toggled off');

// starter prompt CRUD
const sp = await jfetch('POST', '/api/admin/starter-prompts', {
  cookie: admin.cookie, csrf: admin.csrf,
  body: { surface_id: 'web', label: `E2E starter ${ts}`, prompt_text: 'Summarize my day' },
});
ok(sp.status === 201, `starter prompt created (status=${sp.status})`);
const spId = sp.body?.['starter-prompt']?.id;

const spDel = await jfetch('DELETE', `/api/admin/starter-prompts/${spId}`, { cookie: admin.cookie, csrf: admin.csrf });
ok(spDel.status === 200 && spDel.body?.deleted === true, 'starter prompt deleted');

const modeDel = await jfetch('DELETE', `/api/admin/mode-labels/${modeId}`, { cookie: admin.cookie, csrf: admin.csrf });
ok(modeDel.status === 200 && modeDel.body?.deleted === true, 'mode label deleted');

const missing = await jfetch('PUT', `/api/admin/mode-labels/${modeId}`, {
  cookie: admin.cookie, csrf: admin.csrf, body: { label: 'gone' },
});
ok(missing.status === 404, 'update of deleted mode label returns 404');

console.log(`\n=== W9b user-surface E2E PASSED — ${ok.count()} assertions ===\n`);
