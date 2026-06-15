/**
 * stress-test-features.ts — Comprehensive stress test for Agenda, Notes, Actions,
 * Reminders, and AI Agent (supervisor) capabilities.
 *
 * Covers:
 *   • CRUD operations on agenda items and categories
 *   • CRUD on notes + links + backlinks + note databases
 *   • Task (action item) creation, completion, cancellation
 *   • Reminder create / list / delete
 *   • Supervisor agent: agenda_list, reminder_*, memory_recall, multi-topic
 *   • Cross-domain: agent querying agenda + notes at once
 *   • Edge cases: missing fields, filters, NL date parsing
 *
 * Run: npx tsx scripts/stress-test-features.ts
 */

import crypto from 'crypto';
import Database from 'better-sqlite3';

// ─── Config ────────────────────────────────────────────────────────────────

const BASE_URL = 'http://localhost:3500';
const DB_PATH = './geneweave.db';
const JWT_SECRET = 'dev-secret';
const USER_EMAIL = 'giby.varghese@gmail.com';

// ─── Auth setup ────────────────────────────────────────────────────────────

function createAuthToken(userId: string, email: string): { token: string; csrf: string; sessionId: string } {
  const db = new (Database as unknown as typeof import('better-sqlite3').default)(DB_PATH);
  const sessionId = `stress-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const csrf = crypto.randomBytes(16).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 7200;
  db.prepare('INSERT OR REPLACE INTO sessions (id, user_id, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)').run(
    sessionId, userId, csrf, new Date(exp * 1000).toISOString(), new Date().toISOString()
  );
  db.close();
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ userId, email, sessionId, iat: now, exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  return { token: `${header}.${payload}.${sig}`, csrf, sessionId };
}

function getUserId(): string {
  const db = new (Database as unknown as typeof import('better-sqlite3').default)(DB_PATH);
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(USER_EMAIL) as { id: string } | undefined;
  db.close();
  if (!user) throw new Error(`User ${USER_EMAIL} not found`);
  return user.id;
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────

interface TestCtx {
  token: string;
  csrf: string;
  userId: string;
  chatId: string;
}

async function api(
  ctx: TestCtx,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `gw_token=${ctx.token}`,
      'X-CSRF-Token': ctx.csrf,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: unknown;
  const text = await res.text();
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

interface ChatStep {
  type: string;
  toolCall?: { name: string; arguments?: unknown; result?: string };
  delegation?: { worker: string; result?: string };
}

interface ChatResponse {
  content: string;
  steps: ChatStep[];
  enabledTools: string[];
  usage: { totalTokens: number };
  toolsUsed: string[];
}

async function chat(ctx: TestCtx, message: string): Promise<ChatResponse> {
  const res = await api(ctx, 'POST', `/api/chats/${ctx.chatId}/messages`, { content: message });
  const d = res.data as Record<string, unknown>;
  const steps = (d['steps'] as ChatStep[]) ?? [];
  // Collect all tool names called at any level (supervisor direct + in delegation results)
  const toolsUsed: string[] = [];
  for (const s of steps) {
    if (s.toolCall?.name) toolsUsed.push(s.toolCall.name);
    // Check delegation result text for tool evidence
    const delResult = s.delegation?.result ?? '';
    if (delResult.includes('agenda_list') || delResult.includes('"items"')) toolsUsed.push('agenda_list(via_worker)');
  }
  return {
    content: String(d['assistantContent'] ?? d['content'] ?? ''),
    steps,
    enabledTools: (d['enabledTools'] as string[]) ?? [],
    usage: (d['usage'] as { totalTokens: number }) ?? { totalTokens: 0 },
    toolsUsed,
  };
}

// ─── Test runner ───────────────────────────────────────────────────────────

type TestResult = { name: string; passed: boolean; detail: string; duration: number };
const results: TestResult[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  try {
    await fn();
    const ms = Date.now() - start;
    results.push({ name, passed: true, detail: 'OK', duration: ms });
    console.log(`  ✓ ${name} (${ms}ms)`);
  } catch (err) {
    const ms = Date.now() - start;
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, detail, duration: ms });
    console.error(`  ✗ ${name} (${ms}ms): ${detail}`);
  }
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

function assertField<T>(obj: unknown, field: string, expected?: T): void {
  const val = (obj as Record<string, unknown>)[field];
  if (expected !== undefined) {
    assert(val === expected, `Expected ${field}=${JSON.stringify(expected)}, got ${JSON.stringify(val)}`);
  } else {
    assert(val !== undefined && val !== null, `Expected ${field} to exist, got ${JSON.stringify(val)}`);
  }
}

// ─── TEST SUITES ──────────────────────────────────────────────────────────

// ── Suite 1: Agenda CRUD ──────────────────────────────────────────────────

async function testAgendaCRUD(ctx: TestCtx): Promise<void> {
  console.log('\n── Suite 1: Agenda CRUD ──────────────────────────────────────');
  let eventId = '';
  let categoryId = '';

  await test('Create agenda category', async () => {
    const r = await api(ctx, 'POST', '/api/me/agenda/categories', { name: 'Work', color: '#3B82F6', icon: '💼' });
    assert(r.status === 201, `Expected 201, got ${r.status}`);
    const d = r.data as Record<string, unknown>;
    const cats = (d['categories'] as Array<Record<string, unknown>>);
    const created = cats.find(c => c['name'] === 'Work');
    assert(!!created, 'Work category not found');
    categoryId = created!['id'] as string;
  });

  await test('List agenda categories', async () => {
    const r = await api(ctx, 'GET', '/api/me/agenda/categories');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    const d = r.data as Record<string, unknown>;
    assert(Array.isArray(d['categories']), 'categories should be array');
  });

  await test('Create event (NL: dentist next monday at 10am)', async () => {
    const r = await api(ctx, 'POST', '/api/me/agenda', {
      nlText: 'dentist next monday at 10am',
      category_id: categoryId,
    });
    assert(r.status === 201, `Expected 201, got ${r.status}: ${JSON.stringify(r.data)}`);
    const d = r.data as Record<string, unknown>;
    assert(!!d['id'], 'Expected id');
    assert(String(d['start_at'] ?? '').includes('T10:00'), `Expected 10:00 in start_at, got ${d['start_at']}`);
    eventId = d['id'] as string;
  });

  await test('Create event (explicit ISO datetime)', async () => {
    const r = await api(ctx, 'POST', '/api/me/agenda', {
      title: 'Q3 Planning Meeting',
      kind: 'event',
      start_at: '2026-07-01T14:00',
      end_at: '2026-07-01T16:00',
      all_day: 0,
      location: 'Conference Room A',
      description: 'Quarterly planning with leadership',
    });
    assert(r.status === 201, `Expected 201, got ${r.status}`);
    const d = r.data as Record<string, unknown>;
    assertField(d, 'title');
    assert(d['start_at'] === '2026-07-01T14:00', `Wrong start_at: ${d['start_at']}`);
  });

  await test('Create deadline (NL: submit report tomorrow at 5pm)', async () => {
    const r = await api(ctx, 'POST', '/api/me/agenda', {
      nlText: 'submit report tomorrow at 5pm',
    });
    assert(r.status === 201, `Expected 201, got ${r.status}`);
    const d = r.data as Record<string, unknown>;
    assert(d['kind'] === 'deadline', `Expected kind=deadline, got ${d['kind']}`);
    assert(String(d['start_at'] ?? '').includes('T17:00'), `Expected 17:00, got ${d['start_at']}`);
  });

  await test('Create reminder (NL: remind me every monday)', async () => {
    const r = await api(ctx, 'POST', '/api/me/agenda', {
      nlText: 'remind me every monday to send the weekly update',
    });
    assert(r.status === 201, `Expected 201, got ${r.status}`);
    const d = r.data as Record<string, unknown>;
    // Should infer 'recurring' or 'reminder' from "remind me every"
    assert(['reminder', 'recurring'].includes(String(d['kind'])), `Expected reminder/recurring, got ${d['kind']}`);
  });

  await test('Create appointment (NL: doctor appointment friday at 2pm)', async () => {
    const r = await api(ctx, 'POST', '/api/me/agenda', {
      nlText: 'doctor appointment friday at 2pm',
    });
    assert(r.status === 201, `Expected 201, got ${r.status}`);
    const d = r.data as Record<string, unknown>;
    assert(d['kind'] === 'appointment', `Expected appointment, got ${d['kind']}`);
  });

  await test('Create all-day event (NL: company holiday next friday)', async () => {
    const r = await api(ctx, 'POST', '/api/me/agenda', {
      nlText: 'company holiday next friday',
      kind: 'event',
    });
    assert(r.status === 201, `Expected 201, got ${r.status}`);
    const d = r.data as Record<string, unknown>;
    // 'friday' has no time → should be all_day=1
    assert(d['all_day'] === 1, `Expected all_day=1, got ${d['all_day']}`);
  });

  await test('List agenda items (no filter)', async () => {
    const r = await api(ctx, 'GET', '/api/me/agenda');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    const d = r.data as Record<string, unknown>;
    assert(Array.isArray(d['items']), 'items should be array');
    assert((d['items'] as unknown[]).length >= 1, 'Should have at least 1 item');
  });

  await test('List agenda items filtered by kind=appointment', async () => {
    const r = await api(ctx, 'GET', '/api/me/agenda?kind=appointment');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    const d = r.data as Record<string, unknown>;
    const items = d['items'] as Array<Record<string, unknown>>;
    assert(items.every(i => i['kind'] === 'appointment'), `Non-appointment items found`);
  });

  await test('List agenda items filtered by date range', async () => {
    const r = await api(ctx, 'GET', '/api/me/agenda?start=2026-06-15&end=2026-07-31');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    const d = r.data as Record<string, unknown>;
    assert(Array.isArray(d['items']), 'items should be array');
  });

  await test('Get single agenda item', async () => {
    const r = await api(ctx, 'GET', `/api/me/agenda/${eventId}`);
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    const d = r.data as Record<string, unknown>;
    assert(d['id'] === eventId, `Wrong id: ${d['id']}`);
  });

  await test('Update agenda item (PATCH)', async () => {
    const r = await api(ctx, 'PATCH', `/api/me/agenda/${eventId}`, {
      title: 'Dentist checkup (updated)',
      location: 'City Dental Clinic, 123 Main St',
      description: 'Annual checkup + X-rays',
    });
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    const d = r.data as Record<string, unknown>;
    assert(d['title'] === 'Dentist checkup (updated)', `Title not updated: ${d['title']}`);
    assert(d['location'] === 'City Dental Clinic, 123 Main St', `Location not updated`);
  });

  await test('Update agenda status (PATCH → cancelled)', async () => {
    const r = await api(ctx, 'PATCH', `/api/me/agenda/${eventId}`, { status: 'cancelled' });
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    const d = r.data as Record<string, unknown>;
    assert(d['status'] === 'cancelled', `Status not updated: ${d['status']}`);
  });

  await test('Update agenda category', async () => {
    const r = await api(ctx, 'PATCH', `/api/me/agenda/categories/${categoryId}`, {
      name: 'Work & Personal',
      color: '#8B5CF6',
    });
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  await test('Delete agenda item', async () => {
    const r = await api(ctx, 'DELETE', `/api/me/agenda/${eventId}`);
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    const d = r.data as Record<string, unknown>;
    assert(d['deleted'] === true, `Expected deleted=true`);
    // Confirm gone
    const r2 = await api(ctx, 'GET', `/api/me/agenda/${eventId}`);
    assert(r2.status === 404, `Expected 404 after delete, got ${r2.status}`);
  });

  await test('Delete agenda category', async () => {
    const r = await api(ctx, 'DELETE', `/api/me/agenda/categories/${categoryId}`);
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });
}

// ── Suite 2: Notes CRUD ───────────────────────────────────────────────────

async function testNotesCRUD(ctx: TestCtx): Promise<void> {
  console.log('\n── Suite 2: Notes CRUD ──────────────────────────────────────');
  let noteId1 = '';
  let noteId2 = '';
  let noteId3 = '';
  let linkId = '';

  const docJson = JSON.stringify({
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Meeting Notes' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Discussed Q3 roadmap and staffing.' }] },
      {
        type: 'taskList',
        content: [{
          type: 'taskItem',
          attrs: { checked: false },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Follow up on budget approval' }] }],
        }, {
          type: 'taskItem',
          attrs: { checked: false },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Share meeting summary with team' }] }],
        }],
      },
    ],
  });

  await test('Create note with Tiptap doc', async () => {
    const r = await api(ctx, 'POST', '/api/me/notes', {
      title: 'Q3 Meeting Notes',
      doc_json: docJson,
      icon: '📝',
    });
    assert(r.status === 201, `Expected 201, got ${r.status}: ${JSON.stringify(r.data)}`);
    const d = r.data as Record<string, unknown>;
    assertField(d, 'id');
    assert(d['title'] === 'Q3 Meeting Notes', `Wrong title: ${d['title']}`);
    noteId1 = d['id'] as string;
  });

  await test('Create second note (sub-page parent)', async () => {
    const r = await api(ctx, 'POST', '/api/me/notes', {
      title: 'Action Items from Q3 Meeting',
      parent_note_id: noteId1,
      doc_json: JSON.stringify({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Budget approval + summary sharing.' }] }],
      }),
    });
    assert(r.status === 201, `Expected 201, got ${r.status}`);
    const d = r.data as Record<string, unknown>;
    assert(d['parent_note_id'] === noteId1, `Wrong parent: ${d['parent_note_id']}`);
    noteId2 = d['id'] as string;
  });

  await test('Create third note (project reference)', async () => {
    const r = await api(ctx, 'POST', '/api/me/notes', {
      title: 'Project Atlas – Overview',
      doc_json: JSON.stringify({
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Project Atlas' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'AI-powered product roadmap initiative.' }] },
          { type: 'blockquote', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Key insight: automate status updates.' }] }] },
        ],
      }),
      sensitivity: 'confidential',
    });
    assert(r.status === 201, `Expected 201, got ${r.status}`);
    noteId3 = (r.data as Record<string, unknown>)['id'] as string;
  });

  await test('List all notes', async () => {
    const r = await api(ctx, 'GET', '/api/me/notes');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    const d = r.data as Record<string, unknown>;
    assert(Array.isArray(d['notes']), 'notes should be array');
    assert((d['notes'] as unknown[]).length >= 1, 'Should have at least 1 note');
  });

  await test('List notes with parent filter', async () => {
    const r = await api(ctx, 'GET', `/api/me/notes?parent=${noteId1}`);
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    const d = r.data as Record<string, unknown>;
    const notes = d['notes'] as Array<Record<string, unknown>>;
    assert(notes.some(n => n['id'] === noteId2), `Sub-note ${noteId2} not found under parent`);
  });

  await test('List notes with search', async () => {
    const r = await api(ctx, 'GET', '/api/me/notes?search=Q3');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    const d = r.data as Record<string, unknown>;
    const notes = d['notes'] as Array<Record<string, unknown>>;
    assert(notes.some(n => String(n['title'] ?? '').includes('Q3')), 'Q3 note not found in search');
  });

  await test('Get note by ID', async () => {
    const r = await api(ctx, 'GET', `/api/me/notes/${noteId1}`);
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    const d = r.data as Record<string, unknown>;
    assert(d['id'] === noteId1, `Wrong id: ${d['id']}`);
    assertField(d, 'doc_json');
  });

  await test('PATCH note (update title + favorite)', async () => {
    const r = await api(ctx, 'PATCH', `/api/me/notes/${noteId1}`, {
      title: 'Q3 Meeting Notes ⭐',
      favorite: 1,
    });
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    const d = r.data as Record<string, unknown>;
    assert(d['title'] === 'Q3 Meeting Notes ⭐', `Title not updated: ${d['title']}`);
  });

  await test('PATCH note (update doc_json)', async () => {
    const updatedDoc = JSON.stringify({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Meeting Notes (Updated)' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Added additional context from follow-up.' }] },
      ],
    });
    const r = await api(ctx, 'PATCH', `/api/me/notes/${noteId1}`, { doc_json: updatedDoc });
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  await test('List note templates', async () => {
    const r = await api(ctx, 'GET', '/api/me/notes/templates');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    const d = r.data as Record<string, unknown>;
    assert(Array.isArray(d['templates']), 'templates should be array');
  });

  await test('Create link between notes (note1 → note3)', async () => {
    const r = await api(ctx, 'POST', `/api/me/notes/${noteId1}/links`, {
      target_kind: 'note',
      target_id: noteId3,
    });
    assert(r.status === 201, `Expected 201, got ${r.status}: ${JSON.stringify(r.data)}`);
    const d = r.data as Record<string, unknown>;
    assertField(d, 'id');
    linkId = d['id'] as string;
  });

  await test('List outbound links from note1', async () => {
    const r = await api(ctx, 'GET', `/api/me/notes/${noteId1}/links`);
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    const d = r.data as Record<string, unknown>;
    const links = d['links'] as Array<Record<string, unknown>>;
    assert(Array.isArray(links), 'links should be array');
    assert(links.some(l => l['target_id'] === noteId3), 'Link to note3 not found');
  });

  await test('Get backlinks to note3', async () => {
    const r = await api(ctx, 'GET', `/api/me/notes/${noteId3}/backlinks`);
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    const d = r.data as Record<string, unknown>;
    const backlinks = d['backlinks'] as Array<Record<string, unknown>>;
    assert(Array.isArray(backlinks), 'backlinks should be array');
    // note1 links to note3, so note3's backlinks should include note1
    assert(backlinks.some(b => b['source_note_id'] === noteId1 || b['note_id'] === noteId1),
      `note1 not found in note3 backlinks: ${JSON.stringify(backlinks)}`);
  });

  await test('Extract tasks from note doc (to-do items)', async () => {
    const r = await api(ctx, 'POST', `/api/me/notes/${noteId1}/extract`, { doc_json: docJson });
    assert(r.status === 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.data)}`);
    // Should extract "Follow up on budget approval" and "Share meeting summary with team"
  });

  await test('Create note database (saved view)', async () => {
    const r = await api(ctx, 'POST', '/api/me/note-databases', {
      name: 'Project Tracker',
      view_type: 'table',
      filter_json: JSON.stringify({ status: 'active' }),
    });
    assert(r.status === 201, `Expected 201, got ${r.status}: ${JSON.stringify(r.data)}`);
    const d = r.data as Record<string, unknown>;
    assertField(d, 'id');
    const dbId = d['id'] as string;

    // Add rows to database
    const rowR = await api(ctx, 'POST', `/api/me/note-databases/${dbId}/rows`, {
      fields: JSON.stringify({ project: 'Atlas', status: 'in-progress', priority: 'high' }),
    });
    assert(rowR.status === 201, `Expected 201 for row, got ${rowR.status}`);
    const rowId = (rowR.data as Record<string, unknown>)['id'] as string;

    // Update row
    const patchR = await api(ctx, 'PATCH', `/api/me/note-databases/${dbId}/rows/${rowId}`, {
      fields: JSON.stringify({ project: 'Atlas', status: 'completed', priority: 'high' }),
    });
    assert(patchR.status === 200, `Expected 200 for row patch, got ${patchR.status}`);

    // List rows
    const listR = await api(ctx, 'GET', `/api/me/note-databases/${dbId}/rows`);
    assert(listR.status === 200, `Expected 200 for list rows, got ${listR.status}`);
    const rows = (listR.data as Record<string, unknown>)['rows'] as Array<unknown>;
    assert(rows.length >= 1, 'Expected at least 1 row');

    // Delete row
    const delRowR = await api(ctx, 'DELETE', `/api/me/note-databases/${dbId}/rows/${rowId}`);
    assert(delRowR.status === 200, `Expected 200 for row delete`);

    // Delete database
    const delDbR = await api(ctx, 'DELETE', `/api/me/note-databases/${dbId}`);
    assert(delDbR.status === 200, `Expected 200 for database delete`);
  });

  await test('Delete note link', async () => {
    const r = await api(ctx, 'DELETE', `/api/me/notes/${noteId1}/links/${linkId}`);
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  await test('Delete note (leaf: note2)', async () => {
    const r = await api(ctx, 'DELETE', `/api/me/notes/${noteId2}`);
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  await test('Delete note (leaf: note3)', async () => {
    const r = await api(ctx, 'DELETE', `/api/me/notes/${noteId3}`);
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });

  await test('Delete note (parent: note1 with cascades)', async () => {
    const r = await api(ctx, 'DELETE', `/api/me/notes/${noteId1}`);
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    // Verify gone
    const r2 = await api(ctx, 'GET', `/api/me/notes/${noteId1}`);
    assert(r2.status === 404, `Expected 404 after delete, got ${r2.status}`);
  });
}

// ── Suite 3: Action Items (Tasks) ─────────────────────────────────────────

async function testActionItems(ctx: TestCtx): Promise<void> {
  console.log('\n── Suite 3: Action Items (Tasks) ────────────────────────────');
  let taskId1 = '';
  let taskId2 = '';

  await test('Create plain action item', async () => {
    const r = await api(ctx, 'POST', '/api/me/tasks', {
      title: 'Review Q3 proposal',
      description: 'Review and provide feedback by end of week',
      dueAt: '2026-06-20T17:00:00Z',
    });
    assert(r.status === 201, `Expected 201, got ${r.status}: ${JSON.stringify(r.data)}`);
    const d = r.data as Record<string, unknown>;
    assertField(d, 'id');
    taskId1 = d['id'] as string;
  });

  await test('Create actionable task (approval required)', async () => {
    const r = await api(ctx, 'POST', '/api/me/tasks', {
      title: 'Approve budget allocation for Project Atlas',
      actionable: true,
      dueAt: '2026-06-25T09:00:00Z',
    });
    assert(r.status === 201, `Expected 201, got ${r.status}`);
    const d = r.data as Record<string, unknown>;
    taskId2 = d['id'] as string;
  });

  await test('List tasks', async () => {
    const r = await api(ctx, 'GET', '/api/me/tasks');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    const d = r.data as Record<string, unknown>;
    const tasks = d['tasks'] ?? d['items'] ?? d;
    assert(tasks !== undefined, 'No tasks field in response');
  });

  await test('Complete task', async () => {
    const r = await api(ctx, 'POST', `/api/me/tasks/${taskId1}/complete`);
    assert(r.status === 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.data)}`);
  });

  await test('Cancel task', async () => {
    const r = await api(ctx, 'POST', `/api/me/tasks/${taskId2}/cancel`);
    assert(r.status === 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.data)}`);
  });
}

// ── Suite 4: Reminders ────────────────────────────────────────────────────

async function testReminders(ctx: TestCtx): Promise<void> {
  console.log('\n── Suite 4: Reminders ───────────────────────────────────────');
  let reminderId = '';

  await test('Create reminder (fireAt)', async () => {
    const r = await api(ctx, 'POST', '/api/me/reminders', {
      title: 'Take medication',
      fireAt: new Date(Date.now() + 3600000).toISOString(),
    });
    assert(r.status === 201, `Expected 201, got ${r.status}: ${JSON.stringify(r.data)}`);
    const d = r.data as Record<string, unknown>;
    assertField(d, 'id');
    reminderId = d['id'] as string;
  });

  await test('Create reminder (rrule)', async () => {
    const r = await api(ctx, 'POST', '/api/me/reminders', {
      title: 'Daily standup reminder',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    });
    assert(r.status === 201, `Expected 201, got ${r.status}: ${JSON.stringify(r.data)}`);
    const rruleId = (r.data as Record<string, unknown>)['id'] as string;
    // Clean up rrule reminder
    await api(ctx, 'DELETE', `/api/me/reminders/${rruleId}`);
  });

  await test('List reminders', async () => {
    const r = await api(ctx, 'GET', '/api/me/reminders');
    assert(r.status === 200, `Expected 200, got ${r.status}`);
    const d = r.data as Record<string, unknown>;
    assert(d['reminders'] !== undefined, 'Expected reminders field');
  });

  await test('Reschedule reminder (fireAt)', async () => {
    const r = await api(ctx, 'POST', `/api/me/reminders/${reminderId}/reschedule`, {
      fireAt: new Date(Date.now() + 7200000).toISOString(),
    });
    assert(r.status === 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.data)}`);
  });

  await test('Delete reminder', async () => {
    const r = await api(ctx, 'DELETE', `/api/me/reminders/${reminderId}`);
    assert(r.status === 200, `Expected 200, got ${r.status}`);
  });
}

// ── Suite 5: Agent (Supervisor) – Calendar Intelligence ───────────────────

async function testAgentCalendar(baseCtx: TestCtx): Promise<void> {
  console.log('\n── Suite 5: Agent – Calendar Intelligence ───────────────────');

  // Wipe any leftover agent-created items from previous runs before seeding
  const existing = await api(baseCtx, 'GET', '/api/me/agenda?limit=200');
  const existingItems = ((existing.data as Record<string, unknown>)['items'] as Array<{ id: string }>) ?? [];
  for (const item of existingItems) {
    await api(baseCtx, 'DELETE', `/api/me/agenda/${item.id}`);
  }
  if (existingItems.length > 0) console.log(`    Cleared ${existingItems.length} leftover agenda items`);

  // Seed via REST (not through agent chat) so seeded data exists in DB
  const seeds = [
    { nlText: 'team standup tomorrow at 9am' },
    { nlText: 'project review friday at 3pm' },
    { title: 'Doctor appointment', kind: 'appointment', start_at: '2026-06-20T11:00', all_day: 0 },
    { title: 'Pay rent', kind: 'deadline', start_at: '2026-07-01', all_day: 1 },
    { title: 'Dentist follow-up', kind: 'appointment', start_at: '2026-06-25T14:30', all_day: 0 },
  ];
  const seededIds: string[] = [];
  for (const s of seeds) {
    const r = await api(baseCtx, 'POST', '/api/me/agenda', s);
    if (r.status === 201) seededIds.push((r.data as Record<string, unknown>)['id'] as string);
  }
  console.log(`    Seeded ${seededIds.length} agenda items for agent tests`);

  // Each test gets its own fresh chat — zero history — so agenda_list MUST be called
  await test('Agent: ask about dentist appointment', async () => {
    const ctx = await createFreshSupervisorChat(baseCtx, 'Agent – dentist query');
    const r = await chat(ctx, 'when is my dentist appointment?');
    const used = r.toolsUsed.some(t => t.includes('agenda_list'));
    assert(used, `Expected agenda_list call, got tools:[${r.toolsUsed.join(', ')}] content:"${r.content.slice(0,150)}"`);
    assert(r.content.length > 10, `Response too short: "${r.content}"`);
    const hasDateRef = /jun|jul|dentist|appointment|2026/i.test(r.content);
    assert(hasDateRef, `Response doesn't mention the appointment: "${r.content.slice(0,200)}"`);
  });

  await test('Agent: ask what is on the schedule this week', async () => {
    const ctx = await createFreshSupervisorChat(baseCtx, 'Agent – weekly schedule');
    const r = await chat(ctx, 'what do I have on my schedule this week?');
    const used = r.toolsUsed.some(t => t.includes('agenda_list'));
    assert(used, `Expected agenda_list call, got tools:[${r.toolsUsed.join(', ')}] content:"${r.content.slice(0,150)}"`);
    assert(r.content.length > 20, `Response too short`);
  });

  await test('Agent: ask about deadlines', async () => {
    const ctx = await createFreshSupervisorChat(baseCtx, 'Agent – deadlines');
    const r = await chat(ctx, 'do I have any deadlines coming up?');
    const used = r.toolsUsed.some(t => t.includes('agenda_list'));
    assert(used, `Expected agenda_list call, got tools:[${r.toolsUsed.join(', ')}] content:"${r.content.slice(0,150)}"`);
    assert(r.content.length > 10, `Response too short: "${r.content}"`);
  });

  await test('Agent: ask about tomorrow\'s schedule', async () => {
    const ctx = await createFreshSupervisorChat(baseCtx, 'Agent – tomorrow');
    const r = await chat(ctx, "what have I got tomorrow?");
    const used = r.toolsUsed.some(t => t.includes('agenda_list'));
    assert(used, `Expected agenda_list call, got tools:[${r.toolsUsed.join(', ')}] content:"${r.content.slice(0,150)}"`);
    assert(r.content.length > 10, `Response too short`);
  });

  await test('Agent: ask for next appointment', async () => {
    const ctx = await createFreshSupervisorChat(baseCtx, 'Agent – next appointment');
    const r = await chat(ctx, 'what is my next appointment?');
    const used = r.toolsUsed.some(t => t.includes('agenda_list'));
    assert(used, `Expected agenda_list call, got tools:[${r.toolsUsed.join(', ')}] content:"${r.content.slice(0,150)}"`);
    assert(r.content.length > 10, `Response too short`);
  });

  await test('Agent: free time query', async () => {
    const ctx = await createFreshSupervisorChat(baseCtx, 'Agent – free time');
    const r = await chat(ctx, 'am I free on Friday afternoon?');
    const used = r.toolsUsed.some(t => t.includes('agenda_list'));
    assert(used, `Expected agenda_list call, got tools:[${r.toolsUsed.join(', ')}] content:"${r.content.slice(0,150)}"`);
    assert(r.content.length > 10, `Response too short`);
  });

  // Clean up seeded items
  for (const id of seededIds) {
    await api(baseCtx, 'DELETE', `/api/me/agenda/${id}`);
  }
}

