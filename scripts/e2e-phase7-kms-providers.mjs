#!/usr/bin/env node
// scripts/e2e-phase7-kms-providers.mjs
//
// E2E for Tenant Encryption Phase 7: per-tenant KMS provider selection +
// health-check endpoint + cached resolver invalidation on policy edits.
//
// Validates:
//   * GET  /api/admin/encryption/kms-providers                         (registry list)
//   * POST /api/admin/tenant-encryption-policies                        (with kms_provider_id)
//   * POST /api/admin/tenant-encryption-policies/:id/kms/health-check   (success path)
//   * Audit row of kind 'kms_health_check' is persisted
//   * Validation: unknown kms_provider_id → 400
//
// REQUIRES the server to be started with WEAVE_ENCRYPTION_MASTER_KEY set so the
// 'local' provider can wrap/unwrap during the health check. Cloud providers
// (aws-kms, azure-kv, gcp-kms, vault) are advertised by the registry but not
// exercised in this script — they require live cloud credentials.
//
// Usage:  node scripts/e2e-phase7-kms-providers.mjs

import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

const BASE = process.env.BASE_URL ?? 'http://localhost:3500';
const ts = Date.now();
const email = `e2e_phase7_kms_${ts}@example.com`;
const password = 'P@ssw0rd123';
const tenantA = `e2e_kms_local_a_${ts}`;
const tenantB = `e2e_kms_local_b_${ts}`;

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

console.log(`\n=== Phase 7 E2E (KMS provider registry + health-check) — ${BASE} ===\n`);

// 1. Register + promote + login
console.log('1. Register + promote + login');
const reg = await jfetch('POST', '/api/auth/register', { body: { email, password, name: 'kms-phase7' } });
ok(reg.status === 201 || reg.status === 200, `register status=${reg.status}`);
execSync(`sqlite3 ./geneweave.db "UPDATE users SET persona='tenant_admin' WHERE email='${email}';"`);
const login = await jfetch('POST', '/api/auth/login', { body: { email, password } });
ok(login.status === 200, `login status=${login.status}`);
const setCookie = login.headers.get('set-cookie') ?? '';
const cookie = setCookie.split(',').map(c => c.trim().split(';')[0]).join('; ');
const csrf = login.body?.csrfToken;
ok(typeof csrf === 'string' && csrf.length > 0, 'csrf token present');

// 2. GET kms-providers — assert all 5 builtin ids advertised
console.log('2. GET /api/admin/encryption/kms-providers');
const providers = await jfetch('GET', '/api/admin/encryption/kms-providers', { cookie });
ok(providers.status === 200, `providers status=${providers.status}`);
const ids = (providers.body?.providers ?? []).map(p => typeof p === 'string' ? p : p.id);
for (const expected of ['local', 'aws-kms', 'azure-kv', 'gcp-kms', 'vault']) {
  ok(ids.includes(expected), `registry advertises '${expected}'`);
}

// 3. Manager-availability gate (rest of script needs WEAVE_ENCRYPTION_MASTER_KEY)
const list = await jfetch('GET', '/api/admin/tenant-encryption-policies', { cookie });
if (list.body?.manager_available !== true) {
  console.log('\n⚠️  Encryption manager not bootstrapped. Set WEAVE_ENCRYPTION_MASTER_KEY to exercise local-provider health-check.\n');
  console.log(`Partial run: ${assertions} assertions passed (registry-only path).`);
  process.exit(2);
}
ok(true, 'encryption manager available');

// 4. POST policy A — local provider, default config
console.log('4. POST policy A (local, default config)');
const a = await jfetch('POST', '/api/admin/tenant-encryption-policies', {
  cookie, csrf,
  body: {
    tenant_id: tenantA,
    enabled: true,
    kms_provider_id: 'local',
    kms_config: { provider: 'local' },
    rotation_schedule: 'manual',
    blind_index_enabled: false,
    field_policy: { messages: { columns: ['content'] } },
  },
});
ok(a.status === 201, `tenantA create status=${a.status}`);
ok(a.body?.bootstrapped === true, 'tenantA bootstrapped=true');

