/**
 * End-to-end test: pgvector semantic memory via agent memory tools
 *
 * Flow:
 *  1. Register a fresh test user
 *  2. Create a chat in agent mode with memory tools enabled
 *  3. Ask the agent to remember a specific fact using memory_remember
 *  4. Verify the pgvector table received the row
 *  5. Ask the agent to recall the fact using memory_search
 *  6. Verify the response references the stored content
 *  7. Print a summary pass/fail
 */

import { Pool } from 'pg';

const BASE_URL = process.env['API_URL'] ?? 'http://localhost:3500';
const PG_URL = process.env['PGVECTOR_URL'] ?? 'postgresql://gibyvarghese@localhost:5432/geneweave';

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const g = (s: string) => `\x1b[32m${s}\x1b[0m`;
const r = (s: string) => `\x1b[31m${s}\x1b[0m`;
const y = (s: string) => `\x1b[33m${s}\x1b[0m`;
const b = (s: string) => `\x1b[34m${s}\x1b[0m`;
const d = (s: string) => `\x1b[2m${s}\x1b[0m`;

let cookie = '';
let csrfToken = '';
let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ${g('✓')} ${label}`);
    passed++;
  } else {
    console.log(`  ${r('✗')} ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

async function api(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  if (csrfToken && method !== 'GET') headers['X-CSRF-Token'] = csrfToken;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) {
    const m = setCookie.match(/gw_token=([^;]+)/);
    if (m) cookie = `gw_token=${m[1]}`;
  }
  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  return { status: res.status, data };
}

async function apiStream(path: string, body: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await res.text();
  const events = text.split('\n')
    .filter(l => l.startsWith('data: '))
    .map(l => { try { return JSON.parse(l.slice(6)) as Record<string, unknown>; } catch { return {}; } });
  const assistantEvent = events.find(e => e['type'] === 'message' && (e['role'] === 'assistant' || (e['content'] && !e['role'])));
  const doneEvent = events.find(e => e['type'] === 'done');
  const toolEvents = events.filter(e => e['type'] === 'tool_call' || e['type'] === 'tool_result');
  // Collect all text content from chunk/delta events as fallback
  const contentChunks = events
    .filter(e => e['type'] === 'chunk' || e['type'] === 'delta' || e['type'] === 'content')
    .map(e => String(e['content'] ?? e['text'] ?? ''))
    .join('');
  return { status: res.status, events, assistantEvent, doneEvent, toolEvents, contentChunks };
}

// ── Test setup ────────────────────────────────────────────────────────────────

async function registerUser(): Promise<string> {
  const email = `pgvec-test-${Date.now()}@weaveintel.dev`;
  const { status, data } = await api('POST', '/api/auth/register', {
    name: 'PgVector Test User',
    email,
    password: 'Str0ng!Pass99',
  });
  if (status !== 201) throw new Error(`register failed: ${status} ${JSON.stringify(data)}`);
  csrfToken = String(data['csrfToken'] ?? '');
  return email;
}

async function createAgentChat(): Promise<string> {
  const { status, data } = await api('POST', '/api/chats', {
    title: 'pgvector memory e2e test',
    model: 'gpt-4o',
    provider: 'openai',
  });
  if (status !== 201) throw new Error(`create chat failed: ${status}`);
  const chat = data['chat'] as Record<string, unknown>;
  return String(chat['id']);
}

async function configureChatForMemory(chatId: string) {
  const { status } = await api('POST', `/api/chats/${chatId}/settings`, {
    mode: 'agent',
    model: 'gpt-4o',
    provider: 'openai',
    systemPrompt: 'You are a helpful assistant with long-term memory. When asked to remember something, always call memory_remember. When asked to recall or search memory, always call memory_search or memory_recall.',
    enabledTools: ['memory_remember', 'memory_recall', 'memory_search', 'memory_list_entities'],
    redactionEnabled: false,
    workers: [],
  });
  if (status !== 200) throw new Error(`settings failed: ${status}`);
}

// ── pgvector helpers ──────────────────────────────────────────────────────────

async function countPgVectorRows(pool: Pool): Promise<number> {
  try {
    const res = await pool.query('SELECT COUNT(*)::int AS n FROM geneweave_memory_vec');
    return (res.rows[0] as { n: number }).n;
  } catch {
    return -1; // table may not exist yet
  }
}

