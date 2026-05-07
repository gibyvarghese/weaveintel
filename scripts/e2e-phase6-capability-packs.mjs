#!/usr/bin/env node
/**
 * Phase 6 E2E — Capability Packs
 *
 * Validates against local geneweave on http://localhost:3500:
 *   1. Auth + CSRF gating on /api/admin/capability-packs
 *   2. Manifest validation (400 on bad shape)
 *   3. Create draft pack → list → get → export roundtrip
 *   4. Publish (PUT status=published)
 *   5. Install → verify ledger + child rows created (workflow_defs)
 *   6. List installations → uninstall → verify rows removed
 *   7. Delete pack
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

console.log('Phase 6 E2E — Capability Packs');
console.log('BASE =', BASE);

// ── Auth ────────────────────────────────────────────────────────────
const email = `phase6-${Date.now()}@example.com`;
const password = 'Phase6Test99';
console.log('\n[1] register + promote + login');
const reg = await api('POST', '/api/auth/register', { name: 'Phase6', email, password });
expect('register 200/201', reg.status === 200 || reg.status === 201, `status=${reg.status}`);
csrf = reg.data.csrfToken || '';
execSync(`sqlite3 ./geneweave.db "UPDATE users SET persona='tenant_admin' WHERE email='${email}';"`);
const login = await api('POST', '/api/auth/login', { email, password });
expect('login 200', login.status === 200, `status=${login.status}`);
csrf = login.data.csrfToken || csrf;

// ── Auth gating ─────────────────────────────────────────────────────
console.log('\n[2] auth gating');
const saved = cookie; cookie = '';
const noAuth = await api('GET', '/api/admin/capability-packs');
expect('GET unauthenticated → 401', noAuth.status === 401);
cookie = saved;

// ── Manifest validation ─────────────────────────────────────────────
console.log('\n[3] POST with invalid manifest → 400');
const bad = await api('POST', '/api/admin/capability-packs', { manifest: { manifestVersion: '1', key: 'BAD KEY' } });
expect('400 on bad manifest', bad.status === 400, `status=${bad.status}`);
expect('issues returned', Array.isArray(bad.data.issues));

// ── Create draft ────────────────────────────────────────────────────
console.log('\n[4] CREATE draft pack');
const tag = `e2e_${Date.now()}`;
const wfId = `wf-${tag}`;
const manifest = {
  manifestVersion: '1',
  key: `demo.${tag}`,
  version: '1.0.0',
  name: 'Demo Pack',
  description: 'A demo pack for E2E testing.',
  authoredBy: 'e2e@weaveintel.dev',
  contents: {
    workflow_defs: [
      {
        id: wfId,
        name: 'Demo Greet',
        description: 'A demo greet workflow',
        version: '1.0.0',
        steps: [{ id: 's1', name: 'noop', type: 'deterministic', handler: 'noop' }],
        entry_step_id: 's1',
        enabled: 1,
      },
    ],
  },
};
const create = await api('POST', '/api/admin/capability-packs', { manifest });
expect('CREATE 201', create.status === 201, `status=${create.status} body=${JSON.stringify(create.data).slice(0, 200)}`);
const packId = create.data.pack?.id;
expect('pack id returned', typeof packId === 'string');

// ── Duplicate → 409 ─────────────────────────────────────────────────
console.log('\n[5] Re-POST same key+version → 409');
const dup = await api('POST', '/api/admin/capability-packs', { manifest });
expect('duplicate 409', dup.status === 409);

// ── List + get + export ─────────────────────────────────────────────
console.log('\n[6] LIST + GET + EXPORT');
const list = await api('GET', '/api/admin/capability-packs');
expect('LIST 200', list.status === 200);
expect('LIST contains pack', list.data.packs.some((p) => p.id === packId));
const get = await api('GET', `/api/admin/capability-packs/${packId}`);
expect('GET 200', get.status === 200);
expect('GET status=draft', get.data.pack?.status === 'draft');
const exp = await api('GET', `/api/admin/capability-packs/${packId}/export`);
expect('EXPORT 200', exp.status === 200);
expect('exported manifest matches key', exp.data.manifest?.key === manifest.key);

// ── Publish ─────────────────────────────────────────────────────────
console.log('\n[7] PUT status=published');
const pub = await api('PUT', `/api/admin/capability-packs/${packId}`, { status: 'published' });
expect('PUT 200', pub.status === 200);
expect('status=published', pub.data.pack?.status === 'published');

// ── Install ─────────────────────────────────────────────────────────
console.log('\n[8] INSTALL pack');
const inst = await api('POST', `/api/admin/capability-packs/${packId}/install`, { skip_preconditions: true });
expect('INSTALL 201', inst.status === 201, `status=${inst.status} body=${JSON.stringify(inst.data).slice(0, 200)}`);
const installationId = inst.data.installation?.id;
expect('installation id returned', typeof installationId === 'string');
expect('ledger has workflow_defs', Array.isArray(inst.data.ledger?.rowsByKind?.workflow_defs));

// ── Verify child workflow_defs row created ─────────────────────────
console.log('\n[9] Verify workflow_defs row exists');
const wfs = await api('GET', '/api/admin/workflows');
const wfFound = (wfs.data.workflows ?? []).some((w) => w.id === wfId);
expect('workflow row created', wfFound);

// ── List installations ──────────────────────────────────────────────
console.log('\n[10] LIST installations');
const ins = await api('GET', '/api/admin/capability-pack-installations');
expect('LIST 200', ins.status === 200);
expect('contains installation', ins.data.installations.some((i) => i.id === installationId));

// ── Uninstall ───────────────────────────────────────────────────────
console.log('\n[11] UNINSTALL');
const uni = await api('POST', `/api/admin/capability-pack-installations/${installationId}/uninstall`);
expect('UNINSTALL 200', uni.status === 200, `status=${uni.status}`);
expect('uninstalled_at set', !!uni.data.installation?.uninstalled_at);

// ── Verify workflow_defs row removed ────────────────────────────────
console.log('\n[12] Verify workflow_defs row removed');
const wfs2 = await api('GET', '/api/admin/workflows');
const wfStillThere = (wfs2.data.workflows ?? []).some((w) => w.id === wfId);
expect('workflow row removed', !wfStillThere);

// ── Re-uninstall → 409 ──────────────────────────────────────────────
console.log('\n[13] Re-UNINSTALL → 409');
const uni2 = await api('POST', `/api/admin/capability-pack-installations/${installationId}/uninstall`);
expect('re-uninstall 409', uni2.status === 409);

// ── Delete pack ─────────────────────────────────────────────────────
console.log('\n[14] DELETE pack');
const del = await api('DELETE', `/api/admin/capability-packs/${packId}`);
expect('DELETE 200', del.status === 200);
const get404 = await api('GET', `/api/admin/capability-packs/${packId}`);
expect('GET after delete → 404', get404.status === 404);

console.log('\n' + (process.exitCode ? 'FAILED' : 'PASS'));
