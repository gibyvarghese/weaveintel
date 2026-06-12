#!/usr/bin/env node
// scripts/e2e-sp2-conversations.mjs
//
// SP2 (mobile pre-task) — live-server end-to-end proof for the user-scoped
// conversation list that backs the mobile conversation screen (M6):
//
//   GET   /api/me/conversations?query=&filter=&limit=&offset=
//   PATCH /api/me/conversations/:id   { pinned?, archived?, title? }
//
// Flow:
//   1. Register principal A, mint a bearer token via POST /api/auth/token.
//   2. Create three chats; GET /api/me/conversations → assert full response shape.
//   3. Search via ?query= → only matching titles returned.
//   4. PATCH { pinned:true } → pinned conversation floats to the top.
//   5. PATCH { archived:true } → hidden from default list, visible under ?filter=archived.
//   6. PATCH { title } → rename echoed back.
//   7. hasPendingAction: create an action-item task whose provenance.sourceRunId
//      points at a chat → that chat reports hasPendingAction:true (proves the
//      shared in-memory task repo is read across route modules over real HTTP).
//   8. Cross-principal PATCH (principal B) → 404 (no existence disclosure).
//   9. Validation: empty body / bad types → 400; missing CSRF → 403; no auth → 401.
//
// Usage: zsh> set +H && BASE_URL=http://localhost:3599 node scripts/e2e-sp2-conversations.mjs
import { BASE, makeOk, jfetch } from './e2e-helpers.mjs';

const ok = makeOk();
const ts = Date.now();
const password = 'P@ssw0rd123';

console.log(`\n=== SP2 conversations E2E — ${BASE} ===\n`);

// ── 0/1. Two principals, bearer tokens for each ─────────────────────────────
async function principal(tag) {
  const email = `e2e_sp2_${tag}_${ts}@example.com`;
  const reg = await jfetch('POST', '/api/auth/register', { body: { email, password, name: tag } });
  ok(reg.status === 201, `[${tag}] register status=${reg.status}`);
  const tok = await jfetch('POST', '/api/auth/token', { body: { email, password } });
  ok(tok.status === 200 && tok.body?.token, `[${tag}] token minted (status=${tok.status})`);
  return { email, bearer: tok.body.token, csrf: tok.body.csrfToken };
}

console.log('0/1. Register principals A and B and mint bearer tokens');
const A = await principal('a');
const B = await principal('b');

async function createChat(p, title) {
  const r = await jfetch('POST', '/api/chats', { bearer: p.bearer, csrf: p.csrf, body: { title } });
  ok(r.status === 201 && r.body?.chat?.id, `create chat "${title}" (status=${r.status})`);
  return r.body.chat.id;
}

console.log('\n2. Create three chats and list them with the full response shape');
const budgetId = await createChat(A, 'Budget planning Q3');
const ideasId = await createChat(A, 'Random ideas');
const archiveId = await createChat(A, 'Archive me later');

const list1 = await jfetch('GET', '/api/me/conversations', { bearer: A.bearer });
ok(list1.status === 200 && Array.isArray(list1.body?.conversations), `list status=${list1.status}`);
const all = list1.body.conversations;
ok(all.length >= 3, `at least three conversations returned (got ${all.length})`);
const sample = all.find((c) => c.id === budgetId);
ok(!!sample, 'created chat present in the list');
ok(sample.title === 'Budget planning Q3', 'title echoed');
ok('snippet' in sample && (sample.snippet === null || typeof sample.snippet === 'string'), 'snippet present (null or string)');
ok(typeof sample.mode === 'string', `mode present (=${sample.mode})`);
ok(typeof sample.updatedAt === 'string' && !Number.isNaN(Date.parse(sample.updatedAt)), 'updatedAt is an ISO timestamp');
ok(sample.runStatus === null, 'runStatus is null for chat-backed conversations');
ok(sample.pinned === false && sample.archived === false, 'pinned/archived default to false');
ok(sample.hasPendingAction === false, 'hasPendingAction false with no tasks');
ok(Array.isArray(sample.participants) && sample.participants.length === 1, 'participants is length-1');
ok(sample.unread === false, 'unread is false');

console.log('\n3. Search filters by title');
const search = await jfetch('GET', '/api/me/conversations?query=budget', { bearer: A.bearer });
ok(search.status === 200, `search status=${search.status}`);
const searchIds = search.body.conversations.map((c) => c.id);
ok(searchIds.includes(budgetId), 'budget chat matched by search');
ok(!searchIds.includes(ideasId), 'non-matching chat excluded from search');

