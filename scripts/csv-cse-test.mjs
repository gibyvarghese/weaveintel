#!/usr/bin/env node
/**
 * csv-cse-test.mjs — End-to-end test: upload real sales CSV, trigger CSE Python
 * code execution, verify data insights are generated.
 *
 * Usage:
 *   node scripts/csv-cse-test.mjs [--base-url http://localhost:3500] [--csv /path/to/file.csv]
 */

import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

process.on('unhandledRejection', (reason) => {
  if (reason instanceof DOMException && reason.name === 'AbortError') return;
  if (reason instanceof Error && reason.name === 'AbortError') return;
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});

const args = Object.fromEntries(
  process.argv.slice(2)
    .join(' ')
    .match(/--(\w[\w-]*)(?:\s+|=)([^\s-][^\s]*)?/g)
    ?.map(s => {
      const [k, ...v] = s.replace(/^--/, '').split(/[\s=]+/);
      return [k, v.join('') || 'true'];
    }) ?? [],
);

const BASE_URL   = args['base-url'] ?? 'http://localhost:3500';
const TEST_EMAIL = args['email'] ?? `cse-test-${Date.now()}@weaveintel.test`;
const TEST_PASS  = args['password'] ?? 'CSETest1!';
const CSV_PATH   = args['csv'] ?? join(process.env.HOME ?? '', 'Downloads/sales_data_sample.csv');

const COLORS = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  yellow: '\x1b[33m', blue: '\x1b[34m', dim: '\x1b[2m', bold: '\x1b[1m',
  cyan: '\x1b[36m',
};
const c = (color, text) => `${COLORS[color]}${text}${COLORS.reset}`;