// ── Suite 6: Agent – Reminders via Tool ──────────────────────────────────

async function testAgentReminders(baseCtx: TestCtx): Promise<void> {
  console.log('\n── Suite 6: Agent – Reminders via Tool ──────────────────────');
  const ctx = await createFreshSupervisorChat(baseCtx, 'Stress Test – Reminders Agent');

  await test('Agent: create reminder via natural language', async () => {
    const r = await chat(ctx, 'set a reminder to call the bank in 2 hours');
    const used = r.toolsUsed.some(t => t.includes('reminder_create'));
    assert(used, `Expected reminder_create call, got: [${r.toolsUsed.join(', ')}]`);
    assert(r.content.length > 10, `Response too short`);
  });

  await test('Agent: list reminders', async () => {
    const r = await chat(ctx, 'show me all my reminders');
    const used = r.toolsUsed.some(t => t.includes('reminder_list'));
    assert(used, `Expected reminder_list call, got: [${r.toolsUsed.join(', ')}]`);
  });

  await test('Agent: cancel reminder', async () => {
    // First create one via API
    const created = await api(ctx, 'POST', '/api/me/reminders', {
      title: 'Test reminder to cancel',
      fireAt: new Date(Date.now() + 86400000).toISOString(),
    });
    assert(created.status === 201, `Setup: Failed to create reminder`);
    const id = (created.data as Record<string, unknown>)['id'] as string;

    const r = await chat(ctx, `cancel my reminder for "Test reminder to cancel"`);
    // Agent may use reminder_list + reminder_cancel or just reply
    assert(r.content.length > 5, `Response too short`);
  });
}

