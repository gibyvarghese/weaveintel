#!/usr/bin/env node
/**
 * compare-a2a-vs-chat.mjs
 *
 * Sends the exact same CSV analysis prompt through both the A2A JSON-RPC
 * endpoint and the chat messages (SSE streaming) endpoint, then compares
 * results side-by-side.
 *
 * Usage:
 *   node scripts/compare-a2a-vs-chat.mjs [--base-url http://localhost:3500] [--csv ./examples/data/sales.csv]
 */

import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.on('unhandledRejection', (r) => { if (r?.name !== 'AbortError') { console.error(r); process.exit(1); } });

const args = Object.fromEntries(
  (process.argv.slice(2).join(' ').match(/--(\w[\w-]*)(?:\s+|=)([^\s-][^\s]*)?/g) ?? [])
    .map(s => { const [k, ...v] = s.replace(/^--/, '').split(/[\s=]+/); return [k, v.join('') || 'true']; }),
);

const BASE_URL = args['base-url'] ?? 'http://localhost:3500';
const CSV_PATH = args['csv'] ?? join(process.cwd(), 'examples/data/sales.csv');
const EMAIL    = `compare-test-${Date.now()}@weaveintel.test`;
const PASS     = 'Compare1!';

const C = { reset:'\x1b[0m', green:'\x1b[32m', red:'\x1b[31m', yellow:'\x1b[33m',
             blue:'\x1b[34m', dim:'\x1b[2m', bold:'\x1b[1m', cyan:'\x1b[36m', magenta:'\x1b[35m' };
const c = (k, t) => `${C[k]}${t}${C.reset}`;

const PROMPT =
  'I have uploaded a sales dataset as a CSV file. Please analyse it using Python code execution. ' +
  'Write and run Python code to: ' +
  '(1) Load the CSV and show basic stats (rows, columns, dtypes). ' +
  '(2) Compute total revenue and average unit price by region, sorted descending. ' +
  '(3) Show top 5 products by total revenue. ' +
  '(4) Compute monthly revenue trend — identify the best and worst months. ' +
  '(5) Analyse profit margin distribution across categories. ' +
  'After each code block, explain the key insight for a sales manager.';

const CSE_MARKERS = [
  { pattern: /rows:/i,           label: 'row count' },
  { pattern: /columns:/i,        label: 'column count' },
  { pattern: /dtype/i,           label: 'dtypes' },
  { pattern: /import pandas/i,   label: 'pandas import' },
  { pattern: /pd\.read_csv/i,    label: 'pd.read_csv' },
  { pattern: /mean|median|std/i, label: 'stats' },
  { pattern: /\d+\.\d{2}/,       label: 'decimal numbers' },
  { pattern: /region|product/i,  label: 'domain terms' },
  { pattern: /revenue/i,         label: 'revenue analysis' },
  { pattern: /profit|margin/i,   label: 'profit/margin' },
];

function detectCse(text) {
  return CSE_MARKERS.filter(m => m.pattern.test(text)).map(m => m.label);
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function httpJson(method, path, body, token, csrf) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(csrf  ? { 'X-CSRF-Token': csrf } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function authenticate() {
  const reg = await httpJson('POST', '/api/auth/register', { email: EMAIL, password: PASS, name: 'Compare Bot' });
  if (![200, 201, 409].includes(reg.status)) throw new Error(`Register failed: ${reg.status}`);

  const db = [join(process.cwd(), 'geneweave.db')].find(existsSync);
  if (db) try { execSync(`sqlite3 "${db}" "UPDATE users SET email_verified=1 WHERE email='${EMAIL}';"`, { stdio: 'pipe' }); } catch {}

  const login = await httpJson('POST', '/api/auth/token', { email: EMAIL, password: PASS });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status}`);
  const token = login.json?.token ?? login.json?.accessToken;
  if (!token) throw new Error('No auth token');
  return { token, csrf: login.json?.csrfToken };
}

// ─── A2A call ─────────────────────────────────────────────────────────────────

async function callA2A(auth, csvB64) {
  const startMs = Date.now();
  const rpc = {
    jsonrpc: '2.0', id: randomUUID(), method: 'SendMessage',
    params: {
      message: {
        role: 'user',
        parts: [
          { text: PROMPT },
          { raw: csvB64, mediaType: 'text/csv', filename: 'sales.csv' },
        ],
      },
      metadata: { mode: 'agent' },
    },
  };

  const res  = await fetch(`${BASE_URL}/api/a2a`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` },
    body: JSON.stringify(rpc),
  });
  const text = await res.text();
  const body = JSON.parse(text);
  if (!res.ok)     throw new Error(`A2A HTTP ${res.status}: ${text.slice(0, 300)}`);
  if (body.error)  throw new Error(`A2A RPC error ${body.error.code}: ${body.error.message}`);

  const task    = body.result;
  const elapsed = Date.now() - startMs;
  const content = task?.artifacts?.[0]?.parts?.[0]?.text ?? '';
  return { elapsed, content, state: task?.status?.state, meta: task?.metadata ?? {} };
}