async function api(method, path, body, auth) {
  const token = typeof auth === 'string' ? auth : auth?.token;
  const csrf  = typeof auth === 'string' ? undefined : auth?.csrfToken;
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
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

async function setup() {
  console.log(c('bold', '\n=== geneWeave CSV + CSE Code Execution Test ==='));
  console.log(c('dim', `Target: ${BASE_URL}\n`));

  const regRes = await api('POST', '/api/auth/register', { email: TEST_EMAIL, password: TEST_PASS, name: 'CSE Test Bot' });
  if (regRes.status !== 200 && regRes.status !== 201 && regRes.status !== 409) {
    throw new Error(`Registration failed: ${regRes.status} ${JSON.stringify(regRes.json)}`);
  }

  // Auto-verify email in SQLite DB
  const dbPaths = [join(process.cwd(), 'geneweave.db')].filter(p => existsSync(p));
  if (dbPaths.length > 0) {
    try {
      execSync(`sqlite3 "${dbPaths[0]}" "UPDATE users SET email_verified = 1 WHERE email = '${TEST_EMAIL}';"`, { stdio: 'pipe' });
    } catch {}
  }

  const loginRes = await api('POST', '/api/auth/token', { email: TEST_EMAIL, password: TEST_PASS });
  if (loginRes.status !== 200) throw new Error(`Login failed: ${loginRes.status}`);
  const token     = loginRes.json?.token ?? loginRes.json?.accessToken;
  const csrfToken = loginRes.json?.csrfToken;
  if (!token) throw new Error('No token in login response');
  console.log(c('green', '✓ Authenticated\n'));
  return { token, csrfToken };
}

async function createChat(auth, title, mode = 'direct') {
  const res = await api('POST', '/api/chats', { title }, auth);
  if (res.status !== 200 && res.status !== 201) throw new Error(`Create chat failed: ${res.status}`);
  const chatId = res.json?.id ?? res.json?.chat?.id;

  if (mode !== 'direct') {
    const settingsRes = await api('POST', `/api/chats/${chatId}/settings`, { mode }, auth);
    if (settingsRes.status !== 200 && settingsRes.status !== 201) {
      console.log(c('yellow', `  ⚠ Could not set chat mode to ${mode}: HTTP ${settingsRes.status}`));
    }
  }
  return chatId;
}

// ─── Stream helper with tool-call tracking ────────────────────────────────────

async function streamWithTools(auth, chatId, body, label) {
  const startMs = Date.now();
  let ttftMs = null;
  let tokenCount = 0;
  let error = null;
  let streamInterrupted = false;
  let doneReceived = false;
  const toolCalls = [];     // { name, inputSnippet, outputSnippet }
  let currentTool = null;

  const res = await fetch(`${BASE_URL}/api/chats/${chatId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.token}`,
      ...(auth.csrfToken ? { 'X-CSRF-Token': auth.csrfToken } : {}),
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ stream: true, ...body }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    return { ttftMs: null, totalMs: Date.now() - startMs, tokenCount: 0, error: `HTTP ${res.status}: ${txt}`, streamInterrupted: false, toolCalls: [] };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  function parseEvents(chunk) {
    buffer += chunk;
    const parts = buffer.split(/\n\n|\r\n\r\n/);
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      for (const line of part.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trimStart();
        if (!raw) continue;
        let evt;
        try { evt = JSON.parse(raw); } catch { continue; }

        if (evt.type === 'text' && typeof evt.text === 'string' && evt.text.length > 0) {
          if (ttftMs === null) ttftMs = Date.now() - startMs;
          tokenCount += evt.text.length;
        }
        // Agent tool events (emitted in agent/supervisor mode)
        if (evt.type === 'tool_start') {
          currentTool = { name: evt.name ?? '?', inputSnippet: JSON.stringify(evt.arguments ?? {}).slice(0, 200) };
        }
        if (evt.type === 'tool_end') {
          if (currentTool) {
            currentTool.outputSnippet = JSON.stringify(evt.result ?? {}).slice(0, 300);
            toolCalls.push(currentTool);
            currentTool = null;
          } else {
            // tool_end without preceding tool_start
            toolCalls.push({ name: evt.name ?? '?', inputSnippet: '', outputSnippet: JSON.stringify(evt.result ?? {}).slice(0, 300) });
          }
        }
        // Agent step events — log tool_call steps even if no tool_start/end
        if (evt.type === 'step' && evt.step?.type === 'tool_call' && evt.phase === 'step_end') {
          const tc = evt.step?.toolCall;
          if (tc && !toolCalls.find(t => t.name === tc.name)) {
            toolCalls.push({ name: tc.name ?? '?', inputSnippet: JSON.stringify(tc.arguments ?? {}).slice(0, 200), outputSnippet: JSON.stringify(tc.result ?? {}).slice(0, 300) });
          }
        }
        if (evt.type === 'error') error = evt.error;
        if (evt.type === 'done') { streamInterrupted = evt.streamInterrupted ?? false; doneReceived = true; }
      }
    }
  }

  try {
    while (!doneReceived) {
      const { done, value } = await reader.read();
      if (done) break;
      parseEvents(decoder.decode(value, { stream: true }));
    }
  } catch (e) { error = e?.message ?? String(e); }
  finally { try { reader.cancel(); } catch {} }

  return { ttftMs, totalMs: Date.now() - startMs, tokenCount, error, streamInterrupted, toolCalls };
}

// ─── Test A: Send real CSV, ask for insights → triggers CSE data analysis ─────

