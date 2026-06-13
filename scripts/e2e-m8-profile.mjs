// E2E: M8 Profile / Memory / Settings — /api/auth/me + /api/me/memories + /api/me/notification-preferences.
//
// Verifies, end to end, the server surface that backs the mobile Profile, Memory,
// and Settings screens:
//   1.  POST /api/auth/login                       authenticates; csrfToken in body, cookie in header
//   2.  GET  /api/auth/me                           identity round-trips (persona drives "Manage on web")
//   3.  POST /api/me/memories                       creates a user-authored note (kind 'user-authored')
//   4.  GET  /api/me/memories                        lists it under memories['user-authored'], counts grounded
//   5.  PATCH /api/me/memories/:id                   correction preserves lineage (correctedFrom === original)
//   6.  GET  /api/me/memories                        corrected text active; original superseded (hidden)
//   7.  validation                                   blank content → 400; unknown id correct/delete → 404
//   8.  DELETE /api/me/memories/:id                  removes the corrected note; double-delete → 404
//   9.  PUT  /api/me/notification-preferences        round-trips enabled + categories + quietHours string
//  10. GET  /api/me/notification-preferences         reads back exactly what was written
//  11. DELETE /api/me/memories { confirm:true }      clear-all empties the user-authored group
//      DELETE /api/me/memories {}                    requires confirm:true → 400
//
// The test account is a dedicated tenant_user (tester@geneweave.local). Step 11 clears
// that account's authored memory on purpose to prove the destructive path; nothing else
// in the suite depends on pre-existing data.
import { randomUUID } from 'node:crypto';

const BASE = process.env.BASE ?? 'http://localhost:3500';
const EMAIL = process.env.EMAIL ?? 'tester@geneweave.local';
const PASS = process.env.PASS ?? 'Testpass123!';