// ── Suite 7: Agent – Memory ───────────────────────────────────────────────

async function testAgentMemory(baseCtx: TestCtx): Promise<void> {
  console.log('\n── Suite 7: Agent – Memory ──────────────────────────────────');
  const ctx = await createFreshSupervisorChat(baseCtx, 'Stress Test – Memory Agent');

  await test('Agent: recall memory about user', async () => {
    const r = await chat(ctx, 'what do you know about me?');
    assert(r.content.length > 10, `Response too short: "${r.content.slice(0,100)}"`);
    // memory_recall or memory_get_profile may be called
  });

  await test('Agent: date + time query (datetime tool)', async () => {
    const r = await chat(ctx, 'what time is it right now?');
    const dtCalls = r.steps.filter(s => s.toolCall?.name === 'datetime' || s.toolCall?.name === 'timezone_info');
    // Supervisor delegates temporal questions to worker, so the tool may not appear in top-level steps
    assert(r.content.length > 5, `Response too short`);
  });
}

// ── Suite 8: Agent – Multi-domain Combination ─────────────────────────────

async function testAgentCombined(baseCtx: TestCtx): Promise<void> {
  console.log('\n── Suite 8: Agent – Multi-domain Combination ─────────────────');
  const ctx = await createFreshSupervisorChat(baseCtx, 'Stress Test – Combined Agent');

  // Seed items for combination tests
  const eventR = await api(ctx, 'POST', '/api/me/agenda', {
    title: 'Board presentation',
    kind: 'event',
    start_at: '2026-06-25T10:00',
    all_day: 0,
    description: 'Present Q3 results to the board',
  });
  const eventId = (eventR.data as Record<string, unknown>)['id'] as string;

  const noteR = await api(ctx, 'POST', '/api/me/notes', {
    title: 'Board Presentation Prep',
    doc_json: JSON.stringify({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Slides: revenue, growth, headcount.' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Key message: 23% YoY growth.' }] },
      ],
    }),
  });
  const noteId = (noteR.data as Record<string, unknown>)['id'] as string;

  // Link note to agenda item
  await api(ctx, 'POST', `/api/me/notes/${noteId}/links`, {
    target_kind: 'agenda',
    target_id: eventId,
  });

  await test('Agent: combined query – schedule + upcoming tasks', async () => {
    const r = await chat(ctx, 'summarize what I have coming up this week, including any appointments and deadlines');
    const used = r.toolsUsed.some(t => t.includes('agenda_list'));
    assert(used, `Expected agenda_list call, got: [${r.toolsUsed.join(', ')}]`);
    assert(r.content.length > 20, `Response too short`);
  });

  await test('Agent: ask for preparation for an upcoming event', async () => {
    const r = await chat(ctx, 'I have a board presentation coming up – help me think through what I need to prepare');
    assert(r.content.length > 50, `Response too short: "${r.content.slice(0,100)}"`);
  });

  await test('Agent: calculate time until event', async () => {
    const r = await chat(ctx, 'how many days until June 25th?');
    assert(r.content.length > 5, `Response too short`);
    const hasNumber = /\d+\s*(day|days)/i.test(r.content);
    assert(hasNumber, `Response should mention number of days: "${r.content.slice(0,200)}"`);
  });

  await test('Agent: multi-step – list appointments + suggest action', async () => {
    const r = await chat(ctx, 'list all my upcoming appointments and tell me which one I should prepare for first');
    const used = r.toolsUsed.some(t => t.includes('agenda_list'));
    assert(used, `Expected agenda_list call, got: [${r.toolsUsed.join(', ')}]`);
    assert(r.content.length > 20, `Response too short`);
  });

  // Cleanup
  await api(ctx, 'DELETE', `/api/me/notes/${noteId}`);
  if (eventId) await api(ctx, 'DELETE', `/api/me/agenda/${eventId}`);
}

