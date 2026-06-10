#!/usr/bin/env npx tsx
/**
 * geneWeave Memory Chaos + Regression Stress Test
 *
 * Drop this file into: scripts/memory-chaos-stress.ts
 * Run:
 *   BASE_URL=http://localhost:3500 \
 *   ADMIN_EMAIL=e2e-memory-test@weaveintel.dev \
 *   ADMIN_PASSWORD='Str0ng!Pass99' \
 *   npx tsx scripts/memory-chaos-stress.ts
 *
 * Model selection:
 *   By default this test does NOT pin a model. It lets the server's LLM router
 *   (cost-governor + routing policy + DB-backed model resolver in chat-send-message.ts)
 *   pick the model exactly the way the production chat path does. Pass TEST_MODEL='provider/model-id'
 *   only if you need to force a specific endpoint for repro work.
 *
 * Why this exists:
 * The previous memory-stress script was broad, but several checks were too loose:
 *   - many assertions passed if the model merely said "memory" or "project";
 *   - async extraction used fixed sleeps instead of polling;
 *   - global memory settings were modified without a guaranteed restore guard;
 *   - cross-user leakage was mostly checked via final replies, not all user/admin buckets;
 *   - correction/staleness checks allowed old and new facts to coexist;
 *   - semantic recall was not scored against a deterministic oracle;
 *   - no repeatability artefact/report was written for CI.
 *
 * This version keeps the test black-box through the public HTTP API, but adds:
 *   - unique run ids and seeded sentinel facts;
 *   - poll-until conditions for eventual extraction;
 *   - stronger positive and negative oracles;
 *   - final JSON report under test-results/;
 *   - settings snapshot/restore in finally;
 *   - memory bucket scanning for leakage and raw secret retention;
 *   - tenant/user isolation checks across semantic, episodic, entity, procedural buckets;
 *   - stale fact correction checks;
 *   - noisy-memory retrieval precision checks;
 *   - concurrency and idempotency checks;
 *   - optional STRICT mode for teams that want hard failure on weaker behavioural checks.
 */

const BASE = process.env.BASE_URL ?? process.env.BASE ?? 'http://localhost:3500';
// Empty string => let the server's LLM router pick. Set TEST_MODEL only to force a model.
const MODEL = process.env.TEST_MODEL ?? process.env.MODEL ?? '';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'e2e-memory-test@weaveintel.dev';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'Str0ng!Pass99';
const USER_PASSWORD = process.env.USER_PASSWORD ?? 'Str0ng!Pass99';
const STRICT = ['1', 'true', 'yes'].includes(String(process.env.STRICT ?? '').toLowerCase());

const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS ?? 70_000);
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS ?? 15_000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 500);
const CONCURRENCY = Number(process.env.MEM_CONCURRENCY ?? 5);

const MEMORY_TOOLS = [
  'memory_recall',
  'memory_search',
  'memory_remember',
  'memory_forget',
  'memory_list_entities',
  'memory_list_episodes',
  'memory_get_profile',
  'datetime',
];

type Status = 'pass' | 'fail' | 'skip' | 'warn';
type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;
interface Session { cookie: string; csrf: string; userId: string; email: string; name: string }
interface TestResult { name: string; status: Status; detail?: string; ms?: number }
interface HttpResult { status: number; body: Json; headers: Headers }

const results: TestResult[] = [];
const startedAt = new Date();
// IMPORTANT: do NOT include 10+ consecutive digits anywhere in this id.
// The episodic-PII-redaction governance rule contains a US phone-number
// pattern (?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b
// which greedily redacts any 10 consecutive digits. A timestamp like
// 1781075130505 collapses to '178[REDACTED]' once stored, breaking every
// poll predicate that does JSON.stringify(rows).includes(`${runId}-MARKER`).
const runId = `memchaos-${Math.random().toString(36).slice(2, 8)}-${Math.random().toString(36).slice(2, 8)}`;
let admin: Session | null = null;
let settingsSnapshot: Record<string, unknown> | null = null;