const TAG = `e2e-m8-${randomUUID().slice(0, 8)}`;

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  \u2713 ${msg}`);
}

async function main() {
  // ── 1. auth ───────────────────────────────────────────────────────────────
  console.log('\n[1] POST /api/auth/login');
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
  assert(typeof login.csrfToken === 'string' && login.csrfToken.length > 0, 'login returns csrfToken in body');
  const auth = { Cookie: cookie, 'X-CSRF-Token': login.csrfToken, 'Content-Type': 'application/json' };

  const req = async (path, init = {}) => {
    const r = await fetch(`${BASE}${path}`, { headers: auth, ...init });
    const text = await r.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body };
  };

  // ── 2. identity ─────────────────────────────────────────────────────────────
  console.log('\n[2] GET /api/auth/me (identity for the Profile header)');
  const me = await req('/api/auth/me');
  assert(me.status === 200, `me ok (${me.status})`);
  assert(me.body.user && typeof me.body.user.id === 'string', 'me returns a user id');
  assert(me.body.user.email === EMAIL, 'me email matches the signed-in account');
  assert(typeof me.body.user.persona === 'string', `me persona present (${me.body.user.persona})`);

  // ── 3. create a user-authored note ──────────────────────────────────────────
  console.log('\n[3] POST /api/me/memories (author a note)');
  const noteText = `${TAG} I prefer concise answers.`;
  const createRes = await req('/api/me/memories', {
    method: 'POST',
    body: JSON.stringify({ content: noteText }),
  });
  assert(createRes.status === 201, `note created (${createRes.status})`);
  const note = createRes.body;
  assert(typeof note.id === 'string', 'created note has an id');
  assert(note.kind === 'user-authored', 'created note is user-authored');
  assert(note.content === noteText, 'created note content round-trips');

  // ── 4. list shows it under the user-authored group ──────────────────────────
  console.log('\n[4] GET /api/me/memories (note appears in the user-authored group)');
  const list1 = await req('/api/me/memories');
  assert(list1.status === 200, `list ok (${list1.status})`);
  const authored1 = list1.body.memories?.['user-authored'] ?? [];
  const found = authored1.find((m) => m.id === note.id);
  assert(!!found, 'created note listed under memories[user-authored]');
  assert(found.content === noteText, 'listed note keeps its content');
  assert(list1.body.counts?.['user-authored'] === authored1.length, 'user-authored count matches the array length');

  // ── 5. correction preserves lineage ─────────────────────────────────────────
  console.log('\n[5] PATCH /api/me/memories/:id (correct — preserves lineage)');
  const correctedText = `${TAG} I prefer concise, well-sourced answers.`;
  const patchRes = await req(`/api/me/memories/${note.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ content: correctedText, reason: 'tightened wording' }),
  });
  assert(patchRes.status === 200, `correction ok (${patchRes.status})`);
  const corrected = patchRes.body;
  assert(corrected.content === correctedText, 'correction stores the new text');
  assert(corrected.correctedFrom === note.id, 'correction records correctedFrom = original id');
  assert(corrected.id !== note.id, 'correction mints a new memory id');

  // ── 6. corrected active, original superseded ────────────────────────────────
  console.log('\n[6] GET /api/me/memories (corrected active, original hidden)');
  const list2 = await req('/api/me/memories');
  const authored2 = list2.body.memories?.['user-authored'] ?? [];
  assert(authored2.some((m) => m.id === corrected.id), 'corrected note is active');
  assert(!authored2.some((m) => m.id === note.id), 'superseded original is hidden from the active list');

  // ── 7. validation ───────────────────────────────────────────────────────────
  console.log('\n[7] validation (blank content → 400; unknown id → 404)');
  const blank = await req('/api/me/memories', { method: 'POST', body: JSON.stringify({ content: '   ' }) });
  assert(blank.status === 400, `blank content rejected (${blank.status})`);
  const missingPatch = await req(`/api/me/memories/${randomUUID()}`, {
    method: 'PATCH',
    body: JSON.stringify({ content: `${TAG} nope` }),
  });
  assert(missingPatch.status === 404, `correct of unknown id → 404 (${missingPatch.status})`);
  const missingDel = await req(`/api/me/memories/${randomUUID()}`, { method: 'DELETE' });
  assert(missingDel.status === 404, `delete of unknown id → 404 (${missingDel.status})`);

  // ── 8. delete single ────────────────────────────────────────────────────────
  console.log('\n[8] DELETE /api/me/memories/:id (remove the corrected note)');
  const delRes = await req(`/api/me/memories/${corrected.id}`, { method: 'DELETE' });
  assert(delRes.status === 200 && delRes.body.deleted === true, `corrected note deleted (${delRes.status})`);
  const delAgain = await req(`/api/me/memories/${corrected.id}`, { method: 'DELETE' });
  assert(delAgain.status === 404, `double-delete → 404 (${delAgain.status})`);

  // ── 9. notification preferences round-trip ──────────────────────────────────
  console.log('\n[9] PUT /api/me/notification-preferences (round-trip)');
  const quietHours = '22:00-07:00 America/New_York';
  const categories = ['mentions', 'tasks', 'approvals'];
  const putRes = await req('/api/me/notification-preferences', {
    method: 'PUT',
    body: JSON.stringify({ enabled: true, categories, quietHours }),
  });
  assert(putRes.status === 200 && putRes.body.saved === true, `preferences saved (${putRes.status})`);

  // ── 10. read back ───────────────────────────────────────────────────────────
  console.log('\n[10] GET /api/me/notification-preferences (reads back what was written)');
  const getPrefs = await req('/api/me/notification-preferences');
  assert(getPrefs.status === 200, `preferences read (${getPrefs.status})`);
  assert(getPrefs.body.enabled === true, 'enabled round-trips');
  assert(
    Array.isArray(getPrefs.body.categories) &&
      categories.every((c) => getPrefs.body.categories.includes(c)),
    'categories round-trip',
  );
  assert(getPrefs.body.quietHours === quietHours, 'quietHours opaque string round-trips (timezone preserved)');

  // ── 11. clear-all (destructive path) ────────────────────────────────────────
  console.log('\n[11] DELETE /api/me/memories (clear-all requires confirm:true)');
  const clearNoConfirm = await req('/api/me/memories', { method: 'DELETE', body: JSON.stringify({}) });
  assert(clearNoConfirm.status === 400, `clear without confirm → 400 (${clearNoConfirm.status})`);
  // Seed one more so the clear has something to remove, then clear.
  await req('/api/me/memories', { method: 'POST', body: JSON.stringify({ content: `${TAG} ephemeral` }) });
  const clear = await req('/api/me/memories', { method: 'DELETE', body: JSON.stringify({ confirm: true }) });
  assert(clear.status === 200 && clear.body.cleared === true, `clear-all ok (${clear.status})`);
  const afterClear = await req('/api/me/memories');
  const authoredAfter = afterClear.body.memories?.['user-authored'] ?? [];
  assert(authoredAfter.length === 0, 'user-authored group is empty after clear-all');

  console.log('\n\u2705 M8 profile / memory / settings e2e passed');
}

main().catch((err) => {
  console.error(`\n\u274c ${err.message}`);
  process.exit(1);
});