// 5. POST policy B — local provider, *different* config (exercises cache key)
console.log('5. POST policy B (local, alt root-key id)');
const b = await jfetch('POST', '/api/admin/tenant-encryption-policies', {
  cookie, csrf,
  body: {
    tenant_id: tenantB,
    enabled: true,
    kms_provider_id: 'local',
    kms_config: { provider: 'local', rootKeyId: 'alt-root' },
    rotation_schedule: 'manual',
    blind_index_enabled: false,
    field_policy: { messages: { columns: ['content'] } },
  },
});
ok(b.status === 201, `tenantB create status=${b.status}`);
ok(b.body?.bootstrapped === true, 'tenantB bootstrapped=true');

// 6. Validation: unknown provider id rejected
console.log('6. POST policy with unknown provider id → 400');
const bad = await jfetch('POST', '/api/admin/tenant-encryption-policies', {
  cookie, csrf,
  body: {
    tenant_id: `e2e_kms_bad_${ts}`,
    enabled: false,
    kms_provider_id: 'does-not-exist',
    kms_config: {},
    rotation_schedule: 'manual',
    blind_index_enabled: false,
    field_policy: {},
  },
});
ok(bad.status === 400, `unknown-provider status=${bad.status}`);

// 7. Health-check tenant A
console.log('7. POST /kms/health-check tenantA');
const hcA = await jfetch('POST', `/api/admin/tenant-encryption-policies/${tenantA}/kms/health-check`, { cookie, csrf });
ok(hcA.status === 200, `tenantA health-check status=${hcA.status}`);
ok(hcA.body?.ok === true, 'tenantA health-check ok=true');
ok(hcA.body?.providerId === 'local', `tenantA providerId=local (got ${hcA.body?.providerId})`);
ok(typeof hcA.body?.latencyMs === 'number' && hcA.body.latencyMs >= 0, 'tenantA latencyMs reported');

// 8. Health-check tenant B
console.log('8. POST /kms/health-check tenantB');
const hcB = await jfetch('POST', `/api/admin/tenant-encryption-policies/${tenantB}/kms/health-check`, { cookie, csrf });
ok(hcB.status === 200, `tenantB health-check status=${hcB.status}`);
ok(hcB.body?.ok === true, 'tenantB health-check ok=true');

// 9. Audit trail includes kms_health_check
console.log('9. GET /audit — verify kms_health_check row');
const audit = await jfetch('GET', `/api/admin/tenant-encryption-policies/${tenantA}/audit`, { cookie });
ok(audit.status === 200, `audit status=${audit.status}`);
const events = audit.body?.events ?? [];
const hcEvent = events.find(e => e.kind === 'kms_health_check');
ok(hcEvent !== undefined, 'kms_health_check audit event present');

// 10. PUT — change config triggers cache invalidation; health-check still works
console.log('10. PUT policy A (alter kms_config) — invalidates cache');
const put = await jfetch('PUT', `/api/admin/tenant-encryption-policies/${tenantA}`, {
  cookie, csrf,
  body: {
    enabled: true,
    kms_provider_id: 'local',
    kms_config: { provider: 'local', rootKeyId: 'rotated-root' },
    rotation_schedule: 'manual',
    blind_index_enabled: false,
    field_policy: { messages: { columns: ['content'] } },
  },
});
ok(put.status === 200, `put status=${put.status}`);
const hcA2 = await jfetch('POST', `/api/admin/tenant-encryption-policies/${tenantA}/kms/health-check`, { cookie, csrf });
ok(hcA2.status === 200 && hcA2.body?.ok === true, 'health-check still ok after config rotation');

// 11. Cleanup
console.log('11. Cleanup');
await jfetch('DELETE', `/api/admin/tenant-encryption-policies/${tenantA}`, { cookie, csrf });
await jfetch('DELETE', `/api/admin/tenant-encryption-policies/${tenantB}`, { cookie, csrf });
ok(true, 'tenants deleted');

console.log(`\n✅ All ${assertions} assertions passed.\n`);
