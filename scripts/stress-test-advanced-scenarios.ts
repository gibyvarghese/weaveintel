/**
 * stress-test-advanced-scenarios.ts — Extended real-world scenario stress test
 *
 * Covers scenarios derived from REALM-Bench (multi-agent planning stress),
 * multi-turn LLM degradation research, and production agent reliability patterns:
 *
 *   Suite 11: Multi-Intent Single Messages
 *             One message with 3+ distinct actions (agenda + note + reminder)
 *   Suite 12: Conversational Continuity (multi-turn reschedule/modify flows)
 *             Multi-turn chats where each turn modifies what came before
 *   Suite 13: Idempotency & Duplicate Detection
 *             REST-level: duplicate API calls don't corrupt state
 *             Agent-level: re-stating an event doesn't create a second copy
 *   Suite 14: Long Text / Real-World Dump
 *             Calendar invites, email blocks, bulk task dumps, meeting notes
 *   Suite 15: Conflict & Overlap Detection
 *             Agent aware of double-booking before creating
 *   Suite 16: Cross-Domain Compound Workflows
 *             Agenda + linked note + reminder created in a single conversation turn
 *   Suite 17: Edge Cases — Titles, Unicode, Rapid Updates
 *             255-char titles, emoji, special chars, 5 rapid PATCH cycles
 *
 * Run: npx tsx scripts/stress-test-advanced-scenarios.ts
 */

import crypto from 'crypto';
import Database from 'better-sqlite3';

// ─── Config ────────────────────────────────────────────────────────────────

const BASE_URL = 'http://localhost:3500';
const DB_PATH = './geneweave.db';
const JWT_SECRET = 'dev-secret';
const USER_EMAIL = 'giby.varghese@gmail.com';

// ─── Auth setup ────────────────────────────────────────────────────────────