// ─── Chat API (SSE streaming) call ───────────────────────────────────────────

async function callChat(auth, csvB64, csvBytes) {
  // Create a new chat in agent mode
  const chatRes = await httpJson('POST', '/api/chats', { title: 'compare-chat-test' }, auth.token, auth.csrf);
  if (![200, 201].includes(chatRes.status)) throw new Error(`Create chat failed: ${chatRes.status}`);
  const chatId = chatRes.json?.id ?? chatRes.json?.chat?.id;

  const settingsRes = await httpJson('POST', `/api/chats/${chatId}/settings`, { mode: 'agent' }, auth.token, auth.csrf);
  if (![200, 201].includes(settingsRes.status)) {
    console.log(c('yellow', `  ⚠ Chat mode set failed: HTTP ${settingsRes.status}`));
  }

  const startMs = Date.now();
  const res = await fetch(`${BASE_URL}/api/chats/${chatId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.token}`,
      ...(auth.csrf ? { 'X-CSRF-Token': auth.csrf } : {}),
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      stream: true,
      content: PROMPT,
      attachments: [{
        name: 'sales.csv',
        mimeType: 'text/csv',
        size: csvBytes.length,
        dataBase64: csvB64,
      }],
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Chat HTTP ${res.status}: ${t.slice(0, 200)}`);
  }

  // Collect SSE stream
  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', fullText = '', toolCalls = [], done = false;

  while (!done) {
    const { done: eof, value } = await reader.read();
    if (eof) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split(/\n\n|\r\n\r\n/);
    buf = parts.pop() ?? '';
    for (const part of parts) {
      for (const line of part.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        let evt; try { evt = JSON.parse(line.slice(5).trimStart()); } catch { continue; }
        if (evt.type === 'text')         fullText += evt.text ?? '';
        if (evt.type === 'tool_start')   toolCalls.push(evt.name ?? '?');
        if (evt.type === 'done')         done = true;
      }
    }
  }
  try { reader.cancel(); } catch {}

  return { elapsed: Date.now() - startMs, content: fullText, toolCalls };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(c('bold', '\n=== A2A vs Chat API — Same Prompt, Same CSV ==='));
  console.log(c('dim', `Base URL: ${BASE_URL}  |  CSV: ${CSV_PATH}\n`));

  if (!existsSync(CSV_PATH)) {
    console.log(c('red', `✗ CSV not found: ${CSV_PATH}`)); process.exit(1);
  }

  const csvBytes = readFileSync(CSV_PATH);
  const csvB64   = csvBytes.toString('base64');
  const rowCount = csvBytes.toString('utf8').split('\n').length - 1;
  console.log(c('dim', `CSV: ${rowCount} rows, ${(csvBytes.length / 1024).toFixed(1)} KB`));
  console.log(c('dim', `Prompt (${PROMPT.length} chars): "${PROMPT.slice(0, 100)}..."\n`));

  const auth = await authenticate();
  console.log(c('green', '✓ Authenticated\n'));

  // ── Run both calls in parallel ──────────────────────────────────────────────
  console.log(c('blue', '[ Running both API calls in parallel... ]\n'));

  const [a2aResult, chatResult] = await Promise.allSettled([
    callA2A(auth, csvB64).catch(e => { throw new Error(`A2A: ${e.message}`); }),
    callChat(auth, csvB64, csvBytes).catch(e => { throw new Error(`Chat: ${e.message}`); }),
  ]);

  // ── A2A results ─────────────────────────────────────────────────────────────
  console.log(c('bold', '─── A2A JSON-RPC 2.0 ───────────────────────────────────'));
  if (a2aResult.status === 'rejected') {
    console.log(c('red', `✗ FAILED: ${a2aResult.reason.message}`));
  } else {
    const { elapsed, content, state, meta } = a2aResult.value;
    const cse = detectCse(content);
    console.log(`  State:         ${state === 'TASK_STATE_COMPLETED' ? c('green', state) : c('red', state)}`);
    console.log(`  Elapsed:       ${(elapsed/1000).toFixed(1)}s`);
    console.log(`  Response:      ${content.length} chars`);
    console.log(`  Active skills: ${JSON.stringify(meta.activeSkills ?? [])}`);
    console.log(`  CSE evidence:  ${cse.length > 0 ? c('green', cse.join(', ')) : c('red', 'none')}`);
    console.log(c('dim', `\n  Preview:\n  ${content.slice(0, 600).replace(/\n/g, '\n  ')}`));
  }

  // ── Chat results ─────────────────────────────────────────────────────────────
  console.log(c('bold', '\n─── Chat Messages API (SSE stream) ─────────────────────'));
  if (chatResult.status === 'rejected') {
    console.log(c('red', `✗ FAILED: ${chatResult.reason.message}`));
  } else {
    const { elapsed, content, toolCalls } = chatResult.value;
    const cse = detectCse(content);
    console.log(`  Elapsed:       ${(elapsed/1000).toFixed(1)}s`);
    console.log(`  Response:      ${content.length} chars`);
    console.log(`  Tool calls:    ${toolCalls.length > 0 ? c('cyan', toolCalls.join(', ')) : c('yellow', 'none captured in SSE')}`);
    console.log(`  CSE evidence:  ${cse.length > 0 ? c('green', cse.join(', ')) : c('red', 'none')}`);
    console.log(c('dim', `\n  Preview:\n  ${content.slice(0, 600).replace(/\n/g, '\n  ')}`));
  }

  // ── Side-by-side comparison ──────────────────────────────────────────────────
  console.log(c('bold', '\n─── Comparison Summary ──────────────────────────────────'));

  const aOk = a2aResult.status === 'fulfilled';
  const cOk = chatResult.status === 'fulfilled';

  if (aOk && cOk) {
    const aR = a2aResult.value;
    const cR = chatResult.value;
    const aCse = new Set(detectCse(aR.content));
    const cCse = new Set(detectCse(cR.content));
    const shared = [...aCse].filter(x => cCse.has(x));
    const onlyA2A  = [...aCse].filter(x => !cCse.has(x));
    const onlyChat = [...cCse].filter(x => !aCse.has(x));

    console.log(`  Elapsed:          A2A ${(aR.elapsed/1000).toFixed(1)}s  |  Chat ${(cR.elapsed/1000).toFixed(1)}s`);
    console.log(`  Response length:  A2A ${aR.content.length} chars  |  Chat ${cR.content.length} chars`);
    console.log(`  CSE markers hit:  A2A ${aCse.size}  |  Chat ${cCse.size}`);

    if (shared.length > 0)
      console.log(c('green',   `  Shared evidence:  ${shared.join(', ')}`));
    if (onlyA2A.length > 0)
      console.log(c('cyan',    `  Only in A2A:      ${onlyA2A.join(', ')}`));
    if (onlyChat.length > 0)
      console.log(c('magenta', `  Only in Chat:     ${onlyChat.join(', ')}`));

    const bothHaveCse = aCse.size > 0 && cCse.size > 0;
    const verdict = bothHaveCse
      ? c('green', '✓ EQUIVALENT — both paths triggered CSE and returned data-driven answers')
      : c('red',   '✗ DIVERGED — one path is missing CSE evidence');
    console.log(`\n  Verdict: ${verdict}`);
  } else {
    if (!aOk) console.log(c('red', `  A2A  FAILED: ${a2aResult.reason.message}`));
    if (!cOk) console.log(c('red', `  Chat FAILED: ${chatResult.reason.message}`));
  }

  console.log('');
  if (!aOk || !cOk) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
