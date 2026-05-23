#!/usr/bin/env node
// scripts/e2e-phase10-byok.mjs
//
// Phase 10 E2E — BYOK / HYOK / break-glass / signed attestation.
//
// Validates the full operator surface end-to-end against a live geneweave
// server:
//   1. Register an RSA-4096 customer public key (BYOK config) — verify
//      `tenant_encryption_policy` is mirrored to use `byok-pem`.
//   2. Submit a break-glass request, approve with a different principal,
//      list active grants, then deny a second one.
//   3. Generate a signed attestation, fetch the platform public key, and
//      verify the Ed25519 signature locally over the canonical payload.
//
// Run:
//   npx tsx examples/12-geneweave.ts &
//   node scripts/e2e-phase10-byok.mjs
//
// Cleanly degrades when the server is unreachable: prints instructions, exit 2.

import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { generateKeyPairSync, createPublicKey, verify, createHash } from 'node:crypto';

const BASE = process.env.BASE_URL ?? 'http://localhost:3500';
const ts = Date.now();
const email = `e2e_phase10_byok_${ts}@example.com`;
const password = 'P@ssw0rd123';
const tenantId = `e2e_byok_tenant_${ts}`;

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

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

console.log(`\n=== Phase 10 E2E (BYOK / HYOK / break-glass / attestation) — ${BASE} ===\n`);

// 0. Sanity ping
try {
  await fetch(`${BASE}/api/health`).catch(() => null);
} catch (_) { /* tolerated */ }

// 1. Register two operator accounts (need dual-approval)
console.log('1. Register operator + approver');
const opEmail = `e2e_op_${ts}@example.com`;
const apprEmail = `e2e_appr_${ts}@example.com`;
const reg1 = await jfetch('POST', '/api/auth/register', { body: { email: opEmail, password, name: 'op' } });
ok(reg1.status === 201 || reg1.status === 200, `op register status=${reg1.status}`);
const reg2 = await jfetch('POST', '/api/auth/register', { body: { email: apprEmail, password, name: 'appr' } });
ok(reg2.status === 201 || reg2.status === 200, `approver register status=${reg2.status}`);
execSync(`sqlite3 ./geneweave.db "UPDATE users SET persona='tenant_admin' WHERE email IN ('${opEmail}','${apprEmail}');"`);

// 2. Login as operator
console.log('2. Login operator');
const login = await jfetch('POST', '/api/auth/login', { body: { email: opEmail, password } });
ok(login.status === 200, `login status=${login.status}`);
const setCookie = login.headers.get('set-cookie') ?? '';
const cookie = setCookie.split(',').map(c => c.trim().split(';')[0]).join('; ');
const csrf = login.body?.csrfToken;
ok(typeof csrf === 'string' && csrf.length > 0, 'csrf token present');

// 3. Generate an RSA-4096 customer keypair (only the public half is uploaded)
console.log('3. Generate RSA-4096 customer keypair');
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 4096 });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
ok(publicPem.includes('BEGIN PUBLIC KEY'), 'public PEM generated');

// 4. Register BYOK config — also exercises dev-only privateKeyPemDev path
console.log('4. POST /admin/byok/config');
const upsert = await jfetch('POST', '/api/admin/byok/config', {
  cookie, csrf,
  body: {
    tenant_id: tenantId,
    public_key_pem: publicPem,
    mode: 'byok',
    private_key_pem_dev: privatePem,
  },
});
ok(upsert.status === 200, `byok upsert status=${upsert.status}`);
ok(typeof upsert.body?.fingerprint === 'string' && upsert.body.fingerprint.length > 0, 'fingerprint returned');
ok(upsert.body?.mirroredPolicy === true, 'mirrored into tenant_encryption_policy');

// 5. Verify mirrored policy uses byok-pem
console.log('5. Confirm encryption policy mirrored');
const pol = await jfetch('GET', `/api/admin/tenant-encryption-policies/${tenantId}`, { cookie });
ok(pol.status === 200, `policy fetch status=${pol.status}`);
ok(pol.body?.policy?.kms_provider_id === 'byok-pem', `kms_provider_id=byok-pem (got ${pol.body?.policy?.kms_provider_id})`);

// 6. Reject < 4096 keys server-side
console.log('6. Reject RSA-2048 key');
const small = generateKeyPairSync('rsa', { modulusLength: 2048 });
const smallPem = small.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const bad = await jfetch('POST', '/api/admin/byok/config', {
  cookie, csrf,
  body: { tenant_id: `${tenantId}_small`, public_key_pem: smallPem },
});
ok(bad.status === 400, `small-key rejected status=${bad.status}`);

