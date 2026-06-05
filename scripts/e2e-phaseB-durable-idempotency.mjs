#!/usr/bin/env node
// scripts/e2e-phaseB-durable-idempotency.mjs
//
// Phase B (Durable consumers) — prove the admin Kaggle-run idempotency now
// flows through the DB-backed `idempotency_records` table (instead of the
// previous in-process Map) so duplicate POSTs survive restart.
//
// What it verifies end-to-end:
//   1. POST /api/admin/kaggle-runs with Idempotency-Key=X creates a row.
//   2. Same POST again returns the cached payload (no second row).
//   3. `idempotency_records` table contains the key (durable, not Map-only).
//   4. `kaggle_runs` contains exactly one row for the test competition_ref.
//
// Usage: zsh> set +H && node scripts/e2e-phaseB-durable-idempotency.mjs
// Requires server running at http://localhost:3500 (examples/12-geneweave.ts).
import { execSync } from 'node:child_process';
import { BASE, DB_PATH, makeOk, jfetch } from './e2e-helpers.mjs';

const ok = makeOk();
const ts = Date.now();
const email = `e2e_phaseB_${ts}@example.com`;
const password = 'P@ssw0rd123';
const idemKey = `e2e-phaseB-idem-${ts}`;
const compRef = `phaseB-test-${ts}`;

console.log(`\n=== Phase B E2E (durable idempotency) — ${BASE} ===\n`);

// 1. Register + promote + login
console.log('1. Register + promote + login');
await jfetch('POST', '/api/auth/register', { body: { email, password, name: 'phaseB' } });
execSync(`sqlite3 ${DB_PATH} "UPDATE users SET persona='tenant_admin' WHERE email='${email}';"`);
const login = await jfetch('POST', '/api/auth/login', { body: { email, password } });
ok(login.status === 200, `login status=${login.status}`);
const cookie = (login.headers.get('set-cookie') ?? '')
  .split(',').map(c => c.trim().split(';')[0]).join('; ');
const csrf = login.body?.csrfToken;
ok(typeof csrf === 'string', 'csrf token present');

// 2. First POST — creates a kaggle_run
console.log('2. First POST /api/admin/kaggle-runs with Idempotency-Key');
const first = await fetch(`${BASE}/api/admin/kaggle-runs`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    cookie,
    'x-csrf-token': csrf,
    'idempotency-key': idemKey,
  },
  body: JSON.stringify({ competition_ref: compRef, status: 'queued' }),
});
const firstBody = await first.json();
ok(first.status === 201, `first POST status=${first.status}`);
ok(firstBody?.['kaggle-run']?.competition_ref === compRef, 'first POST returns kaggle-run row');
const firstId = firstBody['kaggle-run'].id;

// 3. Second POST same key — must return cached, not create
console.log('3. Second POST same Idempotency-Key — expect cached');
const second = await fetch(`${BASE}/api/admin/kaggle-runs`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    cookie,
    'x-csrf-token': csrf,
    'idempotency-key': idemKey,
  },
  body: JSON.stringify({ competition_ref: compRef, status: 'queued' }),
});
const secondBody = await second.json();
ok(second.status === 201, `second POST status=${second.status}`);
ok(secondBody?.['kaggle-run']?.id === firstId, 'second POST returns same id (cached)');

// 4. Verify `idempotency_records` row written (durable, not in-memory)
console.log('4. Verify idempotency_records row in DB');
const idemKeyDb = `kaggle-runs:${idemKey}`;
const idemCount = execSync(
  `sqlite3 ${DB_PATH} "SELECT COUNT(*) FROM idempotency_records WHERE key='${idemKeyDb}';"`,
).toString().trim();
ok(idemCount === '1', `idempotency_records has 1 row for key (got ${idemCount})`);

// 5. Verify exactly one kaggle_runs row for compRef
console.log('5. Verify kaggle_runs has exactly one row');
const runCount = execSync(
  `sqlite3 ${DB_PATH} "SELECT COUNT(*) FROM kaggle_runs WHERE competition_ref='${compRef}';"`,
).toString().trim();
ok(runCount === '1', `kaggle_runs count=${runCount} (idempotency suppressed duplicate)`);

// 6. Cleanup
console.log('6. Cleanup');
execSync(`sqlite3 ${DB_PATH} "DELETE FROM idempotency_records WHERE key='${idemKeyDb}';"`);
execSync(`sqlite3 ${DB_PATH} "DELETE FROM kaggle_runs WHERE competition_ref='${compRef}';"`);
execSync(`sqlite3 ${DB_PATH} "DELETE FROM users WHERE email='${email}';"`);
ok(true, 'cleanup done');

console.log(`\n✅ Phase B E2E passed — ${ok.count()} assertions\n`);
