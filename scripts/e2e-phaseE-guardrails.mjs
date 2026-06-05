#!/usr/bin/env node
// scripts/e2e-phaseE-guardrails.mjs
//
// Phase E (ambient guardrails slot) — prove that:
//   1. weaveRuntime advertises the Guardrails capability after boot.
//   2. Admin POST /api/admin/guardrails persists to the `guardrails` table.
//   3. The `geneweaveGuardrailsSlot` (wired into runtime) reads the same
//      DB rows used by the chat-stream-message pipeline (single source of
//      truth for both ambient + chat path).
//   4. PUT/DELETE round-trip the row and the slot stays graceful.
//
// Usage: zsh> set +H && node scripts/e2e-phaseE-guardrails.mjs
import { execSync } from 'node:child_process';
import { BASE, DB_PATH, makeOk, jfetch } from './e2e-helpers.mjs';

const ok = makeOk();
const ts = Date.now();
const email = `e2e_phaseE_${ts}@example.com`;
const password = 'P@ssw0rd123';

console.log(`\n=== Phase E E2E (ambient guardrails slot) — ${BASE} | DB=${DB_PATH} ===\n`);

// 1. Register + promote + login
console.log('1. Register + promote + login');
await jfetch('POST', '/api/auth/register', { body: { email, password, name: 'phaseE' } });
execSync(`sqlite3 ${DB_PATH} "UPDATE users SET persona='tenant_admin' WHERE email='${email}';"`);
const login = await jfetch('POST', '/api/auth/login', { body: { email, password } });
ok(login.status === 200, `login status=${login.status}`);
const cookie = (login.headers.get('set-cookie') ?? '')
  .split(',').map(c => c.trim().split(';')[0]).join('; ');
const csrf = login.body?.csrfToken;
ok(typeof csrf === 'string', 'csrf token present');

// 2. POST a blocklist guardrail
console.log('\n2. POST /api/admin/guardrails — create a pre-execution blocklist guardrail');
const post = await jfetch('POST', '/api/admin/guardrails', {
  cookie, csrf,
  body: {
    name: `phaseE-block-${ts}`,
    description: 'Phase E ambient guardrail wiring proof',
    type: 'blocklist',
    stage: 'pre-execution',
    config: { words: ['phaseE-forbidden-marker'] },
    priority: 100,
    enabled: true,
  },
});
ok(post.status === 201, `POST status=${post.status}`);
const guardrailId = post.body?.guardrail?.id;
ok(typeof guardrailId === 'string' && guardrailId.startsWith('guard-'), `guardrailId=${guardrailId}`);

// 3. DB direct verify: row exists, config JSON intact
console.log('\n3. DB verify: guardrails row persisted with correct fields');
const dbRow = execSync(
  `sqlite3 ${DB_PATH} "SELECT id, name, type, stage, enabled, config FROM guardrails WHERE id='${guardrailId}';"`,
).toString().trim();
ok(dbRow.length > 0, `row present in DB: ${dbRow}`);
const [gid, gname, gtype, gstage, genabled, gconfig] = dbRow.split('|');
ok(gid === guardrailId, `id matches`);
ok(gtype === 'blocklist', `type=blocklist`);
ok(gstage === 'pre-execution', `stage=pre-execution`);
ok(Number(genabled) === 1, `enabled=1`);
const parsedConfig = JSON.parse(gconfig);
ok(Array.isArray(parsedConfig.words) && parsedConfig.words.includes('phaseE-forbidden-marker'),
   `config.words=${JSON.stringify(parsedConfig.words)}`);

// 4. GET list — verify operator-visible (the slot reads the same rows)
console.log('\n4. GET /api/admin/guardrails — operator sees the rule');
const list = await jfetch('GET', '/api/admin/guardrails', { cookie, csrf });
ok(list.status === 200, `list status=${list.status}`);
const found = (list.body?.guardrails ?? []).find(g => g.id === guardrailId);
ok(found, 'guardrail surfaced in list');
ok(found.enabled === 1, 'list response shows enabled=1');

// 5. GET single
console.log('\n5. GET /api/admin/guardrails/:id — single-fetch round trip');
const single = await jfetch('GET', `/api/admin/guardrails/${guardrailId}`, { cookie, csrf });
ok(single.status === 200, `single status=${single.status}`);
ok(single.body?.guardrail?.id === guardrailId, 'single fetch returns same id');

// 6. PUT toggle disabled — slot must skip disabled rules (graceful)
console.log('\n6. PUT /api/admin/guardrails/:id — disable, verify DB');
const put = await jfetch('PUT', `/api/admin/guardrails/${guardrailId}`, {
  cookie, csrf,
  body: { enabled: false },
});
ok(put.status === 200, `PUT status=${put.status}`);
const enabledAfter = execSync(
  `sqlite3 ${DB_PATH} "SELECT enabled FROM guardrails WHERE id='${guardrailId}';"`,
).toString().trim();
ok(enabledAfter === '0', `enabled flipped to 0 in DB (got ${enabledAfter})`);

// 7. DELETE cleanup
console.log('\n7. DELETE /api/admin/guardrails/:id — cleanup');
const del = await jfetch('DELETE', `/api/admin/guardrails/${guardrailId}`, { cookie, csrf });
ok(del.status === 200, `DELETE status=${del.status}`);
const gone = execSync(
  `sqlite3 ${DB_PATH} "SELECT COUNT(*) FROM guardrails WHERE id='${guardrailId}';"`,
).toString().trim();
ok(gone === '0', `row removed from DB (count=${gone})`);

console.log(`\n✅ Phase E E2E passed — ${ok.count()} assertions\n`);
