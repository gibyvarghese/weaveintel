#!/usr/bin/env npx tsx
/**
 * Identity Extraction Stress Test
 *
 * Reproduces and gates against the bug where a self-introduction like
 *   "I am a solution architect from Fonterra"
 * is parsed with the organization captured correctly (Fonterra) but the
 * job title ("solution architect") is mistakenly stored as the user's
 * *person* name. Then a later "What's my name?" turn echoes the title
 * back as the user's identity.
 *
 * Black-box via the public HTTP API. Uses a fresh registered user per
 * run for clean memory state. Sends each probe through chat and inspects:
 *   - /api/user/memory.entities for the person/organization rows
 *   - the reply to a follow-up "What is my name?" turn
 *
 * Run:
 *   BASE_URL=http://localhost:3500 \
 *   ADMIN_EMAIL=e2e-memory-test@weaveintel.dev \
 *   ADMIN_PASSWORD='Str0ng!Pass99' \
 *   npx tsx scripts/identity-extraction-stress.ts
 *
 * Model selection:
 *   By default this test does NOT pin a model. The server's LLM router (cost-governor + routing
 *   policy + DB-backed model resolver in chat-send-message.ts) picks the model the same way the
 *   production chat path does. Pass TEST_MODEL='provider/model-id' only when you need to force
 *   a specific endpoint for repro work.
 */

const BASE = process.env.BASE_URL ?? process.env.BASE ?? 'http://localhost:3500';
// Empty string => let the server's LLM router pick. Set TEST_MODEL only to force a model.
const MODEL = process.env.TEST_MODEL ?? process.env.MODEL ?? '';
const USER_PASSWORD = process.env.USER_PASSWORD ?? 'Str0ng!Pass99';
const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS ?? 70_000);
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS ?? 20_000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 500);

const ROLE_TITLE_TOKENS = [
  'architect', 'engineer', 'manager', 'consultant', 'developer', 'designer',
  'analyst', 'scientist', 'lead', 'director', 'officer', 'specialist',
  'researcher', 'doctor', 'nurse', 'teacher', 'professor', 'student',
  'intern', 'associate', 'principal', 'senior', 'junior', 'staff',
  'vp', 'ceo', 'cto', 'cfo', 'coo', 'cmo', 'cio', 'founder', 'partner',
  'product owner', 'product manager', 'project manager', 'program manager',
  'data scientist', 'data engineer', 'software engineer', 'backend engineer',
  'frontend engineer', 'full stack', 'devops', 'sre', 'platform engineer',
  'solution architect', 'enterprise architect', 'cloud architect',
  'head of', 'lead engineer', 'technical lead',
];

type Status = 'pass' | 'fail' | 'warn' | 'skip';
interface TestResult { name: string; status: Status; detail?: string }
interface Session { cookie: string; csrf: string; userId: string; email: string; name: string }
interface HttpResult { status: number; body: unknown }

const results: TestResult[] = [];
const runId = `idex-${Math.random().toString(36).slice(2, 8)}-${Math.random().toString(36).slice(2, 8)}`;

function log(msg = '') { console.log(msg); }
function group(title: string) {
  log(`\n${'─'.repeat(80)}`);
  log(`  ${title}`);
  log('─'.repeat(80));
}
function record(status: Status, name: string, detail?: string) {
  results.push({ name, status, detail });
  const icon = status === 'pass' ? '✅' : status === 'fail' ? '❌' : status === 'warn' ? '⚠️ ' : '⏭ ';
  log(`  ${icon} ${name}`);
  if (detail) log(`     ${detail}`);
}
function text(x: unknown): string { return typeof x === 'string' ? x : JSON.stringify(x ?? ''); }
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function request(method: string, path: string, opts: { body?: unknown; session?: Session } = {}): Promise<HttpResult> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.session) {
    headers.Cookie = opts.session.cookie;
    headers['X-CSRF-Token'] = opts.session.csrf;
  }
  const resp = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const ct = resp.headers.get('content-type') ?? '';
  const body: unknown = ct.includes('application/json') ? await resp.json() : await resp.text();
  return { status: resp.status, body };
}