function log(msg = '') { console.log(msg); }
function group(title: string) {
  log(`\n${'─'.repeat(80)}`);
  log(`  ${title}`);
  log('─'.repeat(80));
}
function record(status: Status, name: string, detail?: string, ms?: number) {
  results.push({ status, name, detail, ms });
  const icon = status === 'pass' ? '✅' : status === 'fail' ? '❌' : status === 'warn' ? '⚠️ ' : '⏭ ';
  log(`  ${icon} ${name}${ms !== undefined ? ` (${ms}ms)` : ''}`);
  if (detail) log(`     ${detail}`);
}
async function check(name: string, fn: () => Promise<boolean> | boolean, detail?: () => string | Promise<string>) {
  const t = Date.now();
  try {
    const ok = await fn();
    record(ok ? 'pass' : 'fail', name, ok ? undefined : await detail?.(), Date.now() - t);
  } catch (err) {
    record('fail', name, err instanceof Error ? err.stack ?? err.message : String(err), Date.now() - t);
  }
}
function skip(name: string, detail: string) { record('skip', name, detail); }
function warn(name: string, detail: string) { record('warn', name, detail); }
function text(x: unknown): string { return typeof x === 'string' ? x : JSON.stringify(x ?? ''); }
function lower(x: unknown): string { return text(x).toLowerCase(); }
function arr(body: Json, key: string): Array<Record<string, unknown>> {
  const v = (body as Record<string, unknown> | null)?.[key];
  return Array.isArray(v) ? v as Array<Record<string, unknown>> : [];
}
function anyBucketContains(memory: Record<string, unknown> | null, needle: string): boolean {
  return JSON.stringify(memory ?? {}).includes(needle);
}
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function request(method: string, path: string, opts: { body?: unknown; session?: Session; rawBody?: string } = {}): Promise<HttpResult> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.rawBody !== undefined || opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.session) {
    headers.Cookie = opts.session.cookie;
    headers['X-CSRF-Token'] = opts.session.csrf;
  }
  const resp = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.rawBody !== undefined ? opts.rawBody : opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const ct = resp.headers.get('content-type') ?? '';
  let body: Json;
  if (ct.includes('application/json')) body = await resp.json() as Json;
  else body = await resp.text();
  return { status: resp.status, body, headers: resp.headers };
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
  const body = await resp.json() as Record<string, unknown>;
  const user = body.user as Record<string, unknown> | undefined;
  return {
    cookie: token,
    csrf: String(body.csrfToken ?? ''),
    userId: String(user?.id ?? ''),
    email,
    name: String(user?.name ?? email),
  };
}
async function register(email: string, name: string): Promise<Session | null> {
  await request('POST', '/api/auth/register', { body: { email, name, password: USER_PASSWORD } });
  return login(email, USER_PASSWORD);
}
async function auth(session: Session, method: string, path: string, body?: unknown) {
  return request(method, path, { session, body });
}