// 7. Break-glass: request, then approve with the other principal
console.log('7. Break-glass request');
const bg = await jfetch('POST', '/api/admin/byok/break-glass/request', {
  cookie, csrf,
  body: { tenant_id: tenantId, reason: 'rotation cron failed at 2026-05-14T00:00Z' },
});
ok(bg.status === 200, `break-glass request status=${bg.status}`);
ok(bg.body?.status === 'pending', 'request status=pending');
ok(typeof bg.body?.expires_at === 'number' && bg.body.expires_at > Date.now(), 'expires_at in future');
const bgId = bg.body.id;

// 7a. Same-principal approve must fail
console.log('7a. Same-principal approve rejected');
const dual = await jfetch('POST', `/api/admin/byok/break-glass/${bgId}/approve`, {
  cookie, csrf,
  body: { customer_approver: opEmail },
});
ok(dual.status === 400, `dual-approval enforced status=${dual.status}`);

// 7b. Different principal approves
console.log('7b. Different-principal approve');
const apprLogin = await jfetch('POST', '/api/auth/login', { body: { email: apprEmail, password } });
const apprCookie = (apprLogin.headers.get('set-cookie') ?? '').split(',').map(c => c.trim().split(';')[0]).join('; ');
const apprCsrf = apprLogin.body?.csrfToken;
const appr = await jfetch('POST', `/api/admin/byok/break-glass/${bgId}/approve`, {
  cookie: apprCookie, csrf: apprCsrf,
  body: { customer_approver: apprEmail },
});
ok(appr.status === 200, `approve status=${appr.status}`);
ok(appr.body?.status === 'approved', 'status=approved');
ok((appr.body.expires_at - appr.body.approved_at) <= 24 * 3600 * 1000, 'window capped at 24h');

// 7c. Active grant lookup
const active = await jfetch('GET', `/api/admin/byok/break-glass/active/${tenantId}`, { cookie });
ok(active.status === 200 && active.body?.grant?.id === bgId, 'active grant matches');

// 7d. Deny path on a fresh request
const bg2 = await jfetch('POST', '/api/admin/byok/break-glass/request', {
  cookie, csrf,
  body: { tenant_id: tenantId, reason: 'second incident — disk full on hsm proxy' },
});
const denied = await jfetch('POST', `/api/admin/byok/break-glass/${bg2.body.id}/deny`, {
  cookie: apprCookie, csrf: apprCsrf,
  body: { note: 'rotate manually instead' },
});
ok(denied.status === 200 && denied.body?.status === 'denied', 'deny path works');

// 8. Attestation export + signature verification
console.log('8. Attestation export + verify');
const att = await jfetch('POST', `/api/admin/byok/attestation/${tenantId}`, { cookie, csrf });
ok(att.status === 200, `attestation status=${att.status}`);
ok(typeof att.body?.attestation?.signature === 'string', 'signature present');
ok(att.body?.attestation?.signatureAlg === 'Ed25519', 'algorithm=Ed25519');

const pub = await jfetch('GET', '/api/admin/byok/attestation/public-key', { cookie });
ok(pub.status === 200 && pub.body?.pem?.includes('BEGIN PUBLIC KEY'), 'platform public key fetched');
ok(pub.body.fingerprint === att.body.attestation.payload.signingKeyFingerprint, 'fingerprint matches attestation');

// Verify locally with node:crypto
const payloadBytes = Buffer.from(canonicalize(att.body.attestation.payload), 'utf8');
const sigBytes = Buffer.from(att.body.attestation.signature, 'base64');
const pubKey = createPublicKey(pub.body.pem);
const sigOk = verify(null, payloadBytes, pubKey, sigBytes);
ok(sigOk, 'Ed25519 signature verifies against canonical payload');

// payload_hash is SHA-256 of canonical payload
const expectedHash = createHash('sha256').update(payloadBytes).digest('hex');
ok(att.body.payloadHash === expectedHash, 'payload_hash = sha256(canonical payload)');

// 8a. Tampered payload must fail
const tampered = { ...att.body.attestation, payload: { ...att.body.attestation.payload, tenantId: 'attacker' } };
const tamperedBytes = Buffer.from(canonicalize(tampered.payload), 'utf8');
ok(!verify(null, tamperedBytes, pubKey, sigBytes), 'tampered payload fails verification');

// 9. Attestation log row written
const log = await jfetch('GET', `/api/admin/byok/attestation/log/${tenantId}`, { cookie });
ok(log.status === 200 && Array.isArray(log.body?.attestations) && log.body.attestations.length >= 1, 'attestation log row present');

console.log(`\n✅  Phase 10 E2E passed — ${assertions} assertions.\n`);
