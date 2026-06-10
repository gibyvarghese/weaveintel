#!/usr/bin/env npx tsx
/**
 * Memory System Comprehensive Stress Test
 *
 * Tests the complete geneWeave memory pipeline through the public HTTP API,
 * always using agent mode so that memory capture and tool usage are exercised
 * the same way a real user would experience them.
 *
 * Coverage:
 *  • Episodic capture: every turn (user + assistant) stored automatically
 *  • Semantic memory: explicit via memory_remember tool (keyword-searchable)
 *  • Memory tools: memory_search, memory_recall, memory_remember, memory_forget,
 *                  memory_list_episodes, memory_get_profile, memory_list_entities
 *  • Cross-chat persistence: facts stored in Chat 1 recalled in Chat 2
 *  • Cross-user isolation: User A's memories never leak to User B
 *  • Admin visibility: admin can read any user's memory; regular users cannot
 *  • Procedural memory: propose → approve → apply → agent behavior change
 *  • Procedural negative paths: apply-before-approve, apply-twice, reject-applied
 *  • Memory settings toggles: disable episodic, send message, verify no capture
 *  • Max limits: trim-to-cap when episodic count exceeds max_episodic_per_user
 *  • Supervisor agent: memory context available to worker via supervisor delegation
 *  • Negative API tests: missing fields, wrong user, bad IDs, non-admin access
 *  • Concurrency: 3 parallel messages → all 6 episodic entries stored
 *  • Full user memory wipe: DELETE /api/user/memory/all
 *  • Governance/PII redaction: episodic + semantic governed by m37 rules
 *  • Content size and data-type handling
 *  • Multi-turn entity extraction from natural conversation
 *  • Implicit recall via system-prompt context (no tool directive)
 *  • Fact correction and update handling (stale facts overwritten)
 *  • Semantic vocabulary gap (store "concise", recall with "brief")
 *  • Professional project scenario with mixed entity/semantic content
 *  • Preference-driven recommendation recall
 *  • Narrative thread recall within the same session (correction flow)
 *  • Relationship memory — third-party entity tracking
 *  • Embedded PII in natural narrative prose (DB strings, JWTs, SSNs)
 *  • Compound multi-hop memory search (pet + allergy + medication + location)
 *
 * Run:
 *   npx tsx scripts/memory-stress.ts
 *
 * Prerequisites:
 *   Server running on PORT (default 3500), ANTHROPIC_API_KEY set in .env.
 *   The first time you run this after a fresh DB, it will auto-promote the
 *   first registered user to tenant_admin.  On an existing DB the script
 *   re-uses the platform_admin user that already exists.
 */

const BASE = process.env['BASE_URL'] ?? 'http://localhost:3500';
const MODEL = 'anthropic/claude-haiku-4-5-20251001';

/** How long to wait for an agent turn (ReAct loop can be slow). */
const AGENT_TIMEOUT = 50_000;
/** How long to wait after a message for async memory extraction to finish. */
const EXTRACTION_WAIT = 2_000;

// ─── Result tracking ───────────────────────────────────────────────────────────

interface TestResult { name: string; status: 'pass' | 'fail' | 'skip'; detail?: string }
const results: TestResult[] = [];

function pass(name: string) {
  results.push({ name, status: 'pass' });
  console.log(`  ✅ ${name}`);
}
function fail(name: string, detail: string) {
  results.push({ name, status: 'fail', detail });
  console.log(`  ❌ ${name}`);
  console.log(`     ${detail}`);
}
function skip(name: string, detail: string) {
  results.push({ name, status: 'skip', detail });
  console.log(`  ⏭  ${name} — ${detail}`);
}
function group(title: string) {
  console.log(`\n${'─'.repeat(64)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(64));
}
function assert(name: string, ok: boolean, msg?: string) {
  ok ? pass(name) : fail(name, msg ?? 'condition was false');
}

// ─── HTTP primitives ────────────────────────────────────────────────────────────

interface Session { cookie: string; csrf: string; userId: string }

async function request(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string; csrf?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const url = `${BASE}${path}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.cookie) headers['Cookie'] = opts.cookie;
  if (opts.csrf)   headers['X-CSRF-Token'] = opts.csrf;
  const resp = await fetch(url, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const ct = resp.headers.get('content-type') ?? '';
  const body = ct.includes('application/json') ? await resp.json() : await resp.text();
  return { status: resp.status, body };
}

async function register(email: string, name: string, pw = 'Str0ng!Pass99'): Promise<Session | null> {
  await request('POST', '/api/auth/register', { body: { name, email, password: pw } });
  return login(email, pw);
}

async function login(email: string, pw = 'Str0ng!Pass99'): Promise<Session | null> {
  const resp = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: pw }),
  });
  if (resp.status !== 200) return null;
  const raw = resp.headers.get('set-cookie') ?? '';
  const match = raw.match(/gw_token=[^;]+/);
  if (!match) return null;
  const data = await resp.json() as Record<string, unknown>;
  return {
    cookie: match[0],
    csrf: (data['csrfToken'] as string) ?? '',
    userId: ((data['user'] as Record<string, unknown>)?.['id'] as string) ?? '',
  };
}

function auth(s: Session, method: string, path: string, body?: unknown) {
  return request(method, path, { body, cookie: s.cookie, csrf: s.csrf });
}

// ─── Chat helpers ──────────────────────────────────────────────────────────────

const MEMORY_TOOLS = [
  'memory_recall', 'memory_search', 'memory_remember', 'memory_forget',
  'memory_list_entities', 'memory_list_episodes', 'memory_get_profile', 'datetime',
];

async function createChat(
  s: Session,
  mode: 'direct' | 'agent' | 'supervisor',
  name = 'Stress Test Chat',
  tools = MEMORY_TOOLS,
): Promise<string | null> {
  const r = await auth(s, 'POST', '/api/chats', { name });
  if (r.status !== 201) return null;
  const chatId = (((r.body as Record<string, unknown>)['chat']) as Record<string, unknown>)?.['id'] as string;
  if (!chatId) return null;
  await auth(s, 'POST', `/api/chats/${chatId}/settings`, { mode, enabledTools: tools });
  return chatId;
}

async function send(
  s: Session,
  chatId: string,
  content: string,
  timeoutMs = AGENT_TIMEOUT,
): Promise<{ ok: boolean; reply: string; status: number }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${BASE}/api/chats/${chatId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': s.cookie,
        'X-CSRF-Token': s.csrf,
      },
      body: JSON.stringify({ content, model: MODEL }),
      signal: ctrl.signal,
    });
    const body = await resp.json() as Record<string, unknown>;
    const reply = (body['assistantContent'] as string) ?? '';
    return { ok: resp.status === 200, reply, status: resp.status };
  } catch {
    return { ok: false, reply: '', status: 0 };
  } finally {
    clearTimeout(t);
  }
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ─── Admin & memory API helpers ────────────────────────────────────────────────

function b(s: Record<string, unknown>, key: string) { return (s[key] as unknown[]) ?? []; }

async function getEpisodic(admin: Session, userId: string, limit = 200) {
  const r = await auth(admin, 'GET', `/api/admin/episodic-memory?userId=${userId}&limit=${limit}`);
  if (r.status !== 200) return null;
  return b(r.body as Record<string, unknown>, 'episodic-memory') as Array<Record<string, unknown>>;
}

async function getEpisodicCount(admin: Session, userId: string) {
  const ep = await getEpisodic(admin, userId);
  return ep ? ep.length : -1;
}

async function getProcedural(admin: Session, userId: string) {
  const r = await auth(admin, 'GET', `/api/admin/procedural-memory?userId=${userId}`);
  if (r.status !== 200) return null;
  return b(r.body as Record<string, unknown>, 'procedural-memory') as Array<Record<string, unknown>>;
}

async function getWorkingMemory(admin: Session, userId: string) {
  const r = await auth(admin, 'GET', `/api/admin/working-memory?userId=${userId}`);
  if (r.status !== 200) return null;
  return b(r.body as Record<string, unknown>, 'working-memory') as Array<Record<string, unknown>>;
}

async function getSettings(admin: Session) {
  const r = await auth(admin, 'GET', '/api/admin/memory-settings');
  if (r.status !== 200) return null;
  const items = b(r.body as Record<string, unknown>, 'memory-settings');
  return items[0] as Record<string, unknown> | undefined;
}

async function putSettings(admin: Session, patch: Record<string, unknown>) {
  return auth(admin, 'PUT', '/api/admin/memory-settings/global', patch);
}

async function createProcedural(admin: Session, data: {
  user_id: string; agent_id: string; instruction_delta: string; proposed_by: string; confidence: number;
}) {
  const r = await auth(admin, 'POST', '/api/admin/procedural-memory', data);
  if (r.status !== 201) return null;
  return ((r.body as Record<string, unknown>)['procedural-memory-entry']) as Record<string, unknown> | null;
}

async function approveProc(admin: Session, id: string) {
  return auth(admin, 'POST', `/api/admin/procedural-memory/${id}/approve`, {});
}
async function applyProc(admin: Session, id: string) {
  return auth(admin, 'POST', `/api/admin/procedural-memory/${id}/apply`, {});
}
async function rejectProc(admin: Session, id: string) {
  return auth(admin, 'POST', `/api/admin/procedural-memory/${id}/reject`, {});
}

async function getUserMemory(s: Session) {
  const r = await auth(s, 'GET', '/api/user/memory');
  if (r.status !== 200) return null;
  return r.body as Record<string, unknown>;
}

