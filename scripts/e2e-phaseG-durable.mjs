#!/usr/bin/env node
// scripts/e2e-phaseG-durable.mjs
//
// Phase G (durable subsystems) — verify OAuth flow state and trigger
// rate-limit windows are persisted via `runtime.persistence.kv` (the
// `runtime_kv` table populated by `weaveSqlitePersistence`).
//
// What it verifies end-to-end:
//   1. POST /api/oauth/authorize-url writes a row to `runtime_kv` with
//      a key prefixed `oauth-flow:` — proves `OAuthClient` was swapped
//      to the durable state store at boot.
//   2. POST /api/admin/triggers creates a manual trigger with
//      rate_limit_per_minute=2; firing the trigger 3 times in the same
//      minute yields exactly 2 dispatched + 1 rate_limited invocations.
//      The `runtime_kv` table contains a row prefixed `trigger-rate:`
//      for the trigger's window.
//
// Usage (one shell):
//   zsh> set +H
//   zsh> bash /tmp/start-phaseG.sh    # boots server with master key + fake oauth creds
//   (in second shell)
//   zsh> DATABASE_PATH=/tmp/geneweave-phaseG.db node scripts/e2e-phaseG-durable.mjs
import { execSync } from 'node:child_process';
import { BASE, DB_PATH, makeOk, jfetch } from './e2e-helpers.mjs';

const ok = makeOk();
const ts = Date.now();
const email = `e2e_phaseG_${ts}@example.com`;
const password = 'P@ssw0rd123';

console.log(`\n=== Phase G E2E (durable subsystems) — ${BASE} ===\n`);

// 1. Register + promote + login
console.log('1. Register + promote + login');
await jfetch('POST', '/api/auth/register', { body: { email, password, name: 'phaseG' } });
execSync(`sqlite3 ${DB_PATH} "UPDATE users SET persona='tenant_admin' WHERE email='${email}';"`);
const login = await jfetch('POST', '/api/auth/login', { body: { email, password } });
ok(login.status === 200, `login status=${login.status}`);
const cookie = (login.headers.get('set-cookie') ?? '')
  .split(',').map(c => c.trim().split(';')[0]).join('; ');
const csrf = login.body?.csrfToken;
ok(typeof csrf === 'string', 'csrf token present');

// 2. OAuth authorize-url — writes flow state into runtime_kv via the durable store
console.log('2. POST /api/oauth/authorize-url (github) — writes oauth-flow:* row');
const authUrl = await jfetch('POST', '/api/oauth/authorize-url', {
  cookie,
  body: { provider: 'github' },
});
ok(authUrl.status === 200, `authorize-url status=${authUrl.status}`);
ok(typeof authUrl.body?.authUrl === 'string' && authUrl.body.authUrl.includes('github.com'),
   `authUrl returned (${(authUrl.body?.authUrl ?? '').slice(0, 60)}...)`);

// SQLite verify: at least one runtime_kv row keyed `oauth-flow:<state>`
const oauthRows = execSync(
  `sqlite3 ${DB_PATH} "SELECT COUNT(*) FROM runtime_kv WHERE k LIKE 'oauth-flow:%';"`,
).toString().trim();
ok(parseInt(oauthRows, 10) >= 1, `runtime_kv has oauth-flow:* rows: ${oauthRows}`);

// Verify the stored payload includes provider=github + a codeVerifier
const oauthSample = execSync(
  `sqlite3 ${DB_PATH} "SELECT v FROM runtime_kv WHERE k LIKE 'oauth-flow:%' LIMIT 1;"`,
).toString().trim();
ok(oauthSample.includes('"provider":"github"'), `oauth-flow row provider=github`);
ok(oauthSample.includes('"codeVerifier"'), `oauth-flow row has codeVerifier`);

// 3. Create a manual trigger with rate_limit_per_minute=2
console.log('3. POST /api/admin/triggers (manual + rate_limit=2)');
const trigKey = `phaseG-trg-${ts}`;
const created = await jfetch('POST', '/api/admin/triggers', {
  cookie,
  csrf,
  body: {
    key: trigKey,
    enabled: true,
    source_kind: 'manual',
    source_config: {},
    target_kind: 'webhook_out',
    target_config: { url: 'http://127.0.0.1:1/discard' },
    rate_limit_per_minute: 2,
  },
});
ok(created.status === 201, `trigger create status=${created.status}`);
const trigId = created.body?.id;
ok(typeof trigId === 'string', `trigger id=${trigId}`);

// 4. Fire the trigger 3 times in the same minute — first 2 ok, 3rd rate_limited
console.log('4. POST /api/admin/triggers/:id/fire x3');
const results = [];
for (let i = 0; i < 3; i++) {
  const r = await jfetch('POST', `/api/admin/triggers/${trigId}/fire`, {
    cookie,
    csrf,
    body: { payload: { i } },
  });
  ok(r.status === 200, `fire #${i + 1} status=${r.status}`);
  const inv = (r.body?.invocations ?? [])[0];
  results.push(inv?.status ?? '<none>');
}
console.log('   invocation statuses:', results);
const rateLimitedCount = results.filter(s => s === 'rate_limited').length;
ok(rateLimitedCount === 1, `exactly one rate_limited (got ${rateLimitedCount})`);

// 5. SQLite verify: runtime_kv has trigger-rate:<id> row
console.log('5. SQLite: verify trigger-rate:* row in runtime_kv');
const rateRows = execSync(
  `sqlite3 ${DB_PATH} "SELECT k FROM runtime_kv WHERE k LIKE 'trigger-rate:%';"`,
).toString().trim();
ok(rateRows.includes('trigger-rate:') && rateRows.includes(trigId),
   `trigger-rate row exists for ${trigId}: ${rateRows}`);

// 6. Verify the rate-window payload shape (count >= 2)
const rateSample = execSync(
  `sqlite3 ${DB_PATH} "SELECT v FROM runtime_kv WHERE k='trigger-rate:${trigId}';"`,
).toString().trim();
ok(rateSample.length > 0, `rate row payload present`);
// Payload shape: { startedAt: <ms>, count: <n> } — count must be >= 2
const ratePayload = JSON.parse(rateSample);
ok(typeof ratePayload.count === 'number' && ratePayload.count >= 2,
   `rate window count=${ratePayload.count} (>=2)`);

console.log(`\n✓ Phase G E2E passed — ${ok.count()} assertions\n`);