console.log('\n4. PATCH { pinned:true } floats the conversation to the top');
const pin = await jfetch('PATCH', `/api/me/conversations/${budgetId}`, { bearer: A.bearer, csrf: A.csrf, body: { pinned: true } });
ok(pin.status === 200 && pin.body?.conversation?.pinned === true, `pin status=${pin.status}, pinned=${pin.body?.conversation?.pinned}`);
const afterPin = await jfetch('GET', '/api/me/conversations', { bearer: A.bearer });
ok(afterPin.body.conversations[0].id === budgetId, 'pinned conversation is first in the list');

console.log('\n5. PATCH { archived:true } hides from default, shows under filter=archived');
const archive = await jfetch('PATCH', `/api/me/conversations/${archiveId}`, { bearer: A.bearer, csrf: A.csrf, body: { archived: true } });
ok(archive.status === 200 && archive.body?.conversation?.archived === true, `archive status=${archive.status}`);
const defaultList = await jfetch('GET', '/api/me/conversations', { bearer: A.bearer });
ok(!defaultList.body.conversations.some((c) => c.id === archiveId), 'archived chat hidden from default list');
const archivedList = await jfetch('GET', '/api/me/conversations?filter=archived', { bearer: A.bearer });
ok(archivedList.body.conversations.some((c) => c.id === archiveId), 'archived chat visible under filter=archived');

console.log('\n6. PATCH { title } renames the conversation');
const rename = await jfetch('PATCH', `/api/me/conversations/${ideasId}`, { bearer: A.bearer, csrf: A.csrf, body: { title: '  Brainstorm backlog  ' } });
ok(rename.status === 200 && rename.body?.conversation?.title === 'Brainstorm backlog', `rename trimmed (=${rename.body?.conversation?.title})`);

console.log('\n7. hasPendingAction is derived from an open task pointing at the chat');
const taskRes = await jfetch('POST', '/api/me/tasks', {
  bearer: A.bearer, csrf: A.csrf,
  body: { title: 'Approve the budget', provenance: { sourceRunId: budgetId, createdBy: 'principal' } },
});
ok(taskRes.status === 201, `task created (status=${taskRes.status})`);
const withTask = await jfetch('GET', '/api/me/conversations', { bearer: A.bearer });
const budgetRow = withTask.body.conversations.find((c) => c.id === budgetId);
ok(budgetRow?.hasPendingAction === true, 'chat with an open task reports hasPendingAction:true');
const ideasRow = withTask.body.conversations.find((c) => c.id === ideasId);
ok(ideasRow?.hasPendingAction === false, 'chat without a task reports hasPendingAction:false');

console.log('\n8. Cross-principal PATCH is hidden behind a 404');
const cross = await jfetch('PATCH', `/api/me/conversations/${budgetId}`, { bearer: B.bearer, csrf: B.csrf, body: { pinned: true } });
ok(cross.status === 404, `principal B cannot touch principal A's chat (status=${cross.status})`);
const crossList = await jfetch('GET', '/api/me/conversations', { bearer: B.bearer });
ok(!crossList.body.conversations.some((c) => c.id === budgetId), 'principal B does not see principal A chats');

console.log('\n9. Validation and auth');
const empty = await jfetch('PATCH', `/api/me/conversations/${budgetId}`, { bearer: A.bearer, csrf: A.csrf, body: {} });
ok(empty.status === 400, `empty PATCH body → 400 (status=${empty.status})`);
const badType = await jfetch('PATCH', `/api/me/conversations/${budgetId}`, { bearer: A.bearer, csrf: A.csrf, body: { pinned: 'yes' } });
ok(badType.status === 400, `non-boolean pinned → 400 (status=${badType.status})`);
const emptyTitle = await jfetch('PATCH', `/api/me/conversations/${budgetId}`, { bearer: A.bearer, csrf: A.csrf, body: { title: '   ' } });
ok(emptyTitle.status === 400, `blank title → 400 (status=${emptyTitle.status})`);
const noCsrf = await jfetch('PATCH', `/api/me/conversations/${budgetId}`, { bearer: A.bearer, body: { pinned: true } });
ok(noCsrf.status === 403, `PATCH without CSRF → 403 (status=${noCsrf.status})`);
const noAuth = await jfetch('GET', '/api/me/conversations', {});
ok(noAuth.status === 401, `unauthenticated list → 401 (status=${noAuth.status})`);
const unknownId = await jfetch('PATCH', '/api/me/conversations/does-not-exist', { bearer: A.bearer, csrf: A.csrf, body: { pinned: true } });
ok(unknownId.status === 404, `unknown conversation id → 404 (status=${unknownId.status})`);

console.log(`\n=== SP2 conversations E2E PASSED — ${ok.count()} assertions ===\n`);