async function login(email: string, password: string): Promise<Session | null> {
  const resp = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (resp.status !== 200) return null;
  const rawCookie = resp.headers.get('set-cookie') ?? '';
  const token = rawCookie.match(/gw_token=[^;]+/)?.[0];
  if (!token) return null;
  const body = (await resp.json()) as Record<string, unknown>;
  const user = body['user'] as Record<string, unknown> | undefined;
  return {
    cookie: token,
    csrf: String(body['csrfToken'] ?? ''),
    userId: String(user?.['id'] ?? ''),
    email,
    name: String(user?.['name'] ?? email),
  };
}

async function register(email: string, name: string): Promise<Session | null> {
  // Retry register against rate limits. The auth route limits new account creation
  // bursts; spacing + retry keeps the test deterministic without backdoor flags.
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await request('POST', '/api/auth/register', { body: { email, name, password: USER_PASSWORD } });
    if (r.status === 200 || r.status === 201) break;
    // Already-exists or success-shaped response → just try login.
    if (r.status === 409 || r.status === 422) break;
    // Rate-limited or transient → backoff and retry.
    if (r.status === 429 || r.status === 503 || r.status === 0) {
      await sleep(2000 + 1500 * attempt);
      continue;
    }
    // Other failure — fall through to login attempt anyway.
    break;
  }
  return login(email, USER_PASSWORD);
}

async function createChat(session: Session, name: string): Promise<string> {
  const r = await request('POST', '/api/chats', { session, body: { name: `${runId}: ${name}` } });
  if (r.status !== 201) throw new Error(`create chat failed ${r.status}: ${text(r.body).slice(0, 300)}`);
  const chat = (r.body as Record<string, unknown>)['chat'] as Record<string, unknown> | undefined;
  const chatId = String(chat?.['id'] ?? '');
  if (!chatId) throw new Error(`create chat returned no id`);
  // Default mode (agent) — explicit settings call to be safe
  await request('POST', `/api/chats/${chatId}/settings`, {
    session,
    body: { mode: 'direct', enabledTools: [] },
  });
  return chatId;
}

