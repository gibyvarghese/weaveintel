#!/usr/bin/env node
/**
 * Phase I — Verification quartet runner.
 *
 * Per the adoption plan, Phase I is the cross-cutting verification step:
 * for every previous phase (A–H), prove the wiring still works end-to-end
 * after each new phase lands, and confirm the framework-wide lint guards
 * (no raw fetch, no ad-hoc resilience) remain green.
 *
 * What this script does (in order):
 *   1. Lint guards: `check:no-raw-fetch`, `check:no-adhoc-resilience`.
 *   2. Phase A example (in-process durable runtime smoke).
 *   3. Vitest unit tests for B, C, D, E, F, G.
 *   4. Boot the geneweave server once (Phase G env), run every server-mode
 *      e2e (B, D, E, F, G) against the same instance, then shut it down.
 *   5. Phase H standalone (boots the live-agents-demo via tsx driver and
 *      verifies a runtime KV row outside the process).
 *
 * The script is fail-fast: any non-zero exit from a sub-step terminates
 * the run with that exit code. The geneweave server is always cleaned up.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const results = [];
function record(name, code) {
  results.push({ name, ok: code === 0, code });
  const sigil = code === 0 ? '✓' : '✗';
  console.log(`\n[Phase I] ${sigil} ${name} (exit=${code})`);
}

function runSync(label, cmd, args, opts = {}) {
  console.log(`\n[Phase I] → ${label}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: repoRoot, ...opts });
  record(label, r.status ?? 1);
  if ((r.status ?? 1) !== 0) cleanupAndExit(r.status ?? 1);
}

let serverChild = null;
function cleanupAndExit(code) {
  if (serverChild && !serverChild.killed) {
    try { serverChild.kill('SIGTERM'); } catch { /* swallow */ }
  }
  printSummary();
  process.exit(code);
}

function printSummary() {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n=== Phase I Summary: ${passed} passed, ${failed} failed ===`);
  for (const r of results) {
    const sigil = r.ok ? '✓' : '✗';
    console.log(`  ${sigil} ${r.name}`);
  }
}

process.on('SIGINT', () => cleanupAndExit(130));

// 1) Lint guards
runSync('check:no-raw-fetch', 'npm', ['run', '--silent', 'check:no-raw-fetch']);
runSync('check:no-adhoc-resilience', 'npm', ['run', '--silent', 'check:no-adhoc-resilience']);

// 2) Phase A example (in-process)
runSync('examples/130-geneweave-durable-runtime.ts', 'npx', [
  'tsx',
  'examples/130-geneweave-durable-runtime.ts',
]);

// 3) Vitest unit tests for the per-phase quartets
const unitTests = [
  ['Phase B unit (workflow-cost-meter-durable)', 'apps/geneweave/src/workflow-cost-meter-durable.test.ts'],
  ['Phase C unit (secrets-via-runtime)', 'apps/geneweave/src/secrets-via-runtime.test.ts'],
  ['Phase D unit (tool-requires)', 'apps/geneweave/src/tool-requires.test.ts'],
  ['Phase E unit (guardrails-slot)', 'apps/geneweave/src/guardrails-slot.test.ts'],
  ['Phase F unit (encryption-slot)', 'apps/geneweave/src/encryption-slot.test.ts'],
  ['Phase G unit (durable-subsystems)', 'apps/geneweave/src/durable-subsystems-phaseG.test.ts'],
];
for (const [label, file] of unitTests) {
  runSync(label, 'npx', ['vitest', 'run', '--root', 'apps/geneweave', file.replace('apps/geneweave/', '')]);
}

// 4) Boot geneweave once and run every server-mode e2e against it
const geneweaveDb = '/tmp/geneweave-phaseI.db';
if (existsSync(geneweaveDb)) rmSync(geneweaveDb);

console.log('\n[Phase I] → booting geneweave (Phase G env, fresh DB)');
serverChild = spawn('npx', ['tsx', 'examples/12-geneweave.ts'], {
  cwd: repoRoot,
  env: {
    ...process.env,
    DATABASE_PATH: geneweaveDb,
    PORT: '3500',
    JWT_SECRET: 'phaseI-jwt-secret-very-long-32-chars-min',
    WEAVE_ENCRYPTION_MASTER_KEY:
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    OAUTH_GITHUB_CLIENT_ID: 'phaseI-fake-client-id',
    OAUTH_GITHUB_CLIENT_SECRET: 'phaseI-fake-client-secret',
    // The server requires at least one non-empty provider key at boot.
    // Fake values are fine for the e2e quartet (no real model calls are made).
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'sk-phaseI-fake-openai-key',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverOut = '';
serverChild.stdout.on('data', (b) => { serverOut += b.toString(); });
serverChild.stderr.on('data', (b) => { serverOut += b.toString(); });

await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('geneweave did not become READY:\n' + serverOut.slice(-2000))), 30_000);
  const interval = setInterval(async () => {
    try {
      const r = await fetch('http://localhost:3500/');
      if (r.status < 500) {
        clearTimeout(t);
        clearInterval(interval);
        resolve();
      }
    } catch { /* not yet */ }
  }, 500);
});
console.log('[Phase I] geneweave is READY on :3500');

const serverE2es = [
  ['Phase B e2e (durable idempotency)', 'scripts/e2e-phaseB-durable-idempotency.mjs'],
  ['Phase D e2e (tool requires)', 'scripts/e2e-phaseD-tool-requires.mjs'],
  ['Phase E e2e (guardrails)', 'scripts/e2e-phaseE-guardrails.mjs'],
  ['Phase F e2e (encryption)', 'scripts/e2e-phaseF-encryption.mjs'],
  ['Phase G e2e (durable subsystems)', 'scripts/e2e-phaseG-durable.mjs'],
];
for (const [label, file] of serverE2es) {
  runSync(label, 'node', [file], { env: { ...process.env, DATABASE_PATH: geneweaveDb } });
}

console.log('\n[Phase I] → stopping geneweave');
serverChild.kill('SIGTERM');
await new Promise((r) => serverChild.on('exit', r));
serverChild = null;

// 5) Phase H — separate app, boots its own driver
runSync('Phase H e2e (live-agents-demo runtime)', 'node', ['scripts/e2e-phaseH-live-agents-demo.mjs']);

printSummary();
process.exit(0);