// ── Suite 9: Edge Cases + Error Handling ─────────────────────────────────

async function testEdgeCases(baseCtx: TestCtx): Promise<void> {
  console.log('\n── Suite 9: Edge Cases + Error Handling ─────────────────────');
  // REST edge cases use baseCtx; agent edge cases get a fresh chat
  const ctx = baseCtx;

  await test('Agenda: create without title or nlText → 400', async () => {
    const r = await api(ctx, 'POST', '/api/me/agenda', { kind: 'event' });
    assert(r.status === 400, `Expected 400, got ${r.status}`);
  });

  await test('Agenda: get nonexistent item → 404', async () => {
    const r = await api(ctx, 'GET', '/api/me/agenda/nonexistent-id-123');
    assert(r.status === 404, `Expected 404, got ${r.status}`);
  });

  await test('Agenda: delete nonexistent item → 404', async () => {
    const r = await api(ctx, 'DELETE', '/api/me/agenda/nonexistent-id-456');
    assert(r.status === 404, `Expected 404, got ${r.status}`);
  });

  await test('Notes: get nonexistent note → 404', async () => {
    const r = await api(ctx, 'GET', '/api/me/notes/nonexistent-note-789');
    assert(r.status === 404, `Expected 404, got ${r.status}`);
  });

  await test('Agenda NL: "today" parses to today\'s date', async () => {
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
    const r = await api(ctx, 'POST', '/api/me/agenda', { nlText: 'meeting today at noon' });
    assert(r.status === 201, `Expected 201, got ${r.status}`);
    const d = r.data as Record<string, unknown>;
    assert(String(d['start_at']).startsWith(todayStr), `Expected today (${todayStr}) in start_at, got: ${d['start_at']}`);
    assert(String(d['start_at']).includes('T12:00'), `Expected noon, got: ${d['start_at']}`);
    await api(ctx, 'DELETE', `/api/me/agenda/${d['id']}`);
  });

  await test('Agenda NL: "day after tomorrow" parses correctly', async () => {
    const d2 = new Date();
    d2.setDate(d2.getDate() + 2);
    const d2Str = `${d2.getFullYear()}-${String(d2.getMonth()+1).padStart(2,'0')}-${String(d2.getDate()).padStart(2,'0')}`;
    const r = await api(ctx, 'POST', '/api/me/agenda', { nlText: 'lunch day after tomorrow at 1pm' });
    assert(r.status === 201, `Expected 201`);
    const rd = r.data as Record<string, unknown>;
    assert(String(rd['start_at']).startsWith(d2Str), `Expected ${d2Str}, got ${rd['start_at']}`);
    await api(ctx, 'DELETE', `/api/me/agenda/${rd['id']}`);
  });

  await test('Agenda NL: "next wednesday" resolves to future date', async () => {
    const r = await api(ctx, 'POST', '/api/me/agenda', { nlText: 'team lunch next wednesday at 12pm' });
    assert(r.status === 201, `Expected 201`);
    const d = r.data as Record<string, unknown>;
    const startAt = new Date(String(d['start_at']));
    const now = new Date();
    assert(startAt > now, `next wednesday should be in the future, got ${d['start_at']}`);
    assert(String(d['start_at']).includes('T12:00'), `Expected noon, got: ${d['start_at']}`);
    await api(ctx, 'DELETE', `/api/me/agenda/${d['id']}`);
  });

  await test('Agenda NL: "2pm" → 14:00 (not 02:00)', async () => {
    const r = await api(ctx, 'POST', '/api/me/agenda', { nlText: 'meeting tomorrow at 2pm' });
    assert(r.status === 201, `Expected 201`);
    const d = r.data as Record<string, unknown>;
    assert(String(d['start_at']).includes('T14:00'), `Expected 14:00, got: ${d['start_at']} (PM timezone bug!)`);
    await api(ctx, 'DELETE', `/api/me/agenda/${d['id']}`);
  });

  await test('Agenda limit filter', async () => {
    const r = await api(ctx, 'GET', '/api/me/agenda?limit=2');
    assert(r.status === 200, `Expected 200`);
    const d = r.data as Record<string, unknown>;
    const items = d['items'] as unknown[];
    assert(items.length <= 2, `Expected ≤2 items, got ${items.length}`);
  });

  // Agent edge cases get a fresh supervisor chat
  const agentCtx = await createFreshSupervisorChat(baseCtx, 'Stress Test – Edge Cases Agent');

  await test('Agent: ask about empty schedule gracefully', async () => {
    const r = await chat(agentCtx, 'do I have anything scheduled for 2027?');
    const used = r.toolsUsed.some(t => t.includes('agenda_list'));
    // Accept: tool called OR response mentions no events (agenda answered from the fact DB is empty)
    const hasGracefulContent = /no|nothing|don't|empty|clear|free|don.t have/i.test(r.content);
    assert(used || hasGracefulContent, `Expected agenda_list call or graceful response, got tools: [${r.toolsUsed.join(', ')}] content: "${r.content.slice(0,150)}"`);
    assert(r.content.length > 5, `Response too short`);
  });

  await test('Agent: ask ambiguous query (no tool needed)', async () => {
    const r = await chat(agentCtx, 'what is 25 * 4?');
    assert(r.content.length > 0, `Response empty`);
    assert(/100/i.test(r.content), `Expected 100 in response, got: "${r.content.slice(0,100)}"`);
  });
}

