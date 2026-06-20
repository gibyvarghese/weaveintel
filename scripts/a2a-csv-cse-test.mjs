#!/usr/bin/env node
/**
 * a2a-csv-cse-test.mjs — Same CSV + CSE analysis as csv-cse-test.mjs but sent
 * via the A2A JSON-RPC 2.0 protocol instead of the chat messages API.
 *
 * A2A endpoint: POST /api/a2a  (method: SendMessage)
 * CSV is sent as a FilePart with raw (base64) + mediaType: 'text/csv'
 *
 * Usage:
 *   node scripts/a2a-csv-cse-test.mjs [--base-url http://localhost:3500] [--csv /path/to/file.csv]
 */

import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.on('unhandledRejection', (reason) => {
  if (reason instanceof Error && reason.name === 'AbortError') return;
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});

const args = Object.fromEntries(
  (process.argv.slice(2).join(' ').match(/--(\w[\w-]*)(?:\s+|=)([^\s-][^\s]*)?/g) ?? [])
    .map(s => {
      const [k, ...v] = s.replace(/^--/, '').split(/[\s=]+/);
      return [k, v.join('') || 'true'];
    }),
);

const BASE_URL   = args['base-url'] ?? 'http://localhost:3500';
const A2A_URL    = `${BASE_URL}/api/a2a`;
const TEST_EMAIL = args['email'] ?? `a2a-cse-test-${Date.now()}@weaveintel.test`;
const TEST_PASS  = args['password'] ?? 'A2ATest1!';
const CSV_PATH   = args['csv'] ?? join(process.cwd(), 'examples/data/sales.csv');

const C = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  yellow: '\x1b[33m', blue: '\x1b[34m', dim: '\x1b[2m', bold: '\x1b[1m', cyan: '\x1b[36m',
};
const c = (col, txt) => `${C[col]}${txt}${C.reset}`;

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function httpJson(method, path, body, token, csrfToken) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token     ? { Authorization: `Bearer ${token}` } : {}),
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