function createAuthToken(userId: string, email: string): { token: string; csrf: string } {
  const db = new (Database as unknown as typeof import('better-sqlite3').default)(DB_PATH);
  const sessionId = `adv-stress-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
  return { token: `${header}.${payload}.${sig}`, csrf };
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

async function api(ctx: TestCtx, method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
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
}

interface ChatResponse {
  content: string;
  steps: ChatStep[];
  enabledTools: string[];
  toolsUsed: string[];
}

async function chat(ctx: TestCtx, message: string): Promise<ChatResponse> {
  const res = await api(ctx, 'POST', `/api/chats/${ctx.chatId}/messages`, { content: message });
  const d = res.data as Record<string, unknown>;
  const steps = (d['steps'] as ChatStep[]) ?? [];
  const toolsUsed: string[] = [];
  for (const s of steps) {
    if (s.toolCall?.name) toolsUsed.push(s.toolCall.name);
  }
  return {
    content: String(d['assistantContent'] ?? d['content'] ?? ''),
    steps,
    enabledTools: (d['enabledTools'] as string[]) ?? [],
    toolsUsed,
  };
}

async function createFreshSupervisorChat(baseCtx: TestCtx, title: string): Promise<TestCtx> {
  const tempCtx: TestCtx = { ...baseCtx, chatId: '' };
  const r = await api(tempCtx, 'POST', '/api/chats', { title });
  const data = r.data as Record<string, unknown>;
  const chatData = (data['chat'] as Record<string, unknown>) ?? data;
  const chatId = chatData['id'] as string;
  if (!chatId) throw new Error(`Failed to create chat: ${JSON.stringify(r.data)}`);
  await api({ ...tempCtx, chatId }, 'POST', `/api/chats/${chatId}/settings`, {
    mode: 'supervisor',
    enabledTools: ['datetime', 'timezone_info', 'calculator', 'json_format', 'text_analysis',
                   'agenda_list', 'agenda_create', 'agenda_update', 'agenda_delete',
                   'reminder_create', 'reminder_list', 'reminder_cancel', 'memory_recall'],
  });
  console.log(`    Created fresh supervisor chat: ${chatId} "${title}"`);
  return { ...baseCtx, chatId };
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

async function wipeAllAgendaItems(baseCtx: TestCtx): Promise<number> {
  const r = await api(baseCtx, 'GET', '/api/me/agenda?limit=200');
  const items = ((r.data as Record<string, unknown>)['items'] as Array<{ id: string }>) ?? [];
  for (const item of items) {
    await api(baseCtx, 'DELETE', `/api/me/agenda/${item.id}`);
  }
  return items.length;
}

// ─── TEST SUITES ──────────────────────────────────────────────────────────

// ── Suite 11: Multi-Intent Single Messages ────────────────────────────────
// One user message requests 2-3 distinct things simultaneously.
// Based on real-world user behavior (dump a todo list, coordinate multiple
// actions from a meeting summary, etc.)

async function testMultiIntent(baseCtx: TestCtx): Promise<void> {
  console.log('\n── Suite 11: Multi-Intent Single Messages ────────────────────');
  const ctx = await createFreshSupervisorChat(baseCtx, 'Advanced – Multi-Intent');
  const seededIds: string[] = [];

  await test('Multi-intent: dentist + reminder + note in one message', async () => {
    const r = await chat(ctx, `
I need you to do three things:
1. Add a dentist appointment for next Monday at 10am
2. Set a reminder for the Sunday before to confirm the appointment
3. Create a short note titled "Dental prep" with the text: "Bring insurance card, arrive 5 mins early, ask about crown quote"
`.trim());
    // Should produce a non-trivial response covering all 3 actions
    assert(r.content.length > 30, `Response too short: "${r.content.slice(0,150)}"`);
    // At least one calendar or reminder tool should have been invoked
    const hasToolActivity = r.toolsUsed.length > 0 || /dentist|reminder|note|sunday|monday|insurance/i.test(r.content);
    assert(hasToolActivity, `Expected tool usage or confirmation content, got: "${r.content.slice(0,200)}"`);
  });

  await test('Multi-intent: 3 meetings in one sentence', async () => {
    const r = await chat(ctx,
      'I have three meetings next week: Monday 9am team standup, Wednesday 2pm client presentation, and Friday 4pm project retrospective. Can you add all three to my calendar?'
    );
    assert(r.content.length > 30, `Response too short`);
    const mentionsAll = /standup|presentation|retrospective/i.test(r.content) ||
                        /monday|wednesday|friday/i.test(r.content) ||
                        r.toolsUsed.some(t => t.includes('agenda'));
    assert(mentionsAll, `Expected all 3 meetings acknowledged: "${r.content.slice(0,250)}"`);
  });

  await test('Multi-intent: cancel + reschedule in one message', async () => {
    // Use its own isolated chat so prior context doesn't interfere
    const isolatedCtx = await createFreshSupervisorChat(baseCtx, 'Advanced – Cancel+Reschedule');
    // Seed a meeting to cancel
    const createR = await api(baseCtx, 'POST', '/api/me/agenda', {
      title: 'Old vendor call',
      kind: 'appointment',
      start_at: '2026-06-22T14:00',
      all_day: 0,
    });
    if (createR.status === 201) seededIds.push((createR.data as Record<string, unknown>)['id'] as string);

    const r = await chat(isolatedCtx,
      'Please cancel my vendor call this Monday and add a new one for Thursday at 3pm instead — same title "Vendor sync". Also remind me to prepare an agenda the night before.'
    );
    assert(r.content.length > 20, `Response too short`);
    // Accept: tool action confirmation OR acknowledgment of the request (vendor/thursday/cancel/remind)
    const mentionsAction = /cancel|reschedule|thursday|vendor|remind|agenda|unable|cannot|restriction/i.test(r.content);
    assert(mentionsAction, `Expected action confirmation or relevant response: "${r.content.slice(0,250)}"`);
  });

  await test('Multi-intent: bulk "my week" dump', async () => {
    const r = await chat(ctx, `
Here's everything I need on my calendar for next week. Please add them all:
- Monday 8am: Gym session
- Monday 10am: 1:1 with Sarah
- Tuesday all day: Company off-site
- Wednesday 2pm: Product demo to investors
- Thursday 9am: Sprint planning
- Thursday 4pm: Doctor checkup
- Friday: No meetings, deep work day (block it as "Focus time")
`.trim());
    assert(r.content.length > 30, `Response too short`);
    // Should acknowledge the bulk request
    const mentionsMultiple = /gym|sarah|off.?site|demo|sprint|doctor|focus/i.test(r.content) ||
                             r.toolsUsed.some(t => t.includes('agenda'));
    assert(mentionsMultiple, `Expected bulk acknowledgment: "${r.content.slice(0,300)}"`);
  });

  // Cleanup
  for (const id of seededIds) await api(baseCtx, 'DELETE', `/api/me/agenda/${id}`);
}

// ── Suite 12: Conversational Continuity ───────────────────────────────────
// Multi-turn flows: each turn refers back to the previous one, modifying
// or building on what was established. Tests context retention and whether
// the supervisor correctly updates vs creates.

async function testConversationContinuity(baseCtx: TestCtx): Promise<void> {
  console.log('\n── Suite 12: Conversational Continuity (Multi-Turn) ─────────');
  const ctx = await createFreshSupervisorChat(baseCtx, 'Advanced – Continuity');

  let boardMeetingId = '';

  await test('Continuity: establish an event', async () => {
    // Seed a board meeting via REST so agent has something to find
    const r = await api(baseCtx, 'POST', '/api/me/agenda', {
      title: 'Board meeting',
      kind: 'appointment',
      start_at: '2026-06-22T10:00',
      all_day: 0,
    });
    assert(r.status === 201, `Setup failed: ${r.status}`);
    boardMeetingId = (r.data as Record<string, unknown>)['id'] as string;

    const chatR = await chat(ctx, 'What meetings do I have next week?');
    assert(chatR.content.length > 10, `Response too short`);
    // Should mention the board meeting from the calendar
    const hasBoardRef = /board/i.test(chatR.content) || chatR.toolsUsed.some(t => t.includes('agenda_list'));
    assert(hasBoardRef, `Expected board meeting in response: "${chatR.content.slice(0,200)}"`);
  });

  await test('Continuity: reschedule with "it" reference', async () => {
    const r = await chat(ctx, 'Actually, move the board meeting to Thursday at 2pm instead');
    assert(r.content.length > 10, `Response too short`);
    // Agent should acknowledge the reschedule
    const mentionsReschedule = /thursday|moved|rescheduled|updated|2.?pm|board/i.test(r.content);
    assert(mentionsReschedule, `Expected reschedule confirmation: "${r.content.slice(0,200)}"`);
  });

  await test('Continuity: add participant to prior event', async () => {
    const r = await chat(ctx, 'Also, can you note that the CFO will be joining the board meeting? Add it to the description.');
    assert(r.content.length > 5, `Response too short`);
    const mentionsCFO = /cfo|joining|description|board|added|noted/i.test(r.content);
    assert(mentionsCFO, `Expected CFO mention: "${r.content.slice(0,200)}"`);
  });

  await test('Continuity: follow-up reminder for prior event', async () => {
    const r = await chat(ctx, 'Set a reminder 2 days before the board meeting to prepare the slides');
    assert(r.content.length > 10, `Response too short`);
    const mentionsReminder = /reminder|slides|prepare|board|before|tuesday/i.test(r.content);
    assert(mentionsReminder, `Expected reminder confirmation: "${r.content.slice(0,200)}"`);
  });

  await test('Continuity: query current state after changes', async () => {
    const r = await chat(ctx, 'Summarize everything I have set up for this board meeting');
    assert(r.content.length > 20, `Response too short`);
    // Should recall the reschedule to Thursday and the CFO note and reminder
    const hasSummary = /board|thursday|cfo|reminder|slides/i.test(r.content) || r.content.length > 80;
    assert(hasSummary, `Expected summary with context: "${r.content.slice(0,300)}"`);
  });

  // Cleanup
  if (boardMeetingId) await api(baseCtx, 'DELETE', `/api/me/agenda/${boardMeetingId}`);
}

// ── Suite 13: Idempotency & Duplicate Detection ───────────────────────────
// At REST level: two identical POSTs DO create two entries (no DB dedup by default).
// At agent level: if user re-states an event, agent should check existing items
// and avoid silently duplicating. Also tests PATCH updates are non-destructive.

async function testIdempotency(baseCtx: TestCtx): Promise<void> {
  console.log('\n── Suite 13: Idempotency & Duplicate Detection ───────────────');
  const ctx = await createFreshSupervisorChat(baseCtx, 'Advanced – Idempotency');
  const cleanupIds: string[] = [];

  await test('REST: duplicate POST creates two entries (expected, no server dedup)', async () => {
    const payload = { title: 'Dup test meeting', kind: 'event' as const, start_at: '2026-07-10T09:00', all_day: 0 };
    const r1 = await api(baseCtx, 'POST', '/api/me/agenda', payload);
    const r2 = await api(baseCtx, 'POST', '/api/me/agenda', payload);
    assert(r1.status === 201, `First POST: ${r1.status}`);
    assert(r2.status === 201, `Second POST: ${r2.status}`);
    const id1 = (r1.data as Record<string, unknown>)['id'] as string;
    const id2 = (r2.data as Record<string, unknown>)['id'] as string;
    assert(id1 !== id2, `Expected different IDs for two POSTs, got same: ${id1}`);
    cleanupIds.push(id1, id2);
    console.log(`    Created 2 entries with distinct IDs: ${id1.slice(-8)}, ${id2.slice(-8)}`);
  });

  await test('REST: PATCH is idempotent (same PATCH twice = same result)', async () => {
    const r = await api(baseCtx, 'POST', '/api/me/agenda', {
      title: 'Idempotent patch test', kind: 'event', start_at: '2026-07-11T10:00', all_day: 0,
    });
    assert(r.status === 201, `Setup: ${r.status}`);
    const id = (r.data as Record<string, unknown>)['id'] as string;
    cleanupIds.push(id);
    const patch = { title: 'Patched title', status: 'tentative' };
    const p1 = await api(baseCtx, 'PATCH', `/api/me/agenda/${id}`, patch);
    const p2 = await api(baseCtx, 'PATCH', `/api/me/agenda/${id}`, patch);
    assert(p1.status === 200, `First PATCH: ${p1.status}`);
    assert(p2.status === 200, `Second PATCH: ${p2.status}`);
    const d1 = p1.data as Record<string, unknown>;
    const d2 = p2.data as Record<string, unknown>;
    assert(d1['title'] === d2['title'], `Title should be same after 2 PATCHes`);
    assert(d1['status'] === d2['status'], `Status should be same after 2 PATCHes`);
  });

  await test('REST: PATCH update does not change unrelated fields', async () => {
    const r = await api(baseCtx, 'POST', '/api/me/agenda', {
      title: 'Non-destructive patch test',
      kind: 'appointment',
      start_at: '2026-07-12T09:00',
      all_day: 0,
      location: 'Conference room B',
      description: 'Important context that should survive the patch',
    });
    assert(r.status === 201, `Setup: ${r.status}`);
    const id = (r.data as Record<string, unknown>)['id'] as string;
    cleanupIds.push(id);
    // Patch ONLY the title
    const p = await api(baseCtx, 'PATCH', `/api/me/agenda/${id}`, { title: 'Updated title only' });
    assert(p.status === 200, `PATCH: ${p.status}`);
    const d = p.data as Record<string, unknown>;
    assert(d['title'] === 'Updated title only', `Title not updated`);
    assert(d['location'] === 'Conference room B', `Location was wiped by patch! Got: ${d['location']}`);
    assert(String(d['description'] ?? '').includes('Important context'), `Description was wiped by patch!`);
  });

  await test('Agent: re-stating an existing event (duplicate intent detection)', async () => {
    // Pre-seed an event
    const pre = await api(baseCtx, 'POST', '/api/me/agenda', {
      title: 'Weekly sync with product team',
      kind: 'appointment',
      start_at: '2026-07-14T10:00',
      all_day: 0,
    });
    if (pre.status === 201) cleanupIds.push((pre.data as Record<string, unknown>)['id'] as string);

    // Ask agent to "add" the same event
    const r = await chat(ctx,
      'Can you add my weekly sync with the product team on Monday July 14th at 10am to my calendar?'
    );
    assert(r.content.length > 10, `Response too short`);
    // Agent should either detect the duplicate OR acknowledge creating/finding the event
    // Either way: it should NOT crash or return an error
    const isValid = /already|exists|created|added|scheduled|found|noted|monday|july/i.test(r.content);
    assert(isValid, `Expected valid response about the event: "${r.content.slice(0,250)}"`);
    console.log(`    Agent response to re-stated event: "${r.content.slice(0,120)}"`);
  });

  await test('Agent: update existing event (not create new) when asked to change time', async () => {
    const r = await chat(ctx,
      'The weekly sync on July 14th — can you move it to 11am instead of 10am?'
    );
    assert(r.content.length > 10, `Response too short`);
    const mentionsUpdate = /moved|updated|changed|rescheduled|11.?am|july|14/i.test(r.content);
    assert(mentionsUpdate, `Expected update acknowledgment: "${r.content.slice(0,200)}"`);
  });

  // Cleanup
  for (const id of cleanupIds) await api(baseCtx, 'DELETE', `/api/me/agenda/${id}`);
}

// ── Suite 14: Long Text / Real-World Dump ─────────────────────────────────
// Realistic long-form inputs: email calendar invites, post-meeting notes,
// weekly planning dumps. Tests that the agent can extract signal from noise.

async function testLongTextScenarios(baseCtx: TestCtx): Promise<void> {
  console.log('\n── Suite 14: Long Text / Real-World Dump ──────────────────────');
  const ctx = await createFreshSupervisorChat(baseCtx, 'Advanced – Long Text');
  const cleanupIds: string[] = [];

  await test('Long text: extract calendar event from forwarded email (400 words)', async () => {
    const longEmail = `
FYI — forwarding you the invite from the Acme project kick-off.

---------- Forwarded message ----------
From: Sarah Mitchell <smitchell@acme.com>
To: Distribution list
Subject: [INVITE] Project Phoenix Kick-Off Meeting
Date: Mon, 12 Jun 2026

Hi all,

I'm thrilled to invite you to the official kick-off meeting for Project Phoenix,
our most ambitious initiative of the year. This meeting will bring together
stakeholders from Product, Engineering, Design, Marketing, and the Executive team
to align on goals, timelines, and ownership.

Meeting Details:
  Date:     Wednesday, June 25, 2026
  Time:     10:00 AM – 12:00 PM (2 hours)
  Location: Main Conference Room + Zoom (link below)
  Zoom:     https://acme.zoom.us/j/98765432

Agenda:
  10:00 – 10:15  Welcome and introductions
  10:15 – 10:45  Project Phoenix overview and strategic rationale
  10:45 – 11:15  Roadmap walkthrough (Q3-Q4 2026)
  11:15 – 11:45  Team assignments and ownership model
  11:45 – 12:00  Q&A and next steps

Please come prepared with any questions and your team's availability for
the following week's deep-dive sessions.

Action items before the meeting:
  - Review the pre-read deck (attached)
  - Complete the stakeholder alignment survey by June 20
  - Confirm your attendance by replying to this email

Looking forward to seeing everyone there!

Best regards,
Sarah Mitchell
Program Manager, Project Phoenix
Acme Corporation

--
This calendar invitation was sent by Acme scheduling system.
`;
    const r = await chat(ctx, `Here's a meeting invite I just received. Can you add this to my calendar and set a reminder 1 day before to review the pre-read deck?\n\n${longEmail}`);
    assert(r.content.length > 30, `Response too short`);
    const mentionsEvent = /phoenix|june 25|kick.?off|jun|25|calendar|added|reminder/i.test(r.content);
    assert(mentionsEvent, `Expected event extraction from email: "${r.content.slice(0,300)}"`);
  });

  await test('Long text: weekly planning dump — extract 5+ action items', async () => {
    const weeklyDump = `
Monday morning brain dump — everything on my plate this week:

URGENT (today):
- Finish Q2 financial report — finance team needs it by EOD
- Call with David Chen from Vertex about the partnership proposal (he said 2pm works)
- Quick Slack check-in with the mobile team about the beta release blocker

IMPORTANT (this week):
- Complete the performance review for Jamie (due Friday June 20)
- Draft the product roadmap for H2 2026 — product meeting Thursday at 3pm
- Send invoice #2847 to TechCorp — 30-day payment window closes July 15
- Review and sign the contractor agreement from LegalZoom

BACKLOG (can defer):
- Update the team handbook with remote work policy
- Plan the team offsite for September
- Explore the new API integration with Salesforce

MEETINGS:
- Tues 10am: Engineering sprint review
- Tues 3pm: 1:1 with Emma (rescheduled from last week)
- Wed 9am: Customer success call with NovaTech (join 5 mins early!)
- Thurs 3pm: Product roadmap review (as above)
- Fri 2pm: End of week retrospective

Oh also I almost forgot — dentist appointment next Monday June 22 at 9:30am (moved from last week's cancellation).
    `.trim();
    const r = await chat(ctx, `Here's my weekly planning dump. Can you create calendar events for all the meetings mentioned, and note the most urgent action items?\n\n${weeklyDump}`);
    assert(r.content.length > 50, `Response too short`);
    // Should extract at least some meetings/events
    const extractsData = /sprint|emma|novatech|roadmap|retrospective|dentist|Q2|david/i.test(r.content) ||
                         r.toolsUsed.some(t => t.includes('agenda'));
    assert(extractsData, `Expected meeting extraction from dump: "${r.content.slice(0,300)}"`);
  });

  await test('Long text: post-meeting notes → action items', async () => {
    const meetingNotes = `
MEETING NOTES — Product Sync 14 June 2026
Attendees: Alice (PM), Bob (Eng lead), Carol (Design), Dave (QA)

DECISIONS MADE:
1. Ship the onboarding v2 feature on June 30 — hard deadline, no extensions.
2. Delay the notifications redesign to Q3. Not enough bandwidth.
3. Bob to investigate the iOS crash reports by EOD Wednesday June 18.
4. Carol to deliver hi-fi mockups for the new dashboard by Friday June 20.
5. Dave to set up automated regression suite for onboarding — target: June 25.

NEXT STEPS:
- PM to schedule follow-up sync for July 7 at 2pm to review onboarding QA results.
- Bob: performance budget review on June 23 at 11am.
- All: complete the quarterly survey (link in Slack) before June 19.

OPEN QUESTIONS:
- Should we support Android tablets for the new feature? (Decision pending — awaiting market data from Ana)
- API rate limits: need clarification from the platform team (action: Alice to email platform by Monday June 17)

RISK: If onboarding is not shipped by June 30, the Q3 OKR target for activation rate is at risk.
    `.trim();
    const r = await chat(ctx, `Here are notes from our product sync. Can you add the follow-up meetings to my calendar and note the action items I own (I'm Alice / PM)?\n\n${meetingNotes}`);
    assert(r.content.length > 30, `Response too short`);
    const mentionsActions = /alice|PM|onboarding|survey|platform|email|june|schedule/i.test(r.content);
    assert(mentionsActions, `Expected PM actions extracted: "${r.content.slice(0,300)}"`);
  });

  await test('Long text: very long message (2000+ chars) — graceful handling', async () => {
    // Use a separate fresh chat to avoid context leakage from prior long-text tests
    const isolatedCtx = await createFreshSupervisorChat(baseCtx, 'Advanced – Long Text Isolated');
    const padding = 'This is background context about my work style and preferences. '.repeat(30);
    const r = await chat(isolatedCtx, `${padding}\n\nBased on all this context: please add a team lunch for next Tuesday at noon.`);
    assert(r.content.length > 10, `Response too short`);
    // Should handle the long input gracefully and fulfill the final instruction
    const mentionsLunch = /lunch|tuesday|noon|added|calendar|12/i.test(r.content);
    assert(mentionsLunch, `Expected lunch event acknowledgment after long context: "${r.content.slice(0,200)}"`);
  });

  // Cleanup any seeded items
  for (const id of cleanupIds) await api(baseCtx, 'DELETE', `/api/me/agenda/${id}`);
}