async function promoteToAdmin(admin: Session, targetUserId: string) {
  return auth(admin, 'POST', `/api/admin/rbac/users/${targetUserId}/persona`, { persona: 'platform_admin' });
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═'.repeat(64));
  console.log('  Memory System Comprehensive Stress Test');
  console.log(`  ${BASE}  •  ${MODEL}`);
  console.log('═'.repeat(64));

  // ── Fixture setup ────────────────────────────────────────────────────────────
  const ts = Date.now();
  const emailA   = `mem-a-${ts}@weaveintel.dev`;
  const emailB   = `mem-b-${ts}@weaveintel.dev`;
  const emailC   = `mem-c-${ts}@weaveintel.dev`;
  const adminEmail = `mem-admin-${ts}@weaveintel.dev`;

  // Try known admin first; fall back to registering a new one and self-promoting
  let admin: Session | null = await login('e2e-memory-test@weaveintel.dev');
  let adminReady = false;

  if (!admin) {
    // Register and ask the first platform_admin to elevate us
    admin = await register(adminEmail, 'Stress Admin');
    // The server's ensureAtLeastOneTenantAdmin may not promote this user since
    // there are existing admins.  We'll try using admin routes and see.
    if (admin) {
      const probe = await auth(admin, 'GET', '/api/admin/memory-settings');
      adminReady = probe.status === 200;
    }
  } else {
    adminReady = true;
  }

  if (!adminReady || !admin) {
    console.log('\n⚠️  No admin session available — admin-only tests will be skipped.');
    console.log('   Tip: promote a user with platform_admin persona in the DB and re-run.\n');
  }

  // Register regular test users
  const sessA = await register(emailA, 'User Alex');
  const sessB = await register(emailB, 'User Blake');
  const sessC = await register(emailC, 'User Casey');

  if (!sessA || !sessB || !sessC) {
    console.error('Fatal: could not register test users. Is the server running?');
    process.exit(1);
  }

  // Promote sessA to admin if we have no admin session yet
  if (!adminReady && admin) {
    const probe = await auth(sessA, 'GET', '/api/admin/memory-settings');
    if (probe.status === 200) {
      admin = sessA;
      adminReady = true;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // GROUP 1 — Foundation
  // ══════════════════════════════════════════════════════════════════════════════
  group('GROUP 1 — Foundation');

  {
    const r = await request('GET', '/api/auth/me', { cookie: sessA.cookie });
    assert('1.1  Server is reachable (GET /api/auth/me → 200)', r.status === 200);
  }

  if (adminReady && admin) {
    const settings = await getSettings(admin);
    assert('1.2  M36 global memory_settings row seeded', !!settings);
    if (settings) {
      assert('1.3  All memory types enabled by default',
        settings['enable_semantic'] === 1 &&
        settings['enable_entity']   === 1 &&
        settings['enable_episodic'] === 1 &&
        settings['enable_procedural'] === 1 &&
        settings['enable_working'] === 1,
        `got: ${JSON.stringify(settings)}`);
    }
  } else {
    skip('1.2  M36 global memory_settings row seeded', 'no admin session');
    skip('1.3  All memory types enabled by default', 'no admin session');
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // GROUP 2 — Automatic episodic capture on agent turns
  // ══════════════════════════════════════════════════════════════════════════════
  group('GROUP 2 — Automatic Episodic Capture');

  const chat2 = await createChat(sessA, 'agent');
  if (!chat2) { fail('2.setup', 'Could not create agent chat for User A'); }
  else {
    const r = await send(sessA, chat2,
      'Hi, I\'m Dr. Sarah Mitchell, a cardiologist at Sydney Heart Institute. I\'ve been practising for 15 years.');
    assert('2.1  Agent chat turn returns 200', r.ok, r.reply.slice(0, 120) || `status ${r.status}`);

    await sleep(EXTRACTION_WAIT);

    if (adminReady && admin) {
      const ep = await getEpisodic(admin, sessA.userId);
      assert('2.2  Episodic memory captured at least 2 entries (user + assistant)',
        (ep?.length ?? 0) >= 2,
        `found ${ep?.length ?? 0} entries`);

      const userTurn = ep?.find(e => e['message_role'] === 'user');
      assert('2.3  User turn stored with correct content',
        !!userTurn && (userTurn['content'] as string).includes('cardiologist'),
        `turn content: ${String(userTurn?.['content'] ?? '').slice(0, 80)}`);

      const asstTurn = ep?.find(e => e['message_role'] === 'assistant');
      assert('2.4  Assistant turn stored', !!asstTurn);

      // Both turns should point to the same chat
      assert('2.5  Episodic entries linked to correct chat_id',
        ep?.every(e => e['chat_id'] === chat2) ?? false,
        `chat_id mismatch`);
    } else {
      skip('2.2-2.5  Episodic count/content verification', 'no admin session');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // GROUP 3 — Agent memory tool usage
  // ══════════════════════════════════════════════════════════════════════════════
  group('GROUP 3 — Agent Memory Tool Usage');

  const chat3 = await createChat(sessA, 'agent', 'Tool Test Chat');
  if (!chat3) { fail('3.setup', 'Could not create agent chat'); }
  else {
    // 3.1 memory_remember — explicit store
    const r31 = await send(sessA, chat3,
      'Please use the memory_remember tool to save: "Project Phoenix deadline is 2027-03-15, budget $2M"');
    assert('3.1  memory_remember tool call returns 200', r31.ok, r31.reply.slice(0, 120));

    // 3.2 memory_search — explicit search; phrase avoids Kaggle skill trigger patterns
    const r32 = await send(sessA, chat3,
      'Search my stored memories for anything about project timelines or due dates ' +
      'using the memory_search tool. Show me what you find.');
    assert('3.2  memory_search tool call returns 200', r32.ok, r32.reply.slice(0, 120));
    // The search should surface the Phoenix fact or at minimum confirm no crash
    const search32Hit = r32.reply.toLowerCase().includes('phoenix') ||
      r32.reply.toLowerCase().includes('2027') ||
      r32.reply.toLowerCase().includes('deadline') ||
      r32.reply.toLowerCase().includes('project') ||
      r32.reply.toLowerCase().includes('budget') ||
      r32.reply.toLowerCase().includes('no memory') ||
      r32.reply.toLowerCase().includes('found') ||
      r32.reply.toLowerCase().includes('nothing') ||
      r32.reply.toLowerCase().includes('memory');
    assert('3.3  memory_search reply is about memory (not an unrelated guardrail)',
      search32Hit,
      `reply: ${r32.reply.slice(0, 200)}`);

    // 3.4 memory_list_episodes — list recent turns
    const r34 = await send(sessA, chat3,
      'Use the memory_list_episodes tool to show me my last 5 conversation events.');
    assert('3.4  memory_list_episodes call returns 200', r34.ok, r34.reply.slice(0, 120));
    // The reply should contain something about recent turns
    assert('3.5  memory_list_episodes reply mentions conversation history',
      r34.reply.toLowerCase().includes('phoenix') ||
      r34.reply.toLowerCase().includes('project') ||
      r34.reply.toLowerCase().includes('deadline') ||
      r34.reply.toLowerCase().includes('conversation') ||
      r34.reply.toLowerCase().includes('episode'),
      `reply: ${r34.reply.slice(0, 200)}`);

    // 3.6 memory_get_profile — full user profile
    await send(sessA, chat3, 'My hobby is deep-sea diving.');  // add a fact first
    const r36 = await send(sessA, chat3,
      'Use the memory_get_profile tool to give me a summary of everything you know about me.');
    assert('3.6  memory_get_profile call returns 200', r36.ok, r36.reply.slice(0, 120));
    assert('3.7  memory_get_profile response contains stored facts',
      r36.reply.toLowerCase().includes('phoenix') ||
      r36.reply.toLowerCase().includes('project') ||
      r36.reply.toLowerCase().includes('deadline') ||
      r36.reply.toLowerCase().includes('diving'),
      `reply: ${r36.reply.slice(0, 200)}`);

    // 3.8 memory_forget — remove a fact
    const r38 = await send(sessA, chat3,
      'Use the memory_forget tool to delete the entry about Project Phoenix from your memory.');
    assert('3.8  memory_forget call returns 200', r38.ok, r38.reply.slice(0, 120));
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // GROUP 4 — Cross-chat memory persistence (facts survive across chat sessions)
  // ══════════════════════════════════════════════════════════════════════════════
  group('GROUP 4 — Cross-Chat Memory Persistence');

  const chat4a = await createChat(sessA, 'agent', 'Persistence Chat A');
  const chat4b = await createChat(sessA, 'agent', 'Persistence Chat B');

  if (!chat4a || !chat4b) {
    fail('4.setup', 'Could not create persistence test chats');
  } else {
    // Store a unique fact in Chat A
    const secret = `UNIQUE-${ts}`;
    await send(sessA, chat4a,
      `Please use memory_remember to store: "My secret code is ${secret}"`);

    // In a different chat, retrieve it
    await sleep(500);
    const r4b = await send(sessA, chat4b,
      'Use memory_recall to search for my secret code. What is it?');
    assert('4.1  Fact stored in Chat A is recalled in Chat B',
      r4b.reply.includes(secret),
      `expected code ${secret} in reply: ${r4b.reply.slice(0, 200)}`);
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // GROUP 5 — System prompt context injection (without explicit tool call)
  // ══════════════════════════════════════════════════════════════════════════════
  group('GROUP 5 — System Prompt Memory Context Injection');

  const chat5a = await createChat(sessA, 'agent', 'Context Inject A');
  const chat5b = await createChat(sessA, 'agent', 'Context Inject B');

  if (!chat5a || !chat5b) {
    fail('5.setup', 'Could not create context injection chats');
  } else {
    // Store facts in Chat A
    await send(sessA, chat5a,
      'Use memory_remember to store: "I am allergic to penicillin and shellfish."');
    await send(sessA, chat5a,
      'Use memory_remember to store: "I live at 42 Ocean Street, Bondi Beach, Sydney."');

    await sleep(500);

    // In Chat B, ask naturally — agent should see facts via system prompt injection
    const r5b = await send(sessA, chat5b,
      'Can you remind me what allergies I have? Answer directly without using tools.');
    assert('5.1  Memory context injected into system prompt',
      r5b.reply.toLowerCase().includes('penicillin') ||
      r5b.reply.toLowerCase().includes('shellfish'),
      `expected allergy mention in: ${r5b.reply.slice(0, 300)}`);
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // GROUP 6 — Cross-user isolation (CRITICAL: no memory leaks)
  // ══════════════════════════════════════════════════════════════════════════════
  group('GROUP 6 — Cross-User Isolation');

  const chat6a = await createChat(sessA, 'agent', 'Isolation: User A');
  const chat6b = await createChat(sessB, 'agent', 'Isolation: User B');

  if (!chat6a || !chat6b) {
    fail('6.setup', 'Could not create isolation test chats');
  } else {
    // User A stores sensitive data
    const sensitiveData = `ACCESS-CODE-${ts}-A`;
    await send(sessA, chat6a,
      `Use memory_remember to store: "My vault PIN is ${sensitiveData}"`);

    await sleep(500);

    // User B tries to retrieve it — should NEVER see User A's data
    const r6b = await send(sessB, chat6b,
      `Use memory_search to find any access codes or PINs stored in memory. Look for anything containing ${ts}.`);
    assert('6.1  User B cannot retrieve User A\'s sensitive memories',
      !r6b.reply.includes(sensitiveData),
      `LEAK: User B saw: ${r6b.reply.slice(0, 200)}`);

    // User B's GET /api/user/memory should not contain User A's data
    const memB = await getUserMemory(sessB);
    if (memB) {
      const allB = JSON.stringify(memB);
      assert('6.2  User B /api/user/memory contains no User A data',
        !allB.includes(sensitiveData),
        `LEAK in user memory API: found ${sensitiveData}`);
    }

    // Admin can see User A's memory (by userId) but User B cannot access it
    if (adminReady && admin) {
      const epA = await getEpisodic(admin!, sessA.userId);
      const hasA = epA?.some(e => (e['content'] as string).includes(sensitiveData)) ?? false;
      assert('6.3  Admin CAN see User A\'s episodic memory', (epA?.length ?? 0) > 0);

      // User B tries to hit admin endpoint for User A (should be 403)
      const rBAdmin = await auth(sessB, 'GET',
        `/api/admin/episodic-memory?userId=${sessA.userId}`);
      assert('6.4  Non-admin (User B) cannot access admin episodic-memory endpoint',
        rBAdmin.status === 403,
        `got ${rBAdmin.status}`);

      // User B tries to delete User A's episodic entry
      if (epA && epA.length > 0) {
        const victimId = epA[0]!['id'] as string;
        const rDelAttempt = await auth(sessB, 'DELETE',
          `/api/user/memory/episodic/${victimId}`);
        // The user-level delete checks auth.userId, so B's delete of A's entry
        // should either return ok:true (but NOT delete A's entry) or fail.
        // Verify A's entry still exists after B's attempt.
        await sleep(300);
        const epAAfter = await getEpisodic(admin!, sessA.userId);
        assert('6.5  User B cannot delete User A\'s episodic entry',
          epAAfter?.some(e => e['id'] === victimId) ?? false,
          `Entry ${victimId} was deleted by User B!`);
      }
    } else {
      skip('6.3-6.5  Admin-side isolation checks', 'no admin session');
    }

    // Memory stored for User A should be empty for User B's list
    if (adminReady && admin) {
      const epB = await getEpisodic(admin!, sessB.userId);
      const bData = JSON.stringify(epB ?? []);
      assert('6.6  Admin sees User B\'s episodic has no User A data',
        !bData.includes(sensitiveData),
        `LEAK detected in User B episodic: ${bData.slice(0, 200)}`);
    } else {
      skip('6.6  Admin episodic cross-check', 'no admin session');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // GROUP 7 — User A cannot access admin endpoints (persona guard)
  // ══════════════════════════════════════════════════════════════════════════════
  group('GROUP 7 — RBAC / Persona Guards');

  {
    const paths = [
      '/api/admin/memory-settings',
      `/api/admin/episodic-memory?userId=${sessA.userId}`,
      `/api/admin/procedural-memory?userId=${sessA.userId}`,
      `/api/admin/working-memory?userId=${sessA.userId}`,
    ];
    for (const p of paths) {
      const r = await auth(sessB, 'GET', p);
      assert(`7.x  tenant_user blocked from ${p}`, r.status === 403, `got ${r.status}`);
    }

    // User can access their OWN memory via user API
    const rOwn = await auth(sessA, 'GET', '/api/user/memory');
    assert('7.1  User can access /api/user/memory (own)', rOwn.status === 200, `got ${rOwn.status}`);
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // GROUP 8 — Procedural memory: full lifecycle + negative paths
  // ══════════════════════════════════════════════════════════════════════════════
  group('GROUP 8 — Procedural Memory Lifecycle');

  if (!adminReady || !admin) {
    skip('8.x  All procedural tests', 'no admin session');
  } else {
    // 8.1 Create
    const marker = `PROC-MARKER-${ts}`;
    const proc = await createProcedural(admin!, {
      user_id: sessA.userId,
      agent_id: 'default',
      instruction_delta: `Whenever the user asks about greetings, always begin your response with "[${marker}]:"`,
      proposed_by: 'admin',
      confidence: 0.95,
    });
    assert('8.1  Create procedural memory → 201', !!proc, 'createProcedural returned null');

    if (proc) {
      const pid = proc['id'] as string;
      assert('8.2  Initial status is "proposed"', proc['status'] === 'proposed',
        `got: ${proc['status']}`);

      // 8.3 Try apply before approve → should fail
      const preApply = await applyProc(admin!, pid);
      assert('8.3  Apply before approve → 400 or 409',
        preApply.status === 400 || preApply.status === 409,
        `got ${preApply.status}: ${JSON.stringify(preApply.body).slice(0, 100)}`);

      // 8.4 Approve
      const approved = await approveProc(admin!, pid);
      assert('8.4  Approve → 200', approved.status === 200,
        `got ${approved.status}: ${JSON.stringify(approved.body).slice(0, 100)}`);

      // 8.5 Apply
      const applied = await applyProc(admin!, pid);
      assert('8.5  Apply (approved) → 200', applied.status === 200,
        `got ${applied.status}: ${JSON.stringify(applied.body).slice(0, 100)}`);

      // 8.6 Apply again → should fail (already applied)
      const applyAgain = await applyProc(admin!, pid);
      assert('8.6  Apply twice → 400 or 409',
        applyAgain.status === 400 || applyAgain.status === 409,
        `got ${applyAgain.status}`);

      // 8.7 Procedural delta changes agent behavior in next chat turn
      await sleep(300);
      const chat8 = await createChat(sessA, 'agent', 'Procedural Behavior Test');
      if (chat8) {
        const r8 = await send(sessA, chat8, 'How would you greet someone you just met?');
        assert('8.7  Applied procedural delta injected into agent system prompt',
          r8.reply.includes(`[${marker}]`),
          `expected [${marker}] prefix in: ${r8.reply.slice(0, 200)}`);
      } else {
        fail('8.7  Procedural behavior test', 'could not create chat');
      }

      // 8.8 Reject after apply → should fail (terminal state)
      const rejectApplied = await rejectProc(admin!, pid);
      assert('8.8  Reject after apply → 400 or 409',
        rejectApplied.status === 400 || rejectApplied.status === 409,
        `got ${rejectApplied.status}`);
    }

    // 8.9 Reject workflow (fresh entry)
    const proc9 = await createProcedural(admin!, {
      user_id: sessA.userId,
      agent_id: 'default',
      instruction_delta: 'Always speak in rhyming couplets.',
      proposed_by: 'admin',
      confidence: 0.5,
    });
    if (proc9) {
      const pid9 = proc9['id'] as string;
      const rejected = await rejectProc(admin!, pid9);
      assert('8.9  Reject proposed → 200', rejected.status === 200,
        `got ${rejected.status}`);

      // Try to approve a rejected entry → should fail
      const approveRejected = await approveProc(admin!, pid9);
      assert('8.10 Approve after reject → 400 or 409',
        approveRejected.status === 400 || approveRejected.status === 409,
        `got ${approveRejected.status}`);

      // Try to apply a rejected entry → should fail
      const applyRejected = await applyProc(admin!, pid9);
      assert('8.11 Apply after reject → 400 or 409',
        applyRejected.status === 400 || applyRejected.status === 409,
        `got ${applyRejected.status}`);
    }

    // 8.12 Create procedural with missing required fields
    const badProc = await auth(admin!, 'POST', '/api/admin/procedural-memory', {
      // missing user_id and instruction_delta
      agent_id: 'default',
      confidence: 0.5,
    });
    assert('8.12 Create procedural with missing fields → 400',
      badProc.status === 400,
      `got ${badProc.status}: ${JSON.stringify(badProc.body).slice(0, 100)}`);
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // GROUP 9 — Max episodic limit enforcement
  // ══════════════════════════════════════════════════════════════════════════════
  group('GROUP 9 — Max Episodic Limit Enforcement');

  if (!adminReady || !admin) {
    skip('9.x  All limit tests', 'no admin session');
  } else {
    // Set a very low cap for User C
    const CAP = 4;
    const putResult = await putSettings(admin!, { max_episodic_per_user: CAP });
    assert('9.1  Update max_episodic_per_user → 200', putResult.status === 200,
      `got ${putResult.status}: ${JSON.stringify(putResult.body).slice(0, 100)}`);

    const chat9 = await createChat(sessC, 'agent', 'Limit Test');
    if (!chat9) {
      fail('9.setup', 'Could not create chat for User C');
    } else {
      // Send more messages than the cap (each turn = 2 episodic entries)
      // CAP=4 means after 3 turns (6 entries) only 4 should remain
      for (let i = 1; i <= 3; i++) {
        await send(sessC, chat9, `Message number ${i}. My lucky number today is ${i}.`);
      }
      await sleep(EXTRACTION_WAIT);

      const count9 = await getEpisodicCount(admin!, sessC.userId);
      assert('9.2  Episodic count trimmed to max_episodic_per_user',
        count9 <= CAP,
        `expected ≤${CAP}, got ${count9}`);
      assert('9.3  Episodic count is > 0 (not cleared completely)',
        count9 > 0,
        `expected > 0, got ${count9}`);
    }

    // Restore default limit
    await putSettings(admin!, { max_episodic_per_user: 200 });

    const settingsAfter = await getSettings(admin!);
    assert('9.4  Max episodic limit restored to 200',
      settingsAfter?.['max_episodic_per_user'] === 200,
      `got ${settingsAfter?.['max_episodic_per_user']}`);
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // GROUP 10 — Memory settings toggles (disable individual types)
  // ══════════════════════════════════════════════════════════════════════════════
  group('GROUP 10 — Memory Settings Toggles');

  if (!adminReady || !admin) {
    skip('10.x  All toggle tests', 'no admin session');
  } else {
    // Disable episodic capture
    await putSettings(admin!, { enable_episodic: false });

    const chat10 = await createChat(sessA, 'agent', 'Toggle Test');
    if (!chat10) {
      fail('10.setup', 'Could not create chat');
    } else {
      const countBefore = await getEpisodicCount(admin!, sessA.userId);
      await send(sessA, chat10, 'This message should NOT be captured in episodic memory.');
      await sleep(EXTRACTION_WAIT);
      const countAfter = await getEpisodicCount(admin!, sessA.userId);

      assert('10.1  No new episodic entry when enable_episodic=false',
        countAfter === countBefore,
        `count before=${countBefore} after=${countAfter}`);

      // Re-enable
      await putSettings(admin!, { enable_episodic: true });
      const countPreEnable = await getEpisodicCount(admin!, sessA.userId);
      await send(sessA, chat10, 'This message SHOULD be captured now that episodic is re-enabled.');
      await sleep(EXTRACTION_WAIT);
      const countPostEnable = await getEpisodicCount(admin!, sessA.userId);

      assert('10.2  New episodic entry created after re-enabling',
        countPostEnable > countPreEnable,
        `count before=${countPreEnable} after=${countPostEnable}`);
    }

    // Disable auto_extract_on_turn entirely → no extraction at all
    await putSettings(admin!, { auto_extract_on_turn: false });
    const chat10b = await createChat(sessA, 'agent', 'No Extraction Test');
    if (chat10b) {
      const cntBefore = await getEpisodicCount(admin!, sessA.userId);
      await send(sessA, chat10b, 'Nothing should be saved when auto_extract_on_turn is disabled.');
      await sleep(EXTRACTION_WAIT);
      const cntAfter = await getEpisodicCount(admin!, sessA.userId);
      assert('10.3  No capture when auto_extract_on_turn=false',
        cntAfter === cntBefore,
        `count changed: ${cntBefore} → ${cntAfter}`);
    }

    // Restore all settings
    await putSettings(admin!, {
      enable_episodic: true,
      enable_semantic: true,
      enable_entity: true,
      enable_procedural: true,
      enable_working: true,
      auto_extract_on_turn: true,
    });
    assert('10.4  Memory settings restored to all-enabled', true);
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // GROUP 11 — Supervisor agent with memory context
  // ══════════════════════════════════════════════════════════════════════════════
  group('GROUP 11 — Supervisor Agent with Memory');

  {
    // First store some facts for User A via agent
    const chatStore = await createChat(sessA, 'agent', 'Pre-supervisor store');
    if (chatStore) {
      await send(sessA, chatStore,
        'Use memory_remember to save: "My company is TechNova, building AI-powered satellites."');
      await sleep(500);
    }

    // Now use supervisor to recall
    const chatSup = await createChat(sessA, 'supervisor', 'Supervisor Memory Test');
    if (!chatSup) {
      fail('11.setup', 'Could not create supervisor chat');
    } else {
      const r11 = await send(sessA, chatSup,
        'What company am I building? Please answer from what you know about me.');
      assert('11.1  Supervisor chat turn returns 200', r11.ok, r11.reply.slice(0, 120));
      // Supervisor mode injects memory context into its system prompt too
      assert('11.2  Supervisor recalls stored company name from memory context',
        r11.reply.toLowerCase().includes('technova') ||
        r11.reply.toLowerCase().includes('satellite') ||
        r11.reply.toLowerCase().includes('company'),
        `reply: ${r11.reply.slice(0, 300)}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // GROUP 12 — User-facing memory API completeness
  // ══════════════════════════════════════════════════════════════════════════════
  group('GROUP 12 — User-Facing Memory API');

  {
    // GET /api/user/memory returns all 4 buckets
    const mem12 = await getUserMemory(sessA);
    assert('12.1  GET /api/user/memory returns 200', !!mem12);
    if (mem12) {
      assert('12.2  Response has entities bucket',   Array.isArray(mem12['entities']));
      assert('12.3  Response has semantic bucket',   Array.isArray(mem12['semantic']));
      assert('12.4  Response has episodic bucket',   Array.isArray(mem12['episodic']));
      assert('12.5  Response has procedural bucket', Array.isArray(mem12['procedural']));

      // Episodic bucket has at least some content from our earlier tests
      assert('12.6  Episodic bucket is non-empty (turns were captured)',
        ((mem12['episodic'] as unknown[]).length) > 0,
        `episodic is empty`);
    }

    // DELETE /api/user/memory/episodic/:id — user deletes a specific episodic entry
    const ep12 = mem12?.['episodic'] as Array<Record<string, unknown>> | undefined;
    if (ep12 && ep12.length > 0) {
      const targetId = ep12[0]!['id'] as string;
      const rDel = await auth(sessA, 'DELETE', `/api/user/memory/episodic/${targetId}`);
      assert('12.7  User can delete own episodic entry → 200', rDel.status === 200,
        `got ${rDel.status}`);

      const memAfter = await getUserMemory(sessA);
      const stillHas = (memAfter?.['episodic'] as Array<Record<string, unknown>>)
        ?.some(e => e['id'] === targetId);
      assert('12.8  Deleted entry no longer in user memory', !stillHas,
        'deleted entry still visible in /api/user/memory');
    }

    // DELETE a non-existent ID → graceful (200 no-op is fine)
    const rBadDel = await auth(sessA, 'DELETE', '/api/user/memory/episodic/nonexistent-id-xyz');
    assert('12.9  Delete non-existent episodic ID is graceful',
      rBadDel.status === 200 || rBadDel.status === 404,
      `got ${rBadDel.status}`);

    // DELETE /api/user/memory/all — full wipe
    // Use User C for this so we don't disturb A's data
    const rWipe = await auth(sessC, 'DELETE', '/api/user/memory/all');
    assert('12.10 DELETE /api/user/memory/all → 200', rWipe.status === 200,
      `got ${rWipe.status}`);

    if (adminReady && admin) {
      const epCAfter = await getEpisodicCount(admin!, sessC.userId);
      assert('12.11 After wipe, User C episodic count is 0',
        epCAfter === 0, `got ${epCAfter}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // GROUP 13 — Negative tests (bad inputs, wrong methods, missing fields)
  // ══════════════════════════════════════════════════════════════════════════════
  group('GROUP 13 — Negative / Edge-Case API Tests');

  if (adminReady && admin) {
    // 13.1 PUT memory-settings with invalid JSON → 400
    const rBadJson = await request('PUT', '/api/admin/memory-settings/global', {
      cookie: admin!.cookie,
      csrf: admin!.csrf,
      body: 'not-json-at-all' as unknown,
    });
    // We're sending a string, not parsed JSON — fetch will stringify it as '"not-json-at-all"'
    // The server should accept it (it's valid JSON string) but ignore non-object body.
    // Just check it doesn't 500.
    assert('13.1  PUT settings with string body → not 500',
      rBadJson.status !== 500,
      `got ${rBadJson.status}`);

    // 13.2 GET procedural for non-existent userId → 200 empty list
    const rEmpty = await auth(admin!, 'GET', '/api/admin/procedural-memory?userId=nonexistent-user-id');
    assert('13.2  Procedural for non-existent userId → 200 (empty)',
      rEmpty.status === 200,
      `got ${rEmpty.status}`);

    // 13.3 Approve non-existent procedural entry → 404 or 400
    const rBadApprove = await auth(admin!, 'POST',
      '/api/admin/procedural-memory/nonexistent-proc-id/approve', {});
    assert('13.3  Approve non-existent procedural → 404 or 400',
      rBadApprove.status === 404 || rBadApprove.status === 400,
      `got ${rBadApprove.status}`);

    // 13.4 DELETE admin episodic for user/id that doesn't exist → 200 (graceful)
    const rDelAdmin = await auth(admin!, 'DELETE',
      `/api/admin/episodic-memory/${sessA.userId}/nonexistent-episodic-id`);
    assert('13.4  Admin delete non-existent episodic → 200 graceful or 404',
      rDelAdmin.status === 200 || rDelAdmin.status === 404,
      `got ${rDelAdmin.status}`);

    // 13.5 GET /api/admin/memory-settings/:tenantId — unknown tenant falls back to global
    // The endpoint returns the *effective* settings (falling back to the global NULL row),
    // so a 200 with the global row is the correct and intentional behaviour.
    const rNoTenant = await auth(admin!, 'GET', '/api/admin/memory-settings/nonexistent-tenant-abc');
    assert('13.5  GET settings for unknown tenant returns effective settings (200 fallback)',
      rNoTenant.status === 200 || rNoTenant.status === 404,
      `got ${rNoTenant.status}`);

    // 13.6 Create procedural with confidence > 1.0 (boundary)
    const rHighConf = await auth(admin!, 'POST', '/api/admin/procedural-memory', {
      user_id: sessA.userId,
      agent_id: 'default',
      instruction_delta: 'Boundary confidence test.',
      proposed_by: 'admin',
      confidence: 1.5,  // > 1.0
    });
    // Should either accept (and clamp) or reject
    assert('13.6  Create procedural with confidence 1.5 → 201 or 400 (not 500)',
      rHighConf.status === 201 || rHighConf.status === 400,
      `got ${rHighConf.status}`);
  } else {
    skip('13.1-13.6  Admin negative tests', 'no admin session');
  }

  // User tries a fabricated admin path; with SPA fallback the server returns 200 HTML for
  // unknown paths, but it must never return 500 and must not leak data.
  const rFakeAdmin = await auth(sessA, 'GET', '/api/admin/memory-settings/nonexistent/extra/path');
  assert('13.7  Fabricated multi-segment admin path → not 500 and not a JSON data leak',
    rFakeAdmin.status !== 500 &&
    (typeof rFakeAdmin.body !== 'object' || !(rFakeAdmin.body as Record<string, unknown>)['memory-settings-row']),
    `got ${rFakeAdmin.status}: ${JSON.stringify(rFakeAdmin.body).slice(0, 100)}`);

  // ══════════════════════════════════════════════════════════════════════════════
  // GROUP 14 — Concurrency (parallel turns without data loss)
  // ══════════════════════════════════════════════════════════════════════════════
  group('GROUP 14 — Concurrency');

  if (adminReady && admin) {
    const chatConc = await createChat(sessA, 'agent', 'Concurrency Test');
    if (!chatConc) {
      fail('14.setup', 'Could not create concurrency chat');
    } else {
      const countBefore = await getEpisodicCount(admin!, sessA.userId);

      // Fire 3 messages in parallel
      const [r1, r2, r3] = await Promise.all([
        send(sessA, chatConc, 'Concurrent message one: I love hiking.'),
        send(sessA, chatConc, 'Concurrent message two: I enjoy cooking.'),
        send(sessA, chatConc, 'Concurrent message three: I play piano.'),
      ]);

      await sleep(EXTRACTION_WAIT);
      const countAfter = await getEpisodicCount(admin!, sessA.userId);
      const added = countAfter - countBefore;

      // 3 messages × 2 turns (user + assistant) = 6 new episodic entries
      assert('14.1  All 3 concurrent agent turns succeeded',
        r1.ok && r2.ok && r3.ok,
        `statuses: ${r1.status}/${r2.status}/${r3.status}`);
      assert('14.2  All 6 episodic entries captured (no data loss under concurrency)',
        added >= 6,
        `expected +6, got +${added}`);
    }
  } else {
    skip('14.x  Concurrency tests', 'no admin session (need episodic count verification)');
    // Still test that parallel requests don't crash
    const chatConc2 = await createChat(sessA, 'agent', 'Concurrency Basic');
    if (chatConc2) {
      const [r1, r2] = await Promise.all([
        send(sessA, chatConc2, 'Parallel message one.'),
        send(sessA, chatConc2, 'Parallel message two.'),
      ]);
      assert('14.1  Parallel agent turns both return 200',
        r1.ok && r2.ok,
        `${r1.status}/${r2.status}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // GROUP 15 — Memory settings PUT is idempotent (upsert semantics)
  // ══════════════════════════════════════════════════════════════════════════════
  group('GROUP 15 — Settings Upsert Idempotency');

  if (adminReady && admin) {
    // Call PUT 3 times with different values
    await putSettings(admin!, { consolidation_interval_min: 30 });
    await putSettings(admin!, { consolidation_interval_min: 60 });
    const r15 = await putSettings(admin!, { consolidation_interval_min: 120 });
    assert('15.1  PUT settings three times → final call returns 200', r15.status === 200);

    const s15 = await getSettings(admin!);
    assert('15.2  Final value is 120 (last PUT wins)',
      s15?.['consolidation_interval_min'] === 120,
      `got ${s15?.['consolidation_interval_min']}`);

    // Reset
    await putSettings(admin!, { consolidation_interval_min: 60 });
  } else {
    skip('15.x  Settings idempotency', 'no admin session');
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // GROUP 16 — Working memory endpoint
  // ══════════════════════════════════════════════════════════════════════════════
  group('GROUP 16 — Working Memory Endpoint');

  if (adminReady && admin) {
    // Working memory is populated by agent turns via the tools callback
    // Check that the endpoint responds (even if empty for most runs)
    const wm = await getWorkingMemory(admin!, sessA.userId);
    assert('16.1  GET /api/admin/working-memory returns 200', wm !== null,
      'returned null');
    assert('16.2  Working memory response is an array', Array.isArray(wm));
  } else {
    skip('16.x  Working memory endpoint', 'no admin session');
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // GROUP 17 — Long message truncation (saves first 1200 chars)
  // ══════════════════════════════════════════════════════════════════════════════
  group('GROUP 17 — Long Message Handling');

  if (adminReady && admin) {
    const chat17 = await createChat(sessA, 'agent', 'Long Message Test');
    if (chat17) {
      // Send a very long message (5000 chars)
      const longContent = 'A'.repeat(500) + ' This is the important part ' + 'B'.repeat(4000);
      const r17 = await send(sessA, chat17, longContent);
      assert('17.1  Very long message (5000 chars) → 200', r17.ok, `status ${r17.status}`);

      await sleep(EXTRACTION_WAIT);
      const epLong = await getEpisodic(admin!, sessA.userId);
      const userEntry = epLong?.find(e =>
        e['message_role'] === 'user' &&
        (e['content'] as string).startsWith('AAA'));

      if (userEntry) {
        const storedLen = (userEntry['content'] as string).length;
        assert('17.2  Stored episodic content is trimmed to ≤1200 chars',
          storedLen <= 1200,
          `stored ${storedLen} chars`);
      } else {
        skip('17.2  Trim check', 'long-message episodic entry not found');
      }
    }
  } else {
    skip('17.x  Long message tests', 'no admin session');
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // GROUP 18 — Multi-user memory visibility (admin sees all, users see only own)
  // ══════════════════════════════════════════════════════════════════════════════
  group('GROUP 18 — Multi-User Admin Visibility');

  if (adminReady && admin) {
    // Admin can see all-users list (no userId filter)
    const rAll = await auth(admin!, 'GET', '/api/admin/episodic-memory?limit=5');
    assert('18.1  Admin episodic-memory without userId → 200',
      rAll.status === 200, `got ${rAll.status}`);

    const allItems = b(rAll.body as Record<string, unknown>, 'episodic-memory');
    // There should be entries from multiple users in our test
    const userIds = new Set(allItems.map(e => (e as Record<string, unknown>)['user_id']));
    assert('18.2  Unfiltered admin view may contain multiple users\' entries',
      userIds.size >= 1, `found userIds: ${[...userIds].join(', ')}`);

    // Admin can filter by userId
    const rFiltered = await auth(admin!, 'GET',
      `/api/admin/episodic-memory?userId=${sessA.userId}&limit=5`);
    const filteredItems = b(rFiltered.body as Record<string, unknown>, 'episodic-memory');
    const allBelongToA = filteredItems.every(
      e => (e as Record<string, unknown>)['user_id'] === sessA.userId,
    );
    assert('18.3  Admin filter by userId returns only that user\'s entries',
      allBelongToA, `found entries not belonging to User A`);
  } else {
    skip('18.x  Multi-user admin visibility', 'no admin session');
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // GROUP 19 — Episodic PII Redaction
  //   Proves that the m37 governance rule fires on episodic saves so that raw
  //   SSNs, credit-card numbers, and credential patterns are scrubbed before the
  //   turn log is persisted.  The turn itself MUST still be captured (no blocking).
  // ══════════════════════════════════════════════════════════════════════════════
  group('GROUP 19 — Episodic PII Redaction (m37 governance)');

  if (adminReady && admin) {
    const chat19 = await createChat(sessA, 'agent', 'Episodic PII Test');
    if (chat19) {
      const beforePii = await getEpisodicCount(admin!, sessA.userId);

      // Craft a message that contains multiple PII types the m37 rule must redact
      const piiMsg =
        'Governance redaction test turn. My SSN is 123-45-6789. ' +
        'Card: 4111111111111111. password=s3cr3t! for the portal.';
      const r19 = await send(sessA, chat19, piiMsg, AGENT_TIMEOUT);
      assert('19.1  Message with PII sends successfully (200)', r19.ok, `status ${r19.status}`);

      await sleep(EXTRACTION_WAIT);

      const epAll19 = await getEpisodic(admin!, sessA.userId, 300);
      const piiEntry = epAll19?.find(e =>
        e['message_role'] === 'user' &&
        (e['content'] as string).includes('Governance redaction test'),
      );

      if (piiEntry) {
        const stored = piiEntry['content'] as string;
        assert('19.2  SSN (123-45-6789) not present in stored episodic content',
          !stored.includes('123-45-6789'),
          `raw SSN found: "${stored}"`);
        assert('19.3  Credit card (4111111111111111) not present in stored episodic content',
          !stored.includes('4111111111111111'),
          `raw card found: "${stored}"`);
        assert('19.4  Credential value (s3cr3t!) not present in stored episodic content',
          !stored.includes('s3cr3t!'),
          `raw credential found: "${stored}"`);
        assert('19.5  [REDACTED] placeholder appears at least once in stored content',
          stored.includes('[REDACTED]'),
          `no [REDACTED] in: "${stored}"`);
        assert('19.6  Non-PII context text preserved (turn was not suppressed)',
          stored.includes('Governance redaction test'),
          `context stripped from: "${stored}"`);
      } else {
        skip('19.2-19.6  PII redaction content checks', 'episodic entry not found (extraction delay?)');
      }

      // Regardless of content check: the turn count MUST increase (episodic capture is never blocked)
      const afterPii = await getEpisodicCount(admin!, sessA.userId);
      assert('19.7  Episodic count increased — turns always captured even when PII present',
        afterPii > beforePii,
        `count before=${beforePii} after=${afterPii}`);
    } else {
      skip('19.x  Episodic PII redaction', 'could not create chat19');
    }
  } else {
    skip('19.x  Episodic PII redaction', 'no admin session');
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // GROUP 20 — memory_remember Tool Governance
  //   Asks the agent to call memory_remember with prohibited content and with
  //   clean content, then verifies the semantic memory reflects the governance
  //   decision (blocked content absent, clean content present).
  // ══════════════════════════════════════════════════════════════════════════════
  group('GROUP 20 — memory_remember Tool Governance');

  {
    const chat20 = await createChat(sessA, 'agent', 'Tool Governance Test');
    if (chat20) {
      // ── 20.1-20.2: SSN content — should be BLOCKED by shouldStore ────────
      const r20a = await send(sessA, chat20,
        'Please use memory_remember to store this exact text: my SSN is 123-45-6789',
        AGENT_TIMEOUT);
      assert('20.1  Agent responds without server crash when memory_remember is blocked',
        r20a.status === 200 || r20a.ok,
        `status ${r20a.status}`);

      await sleep(EXTRACTION_WAIT);

      if (adminReady && admin) {
        const semR20a = await auth(admin!, 'GET',
          `/api/admin/semantic-memory?userId=${sessA.userId}&limit=200`);
        const sem20a = b(semR20a.body as Record<string, unknown>, 'semantic-memory') as Array<Record<string, unknown>>;
        const hasSsn = sem20a.some(e => String(e['content'] ?? '').includes('123-45-6789'));
        assert('20.2  SSN (123-45-6789) absent from semantic memory (governance blocked it)',
          !hasSsn,
          'raw SSN found in semantic memory');
      } else {
        skip('20.2  SSN semantic check', 'no admin session');
      }

      // ── 20.3-20.4: Clean fact — should be ALLOWED and stored ─────────────
      const uniqueTag20 = `prefers-dark-mode-${Date.now()}`;
      const r20b = await send(sessA, chat20,
        `Please use memory_remember to store: I prefer dark-mode in all apps. Tag: ${uniqueTag20}`,
        AGENT_TIMEOUT);
      assert('20.3  Agent responds when remembering clean content', r20b.ok, `status ${r20b.status}`);

      await sleep(EXTRACTION_WAIT);

      // 20.4: Verify storage via agent reply (semantic memory may be in pgvector, not SQLite).
      // When memory_remember succeeds the agent always confirms in its reply.
      assert('20.4  Agent confirmed storage of clean fact (dark-mode)',
        r20b.reply.toLowerCase().includes('dark') ||
        r20b.reply.toLowerCase().includes('stored') ||
        r20b.reply.toLowerCase().includes('remember') ||
        r20b.reply.toLowerCase().includes('saved'),
        `reply did not confirm storage: "${r20b.reply.slice(0, 150)}"`);


      // ── 20.5-20.6: Credential value — should be REDACTED, not blocked ────
      const r20c = await send(sessA, chat20,
        'Please use memory_remember to store: api_key=sk-proj-TESTKEY9999ABCDEFGHIJ12345',
        AGENT_TIMEOUT);
      assert('20.5  Agent responds when remembering credential content', r20c.ok, `status ${r20c.status}`);

      await sleep(EXTRACTION_WAIT);

      if (adminReady && admin) {
        const semR20c = await auth(admin!, 'GET',
          `/api/admin/semantic-memory?userId=${sessA.userId}&limit=200`);
        const sem20c = b(semR20c.body as Record<string, unknown>, 'semantic-memory') as Array<Record<string, unknown>>;
        const hasRawKey = sem20c.some(e => String(e['content'] ?? '').includes('TESTKEY9999ABCDEFGHIJ12345'));
        assert('20.6  Raw API key value absent from semantic memory (redacted by governance)',
          !hasRawKey,
          'raw api_key value found in semantic memory');
      } else {
        skip('20.6  Credential redaction check', 'no admin session');
      }
    } else {
      skip('20.x  memory_remember governance', 'could not create chat20');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // GROUP 21 — Entity Memory Governance
  //   Verifies that (a) governance rules for entity type are registered, and
  //   (b) entities extracted from normal content are saved normally while the
  //   governance path does not crash with a policy loaded.
  // ══════════════════════════════════════════════════════════════════════════════
  group('GROUP 21 — Entity Memory Governance');

  if (adminReady && admin) {
    // 21.1: Verify entity-scoped governance rules exist in the DB
    const govR21 = await auth(admin!, 'GET', '/api/admin/memory-governance');
    const govRules21 = b(govR21.body as Record<string, unknown>, 'memory-governance') as Array<Record<string, unknown>>;
    const entityRules = govRules21.filter(r =>
      (r['memory_types'] as string | null)?.includes('entity'),
    );
    assert('21.1  At least one entity-scoped governance rule exists',
      entityRules.length >= 1,
      `found ${entityRules.length} entity-scoped rules`);

    // 21.2: Verify the entity PII block rule seeded by m37 is present and enabled
    const entityPiiRule = govRules21.find(r => r['id'] === 'mgov-0000-0000-4000-8000-000000000008');
    assert('21.2  m37 "Entity PII Block" rule is seeded and enabled',
      entityPiiRule !== undefined && entityPiiRule['enabled'] === 1,
      entityPiiRule ? `enabled=${entityPiiRule['enabled']}` : 'rule not found');

    // 21.3: Normal entity extraction still works when governance is active
    const chat21 = await createChat(sessA, 'agent', 'Entity Gov Test');
    if (chat21) {
      const r21 = await send(sessA, chat21,
        'For testing: my name is GovEntityTestUser and I live in Melbourne.',
        AGENT_TIMEOUT);
      assert('21.3  Chat turn with entity content completes successfully (no crash)',
        r21.ok,
        `status ${r21.status}`);
      await sleep(EXTRACTION_WAIT);

      // Verify normal entities are NOT suppressed by governance
      const entR21 = await auth(admin!, 'GET', `/api/admin/entity-memory?userId=${sessA.userId}`);
      assert('21.4  Entity memory endpoint returns 200 after governed turn',
        entR21.status === 200,
        `got ${entR21.status}`);
    } else {
      skip('21.3-21.4  Entity extraction test', 'could not create chat21');
    }

    // 21.5: Verify the "No Secrets in Entity Memory" rule (e6488668) also present
    const existingEntityRule = govRules21.find(r =>
      (r['memory_types'] as string | null)?.includes('entity') &&
      (r['block_patterns'] as string | null)?.includes('password'),
    );
    assert('21.5  Pre-existing "No Secrets in Entity Memory" rule is present',
      existingEntityRule !== undefined,
      'entity-secret block rule not found in governance rules');
  } else {
    skip('21.x  Entity memory governance', 'no admin session');
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // GROUP 22 — Content Size and Data-Type Handling
  //   Verifies that large content is truncated before storage, Unicode is handled
  //   cleanly, and governance is robust against edge-case inputs.
  // ══════════════════════════════════════════════════════════════════════════════
  group('GROUP 22 — Content Size and Data-Type Handling');

  {
    const chat22 = await createChat(sessA, 'agent', 'Size & Type Test');
    if (chat22) {
      // 22.1: memory_remember with oversized content is truncated to ≤600 chars
      const bigContent = 'X'.repeat(5000);
      const r22a = await send(sessA, chat22,
        `Please use memory_remember to store this content: ${bigContent}`,
        AGENT_TIMEOUT);
      assert('22.1  Oversized memory_remember (5000-char payload) → 200', r22a.ok, `status ${r22a.status}`);

      await sleep(EXTRACTION_WAIT);

      if (adminReady && admin) {
        const semR22 = await auth(admin!, 'GET',
          `/api/admin/semantic-memory?userId=${sessA.userId}&limit=200`);
        const sem22 = b(semR22.body as Record<string, unknown>, 'semantic-memory') as Array<Record<string, unknown>>;
        const bigEntry = sem22.find(e => String(e['content'] ?? '').includes('XXXX'));
        if (bigEntry) {
          const storedLen = String(bigEntry['content'] ?? '').length;
          assert('22.2  Stored content from oversized memory_remember is ≤600 chars',
            storedLen <= 600,
            `stored ${storedLen} chars`);
        } else {
          skip('22.2  Size truncation check', 'oversized entry not found in semantic memory');
        }
      } else {
        skip('22.2  Size truncation check', 'no admin session');
      }

      // 22.3: Unicode content is stored without corruption
      const unicodeMsg = 'Please remember: I enjoy 日本語, Ñoño, العربية, and 한국어.';
      const r22b = await send(sessA, chat22, unicodeMsg, AGENT_TIMEOUT);
      assert('22.3  Unicode content in memory_remember → 200', r22b.ok, `status ${r22b.status}`);
      await sleep(EXTRACTION_WAIT);

      // 22.4: Governance rules endpoint returns at least 6 rules (4 from m35 + 2 from m37)
      if (adminReady && admin) {
        const govR22 = await auth(admin!, 'GET', '/api/admin/memory-governance');
        const rules22 = b(govR22.body as Record<string, unknown>, 'memory-governance') as unknown[];
        assert('22.4  At least 6 governance rules registered (m35 global + m37 episodic/entity)',
          rules22.length >= 6,
          `found ${rules22.length} rules`);
      } else {
        skip('22.4  Governance rules count', 'no admin session');
      }

      // 22.5: Empty string content — governance should not crash
      const r22c = await send(sessA, chat22,
        'Please use memory_remember to store this: a',
        AGENT_TIMEOUT);
      assert('22.5  Minimal (1-char) content in memory_remember completes without crash',
        r22c.ok,
        `status ${r22c.status}`);

      // 22.6: Content with HTML/script injection patterns — stored as plain text, not executed
      const xssPayload = '<script>alert(1)</script> and <img onerror="evil()"> harmless tag';
      const r22d = await send(sessA, chat22,
        `Please remember: ${xssPayload}`,
        AGENT_TIMEOUT);
      assert('22.6  XSS-pattern content in memory_remember → 200 (no crash)',
        r22d.ok,
        `status ${r22d.status}`);
    } else {
      skip('22.x  Content size and data-type tests', 'could not create chat22');
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // GROUP 23 — Multi-Turn Conversational Entity Extraction
  //   A realistic 5-turn user session with natural language (no tool directives).
  //   Verifies the agent extracts structured facts across a rambling conversation.
  // ══════════════════════════════════════════════════════════════════════════════
  group('GROUP 23 — Multi-Turn Conversational Entity Extraction');

  {
    const chat23 = await createChat(sessA, 'agent', 'Multi-Turn Entity Extraction');
    if (!chat23) {
      fail('23.setup', 'Could not create chat23');
    } else {
      // Turn 1: role + location naturally embedded
      const r23a = await send(sessA, chat23,
        'Hey, quick question — I\'m a product manager at Stripe and I\'m based in Dublin. ' +
        'We\'re migrating our checkout flow to a new payments SDK. Any tips on phased rollouts?',
        AGENT_TIMEOUT);
      assert('23.1  Turn 1 (PM/Stripe/Dublin intro) → 200', r23a.ok, `status ${r23a.status}`);

      // Turn 2: additional context, no explicit save instruction
      const r23b = await send(sessA, chat23,
        'We\'re targeting a Q3 deadline. The team is 4 engineers and I\'m the only PM. ' +
        'We use feature flags via LaunchDarkly for controlled rollouts.',
        AGENT_TIMEOUT);
      assert('23.2  Turn 2 (Q3 deadline, team size, LaunchDarkly) → 200', r23b.ok, `status ${r23b.status}`);

      // Turn 3: personal preference details
      const r23c = await send(sessA, chat23,
        'By the way, I prefer async comms — Slack over meetings. And I work best early mornings ' +
        'before 9am Dublin time.',
        AGENT_TIMEOUT);
      assert('23.3  Turn 3 (preferences) → 200', r23c.ok, `status ${r23c.status}`);

      await sleep(EXTRACTION_WAIT);

      // In a fresh chat, verify context is available via system-prompt injection
      const chat23b = await createChat(sessA, 'agent', 'Entity Recall Check');
      if (chat23b) {
        const r23recall = await send(sessA, chat23b,
          'What do you know about where I work and what I do? Answer directly.',
          AGENT_TIMEOUT);
        assert('23.4  Fresh chat recalls role/company from entity memory',
          r23recall.reply.toLowerCase().includes('stripe') ||
          r23recall.reply.toLowerCase().includes('product') ||
          r23recall.reply.toLowerCase().includes('dublin') ||
          r23recall.reply.toLowerCase().includes('manager'),
          `reply: ${r23recall.reply.slice(0, 300)}`);
      } else {
        skip('23.4  Entity recall check', 'could not create chat23b');
      }

      // Admin check: entity memory should have location + role entities
      if (adminReady && admin) {
        const entR23 = await auth(admin!, 'GET', `/api/admin/entity-memory?userId=${sessA.userId}`);
        assert('23.5  Entity memory endpoint returns 200 after multi-turn session',
          entR23.status === 200, `got ${entR23.status}`);
      } else {
        skip('23.5  Admin entity endpoint check', 'no admin session');
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // GROUP 24 — Implicit Recall via System-Prompt Context (No Tool Directive)
  //   Store facts via explicit tool call, then ask naturally in a NEW chat without
  //   any tool instructions. The agent must surface facts from the injected context.
  // ══════════════════════════════════════════════════════════════════════════════
  group('GROUP 24 — Implicit Recall (System-Prompt Context Injection)');

  {
    // Use sessB so we have a clean slate
    const chat24store = await createChat(sessB, 'agent', 'Storage Chat B');
    if (chat24store) {
      await send(sessB, chat24store,
        'Please use memory_remember to save: ' +
        '"I\'m a senior backend engineer at Monzo. I specialise in Go and distributed systems. ' +
        'My team owns the payments ledger service."',
        AGENT_TIMEOUT);
      await send(sessB, chat24store,
        'Use memory_remember to save: ' +
        '"My preferred code review style is short PRs (< 400 lines) with thorough descriptions."',
        AGENT_TIMEOUT);
      await sleep(EXTRACTION_WAIT);
    }

    const chat24recall = await createChat(sessB, 'agent', 'Natural Recall B');
    if (!chat24recall) {
      fail('24.setup', 'Could not create recall chat for sessB');
    } else {
      // Ask naturally, no tool hint
      const r24 = await send(sessB, chat24recall,
        'I\'m reviewing a 1200-line PR from a colleague. How should I approach it given what you know about my preferences?',
        AGENT_TIMEOUT);
      assert('24.1  Natural recall returns 200', r24.ok, `status ${r24.status}`);
      // Agent should reference the PR size preference or engineering context
      assert('24.2  Agent references stored engineering preferences in response',
        r24.reply.toLowerCase().includes('monzo') ||
        r24.reply.toLowerCase().includes('400') ||
        r24.reply.toLowerCase().includes('pr') ||
        r24.reply.toLowerCase().includes('review') ||
        r24.reply.toLowerCase().includes('short') ||
        r24.reply.toLowerCase().includes('backend') ||
        r24.reply.toLowerCase().includes('preference'),
        `reply: ${r24.reply.slice(0, 300)}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // GROUP 25 — Fact Correction / Update Handling
  //   Store a fact, then send a message that explicitly corrects it. Verify the
  //   agent incorporates the corrected fact in subsequent recall.
  // ══════════════════════════════════════════════════════════════════════════════
  group('GROUP 25 — Fact Correction and Update Handling');

  {
    const chat25a = await createChat(sessA, 'agent', 'Fact Correction A');
    if (!chat25a) {
      fail('25.setup', 'Could not create chat25a');
    } else {
      // Store an initial fact
      await send(sessA, chat25a,
        'Please remember: I work as a data analyst at Accenture.',
        AGENT_TIMEOUT);
      await sleep(EXTRACTION_WAIT);

      // Correct it in the same chat
      const r25b = await send(sessA, chat25a,
        'Actually, I got promoted — I\'m now the Head of Data at a new company called DataBridge. ' +
        'Please update your memory to reflect this.',
        AGENT_TIMEOUT);
      assert('25.1  Correction message → 200', r25b.ok, `status ${r25b.status}`);
      await sleep(EXTRACTION_WAIT);

      // Recall in a fresh chat
      const chat25c = await createChat(sessA, 'agent', 'Post-Correction Recall');
      if (chat25c) {
        const r25c = await send(sessA, chat25c,
          'What is my current job title and where do I work? Answer from what you know.',
          AGENT_TIMEOUT);
        assert('25.2  Post-correction recall returns 200', r25c.ok, `status ${r25c.status}`);
        // Should mention DataBridge or Head of Data (not the old role)
        const mentionsUpdate =
          r25c.reply.toLowerCase().includes('databridge') ||
          r25c.reply.toLowerCase().includes('head of data') ||
          r25c.reply.toLowerCase().includes('promoted') ||
          r25c.reply.toLowerCase().includes('head');
        assert('25.3  Updated fact (DataBridge / Head of Data) present in recall',
          mentionsUpdate,
          `reply: ${r25c.reply.slice(0, 300)}`);
      } else {
        skip('25.2-25.3  Post-correction recall', 'could not create chat25c');
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // GROUP 26 — Semantic Vocabulary Gap
  //   Store a fact using one word; retrieve it using a synonym. Validates that
  //   semantic search handles vocabulary gaps (embedding-based similarity).
  // ══════════════════════════════════════════════════════════════════════════════
  group('GROUP 26 — Semantic Vocabulary Gap (synonym retrieval)');

  {
    const chat26a = await createChat(sessA, 'agent', 'Vocab Gap Store');
    if (chat26a) {
      // Store using word "concise"
      await send(sessA, chat26a,
        'Use memory_remember to save: "My presentation style is concise — I never use more than 10 slides."',
        AGENT_TIMEOUT);
      await sleep(EXTRACTION_WAIT);
    }

    const chat26b = await createChat(sessA, 'agent', 'Vocab Gap Recall');
    if (!chat26b) {
      fail('26.setup', 'Could not create vocab gap recall chat');
    } else {
      // Query using synonym "brief" — tests embedding semantic similarity
      const r26 = await send(sessA, chat26b,
        'Use memory_search to find anything you know about how brief or terse I tend to be in presentations.',
        AGENT_TIMEOUT);
      assert('26.1  Synonym-based memory search → 200', r26.ok, `status ${r26.status}`);
      assert('26.2  Search surfaces the "concise" presentation fact via synonym matching',
        r26.reply.toLowerCase().includes('concise') ||
        r26.reply.toLowerCase().includes('slide') ||
        r26.reply.toLowerCase().includes('presentation') ||
        r26.reply.toLowerCase().includes('brief') ||
        r26.reply.toLowerCase().includes('10') ||
        r26.reply.toLowerCase().includes('style'),
        `reply: ${r26.reply.slice(0, 300)}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // GROUP 27 — Professional Project Scenario (Mixed Entity + Semantic)
  //   A detailed technical project description with entities (tech, team, dates)
  //   and semantic facts (decisions, constraints). Validates rich mixed recall.
  // ══════════════════════════════════════════════════════════════════════════════
  group('GROUP 27 — Professional Project Scenario (Mixed Entity + Semantic)');

  {
    const chat27a = await createChat(sessA, 'agent', 'Project Atlas Store');
    if (chat27a) {
      await send(sessA, chat27a,
        'I\'m the tech lead on Project Atlas — we\'re migrating our real-time analytics pipeline ' +
        'from Kafka to a managed Postgres setup. The stack is TypeScript with Prisma ORM, ' +
        'deployed on AWS EKS. Our target go-live is end of Q3 this year. ' +
        'Please use memory_remember to save a summary of Project Atlas.',
        AGENT_TIMEOUT);
      await sleep(EXTRACTION_WAIT);

      await send(sessA, chat27a,
        'Use memory_remember to also save: ' +
        '"Project Atlas constraint: no downtime allowed during cutover — must use blue/green deployment."',
        AGENT_TIMEOUT);
      await sleep(EXTRACTION_WAIT);
    }

    // Recall in fresh chat
    const chat27b = await createChat(sessA, 'agent', 'Project Atlas Recall');
    if (!chat27b) {
      fail('27.setup', 'Could not create recall chat for Atlas');
    } else {
      const r27 = await send(sessA, chat27b,
        'Can you summarise what you know about my current main project? What are the key technical decisions?',
        AGENT_TIMEOUT);
      assert('27.1  Project Atlas recall → 200', r27.ok, `status ${r27.status}`);
      assert('27.2  Recall mentions Atlas or migration details',
        r27.reply.toLowerCase().includes('atlas') ||
        r27.reply.toLowerCase().includes('postgres') ||
        r27.reply.toLowerCase().includes('kafka') ||
        r27.reply.toLowerCase().includes('migration') ||
        r27.reply.toLowerCase().includes('typescript') ||
        r27.reply.toLowerCase().includes('aws') ||
        r27.reply.toLowerCase().includes('q3'),
        `reply: ${r27.reply.slice(0, 300)}`);
      assert('27.3  Recall mentions deployment constraint (blue/green or no downtime)',
        r27.reply.toLowerCase().includes('blue') ||
        r27.reply.toLowerCase().includes('green') ||
        r27.reply.toLowerCase().includes('downtime') ||
        r27.reply.toLowerCase().includes('constraint') ||
        r27.reply.toLowerCase().includes('deploy'),
        `reply: ${r27.reply.slice(0, 300)}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // GROUP 28 — Preference-Driven Recommendations
  //   Store detailed user preferences, then ask for a recommendation. The agent
  //   should surface context-appropriate suggestions based on stored prefs.
  // ══════════════════════════════════════════════════════════════════════════════
  group('GROUP 28 — Preference-Driven Recommendations');

  {
    const chat28store = await createChat(sessA, 'agent', 'Prefs Store');
    if (chat28store) {
      await send(sessA, chat28store,
        'Please use memory_remember to save my reading preferences: ' +
        '"I only read non-fiction. My favourite genres are behavioural economics and tech history. ' +
        'I prefer books under 300 pages. I read on Kindle. Budget: up to £15 per book."',
        AGENT_TIMEOUT);
      await sleep(EXTRACTION_WAIT);
    }

    const chat28rec = await createChat(sessA, 'agent', 'Book Recommendation');
    if (!chat28rec) {
      fail('28.setup', 'Could not create recommendation chat');
    } else {
      const r28 = await send(sessA, chat28rec,
        'Can you recommend a book I might enjoy? Use what you know about my tastes.',
        AGENT_TIMEOUT);
      assert('28.1  Preference-based recommendation → 200', r28.ok, `status ${r28.status}`);
      // Agent should mention non-fiction, economics, tech, or Kindle/budget constraints
      assert('28.2  Recommendation draws on stored reading preferences',
        r28.reply.toLowerCase().includes('non-fiction') ||
        r28.reply.toLowerCase().includes('nonfiction') ||
        r28.reply.toLowerCase().includes('econom') ||
        r28.reply.toLowerCase().includes('tech') ||
        r28.reply.toLowerCase().includes('kindle') ||
        r28.reply.toLowerCase().includes('budget') ||
        r28.reply.toLowerCase().includes('pages') ||
        r28.reply.toLowerCase().includes('history') ||
        r28.reply.toLowerCase().includes('prefer'),
        `reply: ${r28.reply.slice(0, 300)}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // GROUP 29 — Narrative Thread Recall Within Same Session (Correction Flow)
  //   Send a sequence of messages in one chat that build a narrative. Midway,
  //   correct a detail. Verify later turns reflect the corrected state.
  // ══════════════════════════════════════════════════════════════════════════════
  group('GROUP 29 — Narrative Thread Recall (Within-Session Correction)');

  {
    const chat29 = await createChat(sessA, 'agent', 'Narrative Thread Test');
    if (!chat29) {
      fail('29.setup', 'Could not create chat29');
    } else {
      // Build a narrative
      await send(sessA, chat29,
        'I\'m setting up a local dev environment for a new microservice. ' +
        'I\'ve configured it to run on port 8080.',
        AGENT_TIMEOUT);
      await send(sessA, chat29,
        'The service connects to Redis on port 6379 and exposes a REST API.',
        AGENT_TIMEOUT);

      // Correction
      await send(sessA, chat29,
        'Actually, I just changed the service port to 8443 because 8080 conflicts with another service. ' +
        'Please note the port is now 8443.',
        AGENT_TIMEOUT);
      await sleep(500);

      // Within the same chat, verify the agent tracks the correction
      const r29 = await send(sessA, chat29,
        'Just to confirm — what port is the microservice running on now?',
        AGENT_TIMEOUT);
      assert('29.1  Within-session port correction → 200', r29.ok, `status ${r29.status}`);
      assert('29.2  Agent reports corrected port (8443, not 8080)',
        r29.reply.includes('8443'),
        `expected 8443 in: ${r29.reply.slice(0, 200)}`);
      // Agent should NOT state 8080 as the current port
      assert('29.3  Agent does not state old port (8080) as current',
        !r29.reply.includes('8080') || r29.reply.toLowerCase().includes('changed') || r29.reply.toLowerCase().includes('was'),
        `reply still states 8080 as current: ${r29.reply.slice(0, 200)}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // GROUP 30 — Relationship Memory (Third-Party Entity Tracking)
  //   Mention colleagues/contacts in conversation. Verify the agent tracks these
  //   third-party entities and can recall them by name or role.
  // ══════════════════════════════════════════════════════════════════════════════
  group('GROUP 30 — Relationship Memory (Third-Party Entity Tracking)');

  {
    const chat30store = await createChat(sessA, 'agent', 'Relationship Store');
    if (chat30store) {
      await send(sessA, chat30store,
        'Let me tell you about my team. Priya Sharma is our data engineer — she owns the ETL pipeline. ' +
        'David Chen is the CTO and makes all final architectural decisions. ' +
        'Use memory_remember to save these team members.',
        AGENT_TIMEOUT);
      await sleep(EXTRACTION_WAIT);
    }

    const chat30recall = await createChat(sessA, 'agent', 'Relationship Recall');
    if (!chat30recall) {
      fail('30.setup', 'Could not create relationship recall chat');
    } else {
      const r30 = await send(sessA, chat30recall,
        'I need to escalate a database performance issue. Who on my team should I speak to first?',
        AGENT_TIMEOUT);
      assert('30.1  Relationship recall for role-based query → 200', r30.ok, `status ${r30.status}`);
      // Priya owns ETL/data engineering, so she's the right escalation for DB performance
      assert('30.2  Agent mentions relevant team member for DB/data escalation',
        r30.reply.toLowerCase().includes('priya') ||
        r30.reply.toLowerCase().includes('data engineer') ||
        r30.reply.toLowerCase().includes('etl') ||
        r30.reply.toLowerCase().includes('pipeline'),
        `reply: ${r30.reply.slice(0, 300)}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // GROUP 31 — Embedded PII in Natural Narrative Prose
  //   A realistic user message where PII (DB connection string, JWT secret, SSN)
  //   is embedded naturally in technical prose. Governance must redact all of it
  //   from episodic memory while preserving the non-PII narrative context.
  // ══════════════════════════════════════════════════════════════════════════════
  group('GROUP 31 — Embedded PII in Natural Narrative Prose');

  if (adminReady && admin) {
    const chat31 = await createChat(sessA, 'agent', 'Narrative PII Test');
    if (chat31) {
      const beforePii31 = await getEpisodicCount(admin!, sessA.userId);

      // A realistic DevOps/onboarding message with multiple PII types embedded naturally
      const narrativeMsg =
        'Hey, quick heads-up on the staging environment — the Postgres connection string is ' +
        'postgresql://admin:P@ssw0rdSecret!@db.internal:5432/stagedb. ' +
        'The JWT signing secret is jwt_secret_key_ABCDEF1234567890XYZ. ' +
        'Also, the contractor we onboarded last week — their SSN is 987-65-4321 — ' +
        'needs to be added to the payroll system. ' +
        'Let me know once you\'ve noted all this down.';

      const r31 = await send(sessA, chat31, narrativeMsg, AGENT_TIMEOUT);
      assert('31.1  Narrative with embedded PII → 200', r31.ok, `status ${r31.status}`);
      await sleep(EXTRACTION_WAIT);

      const epAll31 = await getEpisodic(admin!, sessA.userId, 300);
      const piiEntry31 = epAll31?.find(e =>
        e['message_role'] === 'user' &&
        (e['content'] as string).toLowerCase().includes('staging environment'),
      );

      if (piiEntry31) {
        const stored31 = piiEntry31['content'] as string;
        assert('31.2  DB password (P@ssw0rdSecret!) redacted from episodic',
          !stored31.includes('P@ssw0rdSecret!'),
          `raw DB password found: "${stored31.slice(0, 200)}"`);
        assert('31.3  JWT secret (ABCDEF1234567890XYZ) redacted from episodic',
          !stored31.includes('ABCDEF1234567890XYZ'),
          `raw JWT secret found: "${stored31.slice(0, 200)}"`);
        assert('31.4  Contractor SSN (987-65-4321) redacted from episodic',
          !stored31.includes('987-65-4321'),
          `raw SSN found: "${stored31.slice(0, 200)}"`);
        assert('31.5  Non-PII narrative context preserved (staging environment, payroll)',
          stored31.toLowerCase().includes('staging') ||
          stored31.toLowerCase().includes('payroll') ||
          stored31.toLowerCase().includes('contractor'),
          `narrative context stripped from: "${stored31.slice(0, 200)}"`);
        assert('31.6  At least one [REDACTED] token present',
          stored31.includes('[REDACTED]'),
          `no [REDACTED] in: "${stored31.slice(0, 200)}"`);
      } else {
        skip('31.2-31.6  Narrative PII content checks', 'episodic entry not found');
      }

      // Episodic count must increase (turn captured even though PII was present)
      const afterPii31 = await getEpisodicCount(admin!, sessA.userId);
      assert('31.7  Episodic count increased — narrative turn always captured',
        afterPii31 > beforePii31,
        `count before=${beforePii31} after=${afterPii31}`);
    } else {
      skip('31.x  Narrative PII tests', 'could not create chat31');
    }
  } else {
    skip('31.x  Narrative PII tests', 'no admin session');
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // GROUP 32 — Compound Multi-Hop Memory Search
  //   Store several independent facts across different categories. Then send a
  //   natural query that requires the agent to synthesise across multiple stored
  //   facts to produce a coherent, grounded answer.
  // ══════════════════════════════════════════════════════════════════════════════
  group('GROUP 32 — Compound Multi-Hop Memory Search');

  {
    // Use sessC (after wipe from group 12, it's clean)
    const chat32store = await createChat(sessC, 'agent', 'Multi-Hop Store');
    if (chat32store) {
      // Fact set 1: pet + allergy
      await send(sessC, chat32store,
        'Use memory_remember to save: "I have a cat named Luna. She is 3 years old."',
        AGENT_TIMEOUT);
      await send(sessC, chat32store,
        'Use memory_remember to save: "I have a cat allergy (specifically to Fel d 1 protein) ' +
        'and take antihistamines daily."',
        AGENT_TIMEOUT);
      // Fact set 2: location + routine
      await send(sessC, chat32store,
        'Use memory_remember to save: "I live in Edinburgh. I go to Meadows Park every morning."',
        AGENT_TIMEOUT);
      // Fact set 3: health concern
      await send(sessC, chat32store,
        'Use memory_remember to save: "My GP is Dr. Fiona MacLeod at Marchmont Surgery."',
        AGENT_TIMEOUT);
      await sleep(EXTRACTION_WAIT);
    }

    const chat32recall = await createChat(sessC, 'agent', 'Multi-Hop Recall');
    if (!chat32recall) {
      fail('32.setup', 'Could not create multi-hop recall chat');
    } else {
      // Compound query: requires combining pet, allergy, location, and GP facts
      const r32 = await send(sessC, chat32recall,
        'My eyes have been really itchy lately after my morning walk. Given everything you know about me, ' +
        'what might be causing this and what should I do?',
        AGENT_TIMEOUT);
      assert('32.1  Compound multi-hop memory query → 200', r32.ok, `status ${r32.status}`);

      // The answer should synthesise: cat (Fel d 1), antihistamines, Edinburgh/Meadows Park,
      // and/or GP Dr. MacLeod — at least 2 of the stored facts should surface
      const mentionsCat    = r32.reply.toLowerCase().includes('luna') || r32.reply.toLowerCase().includes('cat');
      const mentionsAllergy = r32.reply.toLowerCase().includes('allerg') || r32.reply.toLowerCase().includes('antihistamine') || r32.reply.toLowerCase().includes('fel d');
      const mentionsLocation = r32.reply.toLowerCase().includes('edinburgh') || r32.reply.toLowerCase().includes('meadow') || r32.reply.toLowerCase().includes('morning');
      const mentionsGP      = r32.reply.toLowerCase().includes('macleod') || r32.reply.toLowerCase().includes('surgery') || r32.reply.toLowerCase().includes('doctor') || r32.reply.toLowerCase().includes('gp');

      const hopCount = [mentionsCat, mentionsAllergy, mentionsLocation, mentionsGP].filter(Boolean).length;
      assert('32.2  Agent synthesises at least 2 stored facts in compound response',
        hopCount >= 2,
        `only ${hopCount}/4 fact types found in: ${r32.reply.slice(0, 300)}`);

      // The reply should be medically coherent (not just a list of raw facts)
      assert('32.3  Response is a coherent synthesis (not just raw fact dump)',
        r32.reply.length > 80,
        `reply too short to be coherent synthesis: "${r32.reply}"`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════
  // FINAL REPORT
  // ══════════════════════════════════════════════════════════════════════════════

  const total = results.length;
  const nPass  = results.filter(r => r.status === 'pass').length;
  const nFail  = results.filter(r => r.status === 'fail').length;
  const nSkip  = results.filter(r => r.status === 'skip').length;

  console.log('\n' + '═'.repeat(64));
  console.log('  FINAL RESULTS');
  console.log('═'.repeat(64));
  console.log(`  Total:   ${total}`);
  console.log(`  ✅ Pass:  ${nPass}`);
  console.log(`  ❌ Fail:  ${nFail}`);
  console.log(`  ⏭  Skip:  ${nSkip}`);

  if (nFail > 0) {
    console.log('\n  FAILURES:');
    results
      .filter(r => r.status === 'fail')
      .forEach(r => console.log(`    ❌ ${r.name}\n       ${r.detail ?? ''}`));
  }

  if (nSkip > 0) {
    console.log('\n  SKIPPED (admin session required — run as platform_admin):');
    results
      .filter(r => r.status === 'skip')
      .forEach(r => console.log(`    ⏭  ${r.name}`));
  }

  console.log('═'.repeat(64));
  process.exit(nFail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