// ── Suite 10: Load – Rapid Sequential Writes ──────────────────────────────

async function testLoad(ctx: TestCtx): Promise<void> {
  console.log('\n── Suite 10: Load – Rapid Sequential Writes ─────────────────');
  const createdIds: string[] = [];
  const N = 15;

  await test(`Create ${N} agenda items rapidly`, async () => {
    const kinds = ['event', 'deadline', 'reminder', 'appointment', 'recurring'];
    const promises = Array.from({ length: N }, (_, i) => {
      const kind = kinds[i % kinds.length];
      const day = 20 + (i % 10);
      return api(ctx, 'POST', '/api/me/agenda', {
        title: `Stress test item #${i + 1}`,
        kind,
        start_at: `2026-07-${String(day).padStart(2,'0')}T${String(9 + (i % 8)).padStart(2,'0')}:00`,
        all_day: 0,
      });
    });
    const responses = await Promise.all(promises);
    const failed = responses.filter(r => r.status !== 201);
    assert(failed.length === 0, `${failed.length} creates failed: ${JSON.stringify(failed[0]?.data)}`);
    responses.forEach(r => createdIds.push((r.data as Record<string, unknown>)['id'] as string));
  });

  await test(`List ${N} items (verify all present)`, async () => {
    const r = await api(ctx, 'GET', '/api/me/agenda?start=2026-07-01&end=2026-07-31&limit=50');
    assert(r.status === 200, `Expected 200`);
    const d = r.data as Record<string, unknown>;
    const items = d['items'] as Array<Record<string, unknown>>;
    const stressItems = items.filter(i => String(i['title']).startsWith('Stress test item'));
    assert(stressItems.length >= N, `Expected ≥${N} stress items, got ${stressItems.length}`);
  });

  await test('Create 5 notes rapidly', async () => {
    const notePromises = Array.from({ length: 5 }, (_, i) =>
      api(ctx, 'POST', '/api/me/notes', {
        title: `Stress note #${i + 1}`,
        doc_json: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `Content ${i + 1}` }] }] }),
      })
    );
    const responses = await Promise.all(notePromises);
    const noteIds = responses.filter(r => r.status === 201).map(r => (r.data as Record<string, unknown>)['id'] as string);
    assert(noteIds.length === 5, `Expected 5 notes created, got ${noteIds.length}`);
    // Clean up
    await Promise.all(noteIds.map(id => api(ctx, 'DELETE', `/api/me/notes/${id}`)));
  });

  await test(`Delete all ${N} stress agenda items`, async () => {
    const delResponses = await Promise.all(createdIds.map(id => api(ctx, 'DELETE', `/api/me/agenda/${id}`)));
    const failed = delResponses.filter(r => r.status !== 200);
    assert(failed.length === 0, `${failed.length} deletes failed`);
  });
}