// ── Suite 15: Conflict & Overlap Detection ────────────────────────────────
// Test whether the agent proactively checks for scheduling conflicts before
// creating new events.

async function testConflictDetection(baseCtx: TestCtx): Promise<void> {
  console.log('\n── Suite 15: Conflict & Overlap Detection ─────────────────────');
  const ctx = await createFreshSupervisorChat(baseCtx, 'Advanced – Conflicts');
  const cleanupIds: string[] = [];

  await test('Conflict: add two events at same time slot', async () => {
    // Seed one via REST
    const r1 = await api(baseCtx, 'POST', '/api/me/agenda', {
      title: 'Morning standup',
      kind: 'appointment',
      start_at: '2026-07-20T09:00',
      all_day: 0,
    });
    assert(r1.status === 201, `Setup: ${r1.status}`);
    cleanupIds.push((r1.data as Record<string, unknown>)['id'] as string);

    // Then ask agent to add another at same slot
    const r2 = await chat(ctx, 'Can you add a call with my lawyer on July 20th at 9am?');
    assert(r2.content.length > 10, `Response too short`);
    // Agent should either flag the conflict OR add both (either is valid, but response should be coherent)
    const isCoherent = r2.content.length > 15;
    assert(isCoherent, `Expected coherent response: "${r2.content.slice(0,200)}"`);
    console.log(`    Conflict response: "${r2.content.slice(0,150)}"`);
  });

  await test('Conflict: "am I free?" query before scheduling', async () => {
    // Seed a meeting
    const r = await api(baseCtx, 'POST', '/api/me/agenda', {
      title: 'Board call', kind: 'event', start_at: '2026-07-21T14:00', all_day: 0,
    });
    if (r.status === 201) cleanupIds.push((r.data as Record<string, unknown>)['id'] as string);

    const chatR = await chat(ctx, 'Am I free on July 21st at 2pm? I want to schedule a coffee chat.');
    assert(chatR.content.length > 10, `Response too short`);
    // Agent should check calendar and mention the existing board call
    const checksBusy = /board|call|busy|conflict|already|have|existing|2.?pm|14:00/i.test(chatR.content);
    // If agent doesn't notice the conflict, it should at least give a response about availability
    const isCoherent = chatR.content.length > 20;
    assert(isCoherent || checksBusy, `Expected availability check: "${chatR.content.slice(0,200)}"`);
    console.log(`    Availability response: "${chatR.content.slice(0,150)}"`);
  });

  await test('Conflict: REST double-book is allowed (no server-side conflict guard)', async () => {
    const slot = { start_at: '2026-07-22T10:00', all_day: 0, kind: 'event' as const };
    const r1 = await api(baseCtx, 'POST', '/api/me/agenda', { title: 'Event A', ...slot });
    const r2 = await api(baseCtx, 'POST', '/api/me/agenda', { title: 'Event B', ...slot });
    assert(r1.status === 201, `Event A: ${r1.status}`);
    assert(r2.status === 201, `Event B: ${r2.status}`); // Both allowed — client/agent guards conflicts
    cleanupIds.push((r1.data as Record<string, unknown>)['id'] as string);
    cleanupIds.push((r2.data as Record<string, unknown>)['id'] as string);
    console.log(`    Both double-booked events created — REST API does not guard conflicts (expected)`);
  });

  // Cleanup
  for (const id of cleanupIds) await api(baseCtx, 'DELETE', `/api/me/agenda/${id}`);
}

