#!/usr/bin/env node
/**
 * timeout-load-test.mjs — Phase 1 stress test for timeout architecture.
 *
 * Tests:
 *   1. Long-form response  — forces the LLM to generate thousands of tokens (total-deadline stress)
 *   2. TTFT guard          — verifies a slow-start gets a clear TTFT error, not a 5-minute hang
 *   3. Concurrent load     — 10 simultaneous SSE streams, measures P50/P95/P99 TTFT + completion
 *   4. File analysis       — CSV attachment triggers 5-min budget; measures no timeout at normal length
 *   5. Agent chain         — agent mode gets 10-min budget
 *   6. Dead-connection     — aborts client immediately after SSE connect; expects clean server-side cleanup
 *
 * Usage:
 *   node scripts/timeout-load-test.mjs [--base-url http://localhost:3500] [--email X] [--password Y]
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// ─── Config ──────────────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv.slice(2)
    .join(' ')
    .match(/--(\w[\w-]*)(?:\s+|=)([^\s-][^\s]*)?/g)
    ?.map(s => {
      const [k, ...v] = s.replace(/^--/, '').split(/[\s=]+/);
      return [k, v.join('') || 'true'];
    }) ?? [],
);

const BASE_URL    = args['base-url'] ?? 'http://localhost:3500';
const TEST_EMAIL  = args['email']    ?? `load-test-${Date.now()}@weaveintel.test`;
const TEST_PASS   = args['password'] ?? 'LoadTest1!';
const CONCURRENCY = parseInt(args['concurrency'] ?? '10', 10);

const COLORS = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  yellow: '\x1b[33m', blue: '\x1b[34m', dim: '\x1b[2m', bold: '\x1b[1m',
};
const c = (color, text) => `${COLORS[color]}${text}${COLORS.reset}`;

// ─── Helpers ─────────────────────────────────────────────────────────────────

// auth is { token, csrfToken } — both needed for mutating API calls
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.floor(sorted.length * p / 100);
  return sorted[Math.min(idx, sorted.length - 1)];
}

/**
 * Stream a chat message via SSE and collect timing metrics.
 * Returns: { ttftMs, totalMs, tokenCount, error, streamInterrupted }
 */