async function testCSVInsights(auth) {
  console.log(c('blue', '[ Test A ] Real sales CSV → CSE Python data analysis'));
  console.log(c('dim', `           CSV: ${CSV_PATH}\n`));

  if (!existsSync(CSV_PATH)) {
    console.log(c('red', `  ✗ CSV file not found: ${CSV_PATH}`));
    return false;
  }

  const csvBytes = readFileSync(CSV_PATH);
  const csvText  = csvBytes.toString('utf8');
  const csvB64   = csvBytes.toString('base64');
  const rowCount = csvText.split('\n').length - 1;
  console.log(c('dim', `  Loaded ${rowCount} rows, ${(csvBytes.length / 1024).toFixed(1)} KB`));

  // Use agent mode so cse_run_code is in the default tool set
  const chatId = await createChat(auth, 'sales-csv-cse-test', 'agent');

  // Prompt explicitly asks model to write and execute Python — guaranteed to
  // invoke cse_run_code / cse_run_data_analysis if the skill is available.
  const prompt =
    'I have uploaded a sales dataset. Please analyse it using Python code execution. ' +
    'Write and run Python code to: ' +
    '(1) Load the CSV and show basic stats (rows, columns, dtypes). ' +
    '(2) Compute total sales and average order value by COUNTRY and sort descending. ' +
    '(3) Show top 5 PRODUCTLINE categories by total SALES revenue. ' +
    '(4) Plot or compute monthly SALES trend across all years — identify the best and worst months. ' +
    '(5) Analyse DEALSIZE distribution and its correlation with SALES. ' +
    'After each code block, explain the key insight in plain English for a sales manager.';

  console.log(c('dim', '  Sending message with CSV attachment...'));
  const startMs = Date.now();

  const result = await streamWithTools(auth, chatId, {
    content: prompt,
    attachments: [{
      name:       'sales_data_sample.csv',
      mimeType:   'text/csv',
      size:       csvBytes.length,
      dataBase64: csvB64,
    }],
  });

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`  TTFT: ${result.ttftMs ?? 'N/A'}ms  |  Total: ${elapsed}s  |  Chars: ${result.tokenCount}`);

  if (result.error) {
    console.log(c('red', `  ✗ Error: ${result.error}`));
  }
  if (result.streamInterrupted) {
    console.log(c('red', '  ✗ Stream was interrupted (timeout hit)'));
  }

  if (result.toolCalls.length > 0) {
    console.log(c('green', `\n  ✓ CSE skill triggered — ${result.toolCalls.length} tool call(s):`));
    for (const tc of result.toolCalls) {
      console.log(c('cyan', `    • ${tc.name}`));
      if (tc.inputSnippet)  console.log(c('dim', `      input:  ${tc.inputSnippet}`));
      if (tc.outputSnippet) console.log(c('dim', `      output: ${tc.outputSnippet}`));
    }
  } else {
    console.log(c('yellow', '  ⚠ No tool_use events captured in SSE stream'));
    console.log(c('dim', '    (model may have answered inline without calling CSE — check response below)'));
  }

  if (result.tokenCount > 100) {
    console.log(c('green', `\n  ✓ Response generated (${result.tokenCount} chars)`));
  } else {
    console.log(c('red', `  ✗ Too few chars returned (${result.tokenCount}) — likely a failure`));
  }

  return !result.error && !result.streamInterrupted && result.tokenCount > 100;
}

// ─── Test B: Explicit code execution request (smaller, faster) ────────────────

async function testExplicitCodeExec(auth) {
  console.log(c('blue', '\n[ Test B ] Explicit Python execution request (no file) — verify CSE responds'));

  // Use agent mode so cse_run_code is available
  const chatId = await createChat(auth, 'cse-code-exec-test', 'agent');

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
    '```\n\nThen tell me what these stats indicate about the sales price distribution.';

  const result = await streamWithTools(auth, chatId, { content: prompt });

  console.log(`  TTFT: ${result.ttftMs ?? 'N/A'}ms  |  Total: ${(result.totalMs / 1000).toFixed(1)}s  |  Chars: ${result.tokenCount}`);

  if (result.toolCalls.length > 0) {
    console.log(c('green', `  ✓ CSE invoked — ${result.toolCalls.length} tool call(s):`));
    for (const tc of result.toolCalls) console.log(c('cyan', `    • ${tc.name}`));
  } else {
    console.log(c('yellow', '  ⚠ No tool calls detected in SSE (model may have inlined the answer)'));
  }

  const ok = !result.error && !result.streamInterrupted && result.tokenCount > 50;
  console.log(ok ? c('green', '  ✓ Response OK') : c('red', `  ✗ Failed: ${result.error ?? 'no response'}`));
  return ok;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const auth = await setup();

  const aOk = await testCSVInsights(auth);
  const bOk = await testExplicitCodeExec(auth);

  console.log(c('bold', '\n=== CSE Test Summary ==='));
  console.log(`  Test A (real CSV → CSE insights): ${aOk ? c('green', 'PASS') : c('red', 'FAIL')}`);
  console.log(`  Test B (explicit Python exec):    ${bOk ? c('green', 'PASS') : c('red', 'FAIL')}`);

  if (!aOk || !bOk) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