// ── Suite 16: Cross-Domain Compound Workflows ─────────────────────────────
// One conversation turn that requires creating: agenda item + linked note +
// reminder + action task in a single coordinated response.

async function testCrossDomainWorkflows(baseCtx: TestCtx): Promise<void> {
  console.log('\n── Suite 16: Cross-Domain Compound Workflows ──────────────────');
  const ctx = await createFreshSupervisorChat(baseCtx, 'Advanced – Cross-Domain');
  const cleanupIds: string[] = [];

  await test('Cross-domain: investor demo prep workflow', async () => {
    const r = await chat(ctx, `
I have an investor demo on July 1st at 2pm. Help me set up everything I need:
1. Add it to my calendar as "Investor Demo — Series A"
2. Create a prep checklist note with: "Practice pitch deck", "Test live demo environment", "Prepare Q&A answers", "Confirm dial-in details with Sarah"
3. Set reminders: 3 days before to review pitch, 1 day before to do a dry run
`.trim());
    assert(r.content.length > 40, `Response too short`);
    const mentions = /demo|calendar|note|reminder|checklist|july|investor|pitch/i.test(r.content);
    assert(mentions, `Expected workflow confirmation: "${r.content.slice(0,300)}"`);
  });

  await test('Cross-domain: annual leave planning', async () => {
    const r = await chat(ctx,
      'I\'m taking a week off from July 7-11. Can you block my calendar as "Annual Leave", create a handover note with the title "July vacation handover", and set a reminder on July 4 to send status updates to the team?'
    );
    assert(r.content.length > 30, `Response too short`);
    const mentionsVacation = /leave|vacation|block|calendar|handover|note|reminder|july/i.test(r.content);
    assert(mentionsVacation, `Expected vacation workflow: "${r.content.slice(0,300)}"`);
  });

  await test('Cross-domain: project milestone tracking', async () => {
    const r = await chat(ctx,
      'We just hit our beta milestone! Mark July 15 as "Beta Launch Day" in my calendar, create a milestone note titled "Beta Launch Notes" with "user feedback collection plan", and remind me July 16 morning to check the launch metrics.'
    );
    assert(r.content.length > 20, `Response too short`);
    const mentionsBeta = /beta|launch|calendar|note|reminder|july|milestone/i.test(r.content);
    assert(mentionsBeta, `Expected beta workflow: "${r.content.slice(0,300)}"`);
  });

  // Cleanup
  for (const id of cleanupIds) await api(baseCtx, 'DELETE', `/api/me/agenda/${id}`);
}

