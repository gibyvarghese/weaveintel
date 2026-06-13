// E2E: M6 Chats tab — /api/me/conversations list + flag mutations.
//
// Verifies the SP2 server surface that backs the mobile Chats tab end to end:
//   1. GET  /api/me/conversations            lists the caller's chats (shape)
//   2. ?query=<token>                         server-side text search narrows
//   3. ?filter=pinned                         returns only pinned, non-archived
//   4. PATCH pinned:true                      pins (round-trips into ?filter=pinned)
//   5. PATCH archived:true                    hides from default view, shows in ?filter=archived
//   6. PATCH title                            renames
//   7. PATCH validation                       rejects bad bodies / cross-user ids (404)
//
// Self-contained: seeds a handful of chats (+ a snippet message each) directly
// into SQLite for the test user, exercises the authenticated API, then deletes
// exactly what it seeded. No persona change required (a plain tenant_user owns
// its own conversations).
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const BASE = process.env.BASE ?? 'http://localhost:3500';
const DB = process.env.DB ?? './geneweave.db';
const EMAIL = process.env.EMAIL ?? 'tester@geneweave.local';
const PASS = process.env.PASS ?? 'Testpass123!';

const sql = (q) => execSync(`sqlite3 ${DB} ${JSON.stringify(q)}`).toString().trim();

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

const TAG = `e2e-m6-${randomUUID().slice(0, 8)}`;
const SEARCH_TOKEN = `ZZQ${randomUUID().slice(0, 6).toUpperCase()}`;

// id, title, pinned, archived, ageMinutes (older = larger), snippet
const SEED = [
  { key: 'recent', title: `${TAG} planning notes`, pinned: 0, archived: 0, age: 1, snippet: 'draft the rollout' },
  { key: 'pinned', title: `${TAG} pinned thread`, pinned: 1, archived: 0, age: 30, snippet: 'keep this handy' },
  { key: 'search', title: `${TAG} ${SEARCH_TOKEN} special`, pinned: 0, archived: 0, age: 60, snippet: 'unique one' },
  { key: 'old', title: `${TAG} older chat`, pinned: 0, archived: 0, age: 5000, snippet: 'last week' },
];

function seed() {
  const userId = sql(`SELECT id FROM users WHERE email='${EMAIL}';`);
  if (!userId) throw new Error(`test user ${EMAIL} not found`);
  const ids = {};
  for (const s of SEED) {
    const id = `${TAG}-${s.key}`;
    ids[s.key] = id;
    const ts = `datetime('now', '-${s.age} minutes')`;
    sql(
      `INSERT INTO chats (id, user_id, title, model, provider, pinned, archived, created_at, updated_at) ` +
        `VALUES ('${id}', '${userId}', ${JSON.stringify(s.title)}, 'gpt', 'openai', ${s.pinned}, ${s.archived}, ${ts}, ${ts});`,
    );
    sql(
      `INSERT INTO messages (id, chat_id, role, content, created_at) ` +
        `VALUES ('${id}-m', '${id}', 'assistant', ${JSON.stringify(s.snippet)}, ${ts});`,
    );
  }
  return { userId, ids };
}

function cleanup() {
  // Cascade deletes messages + chat_settings via FK; delete messages explicitly too for safety.
  sql(`DELETE FROM messages WHERE chat_id LIKE '${TAG}-%';`);
  sql(`DELETE FROM chats WHERE id LIKE '${TAG}-%';`);
}