async function send(session: Session, chatId: string, content: string): Promise<{ ok: boolean; status: number; reply: string; error?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), AGENT_TIMEOUT_MS);
  try {
    const resp = await fetch(`${BASE}/api/chats/${chatId}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Cookie: session.cookie,
        'X-CSRF-Token': session.csrf,
      },
      body: JSON.stringify({ content, ...(MODEL ? { model: MODEL } : {}) }),
      signal: ctrl.signal,
    });
    const ct = resp.headers.get('content-type') ?? '';
    const body = ct.includes('application/json') ? ((await resp.json()) as Record<string, unknown>) : { content: await resp.text() };
    const error = body['error'] !== undefined || body['detail'] !== undefined
      ? `${body['error'] ?? ''} :: ${body['detail'] ?? ''}`
      : undefined;
    return {
      ok: resp.status === 200,
      status: resp.status,
      reply: String(body['assistantContent'] ?? body['content'] ?? ''),
      ...(error ? { error } : {}),
    };
  } catch (err) {
    return { ok: false, status: 0, reply: '', error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function sendWithRetry(session: Session, chatId: string, content: string, attempts = 3): Promise<{ ok: boolean; status: number; reply: string; error?: string }> {
  let last = await send(session, chatId, content);
  for (let i = 1; i < attempts && !last.ok; i++) {
    if (last.status !== 503 && last.status !== 429 && last.status !== 422 && last.status !== 0) break;
    await sleep(2000 * i);
    last = await send(session, chatId, content);
  }
  return last;
}

interface EntityRow { entityName: string; entityType: string; facts: Record<string, unknown>; confidence: number; source: string }

async function getEntities(session: Session): Promise<EntityRow[]> {
  const r = await request('GET', '/api/user/memory', { session });
  if (r.status !== 200) return [];
  const ents = (r.body as Record<string, unknown>)['entities'];
  return Array.isArray(ents) ? (ents as EntityRow[]) : [];
}

async function pollEntities(session: Session, predicate: (rows: EntityRow[]) => boolean): Promise<EntityRow[]> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last: EntityRow[] = [];
  while (Date.now() < deadline) {
    last = await getEntities(session);
    if (predicate(last)) return last;
    await sleep(POLL_INTERVAL_MS);
  }
  return last;
}

async function wipeMemory(session: Session) {
  await request('DELETE', '/api/user/memory/all', { session });
}

function isRoleTitle(name: string): boolean {
  const lower = name.toLowerCase().trim();
  if (!lower) return false;
  if (ROLE_TITLE_TOKENS.includes(lower)) return true;
  const tokens = lower.split(/\s+/);
  return tokens.some((t) => ROLE_TITLE_TOKENS.includes(t));
}

interface Probe {
  utterance: string;
  expectOrg?: string | null;       // exact match (case-insensitive). null/undefined = don't check
  expectPerson?: string | null;    // null = no person entity expected; string = expected name
  expectLocation?: string | null;
}

const PROBES: Probe[] = [
  // The original bug
  { utterance: 'I am a solution architect from Fonterra',
    expectOrg: 'Fonterra', expectPerson: null },
  // Common variants
  { utterance: "I'm a backend engineer from Acme",
    expectOrg: 'Acme', expectPerson: null },
  { utterance: 'I work as a product manager at Stripe',
    expectOrg: 'Stripe', expectPerson: null },
  { utterance: 'Hi, I am the VP of Engineering at Snowflake',
    expectOrg: 'Snowflake', expectPerson: null },
  { utterance: 'I am a doctor from Sydney',
    expectOrg: null, expectPerson: null, expectLocation: 'Sydney' },
  // Genuine name + role mixed — must capture name, not the role
  { utterance: 'I am Sarah, a data scientist from Google',
    expectOrg: 'Google', expectPerson: 'Sarah' },
  { utterance: 'My name is John and I am a consultant',
    expectOrg: null, expectPerson: 'John' },
  { utterance: "Call me Mike, I'm a lead designer at Figma",
    expectOrg: 'Figma', expectPerson: 'Mike' },
];

async function runProbe(probe: Probe, index: number) {
  group(`Probe ${index + 1} — "${probe.utterance}"`);

  const email = `idex-${index}-${runId}@weaveintel.dev`;
  const session = await register(email, `Identity Probe ${index}`);
  if (!session) {
    record('fail', `register fresh user (probe ${index + 1})`, `cannot register ${email}`);
    return;
  }
  await wipeMemory(session);

  let chatId: string;
  try {
    chatId = await createChat(session, `probe-${index + 1}`);
  } catch (err) {
    record('fail', `create chat (probe ${index + 1})`, err instanceof Error ? err.message : String(err));
    return;
  }

  const r1 = await sendWithRetry(session, chatId, probe.utterance);
  if (!r1.ok) {
    record('fail', `send self-intro (probe ${index + 1})`, `status=${r1.status} error=${r1.error ?? ''} reply=${r1.reply.slice(0, 200)}`);
    return;
  }

  // Wait until at least one entity is extracted OR the timeout elapses
  const entities = await pollEntities(session, (rows) => rows.length > 0);
  const personRows = entities.filter((e) => e.entityType.toLowerCase() === 'person');
  const orgRows = entities.filter((e) => e.entityType.toLowerCase() === 'organization');
  const locRows = entities.filter((e) => e.entityType.toLowerCase() === 'location');

  const detail = `entities=${entities.map((e) => `${e.entityType}:${e.entityName}`).join(', ') || '(none)'}`;

  // 1. Person name must not be a role/title
  const bogusPerson = personRows.find((p) => isRoleTitle(p.entityName));
  record(
    bogusPerson ? 'fail' : 'pass',
    `[${index + 1}] no role title stored as person`,
    bogusPerson ? `bogus person="${bogusPerson.entityName}". ${detail}` : detail,
  );

  // 2. Person extraction matches expectation
  if (probe.expectPerson === null) {
    record(
      personRows.length === 0 ? 'pass' : 'fail',
      `[${index + 1}] no person entity expected`,
      personRows.length === 0 ? undefined : `unexpected: ${personRows.map((p) => p.entityName).join(', ')}`,
    );
  } else if (probe.expectPerson) {
    const matched = personRows.some((p) => p.entityName.toLowerCase() === probe.expectPerson!.toLowerCase());
    record(
      matched ? 'pass' : 'fail',
      `[${index + 1}] person entity = "${probe.expectPerson}"`,
      matched ? undefined : `got: ${personRows.map((p) => p.entityName).join(', ') || '(none)'}`,
    );
  }

  // 3. Organization extraction matches expectation
  if (probe.expectOrg) {
    const matched = orgRows.some((o) => o.entityName.toLowerCase().includes(probe.expectOrg!.toLowerCase()));
    record(
      matched ? 'pass' : 'fail',
      `[${index + 1}] organization entity contains "${probe.expectOrg}"`,
      matched ? undefined : `got: ${orgRows.map((o) => o.entityName).join(', ') || '(none)'}`,
    );
  }

  // 4. Location, if expected
  if (probe.expectLocation) {
    const matched = locRows.some((l) => l.entityName.toLowerCase().includes(probe.expectLocation!.toLowerCase()));
    record(
      matched ? 'pass' : 'warn',
      `[${index + 1}] location entity contains "${probe.expectLocation}"`,
      matched ? undefined : `got: ${locRows.map((l) => l.entityName).join(', ') || '(none)'}`,
    );
  }

  // 5. Follow-up: "What is my name?" — the assistant must not echo a role
  //    title as the user's name.
  const r2 = await sendWithRetry(session, chatId, 'What is my name?');
  const reply = r2.reply.toLowerCase();
  const claimsRole = ROLE_TITLE_TOKENS.some((t) =>
    new RegExp(`\\byour\\s+name\\s+is\\s+(?:the\\s+|a\\s+)?${t.replace(/\s+/g, '\\s+')}\\b`, 'i').test(r2.reply) ||
    new RegExp(`\\byou(?:'re|\\s+are)\\s+(?:called|named)\\s+${t.replace(/\s+/g, '\\s+')}\\b`, 'i').test(r2.reply),
  );
  record(
    claimsRole ? 'fail' : 'pass',
    `[${index + 1}] follow-up does not claim a role title is the user's name`,
    claimsRole ? `reply: ${r2.reply.slice(0, 240)}` : `reply: ${r2.reply.slice(0, 140)}`,
  );

  if (probe.expectPerson) {
    const echoesName = reply.includes(probe.expectPerson.toLowerCase());
    record(
      echoesName ? 'pass' : 'warn',
      `[${index + 1}] follow-up reply mentions "${probe.expectPerson}"`,
      echoesName ? undefined : `reply: ${r2.reply.slice(0, 240)}`,
    );
  } else if (probe.expectPerson === null) {
    // When no name was disclosed, the reply must NOT invent one. It should
    // either say it doesn't know, or it may reference what the user DID
    // disclose (role + org).
    const inventsName = /your\s+name\s+is\s+[a-z]/i.test(r2.reply) && !claimsRole;
    record(
      inventsName ? 'warn' : 'pass',
      `[${index + 1}] follow-up does not invent a name`,
      inventsName ? `reply: ${r2.reply.slice(0, 240)}` : `reply: ${r2.reply.slice(0, 140)}`,
    );
  }
}

async function main() {
  log('\n============================================================');
  log('  Identity extraction stress test');
  log(`  Run id: ${runId}`);
  log(`  Base:   ${BASE}`);
  log(`  Model:  ${MODEL || '(LLM router decides)'}`);
  log('============================================================');

  for (let i = 0; i < PROBES.length; i++) {
    try {
      await runProbe(PROBES[i]!, i);
    } catch (err) {
      record('fail', `probe ${i + 1} crashed`, err instanceof Error ? err.stack ?? err.message : String(err));
    }
    // Pace probes to avoid upstream rate limits hitting back-to-back model calls.
    await sleep(1500);
  }

  const pass = results.filter((r) => r.status === 'pass').length;
  const fail = results.filter((r) => r.status === 'fail').length;
  const warn = results.filter((r) => r.status === 'warn').length;
  const skip = results.filter((r) => r.status === 'skip').length;

  log('\n============================================================');
  log('  FINAL RESULTS');
  log('============================================================');
  log(`  Total: ${results.length}`);
  log(`  ✅ Pass: ${pass}`);
  log(`  ❌ Fail: ${fail}`);
  log(`  ⚠️  Warn: ${warn}`);
  log(`  ⏭  Skip: ${skip}`);
  log('============================================================');

  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(2);
});
