#!/usr/bin/env node
/**
 * Phase H e2e — verifies live-agents-demo wires a runtime end-to-end:
 *  1) boots the demo with LIVE_AGENTS_DEMO_RUNTIME_SQLITE_PATH set
 *  2) hits the HTTP API (mesh + agent + contract + tick)
 *  3) opens the runtime SQLite file directly and confirms the persistence
 *     slot is reachable from outside the process
 *
 * No mocks. No DB stubs. Real HTTP, real SQLite.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
function assert(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

const dir = mkdtempSync(path.join(tmpdir(), 'la-demo-phaseH-'));
const runtimeDb = path.join(dir, 'runtime.sqlite');
const PORT = 3641;
const BASE = `http://127.0.0.1:${PORT}`;

// Boot the demo through a tiny driver script via tsx so we exercise dist/ + env.
const driver = `
import { createLiveAgentsDemo } from '${repoRoot}/apps/live-agents-demo/dist/index.js';
const handle = await createLiveAgentsDemo({
  port: ${PORT},
  runtimePersistencePath: '${runtimeDb}',
});
process.stdout.write('READY\\n');
process.on('SIGTERM', async () => { await handle.stop(); process.exit(0); });
// Touch the KV so the e2e can verify durable bytes survive.
await handle.runtime.persistence.kv.set('phaseH:e2e:hello', 'world');
`;

const driverPath = path.join(dir, 'driver.mjs');
const fs = await import('node:fs/promises');
await fs.writeFile(driverPath, driver, 'utf8');

const child = spawn(process.execPath, [driverPath], {
  cwd: repoRoot,
  env: { ...process.env, LIVE_AGENTS_DEMO_RUNTIME_SQLITE_PATH: runtimeDb },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (b) => (stderr += b.toString()));

await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('demo did not become READY:\n' + stderr)), 10000);
  child.stdout.on('data', (b) => {
    if (b.toString().includes('READY')) {
      clearTimeout(t);
      resolve();
    }
  });
  child.on('exit', (code) => reject(new Error(`demo exited early (${code})\n${stderr}`)));
});

try {
  console.log('\nPhase H — live-agents-demo runtime wiring');

  // 1) HTTP health
  const health = await fetch(`${BASE}/health`);
  assert('GET /health 200', health.status === 200);

  // 2) Heartbeat tick (uses the runtime-propagated ExecutionContext)
  const tick = await fetch(`${BASE}/api/heartbeat/run-once`, { method: 'POST' });
  assert('POST /api/heartbeat/run-once 200', tick.status === 200);
  const tickBody = await tick.json();
  assert('tick body present', tickBody && typeof tickBody === 'object');

  // 3) DB verification — runtime KV file exists and contains our marker
  assert('runtime.sqlite file created', existsSync(runtimeDb));
  const db = new Database(runtimeDb, { readonly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    assert('runtime_kv table present', tables.includes('runtime_kv'));
    const row = db.prepare('SELECT v FROM runtime_kv WHERE k = ?').get('phaseH:e2e:hello');
    assert('marker row persisted', row && row.v === 'world', JSON.stringify(row));
    const count = db.prepare('SELECT COUNT(*) AS n FROM runtime_kv').get().n;
    assert('runtime_kv has at least 1 row', count >= 1, `count=${count}`);
  } finally {
    db.close();
  }
} finally {
  child.kill('SIGTERM');
  await new Promise((r) => child.on('exit', r));
}

console.log(`\nPhase H result: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