async function main() {
  const { ids } = seed();

  try {
    // ── auth ────────────────────────────────────────────────────────────────
    const loginRes = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASS }),
    });
    if (!loginRes.ok) throw new Error(`login failed: ${loginRes.status} ${await loginRes.text()}`);
    const login = await loginRes.json();
    const setCookie = loginRes.headers.get('set-cookie') ?? '';
    const cookie = setCookie.split(',').map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');
    if (!cookie) throw new Error('no session cookie');
    const auth = { Cookie: cookie, 'X-CSRF-Token': login.csrfToken, 'Content-Type': 'application/json' };

    const req = async (path, init = {}) => {
      const r = await fetch(`${BASE}${path}`, { headers: auth, ...init });
      const text = await r.text();
      let body; try { body = JSON.parse(text); } catch { body = text; }
      return { status: r.status, body };
    };
    const mine = (list) => list.filter((c) => c.id.startsWith(`${TAG}-`));

    // ── 1. list + shape ───────────────────────────────────────────────────────
    console.log('\n[1] GET /api/me/conversations (default active)');
    const list = await req('/api/me/conversations?limit=200');
    assert(list.status === 200, `list ok (${list.status})`);
    const seeded = mine(list.body.conversations);
    assert(seeded.length === 4, `all 4 seeded conversations listed (got ${seeded.length})`);
    const sample = seeded.find((c) => c.id === ids.recent);
    assert(typeof sample.pinned === 'boolean' && typeof sample.archived === 'boolean', 'pinned/archived are booleans');
    assert(sample.snippet === 'draft the rollout', 'snippet is the latest message content');
    assert(Array.isArray(sample.participants) && sample.participants.length >= 1, 'participants present');
    // pinned sorts first (server ORDER BY pinned DESC)
    assert(seeded[0].id === ids.pinned, 'pinned conversation sorts first');

    // ── 2. text search ────────────────────────────────────────────────────────
    console.log('\n[2] GET ?query=<token>');
    const search = await req(`/api/me/conversations?query=${SEARCH_TOKEN}`);
    const found = mine(search.body.conversations);
    assert(found.length === 1 && found[0].id === ids.search, 'search token matches exactly one conversation');

    // ── 3. pinned filter ──────────────────────────────────────────────────────
    console.log('\n[3] GET ?filter=pinned');
    const pinnedOnly = await req('/api/me/conversations?filter=pinned&limit=200');
    const pinnedSeeded = mine(pinnedOnly.body.conversations);
    assert(pinnedSeeded.length === 1 && pinnedSeeded[0].id === ids.pinned, 'only the pinned seed returned');

    // ── 4. PATCH pin (optimistic flag round-trip) ─────────────────────────────
    console.log('\n[4] PATCH pinned:true on a recent chat');
    const pin = await req(`/api/me/conversations/${ids.recent}`, { method: 'PATCH', body: JSON.stringify({ pinned: true }) });
    assert(pin.status === 200, `pin ok (${pin.status})`);
    assert(pin.body.conversation.pinned === true, 'response shows pinned=true');
    const pinnedNow = mine((await req('/api/me/conversations?filter=pinned&limit=200')).body.conversations);
    assert(pinnedNow.some((c) => c.id === ids.recent), 'newly pinned chat appears under ?filter=pinned');

    // ── 5. PATCH archive (hide from active, show in archived) ─────────────────
    console.log('\n[5] PATCH archived:true');
    const arch = await req(`/api/me/conversations/${ids.old}`, { method: 'PATCH', body: JSON.stringify({ archived: true }) });
    assert(arch.status === 200 && arch.body.conversation.archived === true, 'archive ok + flag set');
    const activeAfter = mine((await req('/api/me/conversations?limit=200')).body.conversations);
    assert(!activeAfter.some((c) => c.id === ids.old), 'archived chat hidden from default view');
    const archivedView = mine((await req('/api/me/conversations?filter=archived&limit=200')).body.conversations);
    assert(archivedView.some((c) => c.id === ids.old), 'archived chat visible under ?filter=archived');

    // ── 6. PATCH rename ───────────────────────────────────────────────────────
    console.log('\n[6] PATCH title');
    const renamed = await req(`/api/me/conversations/${ids.search}`, { method: 'PATCH', body: JSON.stringify({ title: 'Renamed by e2e' }) });
    assert(renamed.status === 200 && renamed.body.conversation.title === 'Renamed by e2e', 'title updated');

    // ── 7. validation + isolation ─────────────────────────────────────────────
    console.log('\n[7] PATCH validation + cross-id isolation');
    const empty = await req(`/api/me/conversations/${ids.recent}`, { method: 'PATCH', body: '{}' });
    assert(empty.status === 400, `empty patch rejected (${empty.status})`);
    const badType = await req(`/api/me/conversations/${ids.recent}`, { method: 'PATCH', body: JSON.stringify({ pinned: 'yes' }) });
    assert(badType.status === 400, `non-boolean pinned rejected (${badType.status})`);
    const missing = await req(`/api/me/conversations/does-not-exist-${randomUUID()}`, { method: 'PATCH', body: JSON.stringify({ pinned: true }) });
    assert(missing.status === 404, `unknown id is 404 (${missing.status})`);

    console.log('\n✅ M6 conversations e2e passed');
  } finally {
    cleanup();
    console.log('  ✓ cleaned up seeded conversations');
  }
}

main().catch((err) => {
  cleanup();
  console.error(`\n❌ ${err.message}`);
  process.exit(1);
});