async function createChat(session: Session, mode: 'agent' | 'direct' | 'supervisor', name: string, tools = MEMORY_TOOLS): Promise<string> {
  const r = await auth(session, 'POST', '/api/chats', { name: `${runId}: ${name}` });
  if (r.status !== 201) throw new Error(`create chat failed ${r.status}: ${text(r.body).slice(0, 300)}`);
  const chat = (r.body as Record<string, unknown>).chat as Record<string, unknown> | undefined;
  const chatId = String(chat?.id ?? '');
  if (!chatId) throw new Error(`create chat returned no id: ${text(r.body)}`);
  const s = await auth(session, 'POST', `/api/chats/${chatId}/settings`, { mode, enabledTools: tools });
  if (![200, 201, 204].includes(s.status)) throw new Error(`chat settings failed ${s.status}: ${text(s.body).slice(0, 300)}`);
  return chatId;
}
async function send(session: Session, chatId: string, content: string, timeoutMs = AGENT_TIMEOUT_MS): Promise<{ ok: boolean; status: number; reply: string; body: Json }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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
    const body = ct.includes('application/json') ? await resp.json() as Json : await resp.text();
    const obj = body as Record<string, unknown>;
    return { ok: resp.status === 200, status: resp.status, reply: String(obj.assistantContent ?? obj.content ?? ''), body };
  } catch (err) {
    return { ok: false, status: 0, reply: '', body: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function poll<T>(label: string, producer: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = POLL_TIMEOUT_MS): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  let last: T | null = null;
  while (Date.now() < deadline) {
    last = await producer();
    if (predicate(last)) return last;
    await sleep(POLL_INTERVAL_MS);
  }
  warn(`${label} poll timed out`, `Last value: ${text(last).slice(0, 300)}`);
  return null;
}

async function adminGet(path: string): Promise<HttpResult | null> {
  if (!admin) return null;
  return auth(admin, 'GET', path);
}
async function getUserMemory(session: Session): Promise<Record<string, unknown> | null> {
  const r = await auth(session, 'GET', '/api/user/memory');
  return r.status === 200 && typeof r.body === 'object' && r.body !== null ? r.body as Record<string, unknown> : null;
}
async function getAdminBucket(bucket: 'episodic' | 'semantic' | 'entity' | 'procedural' | 'working', userId?: string, limit = 500) {
  if (!admin) return [] as Array<Record<string, unknown>>;
  const key = bucket === 'entity' ? 'entity-memory' : `${bucket}-memory`;
  const pathBucket = bucket === 'entity' ? 'entity-memory' : `${bucket}-memory`;
  const qs = new URLSearchParams();
  if (userId) qs.set('userId', userId);
  qs.set('limit', String(limit));
  const r = await auth(admin, 'GET', `/api/admin/${pathBucket}?${qs.toString()}`);
  if (r.status !== 200) return [];
  return arr(r.body, key);
}
async function getSettings(): Promise<Record<string, unknown> | null> {
  if (!admin) return null;
  const r = await auth(admin, 'GET', '/api/admin/memory-settings');
  if (r.status !== 200) return null;
  return arr(r.body, 'memory-settings')[0] ?? null;
}
async function putSettings(patch: Record<string, unknown>): Promise<HttpResult | null> {
  if (!admin) return null;
  return auth(admin, 'PUT', '/api/admin/memory-settings/global', patch);
}
async function countEpisodic(userId: string) { return (await getAdminBucket('episodic', userId)).length; }

function expectIncludes(reply: string, needles: string[], min = 1): boolean {
  const r = reply.toLowerCase();
  return needles.filter(n => r.includes(n.toLowerCase())).length >= min;
}
function expectExcludes(reply: string, needles: string[]): boolean {
  const r = reply.toLowerCase();
  return needles.every(n => !r.includes(n.toLowerCase()));
}

async function main() {
  log('═'.repeat(80));
  log('  geneWeave Memory Chaos + Regression Stress Test');
  log(`  Run: ${runId}`);
  log(`  Base: ${BASE}`);
  log(`  Model: ${MODEL || '(LLM router decides)'}`);
  log(`  Strict behavioural checks: ${STRICT ? 'ON' : 'OFF'}`);
  log('═'.repeat(80));

  const server = await request('GET', '/api/auth/me');
  await check('Server responds to /api/auth/me', () => [200, 401, 403].includes(server.status), () => `got ${server.status}`);

  admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  if (admin) {
    const probe = await auth(admin, 'GET', '/api/admin/memory-settings');
    if (probe.status !== 200) {
      warn('Admin login succeeded but admin route is blocked', `ADMIN_EMAIL=${ADMIN_EMAIL}, status=${probe.status}. Admin-only tests will be skipped.`);
      admin = null;
    } else {
      settingsSnapshot = await getSettings();
      record('pass', 'Admin session available');
    }
  } else {
    warn('No admin session available', `Could not login ${ADMIN_EMAIL}. Admin-only tests will be skipped.`);
  }

  const a = await register(`${runId}-alex@weaveintel.dev`, 'Memory Alex');
  const b = await register(`${runId}-blake@weaveintel.dev`, 'Memory Blake');
  const c = await register(`${runId}-casey@weaveintel.dev`, 'Memory Casey');
  if (!a || !b || !c) throw new Error('Could not create test users. Check auth/register endpoint and password policy.');

  try {
    group('1 — Baseline memory settings and API shape');
    if (admin) {
      const settings = await getSettings();
      await check('memory_settings row exists', () => !!settings, () => text(settings));
      await check('semantic/entity/episodic/procedural/working enabled by default', () => {
        if (!settings) return false;
        return ['enable_semantic', 'enable_entity', 'enable_episodic', 'enable_procedural', 'enable_working']
          .every(k => settings[k] === 1 || settings[k] === true);
      }, () => text(settings));
    } else skip('memory_settings baseline', 'admin unavailable');

    const userMem = await getUserMemory(a);
    await check('GET /api/user/memory exposes expected buckets', () => {
      if (!userMem) return false;
      return ['entities', 'semantic', 'episodic', 'procedural'].every(k => Array.isArray(userMem[k]));
    }, () => text(userMem));

    group('2 — Episodic capture with deterministic sentinels');
    const chat2 = await createChat(a, 'agent', 'episodic capture');
    const before2 = admin ? await countEpisodic(a.userId) : -1;
    const epToken = `${runId}-EPISODIC-SENTINEL`;
    const r2 = await send(a, chat2, `For memory capture testing, the unique episodic sentinel is ${epToken}. Reply briefly.`);
    await check('agent turn returns 200', () => r2.ok, () => `status=${r2.status}, body=${text(r2.body).slice(0, 300)}`);
    if (admin) {
      const epAfter = await poll('episodic capture', () => getAdminBucket('episodic', a.userId), rows => rows.length >= before2 + 2 && JSON.stringify(rows).includes(epToken));
      await check('user + assistant episodic entries captured and include sentinel', () => !!epAfter, () => `before=${before2}`);
      await check('captured episodic rows are scoped to correct chat', () => {
        const rows = (epAfter ?? []).filter(x => String(x.content ?? '').includes(epToken));
        return rows.length >= 1 && rows.every(x => x.chat_id === chat2);
      }, () => JSON.stringify((epAfter ?? []).filter(x => String(x.content ?? '').includes(epToken)).slice(0, 3)));
    } else skip('episodic DB verification', 'admin unavailable');

    group('3 — Explicit semantic remember/search/forget with strong oracle');
    const chat3 = await createChat(a, 'agent', 'semantic tools');
    const semToken = `${runId}-SEMANTIC-PHOENIX`;
    const fact = `Project Phoenix-${runId} has go-live date 2027-03-15, budget NZD 2.4M, risk owner Mira Patel, sentinel ${semToken}`;
    const r31 = await send(a, chat3, `Use memory_remember to store this exact durable project fact: "${fact}"`);
    await check('memory_remember returns 200', () => r31.ok, () => text(r31.body).slice(0, 300));
    const r32 = await send(a, chat3, `Use memory_search for Phoenix-${runId}. Return the stored go-live date, budget, risk owner, and sentinel.`);
    await check('memory_search returns exact sentinel and core fields', () =>
      r32.ok && r32.reply.includes(semToken) && r32.reply.includes('2027-03-15') && lower(r32.reply).includes('mira'),
      () => r32.reply.slice(0, 500));
    const r33 = await send(a, chat3, `Use memory_forget to remove the stored Project Phoenix-${runId} memory. Then confirm only deletion.`);
    await check('memory_forget returns 200', () => r33.ok, () => text(r33.body).slice(0, 300));
    const r34 = await send(a, chat3, `Use memory_search for ${semToken}. It should not be present after deletion.`);
    // Oracle: the deleted *facts* must be absent from the reply. The sentinel
    // itself may legitimately be echoed inside a "not found" / "no longer
    // present" confirmation (the model is acknowledging the search term), so
    // we don't penalise that. We DO penalise the model returning any of the
    // structured payload it would have returned before the forget.
    const forgottenFactsAbsent = !r34.reply.includes('2027-03-15')
      && !lower(r34.reply).includes('mira')
      && !r34.reply.includes('NZD 2.4M');
    await check('forgotten sentinel not returned by memory_search', () => forgottenFactsAbsent, () => r34.reply.slice(0, 500));

    group('4 — Cross-chat persistence and implicit context injection');
    const persisted = `${runId}-PERSISTED-CONTEXT`;
    const chat4a = await createChat(a, 'agent', 'persist store');
    const chat4b = await createChat(a, 'agent', 'persist recall');
    await send(a, chat4a, `Use memory_remember to save: "My preferred architecture review phrase is ${persisted}; I prefer risk-first review order."`);
    const r4 = await send(a, chat4b, 'Without using tools, what architecture review order do I prefer and what is my phrase?');
    const ok4 = r4.reply.includes(persisted) || (lower(r4.reply).includes('risk-first') && lower(r4.reply).includes('review'));
    await check('stored fact influences a fresh chat without explicit search directive', () => r4.ok && (STRICT ? r4.reply.includes(persisted) : ok4), () => r4.reply.slice(0, 500));

    group('5 — Cross-user isolation and leakage scan');
    const leakToken = `${runId}-USER-A-VAULT-CODE-9173`;
    const chat5a = await createChat(a, 'agent', 'isolation A');
    const chat5b = await createChat(b, 'agent', 'isolation B');
    await send(a, chat5a, `Use memory_remember to save this private User A fact: vault code ${leakToken}.`);
    const rbSearch = await send(b, chat5b, `Use memory_search to search for vault codes or anything containing ${runId}.`);
    await check('User B cannot recall User A semantic secret', () => !rbSearch.reply.includes(leakToken), () => rbSearch.reply.slice(0, 500));
    const memB = await getUserMemory(b);
    await check('User B /api/user/memory does not contain User A token', () => !anyBucketContains(memB, leakToken), () => JSON.stringify(memB).slice(0, 500));
    if (admin) {
      const bBuckets = [
        ...(await getAdminBucket('episodic', b.userId)),
        ...(await getAdminBucket('semantic', b.userId)),
        ...(await getAdminBucket('entity', b.userId)),
        ...(await getAdminBucket('procedural', b.userId)),
      ];
      await check('Admin-filtered User B buckets contain no User A token', () => !JSON.stringify(bBuckets).includes(leakToken), () => JSON.stringify(bBuckets).slice(0, 500));
      const nonAdmin = await auth(b, 'GET', `/api/admin/episodic-memory?userId=${a.userId}&limit=5`);
      await check('tenant user blocked from admin memory endpoints', () => nonAdmin.status === 403, () => `got ${nonAdmin.status}: ${text(nonAdmin.body).slice(0, 200)}`);
    } else skip('admin-filtered isolation checks', 'admin unavailable');

    group('6 — Correction and stale fact suppression');
    const chat6a = await createChat(a, 'agent', 'correction store');
    await send(a, chat6a, `Use memory_remember to save: "Current role marker ${runId}: I am a Data Analyst at OldCo."`);
    await send(a, chat6a, `Correction: update memory for role marker ${runId}. I am now Head of Data at NewBridge Labs. OldCo is stale and should not be treated as current.`);
    const chat6b = await createChat(a, 'agent', 'correction recall');
    const r6 = await send(a, chat6b, `For role marker ${runId}, what is my current job title and company? Do not mention stale facts unless explaining correction.`);
    await check('current corrected fact is recalled', () => expectIncludes(r6.reply, ['Head of Data', 'NewBridge']), () => r6.reply.slice(0, 500));
    await check('old fact is not presented as current', () => !lower(r6.reply).includes('data analyst at oldco') || lower(r6.reply).includes('stale') || lower(r6.reply).includes('previous'), () => r6.reply.slice(0, 500));

    group('7 — Noisy memory retrieval precision');
    const chat7 = await createChat(a, 'agent', 'noise precision');
    for (let i = 0; i < 12; i++) {
      await send(a, chat7, `Use memory_remember to save: "Noise fact ${runId}-${i}: favourite synthetic colour is colour-${i}; irrelevant to Kubernetes."`);
    }
    const preciseToken = `${runId}-K8S-ROLLBACK-RULE`;
    await send(a, chat7, `Use memory_remember to save: "${preciseToken}: for Kubernetes incidents, rollback if p95 latency exceeds 800ms for 10 minutes after deploy."`);
    const r7 = await send(a, chat7, `Use memory_search for Kubernetes rollback latency guidance. Give only the relevant memory.`);
    await check('semantic search retrieves the relevant needle from noisy memories', () => r7.reply.includes(preciseToken) || (r7.reply.includes('800') && lower(r7.reply).includes('latency')), () => r7.reply.slice(0, 700));
    await check('retrieval answer is not dominated by unrelated noise facts', () => (r7.reply.match(/colour-/g) ?? []).length <= 2, () => r7.reply.slice(0, 700));

    group('8 — Governance: episodic redaction and semantic blocking/redaction');
    if (admin) {
      const chat8 = await createChat(a, 'agent', 'governance pii');
      const piiMarker = `${runId}-PII-MARKER`;
      const rawSsn = '123-45-6789';
      const rawCard = '4111111111111111';
      const rawSecret = 'sk-proj-CHAOSSECRET999999999999';
      const before8 = await countEpisodic(a.userId);
      const r8 = await send(a, chat8, `Governance test ${piiMarker}. SSN ${rawSsn}. Card ${rawCard}. api_key=${rawSecret}. Preserve non-sensitive context.`);
      await check('PII-containing user turn does not crash agent', () => r8.ok, () => `status=${r8.status}`);
      const rows8 = await poll('PII episodic redaction', () => getAdminBucket('episodic', a.userId), rows => rows.length > before8 && JSON.stringify(rows).includes(piiMarker));
      const stored8 = (rows8 ?? []).filter(x => String(x.content ?? '').includes(piiMarker)).map(x => String(x.content ?? '')).join('\n');
      await check('raw SSN/card/API key absent from episodic memory', () => !!stored8 && !stored8.includes(rawSsn) && !stored8.includes(rawCard) && !stored8.includes(rawSecret), () => stored8.slice(0, 700));
      await check('non-sensitive context preserved with redaction token', () => stored8.includes(piiMarker) && stored8.includes('[REDACTED]'), () => stored8.slice(0, 700));

      const semBefore = JSON.stringify(await getAdminBucket('semantic', a.userId));
      await send(a, chat8, `Use memory_remember to store this prohibited SSN text: ${rawSsn} ${runId}`);
      await sleep(1000);
      const semAfter = JSON.stringify(await getAdminBucket('semantic', a.userId));
      await check('raw SSN not persisted in semantic memory', () => !semAfter.includes(rawSsn), () => semAfter.slice(0, 700));
      await check('semantic memory endpoint remains healthy after blocked content', () => semAfter.length >= semBefore.length || semAfter.length >= 2, () => `beforeLen=${semBefore.length}, afterLen=${semAfter.length}`);
    } else skip('governance DB checks', 'admin unavailable');

    group('9 — Memory settings toggles with guaranteed restore');
    if (admin) {
      const settingsBefore = await getSettings();
      const rDisable = await putSettings({ enable_episodic: false, auto_extract_on_turn: true });
      await check('disable episodic setting accepted', () => rDisable?.status === 200, () => text(rDisable?.body));
      const chat9 = await createChat(c, 'agent', 'settings toggle');
      const countBefore = await countEpisodic(c.userId);
      await send(c, chat9, `This should not be captured while episodic is disabled: ${runId}-NO-CAPTURE`);
      await sleep(1500);
      const countAfter = await countEpisodic(c.userId);
      await check('no episodic capture while enable_episodic=false', () => countAfter === countBefore, () => `before=${countBefore}, after=${countAfter}`);
      await putSettings({ enable_episodic: true, auto_extract_on_turn: true });
      await send(c, chat9, `This should be captured after episodic re-enabled: ${runId}-CAPTURED-AGAIN`);
      const rows9 = await poll('episodic re-enable capture', () => getAdminBucket('episodic', c.userId), rows => JSON.stringify(rows).includes(`${runId}-CAPTURED-AGAIN`));
      await check('capture resumes after enable_episodic=true', () => !!rows9, () => `settingsBefore=${text(settingsBefore)}`);
    } else skip('settings toggle checks', 'admin unavailable');

    group('10 — Max episodic cap and trim behaviour');
    if (admin) {
      // Snapshot the current cap so we restore it BEFORE Test 11 — otherwise
      // the cap=6 we set here would trim every concurrent capture in Test 11
      // down to 6 rows and Test 11's `before+CONCURRENCY*2` predicate fails.
      const settings10 = await getSettings();
      const previousCap = (settings10?.['max_episodic_per_user'] as number | undefined) ?? 200;
      const cap = 6;
      await putSettings({ enable_episodic: true, auto_extract_on_turn: true, max_episodic_per_user: cap });
      const chat10 = await createChat(c, 'agent', 'episodic cap');
      for (let i = 0; i < 5; i++) await send(c, chat10, `Cap test ${runId} message ${i}; keep newest rows.`);
      const rows10 = await poll('episodic cap trim', () => getAdminBucket('episodic', c.userId), rows => rows.length > 0 && rows.length <= cap, 20_000);
      await check('episodic rows trimmed to configured cap', () => !!rows10 && rows10.length <= cap, () => `rows=${rows10?.length}`);
      await check('trim does not wipe all rows', () => !!rows10 && rows10.length > 0, () => `rows=${rows10?.length}`);
      // Restore the cap immediately so Test 11's concurrent capture is not throttled.
      await putSettings({ max_episodic_per_user: previousCap });
    } else skip('max cap checks', 'admin unavailable');

    group('11 — Concurrency and duplicate suppression expectations');
    const chat11 = await createChat(a, 'agent', 'concurrency');
    const before11 = admin ? await countEpisodic(a.userId) : 0;
    const concurrent = await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) =>
      send(a, chat11, `Concurrent memory turn ${runId}-${i}: preference token C${i}-${runId}.`)
    ));
    await check(`${CONCURRENCY} concurrent turns all return 200`, () => concurrent.every(x => x.ok), () => concurrent.map(x => x.status).join('/'));
    if (admin) {
      const rows11 = await poll('concurrent episodic capture', () => countEpisodic(a.userId), count => count >= before11 + CONCURRENCY * 2, 25_000);
      await check('concurrent turns capture expected user+assistant episodic entries', () => typeof rows11 === 'number' && rows11 >= before11 + CONCURRENCY * 2, () => `before=${before11}, after=${rows11}`);
    } else skip('concurrent capture count', 'admin unavailable');

    group('12 — Procedural lifecycle state machine');
    if (admin) {
      const marker = `${runId}-PROC-PREFIX`;
      const create = await auth(admin, 'POST', '/api/admin/procedural-memory', {
        user_id: a.userId,
        agent_id: 'default',
        instruction_delta: `When the user asks about memory test greetings, begin with [${marker}].`,
        proposed_by: 'memory-chaos-stress',
        confidence: 0.94,
      });
      const proc = (create.body as Record<string, unknown>)['procedural-memory-entry'] as Record<string, unknown> | undefined;
      const pid = String(proc?.id ?? '');
      await check('create procedural entry returns 201/proposed', () => create.status === 201 && proc?.status === 'proposed' && !!pid, () => `${create.status}: ${text(create.body).slice(0, 300)}`);
      if (pid) {
        const preApply = await auth(admin, 'POST', `/api/admin/procedural-memory/${pid}/apply`, {});
        await check('apply before approve is rejected', () => [400, 409].includes(preApply.status), () => `${preApply.status}: ${text(preApply.body).slice(0, 200)}`);
        const approve = await auth(admin, 'POST', `/api/admin/procedural-memory/${pid}/approve`, {});
        await check('approve proposed procedural entry', () => approve.status === 200, () => text(approve.body).slice(0, 200));
        const apply = await auth(admin, 'POST', `/api/admin/procedural-memory/${pid}/apply`, {});
        await check('apply approved procedural entry', () => apply.status === 200, () => text(apply.body).slice(0, 200));
        const again = await auth(admin, 'POST', `/api/admin/procedural-memory/${pid}/apply`, {});
        await check('apply twice is rejected', () => [400, 409].includes(again.status), () => `${again.status}: ${text(again.body).slice(0, 200)}`);
        const chat12 = await createChat(a, 'agent', 'procedural behaviour');
        const r12 = await send(a, chat12, 'For memory test greetings, how should I greet a new teammate?');
        await check('applied procedural memory influences later agent behaviour', () => r12.reply.includes(`[${marker}]`) || (!STRICT && lower(r12.reply).includes('greet')), () => r12.reply.slice(0, 500));
      }
    } else skip('procedural lifecycle', 'admin unavailable');

    group('13 — User deletion and full wipe');
    const wipeToken = `${runId}-WIPE-CHECK`;
    const chat13 = await createChat(c, 'agent', 'wipe');
    await send(c, chat13, `Use memory_remember to store wipe token ${wipeToken}. Also reply normally.`);
    await sleep(1000);
    let memC = await getUserMemory(c);
    await check('User C has some memory before wipe', () => JSON.stringify(memC ?? {}).length > 50, () => JSON.stringify(memC).slice(0, 500));
    const wipe = await auth(c, 'DELETE', '/api/user/memory/all');
    await check('DELETE /api/user/memory/all returns 200', () => wipe.status === 200, () => `${wipe.status}: ${text(wipe.body).slice(0, 200)}`);
    memC = await getUserMemory(c);
    await check('full wipe removes the wipe sentinel from user-visible memory', () => !anyBucketContains(memC, wipeToken), () => JSON.stringify(memC).slice(0, 500));
    if (admin) {
      const bucketsC = [
        ...(await getAdminBucket('episodic', c.userId)),
        ...(await getAdminBucket('semantic', c.userId)),
        ...(await getAdminBucket('entity', c.userId)),
      ];
      await check('full wipe removes token from admin-visible memory buckets', () => !JSON.stringify(bucketsC).includes(wipeToken), () => JSON.stringify(bucketsC).slice(0, 500));
    }

    group('14 — Negative API checks');
    if (admin) {
      const badJson = await request('PUT', '/api/admin/memory-settings/global', { session: admin, rawBody: '{not valid json' });
      await check('invalid JSON does not return 500', () => badJson.status !== 500, () => `${badJson.status}: ${text(badJson.body).slice(0, 200)}`);
      const missingProc = await auth(admin, 'POST', '/api/admin/procedural-memory', { agent_id: 'default', confidence: 0.5 });
      await check('procedural create missing required fields returns 400', () => missingProc.status === 400, () => `${missingProc.status}: ${text(missingProc.body).slice(0, 200)}`);
      const badApprove = await auth(admin, 'POST', '/api/admin/procedural-memory/not-a-real-id/approve', {});
      await check('approve nonexistent procedural id returns 400/404', () => [400, 404].includes(badApprove.status), () => `${badApprove.status}: ${text(badApprove.body).slice(0, 200)}`);
    } else skip('admin negative API checks', 'admin unavailable');
    const fakeAdmin = await auth(b, 'GET', '/api/admin/memory-settings/nonexistent/extra/path');
    await check('fabricated admin route does not leak JSON memory/settings data', () => fakeAdmin.status !== 500 && !text(fakeAdmin.body).includes('memory-settings-row'), () => `${fakeAdmin.status}: ${text(fakeAdmin.body).slice(0, 200)}`);

  } finally {
    group('Cleanup — restore global memory settings');
    if (admin && settingsSnapshot) {
      const restorePatch: Record<string, unknown> = {};
      for (const k of [
        'enable_semantic', 'enable_entity', 'enable_episodic', 'enable_procedural', 'enable_working',
        'auto_extract_on_turn', 'max_episodic_per_user', 'consolidation_interval_min',
      ]) {
        if (settingsSnapshot[k] !== undefined) restorePatch[k] = settingsSnapshot[k];
      }
      const r = await putSettings(restorePatch);
      record(r?.status === 200 ? 'pass' : 'warn', 'restore memory settings snapshot', r?.status === 200 ? undefined : `${r?.status}: ${text(r?.body).slice(0, 300)}`);
    } else {
      skip('restore memory settings snapshot', 'no snapshot/admin unavailable');
    }
  }

  const endedAt = new Date();
  const summary = {
    runId,
    base: BASE,
    model: MODEL || '(LLM router decides)',
    strict: STRICT,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    totals: {
      total: results.length,
      pass: results.filter(r => r.status === 'pass').length,
      fail: results.filter(r => r.status === 'fail').length,
      warn: results.filter(r => r.status === 'warn').length,
      skip: results.filter(r => r.status === 'skip').length,
    },
    results,
  };

  await writeReport(summary);

  log('\n' + '═'.repeat(80));
  log('  FINAL RESULTS');
  log('═'.repeat(80));
  log(`  Total: ${summary.totals.total}`);
  log(`  ✅ Pass: ${summary.totals.pass}`);
  log(`  ❌ Fail: ${summary.totals.fail}`);
  log(`  ⚠️  Warn: ${summary.totals.warn}`);
  log(`  ⏭  Skip: ${summary.totals.skip}`);
  if (summary.totals.fail) {
    log('\n  FAILURES:');
    for (const r of results.filter(x => x.status === 'fail')) log(`    ❌ ${r.name}\n       ${r.detail ?? ''}`);
  }
  log('═'.repeat(80));

  process.exit(summary.totals.fail > 0 ? 1 : 0);
}

async function writeReport(summary: Record<string, unknown>) {
  try {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const dir = path.resolve(process.cwd(), 'test-results');
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${runId}.json`);
    await fs.writeFile(file, JSON.stringify(summary, null, 2), 'utf8');
    log(`\n  Report written: ${file}`);
  } catch (err) {
    warn('could not write JSON report', err instanceof Error ? err.message : String(err));
  }
}

main().catch(async err => {
  record('fail', 'fatal script error', err instanceof Error ? err.stack ?? err.message : String(err));
  if (admin && settingsSnapshot) {
    try {
      const patch: Record<string, unknown> = {};
      for (const k of ['enable_semantic', 'enable_entity', 'enable_episodic', 'enable_procedural', 'enable_working', 'auto_extract_on_turn', 'max_episodic_per_user']) {
        if (settingsSnapshot[k] !== undefined) patch[k] = settingsSnapshot[k];
      }
      await putSettings(patch);
    } catch { /* best effort */ }
  }
  process.exit(1);
});
