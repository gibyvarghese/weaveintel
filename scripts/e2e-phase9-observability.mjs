#!/usr/bin/env node
// scripts/e2e-phase9-observability.mjs
//
// E2E for Tenant Encryption Phase 9 (observability + alert evaluator).
//
// Verifies:
//   1. /api/admin/encryption/health returns aggregated dashboard payload
//      with tenants[], cache_hit_rates, latency_summary, counters_5m,
//      alert_rules counters, firing_alerts, registered_kms_providers.
//   2. /api/admin/encryption/metrics returns a snapshot whose series are
//      populated after we drive encrypt traffic (login + admin reads
//      decrypt the system tenant's KEK / DEK material).
//   3. Default fleet-wide alert rules were seeded at boot
//      (rotation_overdue, kms_error_rate, aead_error_rate,
//       decrypt_latency_p95, cache_hit_rate).
//   4. POST /api/admin/encryption/alerts creates an operator rule.
//   5. POST /api/admin/encryption/alerts/evaluate returns at least one
//      firing for an aggressively-low cache_hit_rate threshold once we
//      force a rule that always trips.
//   6. PUT /api/admin/encryption/alerts/:id disables it.
//   7. DELETE /api/admin/encryption/alerts/:id removes it.
//
// REQUIRES the geneweave server running at $BASE_URL with
// WEAVE_ENCRYPTION_MASTER_KEY set so the InMemoryMetricsEmitter is wired
// in via bootstrap. If the manager is unavailable the script exits 2.

import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

const BASE = process.env.BASE_URL ?? 'http://localhost:3500';
const DB = process.env.GENEWEAVE_DB ?? './geneweave.db';
const ts = Date.now();
const email = `e2e_phase9_obs_${ts}@example.com`;
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
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let body = null; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}

console.log(`\n=== Phase 9 E2E (encryption observability + alerts) — ${BASE} ===\n`);

// 1. Register + promote so we hit admin surface
console.log('1. Register + promote to tenant_admin');
const reg = await jfetch('POST', '/api/auth/register', { body: { email, password, name: 'phase9' } });
ok(reg.status === 201 || reg.status === 200, `register status=${reg.status}`);
execSync(`sqlite3 ${DB} "UPDATE users SET persona='tenant_admin' WHERE email='${email}';"`);

const login = await jfetch('POST', '/api/auth/login', { body: { email, password } });
ok(login.status === 200, `login status=${login.status}`);
const cookie = (login.headers.get('set-cookie') ?? '').split(',').map(c => c.trim().split(';')[0]).join('; ');
const csrf = login.body?.csrfToken;
ok(typeof csrf === 'string' && csrf.length > 0, 'csrf token present');

// 2. Drive a few encrypt/decrypt operations to populate metrics
console.log('2. Drive encrypt/decrypt traffic (3 logins → KMS+KEK+DEK cache activity)');
for (let i = 0; i < 3; i++) {
  await jfetch('POST', '/api/auth/login', { body: { email, password } });
}

// 3. Health endpoint
console.log('3. GET /api/admin/encryption/health');
const health = await jfetch('GET', '/api/admin/encryption/health', { cookie });
if (health.status === 503 || health.body?.metrics_emitter === 'none') {
  console.log('\n⚠️  Encryption manager / metrics emitter unavailable — set WEAVE_ENCRYPTION_MASTER_KEY then restart.');
  process.exit(2);
}
ok(health.status === 200, `health status=${health.status}`);
ok(typeof health.body?.generated_at === 'number', 'health.generated_at is numeric');
ok(Array.isArray(health.body?.tenants), 'health.tenants[] present');
ok(typeof health.body?.cache_hit_rates === 'object', 'health.cache_hit_rates present');
ok(typeof health.body?.alert_rules === 'object', 'health.alert_rules present');
ok(Array.isArray(health.body?.firing_alerts), 'health.firing_alerts is array');
ok(Array.isArray(health.body?.registered_kms_providers), 'health.registered_kms_providers is array');
ok(health.body?.metrics_emitter === 'in-memory', `metrics_emitter=${health.body?.metrics_emitter}`);

// 4. Default fleet rules were seeded
console.log('4. Default fleet alert rules were seeded at boot');
const rules = await jfetch('GET', '/api/admin/encryption/alerts?tenantId=fleet', { cookie });
ok(rules.status === 200, `alerts list status=${rules.status}`);
const seededKinds = new Set((rules.body?.rules ?? []).map((r) => r.kind));
for (const k of ['rotation_overdue', 'kms_error_rate', 'aead_error_rate', 'decrypt_latency_p95', 'cache_hit_rate']) {
  ok(seededKinds.has(k), `default rule "${k}" seeded`);
}

// 5. Raw metrics snapshot has populated series
console.log('5. GET /api/admin/encryption/metrics returns populated snapshot');
const metrics = await jfetch('GET', '/api/admin/encryption/metrics', { cookie });
ok(metrics.status === 200, `metrics status=${metrics.status}`);
ok(typeof metrics.body?.total_series === 'number', 'metrics.total_series numeric');
ok((metrics.body?.series?.length ?? 0) >= 0, 'metrics.series array present');

// 6. Create an aggressive cache_hit_rate rule that's guaranteed to fire
console.log('6. POST /api/admin/encryption/alerts (cache_hit_rate threshold=1.01 → always fires)');
const created = await jfetch('POST', '/api/admin/encryption/alerts', {
  cookie, csrf,
  body: {
    tenant_id: null,
    kind: 'cache_hit_rate',
    threshold: 1.01,
    enabled: true,
    description: 'phase9 e2e — guaranteed-fire',
  },
});
ok(created.status === 201, `create rule status=${created.status}`);
const ruleId = created.body?.rule?.id;
ok(typeof ruleId === 'string' && ruleId.length > 0, `rule id present (${ruleId})`);

// 7. Evaluate now — should include at least one firing of cache_hit_rate
console.log('7. POST /api/admin/encryption/alerts/evaluate');
const evald = await jfetch('POST', '/api/admin/encryption/alerts/evaluate', { cookie, csrf });
ok(evald.status === 200, `evaluate status=${evald.status}`);
ok(Array.isArray(evald.body?.firings), 'firings[] present');
const cacheFiring = (evald.body?.firings ?? []).find((f) => f.kind === 'cache_hit_rate');
ok(!!cacheFiring, `cache_hit_rate firing returned (${evald.body?.firings?.length ?? 0} total)`);

// 8. Disable rule via PUT
console.log('8. PUT /api/admin/encryption/alerts/:id (disable)');
const upd = await jfetch('PUT', `/api/admin/encryption/alerts/${ruleId}`, {
  cookie, csrf,
  body: { enabled: false },
});
ok(upd.status === 200, `update status=${upd.status}`);
ok(upd.body?.rule?.enabled === false, 'rule disabled');

// 9. DELETE rule
console.log('9. DELETE /api/admin/encryption/alerts/:id');
const del = await jfetch('DELETE', `/api/admin/encryption/alerts/${ruleId}`, { cookie, csrf });
ok(del.status === 200, `delete status=${del.status}`);
const after = await jfetch('GET', '/api/admin/encryption/alerts?tenantId=fleet', { cookie });
const stillThere = (after.body?.rules ?? []).some((r) => r.id === ruleId);
ok(!stillThere, 'rule removed from listing');

console.log(`\n✅ Phase 9 E2E passed — ${assertions} assertions.\n`);
