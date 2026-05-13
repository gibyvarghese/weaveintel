#!/usr/bin/env node
/**
 * Phase 2 E2E — Cost Governor (Cost Policies + Capability Bindings)
 *
 * Validates against local geneweave on http://localhost:3500:
 *   1. Auth + CSRF gating on /api/admin/cost-policies
 *   2. Tier validation (400 on bad tier)
 *   3. Create cost_policies row → list → get → update → delete
 *   4. Bind cost policy via /api/admin/capability-policy-bindings with
 *      policy_kind='cost_policy' to demonstrate reuse of the unified
 *      bindings table.
 *
 * Run:  set +H && node scripts/e2e-phase2-cost-policies.mjs
 */
import { execSync } from 'node:child_process';

const BASE = process.env.BASE ?? 'http://localhost:3500';
let cookie = '';
let csrf = '';

async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const sc = res.headers.get('set-cookie');
  if (sc) {
    const m = sc.match(/gw_token=([^;]+)/);
    if (m) cookie = `gw_token=${m[1]}`;
  }
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { _raw: text }; }
  return { status: res.status, data };
}

function expect(label, cond, detail) {
  const tag = cond ? '✓' : '✗';
  console.log(`  ${tag} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) process.exitCode = 1;
}

console.log('Phase 2 E2E — Cost Governor');
console.log('BASE =', BASE);

// ── 1. Auth-required check ───────────────────────────────────────────
console.log('\n[1] auth-required on /api/admin/cost-policies');
const noauth = await api('GET', '/api/admin/cost-policies');
expect('GET without auth → 401', noauth.status === 401, `status=${noauth.status}`);

// ── 2. Auth ──────────────────────────────────────────────────────────
const email = `phase2cost-${Date.now()}@example.com`;
const password = 'Phase2Cost99';
console.log('\n[2] register + promote + login');
const reg = await api('POST', '/api/auth/register', { name: 'Phase2Cost', email, password });
expect('register 200/201', reg.status === 200 || reg.status === 201, `status=${reg.status}`);
csrf = reg.data.csrfToken || '';
execSync(`sqlite3 ./geneweave.db "UPDATE users SET persona='tenant_admin' WHERE email='${email}';"`);
const login = await api('POST', '/api/auth/login', { email, password });
expect('login 200', login.status === 200, `status=${login.status}`);
csrf = login.data.csrfToken || csrf;
expect('csrf token present', csrf.length > 0);

// ── 3. Validation: bad tier rejected ─────────────────────────────────
console.log('\n[3] tier validation');
const badTier = await api('POST', '/api/admin/cost-policies', {
  key: `test-bad-${Date.now()}`,
  tier: 'super-cheap',
});
expect('bad tier → 400', badTier.status === 400, `status=${badTier.status}`);

// ── 4. Create + list + get ───────────────────────────────────────────
console.log('\n[4] create cost policy');
const polKey = `e2e_econ_${Date.now()}`;
const created = await api('POST', '/api/admin/cost-policies', {
  key: polKey,
  tier: 'economy',
  description: 'E2E phase 2 economy policy',
  levers_json: { reasoningEffort: 'low' },
  enabled: true,
});
expect('create 201', created.status === 201, `status=${created.status}`);
const policyId = created.data?.policy?.id || created.data?.id;
expect('returns id', !!policyId);

const list = await api('GET', '/api/admin/cost-policies');
expect('list 200', list.status === 200, `status=${list.status}`);
const policies = list.data?.policies ?? [];
expect('list contains created', policies.some((p) => p.id === policyId));

const got = await api('GET', `/api/admin/cost-policies/${policyId}`);
expect('get 200', got.status === 200, `status=${got.status}`);
expect('tier=economy', (got.data?.policy ?? got.data)?.tier === 'economy');

// ── 5. Duplicate key rejected ────────────────────────────────────────
console.log('\n[5] duplicate key check');
const dup = await api('POST', '/api/admin/cost-policies', { key: polKey, tier: 'balanced' });
expect('duplicate key → 409', dup.status === 409, `status=${dup.status}`);

// ── 6. Update ────────────────────────────────────────────────────────
console.log('\n[6] update');
const updated = await api('PUT', `/api/admin/cost-policies/${policyId}`, {
  tier: 'balanced',
  description: 'updated to balanced',
});
expect('update 200', updated.status === 200, `status=${updated.status}`);
const got2 = await api('GET', `/api/admin/cost-policies/${policyId}`);
expect('tier=balanced after update', (got2.data?.policy ?? got2.data)?.tier === 'balanced');

// ── 7. Bind cost policy via capability_policy_bindings ───────────────
console.log('\n[7] bind cost policy via capability-policy-bindings');
const meshBindingRef = `mesh-e2e-${Date.now()}`;
const bind = await api('POST', '/api/admin/capability-policy-bindings', {
  binding_kind: 'mesh',
  binding_ref: meshBindingRef,
  policy_kind: 'cost_policy',
  policy_ref: policyId,
  precedence: 50,
  enabled: true,
});
expect('bind 201', bind.status === 201, `status=${bind.status}`);
const bindingId = bind.data?.binding?.id || bind.data?.id;
expect('binding id returned', !!bindingId);

const bindList = await api('GET',
  `/api/admin/capability-policy-bindings?policy_kind=cost_policy&binding_ref=${meshBindingRef}`);
expect('binding list 200', bindList.status === 200);
const bindings = bindList.data?.bindings ?? [];
expect('binding present', bindings.some((b) => b.id === bindingId));

// ── 8. Cleanup ───────────────────────────────────────────────────────
console.log('\n[8] cleanup');
const delBind = await api('DELETE', `/api/admin/capability-policy-bindings/${bindingId}`);
expect('binding delete 200/204', delBind.status === 200 || delBind.status === 204, `status=${delBind.status}`);
const delPol = await api('DELETE', `/api/admin/cost-policies/${policyId}`);
expect('policy delete 200/204', delPol.status === 200 || delPol.status === 204, `status=${delPol.status}`);

console.log('\n=== done ===');
if (process.exitCode === 1) {
  console.log('SOME ASSERTIONS FAILED');
} else {
  console.log('ALL ASSERTIONS PASSED');
}
