#!/usr/bin/env node
// scripts/e2e-sp1-auth-token.mjs
//
// SP1 (mobile pre-task) — live-server end-to-end proof that POST /api/auth/token
// issues a bearer token in the response body (no Set-Cookie) and that the token
// is honoured by the real auth middleware for both reads and CSRF-protected
// mutations — exactly the flow geneweave-mobile will use.
//
//   1. POST /api/auth/token            → { token, csrfToken, expiresAt, user }
//   2. GET  /api/auth/me  (Bearer)     → 200, same principal
//   3. POST /api/me/tasks (Bearer+CSRF)→ 201 (mutation honoured)
//   4. POST /api/me/tasks (Bearer, no CSRF) → 403 (CSRF still enforced)
//   5. bad password / missing fields / unknown email → 401 / 400 / 401
//
// Usage: zsh> set +H && node scripts/e2e-sp1-auth-token.mjs
import { BASE, makeOk, jfetch } from './e2e-helpers.mjs';

const ok = makeOk();
const ts = Date.now();
const password = 'P@ssw0rd123';
const email = `e2e_sp1_${ts}@example.com`;

console.log(`\n=== SP1 auth-token E2E — ${BASE} ===\n`);

console.log('0. Register the principal (cookie path) so credentials exist');
const reg = await jfetch('POST', '/api/auth/register', {
  body: { email, password, name: email.split('@')[0] },
});
ok(reg.status === 201, `register status=${reg.status}`);

console.log('\n1. POST /api/auth/token returns a bearer token in the body (no Set-Cookie)');
const tok = await jfetch('POST', '/api/auth/token', { body: { email, password } });
ok(tok.status === 200, `token status=${tok.status}`);
ok(typeof tok.body?.token === 'string' && tok.body.token.split('.').length === 3, 'token is a 3-part JWT');
ok(typeof tok.body?.csrfToken === 'string', 'csrfToken present');
ok(typeof tok.body?.expiresAt === 'string' && !Number.isNaN(Date.parse(tok.body.expiresAt)), 'expiresAt is an ISO timestamp');
ok(tok.body?.user?.email === email, 'user echoed in body');
ok(Array.isArray(tok.body?.permissions), 'permissions array present');
ok(!tok.headers.get('set-cookie'), 'token route does NOT set an auth cookie (body-only)');

const bearer = tok.body.token;
const csrf = tok.body.csrfToken;

console.log('\n2. GET /api/auth/me with the bearer token authenticates the same principal');
const me = await jfetch('GET', '/api/auth/me', { bearer });
ok(me.status === 200, `me status=${me.status}`);
ok(me.body?.user?.email === email, 'me resolves to the same principal via Bearer');

console.log('\n3. A CSRF-protected mutation succeeds with Bearer + X-CSRF-Token');
const task = await jfetch('POST', '/api/me/tasks', {
  bearer, csrf,
  body: { title: `SP1 task ${ts}` },
});
ok(task.status === 201 && typeof task.body?.id === 'string', `task created via bearer (status=${task.status})`);

console.log('\n4. The same mutation WITHOUT the CSRF header is rejected (403)');
const noCsrf = await jfetch('POST', '/api/me/tasks', {
  bearer,
  body: { title: `SP1 task no-csrf ${ts}` },
});
ok(noCsrf.status === 403, `bearer without CSRF rejected (status=${noCsrf.status})`);

console.log('\n5. Error paths');
const badPass = await jfetch('POST', '/api/auth/token', { body: { email, password: 'nope' } });
ok(badPass.status === 401, `wrong password → 401 (status=${badPass.status})`);
ok(!badPass.body?.token, 'no token issued on bad password');

const unknown = await jfetch('POST', '/api/auth/token', { body: { email: `ghost_${ts}@example.com`, password } });
ok(unknown.status === 401, `unknown email → 401 (status=${unknown.status})`);

const missing = await jfetch('POST', '/api/auth/token', { body: { email } });
ok(missing.status === 400, `missing password → 400 (status=${missing.status})`);

console.log(`\n=== SP1 auth-token E2E PASSED — ${ok.count()} assertions ===\n`);