async function setup() {
  console.log(c('bold', '\n=== geneWeave A2A CSV + CSE Code Execution Test ==='));
  console.log(c('dim', `A2A endpoint: ${A2A_URL}\n`));

  const reg = await httpJson('POST', '/api/auth/register', { email: TEST_EMAIL, password: TEST_PASS, name: 'A2A CSE Bot' });
  if (reg.status !== 200 && reg.status !== 201 && reg.status !== 409) {
    throw new Error(`Registration failed: ${reg.status} ${JSON.stringify(reg.json)}`);
  }

  const dbPaths = [join(process.cwd(), 'geneweave.db')].filter(p => existsSync(p));
  if (dbPaths.length > 0) {
    try {
      execSync(`sqlite3 "${dbPaths[0]}" "UPDATE users SET email_verified = 1 WHERE email = '${TEST_EMAIL}';"`, { stdio: 'pipe' });
    } catch {}
  }

  const login = await httpJson('POST', '/api/auth/token', { email: TEST_EMAIL, password: TEST_PASS });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status} ${JSON.stringify(login.json)}`);
  const token     = login.json?.token ?? login.json?.accessToken;
  const csrfToken = login.json?.csrfToken;
  if (!token) throw new Error('No token in login response');
  console.log(c('green', '✓ Authenticated\n'));
  return { token, csrfToken };
}

// ─── A2A JSON-RPC helper ──────────────────────────────────────────────────────

async function a2aSend(token, params) {
  const rpc = {
    jsonrpc: '2.0',
    id: randomUUID(),
    method: 'SendMessage',
    params,
  };

  const res = await fetch(A2A_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(rpc),
  });

  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }

  if (!res.ok) throw new Error(`A2A HTTP ${res.status}: ${text.slice(0, 300)}`);
  if (body.error) throw new Error(`A2A JSON-RPC error ${body.error.code}: ${body.error.message}`);
  return body.result; // A2ATask
}

// ─── Detect CSE evidence in response text ────────────────────────────────────

function detectCseEvidence(text) {
  const markers = [
    { pattern: /rows:/i,              label: 'row count output' },
    { pattern: /columns:/i,           label: 'column count output' },
    { pattern: /dtype/i,              label: 'pandas dtype output' },
    { pattern: /stdout/i,             label: 'stdout field' },
    { pattern: /import pandas/i,      label: 'pandas import' },
    { pattern: /pd\.read_csv/i,       label: 'pd.read_csv call' },
    { pattern: /mean|median|std/i,    label: 'statistical output' },
    { pattern: /\d+\.\d{2}/,          label: 'decimal numeric output' },
    { pattern: /execute[d]?\s+code/i, label: 'execution confirmation' },
  ];
  return markers.filter(m => m.pattern.test(text)).map(m => m.label);
}

// ─── Test A: CSV FilePart → CSE Python data analysis via A2A ─────────────────

async function testCSVViaA2A(auth) {
  console.log(c('blue', '[ Test A ] Real sales CSV sent as A2A FilePart → CSE Python analysis'));
  console.log(c('dim', `           CSV: ${CSV_PATH}\n`));

  if (!existsSync(CSV_PATH)) {
    console.log(c('red', `  ✗ CSV file not found: ${CSV_PATH}`));
    return false;
  }

  const csvBytes = readFileSync(CSV_PATH);
  const csvB64   = csvBytes.toString('base64');
  const rowCount = csvBytes.toString('utf8').split('\n').length - 1;
  console.log(c('dim', `  Loaded ${rowCount} rows, ${(csvBytes.length / 1024).toFixed(1)} KB`));

  const prompt =
    'I have uploaded a sales dataset as a CSV file. Please analyse it using Python code execution. ' +
    'Write and run Python code to: ' +
    '(1) Load the CSV and show basic stats (rows, columns, dtypes). ' +
    '(2) Compute total revenue and average unit price by region, sorted descending. ' +
    '(3) Show top 5 products by total revenue. ' +
    '(4) Compute monthly revenue trend — identify the best and worst months. ' +
    '(5) Analyse profit margin distribution across categories. ' +
    'After each code block, explain the key insight for a sales manager.';

  console.log(c('dim', '  Sending A2A SendMessage with CSV FilePart (mode: agent)...'));
  const startMs = Date.now();

  let task;
  try {
    task = await a2aSend(auth.token, {
      message: {
        role: 'user',
        parts: [
          { text: prompt },
          {
            raw:       csvB64,
            mediaType: 'text/csv',
            filename:  'sales.csv',
          },
        ],
      },
      metadata: { mode: 'agent' },
    });
  } catch (err) {
    console.log(c('red', `  ✗ A2A request failed: ${err.message}`));
    return false;
  }

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  const state   = task?.status?.state ?? 'unknown';
  const text    = task?.artifacts?.[0]?.parts?.[0]?.text ?? '';
  const meta    = task?.metadata ?? {};

  console.log(`  Task ID:      ${task?.id ?? 'n/a'}`);
  console.log(`  State:        ${state === 'TASK_STATE_COMPLETED' ? c('green', state) : c('red', state)}`);
  console.log(`  Elapsed:      ${elapsed}s`);
  console.log(`  Latency ms:   ${meta.latencyMs ?? 'n/a'}`);
  console.log(`  Resolved mode: ${meta.resolvedMode ?? 'n/a'}`);
  console.log(`  Active skills: ${JSON.stringify(meta.activeSkills ?? [])}`);

  if (meta.guardrail) {
    console.log(c('yellow', `  Guardrail: ${JSON.stringify(meta.guardrail)}`));
  }
  if (meta.attachmentCount !== undefined) {
    console.log(`  Attachments:  ${meta.attachmentCount} (${(meta.attachmentTypes ?? []).join(', ')})`);
  }

  // Scan response text for CSE execution evidence
  const cseMarkers = detectCseEvidence(text);
  if (cseMarkers.length > 0) {
    console.log(c('green', `\n  ✓ CSE execution evidence found (${cseMarkers.length} markers):`));
    for (const m of cseMarkers) console.log(c('cyan', `    • ${m}`));
  } else {
    console.log(c('yellow', '\n  ⚠ No CSE execution evidence detected in response text'));
  }

  if (text.length > 50) {
    console.log(c('dim', `\n  Response preview (first 500 chars):\n  ${text.slice(0, 500).replace(/\n/g, '\n  ')}`));
  } else {
    console.log(c('red', `  ✗ Response too short (${text.length} chars): ${text}`));
  }

  const ok = state === 'TASK_STATE_COMPLETED' && text.length > 50;
  console.log('\n  ' + (ok ? c('green', '✓ PASS') : c('red', '✗ FAIL')));
  return ok;
}

// ─── Test B: Explicit Python code exec via A2A (no file) ─────────────────────

async function testCodeExecViaA2A(auth) {
  console.log(c('blue', '\n[ Test B ] Explicit Python execution via A2A (no file)'));

  const prompt =
    'Please run this Python code and show me the output:\n\n' +
    '```python\n' +
    'import math, statistics\n' +
    'data = [95.7, 81.35, 94.74, 83.26, 71.15, 86.80, 62.90, 98.00]\n' +
    'print(f"Count: {len(data)}")\n' +
    'print(f"Mean: {statistics.mean(data):.2f}")\n' +
    'print(f"Median: {statistics.median(data):.2f}")\n' +
    'print(f"Std dev: {statistics.stdev(data):.2f}")\n' +
    'print(f"Min: {min(data):.2f}, Max: {max(data):.2f}")\n' +
    '```\n\nThen tell me what these stats indicate about the price distribution.';

  const startMs = Date.now();
  let task;
  try {
    task = await a2aSend(auth.token, {
      message: { role: 'user', parts: [{ text: prompt }] },
      metadata: { mode: 'agent' },
    });
  } catch (err) {
    console.log(c('red', `  ✗ A2A request failed: ${err.message}`));
    return false;
  }

  const elapsed  = ((Date.now() - startMs) / 1000).toFixed(1);
  const state    = task?.status?.state ?? 'unknown';
  const text     = task?.artifacts?.[0]?.parts?.[0]?.text ?? '';
  const meta     = task?.metadata ?? {};
  const cseMarkers = detectCseEvidence(text);

  console.log(`  State: ${state === 'TASK_STATE_COMPLETED' ? c('green', state) : c('red', state)}  |  ${elapsed}s  |  ${text.length} chars`);
  console.log(`  Active skills: ${JSON.stringify(meta.activeSkills ?? [])}`);

  if (cseMarkers.length > 0) {
    console.log(c('green', `  ✓ CSE evidence: ${cseMarkers.join(', ')}`));
  } else {
    console.log(c('yellow', '  ⚠ No CSE markers in response'));
  }

  if (text.length > 30) {
    console.log(c('dim', `  Preview: ${text.slice(0, 300).replace(/\n/g, ' ')}`));
  }

  const ok = state === 'TASK_STATE_COMPLETED' && text.length > 30;
  console.log('  ' + (ok ? c('green', '✓ PASS') : c('red', '✗ FAIL')));
  return ok;
}

