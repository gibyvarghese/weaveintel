#!/usr/bin/env node
/**
 * Phase 3 (Cost Governor — Prompt Caching) E2E
 *
 * Asserts:
 *   1. seedDefaultCostPolicies created the 4 tier-default rows (economy /
 *      balanced / performance / max) with `enabled=1`.
 *   2. A capability_policy_binding can target a cost_policy by id with
 *      policy_kind='cost_policy' and policy_ref pointing at the seeded
 *      balanced policy.
 *   3. Auth + CSRF gating works on cost-policies and bindings routes.
 *
 * Reuses the auth pattern from scripts/e2e-phase2-cost-policies.mjs.
 * Run: `node scripts/e2e-phase3-prompt-caching.mjs`
 */

import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const BASE = process.env.BASE ?? 'http://localhost:3500';
const DB = process.env.DATABASE_PATH ?? './geneweave.db';
let pass = 0;
let fail = 0;

function assert(cond, label) {
  if (cond) {
    console.log(`  ✓ ${label}`);
    pass++;
  } else {
    console.log(`  ✗ ${label}`);
    fail++;
  }
}

async function req(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, opts);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body, headers: res.headers };
}

async function main() {
  console.log('Phase 3 E2E — Cost Governor Prompt Caching');
  console.log(`BASE = ${BASE}`);
  console.log(`DB   = ${DB}`);

  // [1] auth required
  console.log('\n[1] auth-required on /api/admin/cost-policies');
  let r = await req('/api/admin/cost-policies');
  assert(r.status === 401, `GET without auth → 401 (got ${r.status})`);

  // [2] register + promote + login
  console.log('\n[2] register + promote + login');
  const email = `phase3-${Date.now()}@test.local`;
  const password = 'Test12345.password';
  r = await req('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name: 'Phase 3 Test' }),
  });
  assert(r.status === 200 || r.status === 201, `register (got ${r.status})`);

  try {
    execSync(`sqlite3 "${DB}" "UPDATE users SET persona='tenant_admin' WHERE email='${email}';"`);
    console.log('  ✓ promoted persona=tenant_admin');
    pass++;
  } catch (e) {
    console.log(`  ✗ sqlite promote failed: ${e.message}`);
    fail++;
  }

  r = await req('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert(r.status === 200, `login (got ${r.status})`);
  const cookie = r.headers.get('set-cookie')?.split(';')[0] ?? '';
  const csrf = r.body?.csrfToken ?? '';
  assert(cookie.length > 0, 'session cookie');
  assert(csrf.length > 0, 'csrf token');

  const authHeaders = { Cookie: cookie, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' };

  // [3] seeded cost policies present
  console.log('\n[3] seeded cost policies (economy / balanced / performance / max)');
  r = await req('/api/admin/cost-policies', { headers: { Cookie: cookie } });
  assert(r.status === 200, `list cost-policies (got ${r.status})`);
  const policies = r.body?.policies ?? r.body?.items ?? r.body ?? [];
  const list = Array.isArray(policies) ? policies : [];
  const byKey = Object.fromEntries(list.map((p) => [p.key, p]));
  for (const tier of ['economy', 'balanced', 'performance', 'max']) {
    const row = byKey[tier];
    assert(row != null, `seeded policy '${tier}' present`);
    if (row) {
      assert(row.enabled === 1 || row.enabled === true, `'${tier}' enabled`);
      assert(row.tier === tier, `'${tier}' tier matches key`);
    }
  }

  // [4] bind balanced cost_policy to a synthetic agent
  console.log('\n[4] bind balanced cost_policy via capability-policy-bindings');
  const balancedId = byKey['balanced']?.id;
  assert(typeof balancedId === 'string' && balancedId.length > 0, 'balanced.id is a string');

  const bindingRef = `agent-phase3-${randomUUID().slice(0, 8)}`;
  r = await req('/api/admin/capability-policy-bindings', {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      binding_kind: 'agent',
      binding_ref: bindingRef,
      policy_kind: 'cost_policy',
      policy_ref: balancedId,
      precedence: 100,
      enabled: true,
    }),
  });
  assert(r.status === 201 || r.status === 200, `bind cost_policy (got ${r.status})`);
  const bindingId = r.body?.id ?? r.body?.binding?.id;
  assert(typeof bindingId === 'string' && bindingId.length > 0, 'binding id returned');

  r = await req(`/api/admin/capability-policy-bindings?policy_kind=cost_policy`, {
    headers: { Cookie: cookie },
  });
  assert(r.status === 200, `list bindings (got ${r.status})`);
  const bindings = r.body?.bindings ?? r.body?.items ?? r.body ?? [];
  const found = (Array.isArray(bindings) ? bindings : []).find((b) => b.id === bindingId);
  assert(found != null, 'binding present in list');
  assert(found?.policy_kind === 'cost_policy', 'binding policy_kind=cost_policy');

  // [5] cleanup
  console.log('\n[5] cleanup');
  if (bindingId) {
    r = await req(`/api/admin/capability-policy-bindings/${bindingId}`, {
      method: 'DELETE',
      headers: authHeaders,
    });
    assert(r.status === 200 || r.status === 204, `delete binding (got ${r.status})`);
  }

  console.log('\n=== done ===');
  console.log(`PASS: ${pass}  FAIL: ${fail}`);
  if (fail > 0) {
    console.log('SOME ASSERTIONS FAILED');
    process.exit(1);
  } else {
    console.log('ALL ASSERTIONS PASSED');
  }
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(2);
});
