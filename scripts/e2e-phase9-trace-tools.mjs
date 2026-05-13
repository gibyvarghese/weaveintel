#!/usr/bin/env node
// scripts/e2e-phase9-trace-tools.mjs
//
// E2E for Live-Agents Phase 9: prove that the extended
// `prepare_config_json.tools` recipe shape — `{ "tools": { "traceTools":
// "$auto" } }` and `{ "tools": { "auto": true, "traceTools": "$auto" } }`
// — round-trips through the live_agents REST API and persists into
// `live_agents.prepare_config_json`.
//
// Usage: zsh> set +H && node scripts/e2e-phase9-trace-tools.mjs
//
// Requires server running at http://localhost:3500 (examples/12-geneweave.ts).

import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL ?? 'http://localhost:3500';
const ts = Date.now();
const email = `e2e_phase9_${ts}@example.com`;
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

console.log(`\n=== Phase 9 E2E (live-agents trace tools) — ${BASE} ===\n`);

// 1. Register
console.log('1. Register');
const reg = await jfetch('POST', '/api/auth/register', { body: { email, password, name: 'phase9' } });
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

// 4. Find or create a mesh_def + live_mesh to attach the agent to.
// Re-use any existing live_mesh row to avoid mesh-def schema coupling.
console.log('4. Locate an existing live_mesh');
const meshList = await jfetch('GET', '/api/admin/live-meshes', { cookie });
ok(meshList.status === 200, `list meshes status=${meshList.status}`);
const meshes = meshList.body?.['live-meshes'] ?? [];
let meshId = meshes[0]?.id;
if (!meshId) {
  // Attempt to seed one ourselves via raw sqlite. We need a mesh_def first.
  console.log('   No live_mesh found — creating mesh_def + live_mesh via sqlite');
  const meshDefId = `e2e-mdef-${ts}`;
  meshId = `e2e-lmesh-${ts}`;
  const sql = [
    `INSERT OR IGNORE INTO live_mesh_defs (id, tenant_id, key, name, description, dual_control_required_for, status, created_at, updated_at)
       VALUES ('${meshDefId}', NULL, 'e2e_p9_${ts}', 'E2E P9', 'phase9 e2e', '[]', 'ACTIVE', datetime('now'), datetime('now'));`,
    `INSERT OR IGNORE INTO live_meshes (id, tenant_id, mesh_def_id, name, status, domain, dual_control_required_for, owner_human_id, mcp_server_ref, account_id, context_json, created_at, updated_at)
       VALUES ('${meshId}', NULL, '${meshDefId}', 'E2E P9 Mesh', 'ACTIVE', NULL, '[]', NULL, NULL, NULL, NULL, datetime('now'), datetime('now'));`,
  ].join('\n');
  execSync(`sqlite3 ./geneweave.db "${sql.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`);
  ok(true, `seeded live_mesh ${meshId}`);
}
ok(typeof meshId === 'string' && meshId.length > 0, `meshId resolved (${meshId})`);

// 5. POST a live_agent with traceTools-only recipe
console.log('5. POST live_agent with prepare_config_json.tools.traceTools=$auto');
const recipe1 = {
  systemPrompt: 'You are a long-running agent. Use trace tools to inspect prior tick activity before acting.',
  tools: { traceTools: '$auto' },
};
const created = await jfetch('POST', '/api/admin/live-agents', {
  cookie, csrf,
  body: {
    mesh_id: meshId,
    role_key: `e2e_p9_role_${ts}`,
    name: `E2E Phase 9 Agent ${ts}`,
    role_label: 'Trace Inspector',
    persona: 'long-running observer',
    objectives: '[]',
    success_indicators: '[]',
    status: 'ACTIVE',
    prepare_config_json: JSON.stringify(recipe1),
  },
});
ok(created.status === 201, `create status=${created.status}`);
const agentId = created.body?.['live-agent']?.id;
ok(typeof agentId === 'string' && agentId.length > 0, `agent id present (${agentId})`);

// 6. GET roundtrip — verify recipe persisted
console.log('6. GET roundtrip');
const got = await jfetch('GET', `/api/admin/live-agents/${agentId}`, { cookie });
ok(got.status === 200, `get status=${got.status}`);
const agent = got.body?.['live-agent'];
ok(agent.prepare_config_json !== null && agent.prepare_config_json !== undefined, 'prepare_config_json persisted');
const parsed = typeof agent.prepare_config_json === 'string'
  ? JSON.parse(agent.prepare_config_json)
  : agent.prepare_config_json;
ok(parsed.tools?.traceTools === '$auto', `tools.traceTools === '$auto'`);
ok(typeof parsed.systemPrompt === 'string' && parsed.systemPrompt.length > 0, 'systemPrompt roundtrip');

// 7. PUT — switch to merge form (auto:true + traceTools:$auto)
console.log('7. PUT update to merge form');
const recipe2 = {
  systemPrompt: 'Updated prompt',
  tools: { auto: true, traceTools: '$auto' },
};
const updated = await jfetch('PUT', `/api/admin/live-agents/${agentId}`, {
  cookie, csrf,
  body: { prepare_config_json: JSON.stringify(recipe2) },
});
ok(updated.status === 200, `update status=${updated.status}`);
const got2 = await jfetch('GET', `/api/admin/live-agents/${agentId}`, { cookie });
const parsed2 = typeof got2.body['live-agent'].prepare_config_json === 'string'
  ? JSON.parse(got2.body['live-agent'].prepare_config_json)
  : got2.body['live-agent'].prepare_config_json;
ok(parsed2.tools?.auto === true, 'tools.auto === true after PUT');
ok(parsed2.tools?.traceTools === '$auto', 'tools.traceTools === $auto after PUT');
ok(parsed2.systemPrompt === 'Updated prompt', 'systemPrompt updated');

// 8. PUT — verify legacy "$auto" string form still accepted (back-compat)
console.log('8. PUT legacy "$auto" string form still accepted');
const recipe3 = { systemPrompt: 'legacy', tools: '$auto' };
const upd3 = await jfetch('PUT', `/api/admin/live-agents/${agentId}`, {
  cookie, csrf,
  body: { prepare_config_json: JSON.stringify(recipe3) },
});
ok(upd3.status === 200, `legacy PUT status=${upd3.status}`);
const got3 = await jfetch('GET', `/api/admin/live-agents/${agentId}`, { cookie });
const parsed3 = typeof got3.body['live-agent'].prepare_config_json === 'string'
  ? JSON.parse(got3.body['live-agent'].prepare_config_json)
  : got3.body['live-agent'].prepare_config_json;
ok(parsed3.tools === '$auto', 'tools === "$auto" (legacy form preserved)');

// 9. DELETE + verify 404
console.log('9. DELETE + verify 404');
const del = await jfetch('DELETE', `/api/admin/live-agents/${agentId}`, { cookie, csrf });
ok(del.status === 200 || del.status === 204, `delete status=${del.status}`);
const after = await jfetch('GET', `/api/admin/live-agents/${agentId}`, { cookie });
ok(after.status === 404, `after delete status=${after.status}`);

console.log(`\n✅ Phase 9 E2E passed — ${assertions} assertions\n`);