// ─── Test C: Verify Agent Card shows DB-backed skills ────────────────────────

async function testAgentCard() {
  console.log(c('blue', '\n[ Test C ] Agent Card — verify DB-backed skills published'));

  const res = await fetch(`${BASE_URL}/.well-known/agent-card.json`);
  if (!res.ok) {
    console.log(c('red', `  ✗ Agent Card HTTP ${res.status}`));
    return false;
  }
  const card = await res.json();

  console.log(`  Agent name:    ${card.name}`);
  console.log(`  Version:       ${card.version}`);
  console.log(`  Skills (${(card.skills ?? []).length}):`);
  for (const s of card.skills ?? []) {
    const scopes = s.security?.[0]?.bearer ?? [];
    console.log(c('cyan', `    • ${s.id} — ${s.name}`));
    console.log(c('dim',  `      scopes: ${scopes.join(', ')} | inputModes: ${(s.inputModes ?? []).join(', ')}`));
  }

  const hasSkills = (card.skills ?? []).length > 0;
  console.log('\n  ' + (hasSkills ? c('green', '✓ PASS — skills loaded from DB') : c('red', '✗ FAIL — no skills on card')));
  return hasSkills;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const auth = await setup();

  const cOk = await testAgentCard();
  const aOk = await testCSVViaA2A(auth);
  const bOk = await testCodeExecViaA2A(auth);

  console.log(c('bold', '\n=== A2A CSE Test Summary ==='));
  console.log(`  Test C (Agent Card — DB skills):      ${cOk ? c('green', 'PASS') : c('red', 'FAIL')}`);
  console.log(`  Test A (CSV FilePart → CSE analysis): ${aOk ? c('green', 'PASS') : c('red', 'FAIL')}`);
  console.log(`  Test B (explicit Python exec via A2A): ${bOk ? c('green', 'PASS') : c('red', 'FAIL')}`);

  if (!aOk || !bOk || !cOk) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