async function getPgVectorRows(pool: Pool, limit = 5): Promise<Array<{ id: string; content: string; user_id: string; type: string; metadata: string }>> {
  try {
    const res = await pool.query(
      `SELECT id, content, user_id, type, metadata::text
         FROM geneweave_memory_vec
        ORDER BY created_at DESC
        LIMIT $1`,
      [limit],
    );
    return res.rows as Array<{ id: string; content: string; user_id: string; type: string; metadata: string }>;
  } catch {
    return [];
  }
}

// ── Main test ─────────────────────────────────────────────────────────────────

async function run() {
  console.log(b('\n══════════════════════════════════════════════════════'));
  console.log(b('  pgvector Semantic Memory — End-to-End Test'));
  console.log(b('══════════════════════════════════════════════════════\n'));

  const pool = new Pool({ connectionString: PG_URL });

  // ── Step 0: verify pgvector is reachable ─────────────────────────────────
  console.log(b('[ 0 ] Verify pgvector connection'));
  try {
    const res = await pool.query("SELECT extversion FROM pg_extension WHERE extname='vector'");
    const ver = (res.rows[0] as { extversion: string } | undefined)?.extversion;
    assert(`vector extension installed (${ver})`, !!ver, 'run: CREATE EXTENSION vector in geneweave DB');
  } catch (e) {
    assert('pgvector DB reachable', false, String(e));
    console.log(r('\nCannot reach pgvector — aborting.\n'));
    await pool.end();
    process.exit(1);
  }

  // ── Step 1: register user + create chat ──────────────────────────────────
  console.log(b('\n[ 1 ] Auth + chat setup'));
  let chatId: string;
  try {
    const email = await registerUser();
    console.log(`  ${d('user:')} ${email}`);
    chatId = await createAgentChat();
    console.log(`  ${d('chat:')} ${chatId}`);
    await configureChatForMemory(chatId);
    assert('registered user, created agent chat with memory tools', true);
  } catch (e) {
    assert('setup', false, String(e));
    await pool.end(); process.exit(1);
  }

  const rowsBefore = await countPgVectorRows(pool);
  console.log(`  ${d(`pgvector rows before test: ${rowsBefore === -1 ? '(table does not exist yet)' : rowsBefore}`)}`);

  // ── Step 2: ask agent to remember a fact ─────────────────────────────────
  console.log(b('\n[ 2 ] Ask agent to store a fact via memory_remember'));
  const FACT = 'My name is Aria Nakamura. I am a senior distributed systems engineer at CloudScale Inc. I specialise in consensus algorithms and Raft-based replication.';
  console.log(`  ${d('sending:')} "${FACT.slice(0, 80)}..."`);

  const rememberResp = await apiStream(`/api/chats/${chatId}/messages`, {
    content: `Please use the memory_remember tool to store this information permanently: "${FACT}"`,
    stream: true,
    model: 'gpt-4o',
    provider: 'openai',
  });

  assert('HTTP 200 from remember message', rememberResp.status === 200);
  assert('got done event', !!rememberResp.doneEvent);

  const usedMemoryRemember = rememberResp.toolEvents.some(
    e => String(e['name'] ?? e['tool'] ?? JSON.stringify(e)).includes('memory_remember'),
  );
  if (!usedMemoryRemember) {
    // Also check content text for confirmation
    const allContent = rememberResp.events.map(e => String(e['content'] ?? '')).join('');
    console.log(`  ${y('⚠')}  tool_events found: ${rememberResp.toolEvents.length} — checking content for confirmation`);
    console.log(`  ${d('response excerpt:')} ${allContent.slice(0, 200)}`);
  }

  // Poll for rows — the lazy schema init and write happen after the SSE stream closes
  let rowsAfterStore = -1;
  for (let attempt = 0; attempt < 8; attempt++) {
    await new Promise(res => setTimeout(res, 1500));
    rowsAfterStore = await countPgVectorRows(pool);
    if (rowsAfterStore > 0) break;
  }

  // ── Step 3: verify pgvector row was written ───────────────────────────────
  console.log(b('\n[ 3 ] Verify pgvector row written'));
  assert(
    `pgvector table exists and has rows (${rowsAfterStore})`,
    rowsAfterStore > 0,
    rowsAfterStore === -1 ? 'geneweave_memory_vec table missing — app may not have pgvector active (restart required?)' : 'no rows written',
  );

  if (rowsAfterStore > 0) {
    const rows = await getPgVectorRows(pool, 3);
    console.log(`\n  ${d('latest pgvector rows:')}`);
    for (const row of rows) {
      console.log(`    ${d('id:')} ${row.id.slice(0, 8)}…  ${d('type:')} ${row.type}`);
      console.log(`    ${d('content:')} ${row.content.slice(0, 120)}`);
      try {
        const meta = JSON.parse(row.metadata) as Record<string, unknown>;
        console.log(`    ${d('metadata:')} memory_type=${meta['memory_type']} source=${meta['source']}`);
      } catch { /* */ }
      console.log();
    }

    const hasFactContent = rows.some(row =>
      row.content.toLowerCase().includes('aria') ||
      row.content.toLowerCase().includes('nakamura') ||
      row.content.toLowerCase().includes('cloudscale') ||
      row.content.toLowerCase().includes('distributed'),
    );
    assert('stored content contains the remembered fact', hasFactContent,
      `none of the ${rows.length} rows matched expected keywords`);

    // Check embedding was stored
    const embeddingCheck = await pool.query(
      `SELECT id, (embedding IS NOT NULL) AS has_embedding
         FROM geneweave_memory_vec
        ORDER BY created_at DESC LIMIT 3`,
    );
    const hasEmbedding = (embeddingCheck.rows as Array<{ has_embedding: boolean }>).some(r => r.has_embedding);
    assert('embedding vector stored alongside content', hasEmbedding);
  }

  // ── Step 4: ask agent to recall the fact ─────────────────────────────────
  console.log(b('\n[ 4 ] Ask agent to retrieve via memory_search'));
  const recallResp = await apiStream(`/api/chats/${chatId}/messages`, {
    content: 'Use memory_search to find what you know about me — my name, role, and company.',
    stream: true,
    model: 'gpt-4o',
    provider: 'openai',
  });

  assert('HTTP 200 from recall message', recallResp.status === 200);
  assert('got done event', !!recallResp.doneEvent);

  const allRecallContent = recallResp.events
    .map(e => String(e['content'] ?? e['text'] ?? ''))
    .join('')
    .toLowerCase();

  console.log(`\n  ${d('agent response excerpt:')}`);
  const excerptText = recallResp.events
    .map(e => String(e['content'] ?? e['text'] ?? ''))
    .join('')
    .slice(0, 400);
  console.log(`  ${d(excerptText || '(no text content in events)')}`);

  assert('response mentions "Aria" or "Nakamura"',
    allRecallContent.includes('aria') || allRecallContent.includes('nakamura'));
  assert('response mentions role/company',
    allRecallContent.includes('engineer') || allRecallContent.includes('cloudscale') || allRecallContent.includes('distributed'));

  // ── Step 5: final pgvector row count ────────────────────────────────────
  console.log(b('\n[ 5 ] Final pgvector state'));
  const rowsFinal = await countPgVectorRows(pool);
  console.log(`  Total rows in geneweave_memory_vec: ${rowsFinal}`);

  const dimCheck = await pool.query(
    `SELECT vector_dims(embedding) AS dims
       FROM geneweave_memory_vec
      WHERE embedding IS NOT NULL
      LIMIT 1`,
  ).catch(() => ({ rows: [] }));
  if (dimCheck.rows.length > 0) {
    const dims = (dimCheck.rows[0] as { dims: number }).dims;
    assert(`embedding dimensionality = ${dims} (expected 1536)`, dims === 1536);
  }

  // ── Summary ────────────────────────────────────────────────────────────
  await pool.end();
  console.log(b('\n══════════════════════════════════════════════════════'));
  if (failed === 0) {
    console.log(g(`  ALL ${passed} ASSERTIONS PASSED`));
  } else {
    console.log(r(`  ${failed} FAILED`) + d(` / `) + g(`${passed} passed`));
  }
  console.log(b('══════════════════════════════════════════════════════\n'));
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => {
  console.error(r('\nUnhandled error: ') + String(e));
  process.exit(1);
});