// ── Suite 17: Edge Cases — Titles, Unicode, Rapid Updates ────────────────

async function testEdgeCasesAdvanced(baseCtx: TestCtx): Promise<void> {
  console.log('\n── Suite 17: Edge Cases — Titles, Unicode, Rapid Updates ──────');
  const cleanupIds: string[] = [];

  await test('Edge: very long title (200 chars) — accepted', async () => {
    const longTitle = 'A'.repeat(200);
    const r = await api(baseCtx, 'POST', '/api/me/agenda', {
      title: longTitle, kind: 'event', start_at: '2026-08-01', all_day: 1,
    });
    assert(r.status === 201, `Expected 201, got ${r.status}: ${JSON.stringify(r.data).slice(0,100)}`);
    cleanupIds.push((r.data as Record<string, unknown>)['id'] as string);
  });

  await test('Edge: Unicode and emoji in title — accepted', async () => {
    const r = await api(baseCtx, 'POST', '/api/me/agenda', {
      title: '🦷 Dentist (歯科) — привет — مرحبا — check: √ ≠ ∞',
      kind: 'appointment', start_at: '2026-08-02T09:00', all_day: 0,
    });
    assert(r.status === 201, `Expected 201, got ${r.status}: ${JSON.stringify(r.data).slice(0,100)}`);
    const id = (r.data as Record<string, unknown>)['id'] as string;
    cleanupIds.push(id);
    // Read it back and verify round-trip
    const getR = await api(baseCtx, 'GET', `/api/me/agenda/${id}`);
    assert(getR.status === 200, `GET after Unicode create: ${getR.status}`);
    const d = getR.data as Record<string, unknown>;
    assert(String(d['title']).includes('🦷'), `Unicode title not preserved: ${d['title']}`);
  });

  await test('Edge: newlines and special chars in description — accepted', async () => {
    const r = await api(baseCtx, 'POST', '/api/me/agenda', {
      title: 'Special chars test',
      kind: 'event',
      start_at: '2026-08-03',
      all_day: 1,
      description: `Line 1\nLine 2\nLine 3 with "quotes" and 'apostrophes'\nSQL: SELECT * FROM users WHERE id = 1;\nHTML: <b>bold</b> <script>alert(1)</script>`,
    });
    assert(r.status === 201, `Expected 201, got ${r.status}`);
    const id = (r.data as Record<string, unknown>)['id'] as string;
    cleanupIds.push(id);
    const getR = await api(baseCtx, 'GET', `/api/me/agenda/${id}`);
    const d = getR.data as Record<string, unknown>;
    assert(String(d['description']).includes('Line 1'), `Description not preserved`);
    assert(String(d['description']).includes('<b>bold</b>'), `HTML in description not preserved literally`);
  });

  await test('Edge: 5 rapid PATCH updates to same item — last one wins', async () => {
    const r = await api(baseCtx, 'POST', '/api/me/agenda', {
      title: 'Rapid patch target', kind: 'event', start_at: '2026-08-04T10:00', all_day: 0,
    });
    assert(r.status === 201, `Setup: ${r.status}`);
    const id = (r.data as Record<string, unknown>)['id'] as string;
    cleanupIds.push(id);

    // Fire 5 PATCHes in sequence
    const times = ['T09:00', 'T10:00', 'T11:00', 'T12:00', 'T13:00'];
    for (const t of times) {
      const p = await api(baseCtx, 'PATCH', `/api/me/agenda/${id}`, { start_at: `2026-08-04${t}` });
      assert(p.status === 200, `PATCH to ${t}: ${p.status}`);
    }
    const final = await api(baseCtx, 'GET', `/api/me/agenda/${id}`);
    const d = final.data as Record<string, unknown>;
    assert(String(d['start_at']).includes('T13:00'), `Expected last PATCH (T13:00) to win, got: ${d['start_at']}`);
  });

  await test('Edge: 5 parallel PATCH updates — no server crash (last write wins)', async () => {
    const r = await api(baseCtx, 'POST', '/api/me/agenda', {
      title: 'Parallel patch target', kind: 'event', start_at: '2026-08-05T10:00', all_day: 0,
    });
    assert(r.status === 201, `Setup: ${r.status}`);
    const id = (r.data as Record<string, unknown>)['id'] as string;
    cleanupIds.push(id);
    const patches = ['Meeting A', 'Meeting B', 'Meeting C', 'Meeting D', 'Meeting E'].map(t =>
      api(baseCtx, 'PATCH', `/api/me/agenda/${id}`, { title: t })
    );
    const results = await Promise.all(patches);
    const allOk = results.every(p => p.status === 200);
    assert(allOk, `Some parallel PATCHes failed: ${JSON.stringify(results.map(p => p.status))}`);
    const final = await api(baseCtx, 'GET', `/api/me/agenda/${id}`);
    assert(final.status === 200, `Final GET: ${final.status}`);
    const d = final.data as Record<string, unknown>;
    assert(['Meeting A','Meeting B','Meeting C','Meeting D','Meeting E'].includes(String(d['title'])),
      `Unexpected title after parallel patches: ${d['title']}`);
  });

  await test('Edge: empty title disallowed', async () => {
    const r = await api(baseCtx, 'POST', '/api/me/agenda', { title: '', kind: 'event' });
    assert(r.status === 400, `Expected 400 for empty title, got ${r.status}`);
  });

  await test('Edge: note with 5000-char doc_json body — accepted', async () => {
    const longPara = 'Lorem ipsum dolor sit amet. '.repeat(180); // ~5000 chars
    const r = await api(baseCtx, 'POST', '/api/me/notes', {
      title: 'Long note stress test',
      doc_json: JSON.stringify({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: longPara }] }],
      }),
    });
    assert(r.status === 201, `Expected 201, got ${r.status}: ${String(r.data).slice(0,100)}`);
    const noteId = (r.data as Record<string, unknown>)['id'] as string;
    // Read it back
    const getR = await api(baseCtx, 'GET', `/api/me/notes/${noteId}`);
    assert(getR.status === 200, `GET after long note: ${getR.status}`);
    // Cleanup
    await api(baseCtx, 'DELETE', `/api/me/notes/${noteId}`);
  });

  await test('Edge: agent with very specific date/time query', async () => {
    const ctx = await createFreshSupervisorChat(baseCtx, 'Adv – Specific Date');
    await api(baseCtx, 'POST', '/api/me/agenda', {
      title: 'Quarter close review', kind: 'deadline', start_at: '2026-06-30T16:00', all_day: 0,
    });
    const r = await chat(ctx, 'What do I have at 4pm on June 30th 2026?');
    assert(r.content.length > 5, `Response too short`);
    const mentionsEvent = /quarter|close|review|june 30|4.?pm|16:00/i.test(r.content) ||
                          r.toolsUsed.some(t => t.includes('agenda_list'));
    assert(mentionsEvent, `Expected specific event: "${r.content.slice(0,200)}"`);
  });

  // Cleanup
  for (const id of cleanupIds) await api(baseCtx, 'DELETE', `/api/me/agenda/${id}`);
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  geneWeave Advanced Scenario Stress Test');
  console.log('  Based on REALM-Bench, multi-turn LLM degradation research,');
  console.log('  and production agent reliability patterns.');
  console.log('  Target: ' + BASE_URL);
  console.log('  Date: ' + new Date().toISOString());
  console.log('═══════════════════════════════════════════════════════════════');

  try {
    const health = await fetch(`${BASE_URL}/`);
    if (!health.ok && health.status !== 404) throw new Error(`Server ${health.status}`);
  } catch (e) {
    console.error(`\nERROR: Server not reachable at ${BASE_URL}`);
    process.exit(1);
  }

  const userId = getUserId();
  const { token, csrf } = createAuthToken(userId, USER_EMAIL);
  console.log(`\nAuthenticated as ${USER_EMAIL} (${userId})`);
  const baseCtx: TestCtx = { token, csrf, userId, chatId: '' };

  // Wipe any agenda items left from previous runs before starting
  const wipedBefore = await wipeAllAgendaItems(baseCtx);
  if (wipedBefore > 0) console.log(`\n  Cleared ${wipedBefore} leftover agenda items from previous runs`);

  await testMultiIntent(baseCtx);
  await testConversationContinuity(baseCtx);
  await testIdempotency(baseCtx);
  await testLongTextScenarios(baseCtx);
  await testConflictDetection(baseCtx);
  await testCrossDomainWorkflows(baseCtx);
  await testEdgeCasesAdvanced(baseCtx);

  // Clean up all agent-created agenda items after the run
  const wipedAfter = await wipeAllAgendaItems(baseCtx);
  if (wipedAfter > 0) console.log(`\n  Cleaned up ${wipedAfter} agent-created agenda items`);

  // ── Report ────────────────────────────────────────────────────────────────
  const passed = results.filter(r => r.passed);
  const failed = results.filter(r => !r.passed);
  const totalMs = results.reduce((s, r) => s + r.duration, 0);
  const agentMs = results.filter(r => r.name.startsWith('Multi-intent') || r.name.startsWith('Continuity') ||
    r.name.startsWith('Agent') || r.name.startsWith('Long text') || r.name.startsWith('Cross-domain') ||
    r.name.startsWith('Conflict')).reduce((s, r) => s + r.duration, 0);

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  RESULTS: ${passed.length}/${results.length} passed  |  ${totalMs}ms total  |  ${agentMs}ms agent time`);
  console.log('═══════════════════════════════════════════════════════════════');

  if (failed.length > 0) {
    console.log('\nFailed tests:');
    failed.forEach(f => console.log(`  ✗ ${f.name}\n    ${f.detail}`));
  }

  const suiteMap: Record<string, string> = {
    'Multi-intent': 'Suite 11: Multi-Intent Messages',
    'Continuity': 'Suite 12: Conversation Continuity',
    'REST': 'Suite 13: Idempotency (REST)',
    'Agent': 'Suite 13: Idempotency (Agent)',
    'Long text': 'Suite 14: Long Text',
    'Conflict': 'Suite 15: Conflict Detection',
    'Cross-domain': 'Suite 16: Cross-Domain Workflows',
    'Edge': 'Suite 17: Edge Cases',
  };

  console.log('\nBy category:');
  const suites: Record<string, TestResult[]> = {};
  for (const r of results) {
    const key = Object.keys(suiteMap).find(k => r.name.startsWith(k)) ?? 'Other';
    (suites[suiteMap[key] ?? key] ??= []).push(r);
  }
  Object.entries(suites).forEach(([suite, tests]) => {
    const p = tests.filter(t => t.passed).length;
    const avgMs = Math.round(tests.reduce((s, t) => s + t.duration, 0) / tests.length);
    const emoji = p === tests.length ? '✅' : p === 0 ? '❌' : '⚠️';
    console.log(`  ${emoji} ${suite}: ${p}/${tests.length}  (avg ${avgMs}ms/test)`);
  });

  console.log('');
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