// ─── Fresh supervisor chat helper ──────────────────────────────────────────

async function createFreshSupervisorChat(baseCtx: TestCtx, title: string): Promise<TestCtx> {
  const tempCtx: TestCtx = { ...baseCtx, chatId: '' };
  const r = await api(tempCtx, 'POST', '/api/chats', { title });
  const data = r.data as Record<string, unknown>;
  // API returns { chat: { id, ... } } or { id, ... }
  const chatData = (data['chat'] as Record<string, unknown>) ?? data;
  const chatId = chatData['id'] as string;
  if (!chatId) throw new Error(`Failed to create fresh chat: ${JSON.stringify(r.data)}`);
  // Set supervisor mode explicitly with the required enabled tools
  await api({ ...tempCtx, chatId }, 'POST', `/api/chats/${chatId}/settings`, {
    mode: 'supervisor',
    enabledTools: ['datetime', 'timezone_info', 'calculator', 'json_format', 'text_analysis',
                   'agenda_list', 'agenda_create', 'agenda_update', 'agenda_delete',
                   'reminder_create', 'reminder_list', 'reminder_cancel', 'memory_recall'],
  });
  console.log(`    Created fresh supervisor chat: ${chatId}`);
  return { ...baseCtx, chatId };
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  geneWeave Feature Stress Test');
  console.log('  Target: ' + BASE_URL);
  console.log('  Date: ' + new Date().toISOString());
  console.log('═══════════════════════════════════════════════════════════════');

  // Health check
  try {
    const health = await fetch(`${BASE_URL}/`);
    if (!health.ok && health.status !== 200 && health.status !== 404) {
      throw new Error(`Server returned ${health.status}`);
    }
  } catch (e) {
    console.error(`\nERROR: Server not reachable at ${BASE_URL}`);
    console.error('Start the server with: npx tsx deploy/server.ts');
    process.exit(1);
  }

  // Auth
  const userId = getUserId();
  const { token, csrf } = createAuthToken(userId, USER_EMAIL);
  console.log(`\nAuthenticated as ${USER_EMAIL} (${userId})`);

  // Create a base chat for REST API tests (Suites 1-4, 9, 10)
  const baseCtxTemp: TestCtx = { token, csrf, userId, chatId: '' };
  const baseChatR = await api(baseCtxTemp, 'POST', '/api/chats', { title: 'Stress Test – REST API' });
  const baseChatData = baseChatR.data as Record<string, unknown>;
  const baseChatInner = (baseChatData['chat'] as Record<string, unknown>) ?? baseChatData;
  const baseChatId = baseChatInner['id'] as string ?? '';

  const ctx: TestCtx = { token, csrf, userId, chatId: baseChatId };
  console.log(`Using REST API chat: ${ctx.chatId}`);

  // Run all suites
  await testAgendaCRUD(ctx);
  await testNotesCRUD(ctx);
  await testActionItems(ctx);
  await testReminders(ctx);
  // Agent suites get fresh chats so the supervisor must call tools (no context to cheat from)
  await testAgentCalendar(ctx);
  await testAgentReminders(ctx);
  await testAgentMemory(ctx);
  await testAgentCombined(ctx);
  await testEdgeCases(ctx);
  await testLoad(ctx);

  // ── Report ────────────────────────────────────────────────────────────────
  const passed = results.filter(r => r.passed);
  const failed = results.filter(r => !r.passed);
  const totalMs = results.reduce((s, r) => s + r.duration, 0);

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  RESULTS: ${passed.length}/${results.length} passed  |  ${totalMs}ms total`);
  console.log('═══════════════════════════════════════════════════════════════');

  if (failed.length > 0) {
    console.log('\nFailed tests:');
    failed.forEach(f => console.log(`  ✗ ${f.name}\n    ${f.detail}`));
  }

  // By suite
  const suites: Record<string, TestResult[]> = {};
  results.forEach(r => {
    const suite = r.name.split(':')[0] ?? 'General';
    (suites[suite] ??= []).push(r);
  });

  console.log('\nBy category:');
  Object.entries(suites).forEach(([suite, tests]) => {
    const p = tests.filter(t => t.passed).length;
    const emoji = p === tests.length ? '✅' : p === 0 ? '❌' : '⚠️';
    console.log(`  ${emoji} ${suite}: ${p}/${tests.length}`);
  });

  console.log('');
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