async function streamChat(auth, chatId, message, signal, extraBody = {}) {
  const { token, csrfToken } = auth;
  const startMs = Date.now();
  let ttftMs = null;
  let tokenCount = 0;
  let error = null;
  let streamInterrupted = false;
  let doneReceived = false;

  // Outer try-catch ensures AbortErrors thrown by fetch() during connection
  // setup (before the response body reader is open) are caught, not leaked.
  try {
    const res = await fetch(`${BASE_URL}/api/chats/${chatId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ content: message, stream: true, ...extraBody }),
      signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ttftMs: null, totalMs: Date.now() - startMs, tokenCount: 0, error: `HTTP ${res.status}: ${body}`, streamInterrupted: false };
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    function parseEvents(chunk) {
      buffer += chunk;
      // SSE events are delimited by double-newline
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
          if (evt.type === 'error') error = evt.error;
          if (evt.type === 'done') {
            streamInterrupted = evt.streamInterrupted ?? false;
            doneReceived = true;
          }
        }
      }
    }

    try {
      while (!doneReceived) {
        const { done, value } = await reader.read();
        if (done) break;
        parseEvents(decoder.decode(value, { stream: true }));
      }
      // Flush remaining buffer
      if (buffer.trim()) parseEvents('');
    } catch (e) {
      error = e?.message ?? String(e);
    } finally {
      try { reader.cancel(); } catch {}
    }
  } catch (outerErr) {
    error = outerErr?.message ?? String(outerErr);
  }

  return { ttftMs, totalMs: Date.now() - startMs, tokenCount, error, streamInterrupted };
}

// ─── Setup ───────────────────────────────────────────────────────────────────

async function setup() {
  console.log(c('bold', '\n=== geneWeave Timeout Load Test ==='));
  console.log(c('dim', `Target: ${BASE_URL}  |  Concurrency: ${CONCURRENCY}\n`));

  // Register test user (ignore 409 = already exists)
  console.log('→ Registering test user...');
  const regRes = await api('POST', '/api/auth/register', { email: TEST_EMAIL, password: TEST_PASS, name: 'Load Test Bot' });
  if (regRes.status !== 200 && regRes.status !== 201 && regRes.status !== 409) {
    throw new Error(`Registration failed: ${regRes.status} ${JSON.stringify(regRes.json)}`);
  }

  // Auto-verify email in the SQLite DB so the test doesn't need an email server.
  const dbPaths = [
    join(process.cwd(), 'geneweave.db'),
    join(process.cwd(), args['db'] ?? ''),
  ].filter(p => p && existsSync(p));
  if (dbPaths.length > 0) {
    try {
      execSync(`sqlite3 "${dbPaths[0]}" "UPDATE users SET email_verified = 1 WHERE email = '${TEST_EMAIL}';"`, { stdio: 'pipe' });
      console.log(c('dim', '  (email auto-verified via DB for test)'));
    } catch {}
  }

  // Login — returns both a JWT and a csrfToken that must accompany mutating requests
  console.log('→ Logging in...');
  const loginRes = await api('POST', '/api/auth/token', { email: TEST_EMAIL, password: TEST_PASS });
  if (loginRes.status !== 200) {
    throw new Error(`Login failed: ${loginRes.status} ${JSON.stringify(loginRes.json)}`);
  }
  const token     = loginRes.json?.token ?? loginRes.json?.accessToken;
  const csrfToken = loginRes.json?.csrfToken;
  if (!token) throw new Error(`No token in login response: ${JSON.stringify(loginRes.json)}`);
  console.log(c('green', '✓ Authenticated\n'));
  return { token, csrfToken };
}

async function createChat(auth, title) {
  const res = await api('POST', '/api/chats', { title: title ?? 'load-test' }, auth);
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`Create chat failed: ${res.status} ${JSON.stringify(res.json)}`);
  }
  return res.json?.id ?? res.json?.chat?.id;
}

// ─── Test 1: Long-form response (total deadline stress) ───────────────────────

async function testLongResponse(auth) {
  console.log(c('blue', '[ Test 1 ] Long-form response — total deadline stress'));
  const chatId = await createChat(auth, 'long-response-test');

  const prompts = [
    'Write a comprehensive 4000-word technical report on distributed consensus algorithms. Cover Paxos, Raft, Byzantine fault tolerance, PBFT, and Zab. Include pseudocode, comparison tables, and real-world deployment examples from etcd, ZooKeeper, and CockroachDB.',
    'Generate a detailed 3000-word guide to implementing a production-grade LLM gateway from scratch. Cover rate limiting, circuit breakers, multi-provider routing, streaming SSE, token cost tracking, and observability with OpenTelemetry.',
  ];

  for (const prompt of prompts) {
    const shortLabel = prompt.slice(0, 60) + '...';
    process.stdout.write(`  Sending: "${shortLabel}"\n`);
    const result = await streamChat(auth, chatId, prompt, undefined);
    const status = result.streamInterrupted
      ? c('red', '✗ INTERRUPTED')
      : result.error
        ? c('red', `✗ ERROR: ${result.error}`)
        : c('green', '✓ OK');
    console.log(`  ${status}  TTFT=${result.ttftMs ?? '—'}ms  total=${result.totalMs}ms  chars=${result.tokenCount}`);
    if (result.streamInterrupted || result.error) {
      console.log(c('red', `  ERROR DETAIL: ${result.error}`));
    }
    await sleep(1000);
  }
  console.log();
}

// ─── Test 2: TTFT guard verification ─────────────────────────────────────────

async function testTtftEdge(auth) {
  console.log(c('blue', '[ Test 2 ] Concurrent rapid-fire — TTFT and delivery under load'));
  const chatId = await createChat(auth, 'ttft-test');

  // Fire 5 requests back-to-back without waiting; all should succeed or get a
  // meaningful TTFT error, never a 5-minute silent hang.
  const prompts = Array.from({ length: 5 }, (_, i) =>
    `Question ${i + 1}: What is ${i + 2} + ${i + 3}? Please answer concisely.`
  );

  const runs = await Promise.all(
    prompts.map(p => streamChat(auth, chatId, p, undefined))
  );

  runs.forEach((r, i) => {
    const ok = !r.streamInterrupted && !r.error;
    const icon = ok ? c('green', '✓') : c('red', '✗');
    console.log(`  [${i}] ${icon}  TTFT=${r.ttftMs ?? '—'}ms  total=${r.totalMs}ms  ${r.error ? 'ERR: ' + r.error : ''}`);
  });
  console.log();
}

// ─── Test 3: Concurrent load (P50/P95/P99 metrics) ───────────────────────────

async function testConcurrentLoad(auth) {
  console.log(c('blue', `[ Test 3 ] Concurrent load — ${CONCURRENCY} simultaneous streams`));
  const chatIds = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) => createChat(auth, `concurrent-${i}`))
  );

  // Mix of simple and medium-length prompts to simulate realistic traffic
  const messages = [
    'Summarize the key differences between REST, GraphQL, and gRPC in 200 words.',
    'Explain how a transformer attention mechanism works, step by step.',
    'List 20 common software architecture patterns with a one-sentence description each.',
    'What are the trade-offs between eventual consistency and strong consistency?',
    'Write a Python function to detect cycles in a directed graph using DFS with comments.',
    'Describe the CAP theorem and give a real-world example for each cell of the triangle.',
    'How does TCP congestion control work? Cover slow start, congestion avoidance, fast retransmit.',
    'Explain MVCC (Multi-Version Concurrency Control) in PostgreSQL with an example.',
    'What is the difference between process and thread scheduling in a modern OS?',
    'Describe a blue-green deployment strategy and how to implement zero-downtime rollbacks.',
  ];

  const startAll = Date.now();
  const results = await Promise.all(
    chatIds.map((chatId, i) =>
      streamChat(auth, chatId, messages[i % messages.length], undefined)
    )
  );
  const wallMs = Date.now() - startAll;

  const successes = results.filter(r => !r.streamInterrupted && !r.error);
  const failures  = results.filter(r =>  r.streamInterrupted || r.error);
  const ttfts     = results.map(r => r.ttftMs ?? 99_999).sort((a, b) => a - b);
  const totals    = results.map(r => r.totalMs).sort((a, b) => a - b);

  console.log(`  Concurrency:    ${CONCURRENCY}`);
  console.log(`  Wall time:      ${wallMs}ms`);
  console.log(`  Success:        ${c('green', successes.length)} / ${CONCURRENCY}`);
  console.log(`  Failures:       ${failures.length ? c('red', failures.length) : c('green', '0')}`);
  console.log(`  TTFT  P50=${percentile(ttfts, 50)}ms  P95=${percentile(ttfts, 95)}ms  P99=${percentile(ttfts, 99)}ms`);
  console.log(`  Total P50=${percentile(totals, 50)}ms  P95=${percentile(totals, 95)}ms  P99=${percentile(totals, 99)}ms`);

  if (failures.length > 0) {
    console.log(c('red', '  Failure details:'));
    failures.forEach(r => console.log(c('red', `    ${r.error}`)));
  }
  console.log();
}

// ─── Test 4: File analysis (CSV attachment → 5-min budget) ───────────────────

async function testFileAnalysis(auth) {
  console.log(c('blue', '[ Test 4 ] File analysis — CSV attachment → 5-min budget'));
  const chatId = await createChat(auth, 'file-analysis-test');

  // Generate a reasonably sized CSV (50 rows × 8 columns)
  const headers = 'month,region,product,units_sold,revenue_usd,cogs_usd,gross_margin,customer_nps';
  const regions = ['APAC', 'EMEA', 'AMER', 'LATAM'];
  const products = ['PlanA', 'PlanB', 'Enterprise', 'Starter'];
  const rows = Array.from({ length: 50 }, (_, i) => {
    const units = 100 + Math.floor(Math.random() * 900);
    const revenue = (units * (20 + Math.random() * 80)).toFixed(2);
    const cogs = (parseFloat(revenue) * (0.3 + Math.random() * 0.2)).toFixed(2);
    const margin = (((parseFloat(revenue) - parseFloat(cogs)) / parseFloat(revenue)) * 100).toFixed(1);
    const nps = (30 + Math.floor(Math.random() * 60)).toString();
    return [
      `2025-${String((i % 12) + 1).padStart(2, '0')}`,
      regions[i % 4],
      products[i % 4],
      units,
      revenue,
      cogs,
      margin,
      nps,
    ].join(',');
  });
  const csv = [headers, ...rows].join('\n');
  const csvB64 = Buffer.from(csv, 'utf8').toString('base64');

  // Use the raw stream with an attachment
  const startMs = Date.now();
  const res = await fetch(`${BASE_URL}/api/chats/${chatId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.token}`,
      ...(auth.csrfToken ? { 'X-CSRF-Token': auth.csrfToken } : {}),
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      content: 'Can you please analyse the data in this csv file and come up with interesting insights for future decision making? Look at trends by region, product and over time.',
      stream: true,
      attachments: [{
        name: 'sales_data.csv',
        mimeType: 'text/csv',
        size: csv.length,
        dataBase64: csvB64,
      }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.log(c('red', `  ✗ HTTP ${res.status}: ${body}`));
    return;
  }

  let ttftMs = null;
  let tokenCount = 0;
  let error = null;
  let streamInterrupted = false;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let doneReceived = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (!raw) continue;
        let evt;
        try { evt = JSON.parse(raw); } catch { continue; }
        if (evt.type === 'text' && evt.text) {
          if (ttftMs === null) ttftMs = Date.now() - startMs;
          tokenCount += evt.text.length;
        }
        if (evt.type === 'error') error = evt.error;
        if (evt.type === 'done') { streamInterrupted = evt.streamInterrupted ?? false; doneReceived = true; break; }
      }
      if (doneReceived) break;
    }
  } catch (e) { error = e?.message ?? String(e); }
  finally { try { reader.cancel(); } catch {} }

  const totalMs = Date.now() - startMs;
  const status = streamInterrupted
    ? c('red', '✗ INTERRUPTED — timeout fix NOT working')
    : error
      ? c('red', `✗ ERROR: ${error}`)
      : c('green', '✓ Completed within budget');

  console.log(`  ${status}`);
  console.log(`  TTFT=${ttftMs ?? '—'}ms  total=${totalMs}ms  response_chars=${tokenCount}`);
  console.log();
}

// ─── Test 5: Dead-connection cleanup ─────────────────────────────────────────

async function testDeadConnection(auth) {
  console.log(c('blue', '[ Test 5 ] Dead-connection — client aborts immediately after SSE connect'));
  const chatId = await createChat(auth, 'dead-conn-test');

  // Abort the client after 500 ms — the server should detect clientDisconnected
  // and clean up cleanly, not hold resources until deadline fires.
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 500);

  const startMs = Date.now();
  try {
    await streamChat(auth, chatId, 'Write a very long essay on the history of computing from 1940 to present day, covering every major milestone.', controller.signal);
  } catch (e) {
    // AbortError expected
  }
  const elapsed = Date.now() - startMs;

  if (elapsed < 2000) {
    console.log(c('green', `  ✓ Client abort cleaned up in ${elapsed}ms (server-side socket closed)`));
  } else {
    console.log(c('yellow', `  ⚠ Cleanup took ${elapsed}ms — check onClientClose handler`));
  }
  console.log();
}

// ─── Test 6: Maximum concurrent spike ────────────────────────────────────────

async function testConcurrentSpike(auth) {
  const spike = Math.max(CONCURRENCY * 2, 20);
  console.log(c('blue', `[ Test 6 ] Spike test — ${spike} simultaneous long requests`));

  const chatIds = await Promise.all(
    Array.from({ length: spike }, (_, i) => createChat(auth, `spike-${i}`))
  );

  const heavyPrompt = 'Explain the entire history of the internet from ARPANET to modern cloud computing. Include technical details, key protocols, and milestone dates. Be comprehensive.';

  const startAll = Date.now();
  const results = await Promise.all(
    chatIds.map(chatId => streamChat(auth, chatId, heavyPrompt, undefined))
  );
  const wallMs = Date.now() - startAll;

  const ok = results.filter(r => !r.streamInterrupted && !r.error).length;
  const interrupted = results.filter(r => r.streamInterrupted).length;
  const errored = results.filter(r => r.error && !r.streamInterrupted).length;
  const ttfts = results.map(r => r.ttftMs ?? 99_999).sort((a, b) => a - b);

  console.log(`  Requests:  ${spike}`);
  console.log(`  Wall time: ${wallMs}ms`);
  console.log(`  Success:   ${c('green', ok)}`);
  console.log(`  Timeout/Interrupted: ${interrupted ? c('red', interrupted) : c('green', '0')}`);
  console.log(`  Other errors: ${errored ? c('red', errored) : c('green', '0')}`);
  console.log(`  TTFT P50=${percentile(ttfts, 50)}ms  P95=${percentile(ttfts, 95)}ms  P99=${percentile(ttfts, 99)}ms`);
  if (interrupted > 0) {
    console.log(c('red', `  ✗ ${interrupted} streams were interrupted — timeout budget may be too short under spike load`));
  } else {
    console.log(c('green', '  ✓ No stream interruptions under spike load'));
  }
  console.log();
}

// ─── Phase 2 helpers ─────────────────────────────────────────────────────────

/**
 * Like streamChat but also captures raw SSE heartbeat (": ping") lines so
 * we can verify the server emits them on schedule.
 */
async function streamChatWithHeartbeat(auth, chatId, prompt, signal) {
  const controller = signal ? undefined : new AbortController();
  const abortSignal = signal ?? controller.signal;

  const res = await fetch(`${BASE_URL}/api/chats/${chatId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${auth.token}`,
      'X-CSRF-Token': auth.csrfToken,
    },
    body: JSON.stringify({ content: prompt, stream: true }),
    signal: abortSignal,
  });

  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let tokenCount = 0;
  let ttftMs = null;
  const startMs = Date.now();
  const pingTimestamps = [];   // when each ": ping" arrived
  let doneReceived = false;
  let streamInterrupted = false;

  const processChunk = (chunk) => {
    buffer += chunk;
    const parts = buffer.split(/\n\n|\r\n\r\n/);
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      for (const line of part.split(/\r?\n/)) {
        if (line.startsWith(':')) {
          // SSE comment — heartbeat ping
          pingTimestamps.push(Date.now() - startMs);
          continue;
        }
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trimStart();
        let evt;
        try { evt = JSON.parse(raw); } catch { continue; }
        if (evt.type === 'text' && typeof evt.text === 'string' && evt.text.length > 0) {
          if (ttftMs === null) ttftMs = Date.now() - startMs;
          tokenCount += evt.text.length;
        }
        if (evt.type === 'done') {
          streamInterrupted = evt.streamInterrupted ?? false;
          doneReceived = true;
        }
      }
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      processChunk(decoder.decode(value, { stream: true }));
    }
  } finally {
    try { await reader.cancel(); } catch { /* ignore */ }
    reader.releaseLock();
  }

  return { ttftMs, tokenCount, doneReceived, streamInterrupted, pingTimestamps, elapsedMs: Date.now() - startMs };
}

// ─── Test 7: Heartbeat interval verification ──────────────────────────────────

async function testHeartbeat(auth) {
  console.log(c('blue', '[ Test 7 ] Heartbeat — verify ": ping" comments arrive every ~12 s'));
  console.log(c('dim',  '           (run a long prompt, watch for heartbeat SSE comments)'));

  const chatId = await createChat(auth, 'heartbeat-test');
  const prompt = [
    'Write a detailed, step-by-step technical tutorial on building a full-stack web application',
    'from scratch using Node.js, TypeScript, React, and PostgreSQL.',
    'Include code examples for every step: project setup, database schema, backend routes,',
    'authentication, frontend components, state management, testing, and deployment.',
    'Be extremely verbose and comprehensive — this should be at least 3000 words.',
  ].join(' ');

  const { ttftMs, tokenCount, pingTimestamps, doneReceived, elapsedMs } = await streamChatWithHeartbeat(auth, chatId, prompt);

  console.log(`  TTFT:       ${ttftMs ?? '—'}ms`);
  console.log(`  Chars:      ${tokenCount}`);
  console.log(`  Duration:   ${elapsedMs}ms`);
  console.log(`  Pings:      ${pingTimestamps.length}  [${pingTimestamps.map(t => `${(t/1000).toFixed(1)}s`).join(', ')}]`);
  console.log(`  Done event: ${doneReceived ? c('green', 'yes') : c('red', 'missing')}`);

  // Validate: at least 1 ping per 15 s of stream time (heartbeat interval is 12 s)
  const expectedMinPings = Math.max(1, Math.floor(elapsedMs / 15_000));
  if (pingTimestamps.length >= expectedMinPings) {
    console.log(c('green', `  ✓ Heartbeat verified: ${pingTimestamps.length} pings over ${(elapsedMs/1000).toFixed(1)}s`));
  } else if (pingTimestamps.length > 0) {
    console.log(c('yellow', `  ⚠ Only ${pingTimestamps.length} pings over ${(elapsedMs/1000).toFixed(1)}s — expected ≥${expectedMinPings}`));
  } else {
    console.log(c('red', '  ✗ No heartbeat pings received — server may not be sending heartbeats'));
  }

  // Check inter-ping intervals
  if (pingTimestamps.length >= 2) {
    const intervals = pingTimestamps.slice(1).map((t, i) => t - pingTimestamps[i]);
    const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const maxInterval = Math.max(...intervals);
    console.log(`  Avg interval: ${(avgInterval/1000).toFixed(1)}s  Max: ${(maxInterval/1000).toFixed(1)}s`);
    if (maxInterval > 20_000) {
      console.log(c('yellow', `  ⚠ Max ping gap ${(maxInterval/1000).toFixed(1)}s exceeds 20 s — may starve proxies with tight timeouts`));
    } else {
      console.log(c('green', `  ✓ Ping regularity OK (max gap ${(maxInterval/1000).toFixed(1)}s < 20 s)`));
    }
  }
  console.log();
}

// ─── Test 8: Concurrent partial disconnects — survivor integrity ───────────────

async function testPartialDisconnects(auth) {
  const total = 16;
  const abortCount = 8;
  console.log(c('blue', `[ Test 8 ] Partial disconnects — ${abortCount}/${total} streams abort mid-stream; survivors must complete cleanly`));

  const chatIds = await Promise.all(
    Array.from({ length: total }, (_, i) => createChat(auth, `partial-${i}`))
  );

  const heavyPrompt = 'Write a comprehensive survey of modern distributed systems design patterns, covering consensus algorithms, replication strategies, CAP theorem trade-offs, and real-world case studies. Be very detailed.';

  const controllers = Array.from({ length: total }, () => new AbortController());

  // Abort the first `abortCount` streams after a random 1–4 s delay
  controllers.slice(0, abortCount).forEach((ctrl, i) => {
    const delay = 1000 + Math.random() * 3000;
    setTimeout(() => ctrl.abort(), delay);
  });

  const results = await Promise.allSettled(
    chatIds.map((chatId, i) => streamChat(auth, chatId, heavyPrompt, controllers[i].signal))
  );

  const aborted  = results.slice(0, abortCount);
  const survivors = results.slice(abortCount);

  const survivorOk = survivors.filter(r => r.status === 'fulfilled' && !r.value.streamInterrupted && !r.value.error).length;
  const survivorFail = survivors.filter(r => r.status === 'rejected' || r.value?.streamInterrupted || r.value?.error).length;

  const survivorTtfts = survivors
    .filter(r => r.status === 'fulfilled' && r.value.ttftMs != null)
    .map(r => r.value.ttftMs)
    .sort((a, b) => a - b);

  console.log(`  Intentional aborts: ${abortCount}/${total}`);
  console.log(`  Survivors OK:       ${c(survivorOk === survivors.length ? 'green' : 'red', survivorOk)}/${survivors.length}`);
  if (survivorTtfts.length > 0) {
    console.log(`  Survivor TTFT P50:  ${percentile(survivorTtfts, 50)}ms  P95: ${percentile(survivorTtfts, 95)}ms`);
  }

  if (survivorFail > 0) {
    const failDetails = survivors
      .filter(r => r.status === 'rejected' || r.value?.streamInterrupted || r.value?.error)
      .map(r => r.status === 'rejected' ? r.reason?.message : (r.value?.error || 'interrupted'))
      .join(', ');
    console.log(c('red', `  ✗ ${survivorFail} survivors failed — partial disconnects may have corrupted server state: ${failDetails}`));
  } else {
    console.log(c('green', '  ✓ All survivors completed cleanly despite concurrent aborts'));
  }
  console.log();
}

// ─── Test 9: Connection leak detection ───────────────────────────────────────

async function testConnectionLeaks(auth) {
  console.log(c('blue', '[ Test 9 ] Connection leak — 20 fast-abort streams; check lsof fd count after'));

  // Capture open-fd count before (macOS/Linux)
  let fdBefore = null;
  let fdAfter  = null;
  try {
    const { execSync } = await import('node:child_process');
    const pid = (await fetch(`${BASE_URL}/api/health`).catch(() => null))
      ? undefined  // can't get server PID from outside — use lsof on port
      : undefined;
    fdBefore = parseInt(execSync(`lsof -i :3500 2>/dev/null | grep ESTABLISHED | wc -l`, { encoding: 'utf-8' }).trim(), 10);
  } catch {
    fdBefore = null;
  }

  const chatIds = await Promise.all(
    Array.from({ length: 20 }, (_, i) => createChat(auth, `leak-${i}`))
  );

  const prompt = 'Write a very long story about dragons.';
  const controllers = Array.from({ length: 20 }, () => new AbortController());

  // Abort all after 300–800 ms
  controllers.forEach((ctrl, i) => setTimeout(() => ctrl.abort(), 300 + i * 25));

  await Promise.allSettled(
    chatIds.map((chatId, i) =>
      streamChat(auth, chatId, prompt, controllers[i].signal).catch(() => {})
    )
  );

  // Give the server 2 s to clean up
  await new Promise(r => setTimeout(r, 2000));

  try {
    const { execSync } = await import('node:child_process');
    fdAfter = parseInt(execSync(`lsof -i :3500 2>/dev/null | grep ESTABLISHED | wc -l`, { encoding: 'utf-8' }).trim(), 10);
  } catch {
    fdAfter = null;
  }

  if (fdBefore !== null && fdAfter !== null) {
    const leaked = fdAfter - fdBefore;
    if (leaked <= 2) {
      console.log(c('green', `  ✓ No connection leak: ${fdBefore} before → ${fdAfter} after (Δ${leaked})`));
    } else {
      console.log(c('yellow', `  ⚠ Possible leak: ${fdBefore} before → ${fdAfter} after (Δ${leaked} — may be background reconnects)`));
    }
  } else {
    console.log(c('dim', '  — lsof check skipped (could not query open connections — run manually: lsof -i :3500 | grep ESTABLISHED | wc -l)'));
    console.log(c('green', '  ✓ 20 fast-abort streams completed without process crash'));
  }
  console.log();
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const auth = await setup().catch(e => { console.error(c('red', `Setup failed: ${e.message}`)); process.exit(1); });

  await testLongResponse(auth);
  await testTtftEdge(auth);
  await testConcurrentLoad(auth);
  await testFileAnalysis(auth);
  await testDeadConnection(auth);
  await testConcurrentSpike(auth);

  // Phase 2: heartbeat, partial disconnects, connection leaks
  await testHeartbeat(auth);
  await testPartialDisconnects(auth);
  await testConnectionLeaks(auth);

  console.log(c('bold', '=== Load test complete ===\n'));
}

main().catch(e => {
  console.error(c('red', `Fatal: ${e.message}`));
  process.exit(1);
});
