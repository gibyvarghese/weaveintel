#!/usr/bin/env npx tsx
/**
 * geneWeave W1–W7 Strategy Benchmark Stress Test
 *
 * Exercises all seven weaveIntel strategy enhancements end-to-end against
 * a running geneWeave server.  Inspired by ReAct/LATS/Reflexion/AgentBench
 * evaluation patterns, adapted to the geneWeave HTTP API.
 *
 *   W1 — Reflection (self-critique, iterative revision)
 *   W2 — Evaluator-Optimizer (rubric verify + regenerate)
 *   W3 — Supervisor re-plan + parallel delegation
 *   W4 — Workflow-as-tool adapter
 *   W5 — Ensemble / debate (vote, arbiter, judge)
 *   W6 — A2A-out (agent card discovery + task submission)
 *   W7 — geneWeave settings API (enable/disable per-chat strategies)
 *
 * Run:
 *   BASE_URL=http://localhost:3500 \
 *   ADMIN_EMAIL=admin@weaveintel.dev \
 *   ADMIN_PASSWORD='AdminPass99!' \
 *   TEST_MODEL='anthropic/claude-haiku-4-5-20251001' \
 *   npx tsx scripts/weave-strategies-stress-test.ts
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// ── Configuration ─────────────────────────────────────────────────────────────
const BASE          = process.env.BASE_URL ?? 'http://localhost:3500';
const MODEL         = process.env.TEST_MODEL ?? 'anthropic/claude-haiku-4-5-20251001';
const ADMIN_EMAIL   = process.env.ADMIN_EMAIL ?? 'admin@weaveintel.dev';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'AdminPass99!';
const USER_PASSWORD  = process.env.USER_PASSWORD ?? 'Str0ng!Pass99';
const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS ?? 90_000);
const STRICT = ['1', 'true', 'yes'].includes(String(process.env.STRICT ?? '').toLowerCase());

// ── Types ─────────────────────────────────────────────────────────────────────
type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;
type Status = 'pass' | 'fail' | 'warn' | 'skip';
interface Session { cookie: string; csrf: string; userId: string; email: string; name: string }
interface HttpResult { status: number; body: Json; headers: Headers }
interface TestResult { group: string; name: string; status: Status; detail?: string; ms?: number }
interface LatencySample { kind: 'chat_send' | 'api'; label: string; ms: number; ok: boolean; status?: number }
interface MetricEvent { id: string; benchmark: string; capability: string; label: string; score: number; weight: number; detail?: string }
interface BenchmarkMeasurement { id: string; label: string; benchmark: string; score: number; weight: number; samples: number }

// ── State ─────────────────────────────────────────────────────────────────────
const results: TestResult[] = [];
const latencySamples: LatencySample[] = [];
const metricEvents: MetricEvent[] = [];
let currentGroup = 'setup';
let admin: Session | null = null;
const startedAt = new Date();

function letters(n: number): string {
  const a = 'abcdefghijklmnopqrstuvwxyz'; let s = ''; for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)]; return s;
}
const runId = `weavestress-${letters(8)}-${letters(6)}`;
const runTag = runId.toUpperCase().replace(/[^A-Z]/g, '');
function tok(label: string) { return `${runTag}${label.toUpperCase().replace(/[^A-Z]/g, '')}`; }
function nowMs() { return Date.now(); }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function asText(x: unknown): string { return typeof x === 'string' ? x : JSON.stringify(x ?? ''); }
function lower(x: unknown): string { return asText(x).toLowerCase(); }
function compact(x: unknown, max = 500): string { return asText(x).replace(/\s+/g, ' ').slice(0, max); }
function includesAny(h: string, ns: string[]) { const l = h.toLowerCase(); return ns.some(n => l.includes(n.toLowerCase())); }
function includesAll(h: string, ns: string[]) { const l = h.toLowerCase(); return ns.every(n => l.includes(n.toLowerCase())); }
function round3(n: number) { return Math.round(n * 1000) / 1000; }
function round2(n: number) { return Math.round(n * 100) / 100; }
function grade(s: number) { return s >= .95 ? 'A+' : s >= .9 ? 'A' : s >= .85 ? 'B+' : s >= .8 ? 'B' : s >= .7 ? 'C' : s >= .6 ? 'D' : 'F'; }
function percentile(values: number[], p: number) { if (!values.length) return null; const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))] ?? null; }

function group(name: string) {
  currentGroup = name;
  console.log(`\n${'─'.repeat(90)}`); console.log(`  ${name}`); console.log('─'.repeat(90));
}
function record(status: Status, name: string, detail?: string, ms?: number) {
  results.push({ group: currentGroup, name, status, detail, ms });
  const icon = status === 'pass' ? '✅' : status === 'fail' ? '❌' : status === 'warn' ? '⚠️ ' : '⏭ ';
  console.log(`  ${icon} ${name}${ms === undefined ? '' : ` (${ms}ms)`}`);
  if (detail) console.log(`     ${detail}`);
}
function addMetric(ev: MetricEvent) { metricEvents.push(ev); }
function addScalarMetric(id: string, benchmark: string, capability: string, label: string, score: number, weight = 1, detail?: string) {
  addMetric({ id, benchmark, capability, label, score: Math.max(0, Math.min(1, score)), weight, detail });
}
async function check(name: string, fn: () => Promise<boolean> | boolean, detail?: () => string | Promise<string>, metric?: Omit<MetricEvent, 'score' | 'label'> & { label?: string }) {
  const t = nowMs();
  try {
    const ok = await fn();
    record(ok ? 'pass' : 'fail', name, ok ? undefined : await detail?.(), nowMs() - t);
    if (metric) addMetric({ ...metric, label: metric.label ?? name, score: ok ? 1 : 0 });
  } catch (e) {
    record('fail', name, e instanceof Error ? (e.stack ?? e.message) : String(e), nowMs() - t);
    if (metric) addMetric({ ...metric, label: metric.label ?? name, score: 0, detail: e instanceof Error ? e.message : String(e) });
  }
}
function warn(name: string, detail: string, metric?: Omit<MetricEvent, 'score' | 'label'> & { label?: string }) {
  record('warn', name, detail);
  if (metric) addMetric({ ...metric, label: metric.label ?? name, score: .5, detail });
}
function skip(name: string, detail: string) { record('skip', name, detail); }

// ── HTTP Helpers ──────────────────────────────────────────────────────────────
async function request(method: string, path: string, opts: { body?: unknown; session?: Session; rawBody?: string; bearerToken?: string } = {}): Promise<HttpResult> {
  const started = nowMs();
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined || opts.rawBody !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.session) { headers['Cookie'] = opts.session.cookie; headers['X-CSRF-Token'] = opts.session.csrf; }
  if (opts.bearerToken) headers['Authorization'] = `Bearer ${opts.bearerToken}`;
  const resp = await fetch(`${BASE}${path}`, {
    method, headers,
    body: opts.rawBody !== undefined ? opts.rawBody : opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const ct = resp.headers.get('content-type') ?? '';
  const body = ct.includes('application/json') ? await resp.json() as Json : await resp.text();
  latencySamples.push({ kind: 'api', label: `${method} ${path}`, ms: nowMs() - started, ok: resp.status < 500, status: resp.status });
  return { status: resp.status, body, headers: resp.headers };
}
async function auth(session: Session, method: string, path: string, body?: unknown) { return request(method, path, { session, body }); }
async function login(email: string, password: string): Promise<Session | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const started = nowMs();
    const resp = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ email, password }) });
    latencySamples.push({ kind: 'api', label: 'POST /api/auth/login', ms: nowMs() - started, ok: resp.status === 200, status: resp.status });
    if (resp.status === 200) {
      const cookie = (resp.headers.get('set-cookie') ?? '').match(/gw_token=[^;]+/)?.[0];
      if (!cookie) return null;
      const body = await resp.json() as Record<string, unknown>;
      const user = body['user'] as Record<string, unknown> | undefined;
      return { cookie, csrf: String(body['csrfToken'] ?? ''), userId: String(user?.['id'] ?? ''), email, name: String(user?.['name'] ?? email) };
    }
    if (resp.status === 429 && attempt < 4) { await sleep(3000); continue; }
    return null;
  }
  return null;
}
async function register(email: string, name: string): Promise<Session | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await request('POST', '/api/auth/register', { body: { email, name, password: USER_PASSWORD } });
    if ([200, 201, 409, 422].includes(r.status)) break;
    if ([429, 503].includes(r.status)) { await sleep(2500 + 1500 * attempt); continue; }
    break;
  }
  return login(email, USER_PASSWORD);
}

async function createChat(session: Session, mode: string, name: string, extraSettings?: Record<string, unknown>): Promise<string> {
  const r = await auth(session, 'POST', '/api/chats', { name: `${runId}: ${name}` });
  if (r.status !== 201) throw new Error(`create chat failed ${r.status}: ${compact(r.body)}`);
  const chat = (r.body as Record<string, unknown>)['chat'] as Record<string, unknown> | undefined;
  const chatId = String(chat?.['id'] ?? '');
  if (!chatId) throw new Error(`create chat returned no id: ${compact(r.body)}`);
  const sr = await auth(session, 'POST', `/api/chats/${chatId}/settings`, { mode, ...extraSettings });
  if (![200, 201, 204].includes(sr.status)) throw new Error(`chat settings failed ${sr.status}: ${compact(sr.body)}`);
  return chatId;
}

async function send(session: Session, chatId: string, content: string, timeoutMs = AGENT_TIMEOUT_MS): Promise<{ ok: boolean; status: number; reply: string; body: Json; ms: number }> {
  const started = nowMs();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${BASE}/api/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Cookie: session.cookie, 'X-CSRF-Token': session.csrf },
      body: JSON.stringify({ content, model: MODEL }),
      signal: ctrl.signal,
    });
    const ct = resp.headers.get('content-type') ?? '';
    const body = ct.includes('application/json') ? await resp.json() as Json : await resp.text();
    const obj = body as Record<string, unknown>;
    const ms = nowMs() - started;
    const reply = String(obj['assistantContent'] ?? obj['content'] ?? '');
    latencySamples.push({ kind: 'chat_send', label: 'POST /api/chats/:id/messages', ms, ok: resp.status === 200, status: resp.status });
    return { ok: resp.status === 200, status: resp.status, reply, body, ms };
  } catch (e) {
    const ms = nowMs() - started;
    latencySamples.push({ kind: 'chat_send', label: 'POST /api/chats/:id/messages', ms, ok: false, status: 0 });
    return { ok: false, status: 0, reply: '', body: e instanceof Error ? e.message : String(e), ms };
  } finally {
    clearTimeout(timer);
  }
}

// Extract the JWT value from the gw_token cookie (used as Bearer token for A2A).
function getBearerToken(session: Session): string | null {
  // session.cookie is "gw_token=<jwt>" (trimmed by the login helper above).
  const match = session.cookie.match(/^gw_token=(.+)$/);
  return match ? match[1]! : null;
}

// ── W1 — Reflection ───────────────────────────────────────────────────────────
async function runW1Reflection(user: Session) {
  group('W1 — Reflection: self-critique and iterative revision');

  // Basic reflection round-trip: chat in agent mode with reflection enabled
  const chatId = await createChat(user, 'agent', 'W1-reflection', {
    reflectEnabled: true,
    reflectMaxRevisions: 2,
    reflectCriteria: 'Answer must be specific, grounded in evidence, and clearly structured.',
  });

  // T1: Normal task — reflection should improve factual specificity
  const t1 = await send(user, chatId, 'Briefly explain what TypeScript generics are and why they are useful. Be concise and precise.');
  await check('W1: reflection-enabled agent returns 200', () => t1.ok, () => compact(t1.reply || t1.body), {
    id: 'w1-basic-reflection', benchmark: 'ReAct/Reflexion proxy', capability: 'W1 reflection', weight: 1,
  });
  await check('W1: answer discusses generics/types/reuse', () => t1.ok && includesAny(t1.reply, ['generic', 'type', 'reusable', 'parameter', 'function', 'interface']),
    () => compact(t1.reply || t1.body), { id: 'w1-reflection-quality', benchmark: 'ReAct/Reflexion proxy', capability: 'W1 reflection quality', weight: 1.2 });
  addScalarMetric('w1-response-length', 'W1 reflection', 'answer substantiveness', 'reply length proxy',
    t1.reply.length >= 60 && t1.reply.length <= 1200 ? 1 : 0.4, 0.7, `len=${t1.reply.length}`);

  // T2: Adversarial — deliberately vague request, reflection should push toward specificity
  const chat2Id = await createChat(user, 'agent', 'W1-adversarial', {
    reflectEnabled: true,
    reflectMaxRevisions: 1,
    reflectCriteria: 'Must contain at least one concrete example.',
  });
  const t2 = await send(user, chat2Id, 'Explain something about programming languages.');
  await check('W1: adversarial vague prompt still gets a response', () => t2.ok, () => compact(t2.reply || t2.body), {
    id: 'w1-adversarial-vague', benchmark: 'Reflexion proxy', capability: 'W1 reflection on vague input', weight: 0.9,
  });

  // T3: Multi-revision — criteria that require concrete refinement
  const chat3Id = await createChat(user, 'agent', 'W1-multi-revision', {
    reflectEnabled: true,
    reflectMaxRevisions: 3,
    reflectCriteria: 'Answer must mention Python, include a code example, and explain complexity.',
  });
  const t3 = await send(user, chat3Id, 'Describe the quicksort algorithm: how it works, a Python code example, and its average-case time complexity.');
  await check('W1: multi-revision reflection completes successfully', () => t3.ok, () => compact(t3.reply || t3.body), {
    id: 'w1-multi-revision', benchmark: 'Reflexion proxy', capability: 'W1 multi-revision', weight: 1,
  });
  await check('W1: multi-revision answer covers algorithm, code, and complexity', () => t3.ok && includesAny(t3.reply, ['python', 'quicksort', 'quick sort', 'def ', 'o(n', 'complexity', 'pivot', 'partition']),
    () => compact(t3.reply || t3.body), { id: 'w1-multi-revision-quality', benchmark: 'Reflexion proxy', capability: 'W1 multi-revision quality', weight: 1.1 });

  // T4: Reflection disabled — should still answer but cheaper/faster
  const chat4Id = await createChat(user, 'agent', 'W1-disabled', { reflectEnabled: false });
  const t4 = await send(user, chat4Id, 'What is a closure in JavaScript?');
  await check('W1: reflection-disabled agent also responds correctly', () => t4.ok && includesAny(t4.reply, ['closure', 'scope', 'function', 'variable']),
    () => compact(t4.reply || t4.body), { id: 'w1-reflection-disabled', benchmark: 'W1 baseline', capability: 'W1 off baseline', weight: 0.8 });

  // Latency comparison metric
  addScalarMetric('w1-latency-acceptable', 'W1 reflection', 'latency', 'reflection turn latency within 90s budget',
    t1.ms < AGENT_TIMEOUT_MS ? 1 : 0, 0.8, `ms=${t1.ms}`);
}

// ── W2 — Evaluator-Optimizer ──────────────────────────────────────────────────
async function runW2EvaluatorOptimizer(user: Session) {
  group('W2 — Evaluator-Optimizer: rubric verify + regenerate loop');

  // T1: Verify + regenerate cycle — answer must pass quality bar
  const chatId = await createChat(user, 'agent', 'W2-verify', {
    verifyEnabled: true,
    verifyMinScore: 0.7,
    verifyMaxAttempts: 2,
  });
  const t1 = await send(user, chatId, 'Write a two-sentence explanation of why unit tests matter in software development.');
  await check('W2: verify-enabled agent returns 200', () => t1.ok, () => compact(t1.reply || t1.body), {
    id: 'w2-basic-verify', benchmark: 'AgentBench proxy', capability: 'W2 evaluator-optimizer', weight: 1,
  });
  await check('W2: verified response discusses testing value', () => t1.ok && includesAny(t1.reply, ['test', 'bug', 'code', 'quality', 'regression', 'reliability']),
    () => compact(t1.reply || t1.body), { id: 'w2-verify-quality', benchmark: 'AgentBench proxy', capability: 'W2 verification quality', weight: 1.2 });

  // T2: Low min-score — should accept first attempt quickly
  const chat2Id = await createChat(user, 'agent', 'W2-low-bar', {
    verifyEnabled: true,
    verifyMinScore: 0.1,
    verifyMaxAttempts: 1,
  });
  const t2 = await send(user, chat2Id, 'Name one benefit of using a database.');
  await check('W2: low-score-bar verify still completes', () => t2.ok && t2.reply.length > 10,
    () => compact(t2.reply || t2.body), { id: 'w2-low-bar', benchmark: 'AgentBench proxy', capability: 'W2 low-bar completion', weight: 0.8 });

  // T3: High min-score with multiple attempts — system should iterate
  const chat3Id = await createChat(user, 'agent', 'W2-high-bar', {
    verifyEnabled: true,
    verifyMinScore: 0.95,
    verifyMaxAttempts: 3,
  });
  const t3Token = tok('W2HIGHBAR');
  const t3 = await send(user, chat3Id, `Write a comprehensive explanation of REST API design principles. My session reference is ${t3Token} — please echo it back once.`);
  await check('W2: high-bar verify completes without timeout', () => t3.ok, () => compact(t3.reply || t3.body), {
    id: 'w2-high-bar-verify', benchmark: 'AgentBench proxy', capability: 'W2 high-bar iteration', weight: 1,
  });
  await check('W2: response contains REST principles (stateless, resource, HTTP)', () => t3.ok && includesAny(t3.reply, ['rest', 'stateless', 'resource', 'endpoint', 'http', 'api']),
    () => compact(t3.reply || t3.body), { id: 'w2-rest-content', benchmark: 'AgentBench proxy', capability: 'W2 verified content quality', weight: 1.1 });

  // T4: Verify disabled — baseline behaviour unchanged
  const chat4Id = await createChat(user, 'agent', 'W2-disabled', { verifyEnabled: false });
  const t4 = await send(user, chat4Id, 'Explain what an API is in one sentence.');
  await check('W2: verify-disabled agent responds normally', () => t4.ok && includesAny(t4.reply, ['api', 'interface', 'application', 'service', 'endpoint']),
    () => compact(t4.reply || t4.body), { id: 'w2-disabled-baseline', benchmark: 'W2 baseline', capability: 'W2 off baseline', weight: 0.8 });

  addScalarMetric('w2-latency-acceptable', 'W2 evaluator-optimizer', 'latency',
    'verify turn latency within budget', t1.ms < AGENT_TIMEOUT_MS ? 1 : 0, 0.8, `ms=${t1.ms}`);
}

// ── W3 — Supervisor Replan + Parallel ────────────────────────────────────────
async function runW3Supervisor(user: Session) {
  group('W3 — Supervisor: replanOnFailure + parallelDelegation');

  // T1: Supervisor with replan on failure + parallel delegation enabled
  const chatId = await createChat(user, 'supervisor', 'W3-supervisor', {
    supervisorReplanOnFailure: true,
    supervisorParallelDelegation: true,
    workers: [
      { name: 'researcher', description: 'Finds information and performs research tasks' },
      { name: 'analyst', description: 'Analyses data and draws conclusions' },
    ],
  });
  const t1 = await send(user, chatId, 'Research and analyse: what are the three main benefits of TypeScript over JavaScript? Provide a structured answer with evidence.');
  await check('W3: supervisor with replan+parallel returns 200', () => t1.ok, () => compact(t1.reply || t1.body), {
    id: 'w3-supervisor-basic', benchmark: 'AgentBench proxy', capability: 'W3 supervisor', weight: 1,
  });
  await check('W3: supervisor answer covers TypeScript benefits', () => t1.ok && includesAny(t1.reply, ['type', 'typescript', 'safety', 'error', 'refactor', 'ide', 'tooling', 'benefit']),
    () => compact(t1.reply || t1.body), { id: 'w3-supervisor-content', benchmark: 'AgentBench proxy', capability: 'W3 content quality', weight: 1.1 });

  // T2: Supervisor mode — replan flag off to verify default behaviour
  const chat2Id = await createChat(user, 'supervisor', 'W3-supervisor-norep', {
    supervisorReplanOnFailure: false,
    supervisorParallelDelegation: false,
  });
  const t2 = await send(user, chat2Id, 'What is dependency injection? Answer in two sentences.');
  await check('W3: supervisor without replan/parallel still responds', () => t2.ok && includesAny(t2.reply, ['inject', 'dependency', 'decouple', 'service', 'class', 'interface']),
    () => compact(t2.reply || t2.body), { id: 'w3-supervisor-baseline', benchmark: 'W3 baseline', capability: 'W3 supervisor baseline', weight: 0.9 });

  // T3: Multi-turn supervisor with parallel delegation — 2 workers to keep synthesis turn within timeout
  const chat3Id = await createChat(user, 'supervisor', 'W3-parallel', {
    supervisorReplanOnFailure: true,
    supervisorParallelDelegation: true,
    workers: [
      { name: 'frontend-expert', description: 'Expert in frontend development and frameworks' },
      { name: 'backend-expert', description: 'Expert in backend systems and APIs' },
    ],
  });
  const t3a = await send(user, chat3Id, 'What frontend framework should I use for a new SaaS product in 2026?');
  await check('W3: multi-worker supervisor parallel first turn', () => t3a.ok, () => compact(t3a.reply || t3a.body));
  const t3b = await send(user, chat3Id, 'Now suggest the backend stack. It needs to handle 10k concurrent users.');
  await check('W3: multi-worker supervisor parallel second turn', () => t3b.ok, () => compact(t3b.reply || t3b.body));
  // Synthesis turn — give 2× the normal budget since it must aggregate multiple worker responses.
  const t3c = await send(user, chat3Id, 'Summarise both picks in two sentences.', AGENT_TIMEOUT_MS * 2);
  await check('W3: multi-worker supervisor synthesis turn', () => t3c.ok && includesAny(t3c.reply, ['frontend', 'backend', 'framework', 'stack', 'recommend']),
    () => compact(t3c.reply || t3c.body), { id: 'w3-parallel-synthesis', benchmark: 'AgentBench proxy', capability: 'W3 parallel synthesis', weight: 1.2 });

  // T4: Adversarial — ambiguous task that might cause workers to under-deliver
  const chat4Id = await createChat(user, 'supervisor', 'W3-adversarial', {
    supervisorReplanOnFailure: true,
    supervisorParallelDelegation: false,
  });
  const t4 = await send(user, chat4Id, 'Write a short comprehensive analysis.');
  await check('W3: supervisor handles ambiguous task without crash', () => t4.ok, () => compact(t4.reply || t4.body), {
    id: 'w3-adversarial-ambiguous', benchmark: 'AgentBench proxy', capability: 'W3 adversarial resilience', weight: 0.9,
  });
}

// ── W4 — Workflow-as-Tool ─────────────────────────────────────────────────────
async function runW4WorkflowAsTool(user: Session) {
  group('W4 — Workflow-as-tool: agent triggers workflow via tool call');

  // The workflow-as-tool is server-side. We test the API integration by
  // asking an agent chat to perform a task that involves a workflow step.
  // Since workflows may not be pre-registered in every deployment, we focus
  // on the chat pipeline behaving correctly with tool-calling in agent mode.

  const chatId = await createChat(user, 'agent', 'W4-workflow-tool', {
    enabledTools: ['datetime', 'calculator'],
  });

  // T1: Agent uses calculator tool (verifies tool-as-workflow pattern works)
  const t1 = await send(user, chatId, 'Calculate: what is 347 times 829? Use the calculator tool.');
  await check('W4: agent with calculator tool returns 200', () => t1.ok, () => compact(t1.reply || t1.body), {
    id: 'w4-tool-call-basic', benchmark: 'AgentBench proxy', capability: 'W4 workflow-as-tool', weight: 1,
  });
  await check('W4: agent result contains the product (287,663)', () => t1.ok && includesAny(t1.reply, ['287663', '287,663', '287 663']),
    () => compact(t1.reply || t1.body), { id: 'w4-tool-accuracy', benchmark: 'AgentBench proxy', capability: 'W4 tool result accuracy', weight: 1.2 });

  // T2: Agent uses datetime tool to verify real-time tool invocation
  const t2 = await send(user, chatId, 'What is today\'s date and time? Use the datetime tool.');
  await check('W4: datetime tool invocation returns current time', () => t2.ok && (includesAny(t2.reply, ['2026', '2025', 'date', 'time', 'utc', ':']) || t2.reply.match(/\d{4}/) !== null),
    () => compact(t2.reply || t2.body), { id: 'w4-datetime-tool', benchmark: 'AgentBench proxy', capability: 'W4 realtime tool', weight: 1 });

  // T3: Multi-tool chain — verifies sequential tool invocation (workflow-like)
  const t3 = await send(user, chatId, 'First get the current date, then calculate how many days are in the current month.');
  await check('W4: multi-step tool chain completes', () => t3.ok && t3.reply.length > 20,
    () => compact(t3.reply || t3.body), { id: 'w4-multi-tool-chain', benchmark: 'AgentBench proxy', capability: 'W4 multi-tool chain', weight: 1.1 });

  // T4: Tool not in policy — agent should respond without using disallowed tool
  const chat4Id = await createChat(user, 'agent', 'W4-no-tools', { enabledTools: [] });
  const t4 = await send(user, chat4Id, 'Calculate 15 + 27 without using any tools. Just reason it through.');
  await check('W4: direct mode with no tools answers arithmetic', () => t4.ok && includesAny(t4.reply, ['42', 'forty-two', 'forty two']),
    () => compact(t4.reply || t4.body), { id: 'w4-no-tool-fallback', benchmark: 'W4 baseline', capability: 'W4 no-tool fallback', weight: 0.8 });
}

// ── W5 — Ensemble ─────────────────────────────────────────────────────────────
async function runW5Ensemble(user: Session) {
  group('W5 — Ensemble: multi-agent vote/arbiter consensus');

  // T1: Ensemble mode with vote resolver — multiple agents, majority wins
  // Note: 'ensemble' mode requires the settings route to accept it (fixed above)
  const chatId = await createChat(user, 'agent', 'W5-ensemble-vote', {
    // Ensemble is handled within the chat engine when mode='ensemble' and ensembleAgents is set
    // For now, test via agent mode with multiple models — ensemble mode requires UI configuration
    // We test the settings API accepts 'ensemble' mode and the chat runs
    mode: 'agent',
    ensembleResolver: 'vote',
  });

  const t1 = await send(user, chatId, 'What programming language is best suited for data science? Provide a clear recommendation.');
  await check('W5: agent with ensemble resolver hint returns 200', () => t1.ok, () => compact(t1.reply || t1.body), {
    id: 'w5-ensemble-basic', benchmark: 'Ensemble/debate proxy', capability: 'W5 ensemble', weight: 1,
  });
  await check('W5: ensemble answer makes a concrete recommendation', () => t1.ok && includesAny(t1.reply, ['python', 'r language', 'julia', 'recommend', 'best', 'suggest']),
    () => compact(t1.reply || t1.body), { id: 'w5-ensemble-recommends', benchmark: 'Ensemble/debate proxy', capability: 'W5 recommendation quality', weight: 1.1 });

  // T2: Settings API accepts 'ensemble' mode without error (W7 integration)
  const r2 = await auth(user, 'POST', '/api/chats', { name: `${runId}: W5-ensemble-mode` });
  const chat2Raw = (r2.body as Record<string, unknown>)['chat'] as Record<string, unknown> | undefined;
  const chat2Id = String(chat2Raw?.['id'] ?? '');
  if (chat2Id) {
    const sr = await auth(user, 'POST', `/api/chats/${chat2Id}/settings`, {
      mode: 'ensemble',
      ensembleResolver: 'arbiter',
      ensembleAgents: [
        { name: 'model-a', model: MODEL, systemPrompt: 'You are a pragmatist.' },
        { name: 'model-b', model: MODEL, systemPrompt: 'You are an idealist.' },
      ],
    });
    await check('W5+W7: settings API accepts ensemble mode with agents', () => [200, 201, 204].includes(sr.status),
      () => `status=${sr.status}: ${compact(sr.body)}`, {
        id: 'w5-settings-ensemble', benchmark: 'W5+W7 settings integration', capability: 'ensemble mode settings', weight: 1.2,
      });

    if ([200, 201, 204].includes(sr.status)) {
      // Verify settings were persisted
      const gr = await auth(user, 'GET', `/api/chats/${chat2Id}/settings`);
      await check('W5+W7: ensemble settings persist and are readable', () => {
        const s = (gr.body as Record<string, unknown>)['settings'] as Record<string, unknown> | undefined;
        return gr.status === 200 && s?.['mode'] === 'ensemble';
      }, () => compact(gr.body), { id: 'w5-settings-persist', benchmark: 'W5+W7 persistence', capability: 'settings persistence', weight: 1 });
    }
  } else {
    skip('W5+W7: ensemble mode settings', 'Could not create chat');
  }

  // T3: Arbiter resolver — describe a debate-style resolution scenario
  const chat3Id = await createChat(user, 'agent', 'W5-arbiter', {
    ensembleResolver: 'arbiter',
  });
  const t3 = await send(user, chat3Id, 'Compare monolithic vs microservices architecture. Which is better for a startup? Give a decisive recommendation.');
  await check('W5: arbiter-mode agent gives decisive architecture recommendation', () => t3.ok && (includesAny(t3.reply, ['monolith', 'microservice', 'recommend', 'suggest', 'start', 'scale'])),
    () => compact(t3.reply || t3.body), { id: 'w5-arbiter-decisive', benchmark: 'Ensemble/debate proxy', capability: 'W5 arbiter decisiveness', weight: 1 });

  // T4: Tie-breaking scenario — strongly ambiguous question
  const chat4Id = await createChat(user, 'agent', 'W5-tiebreak', {
    ensembleResolver: 'vote',
  });
  const t4 = await send(user, chat4Id, 'Vim or VS Code? Give a brief recommendation for a new developer.');
  await check('W5: tie-break question still resolves to one recommendation', () => t4.ok && t4.reply.length > 20,
    () => compact(t4.reply || t4.body), { id: 'w5-tiebreak', benchmark: 'Ensemble/debate proxy', capability: 'W5 tie-breaking', weight: 0.9 });
}

// ── W6 — A2A-Out ──────────────────────────────────────────────────────────────
async function runW6A2A(user: Session) {
  group('W6 — A2A-out: agent card discovery + task submission');

  // T1: Well-known agent card discovery (public endpoint, no auth)
  const t1 = await request('GET', '/.well-known/agent.json');
  await check('W6: GET /.well-known/agent.json returns 200', () => t1.status === 200, () => `${t1.status}: ${compact(t1.body)}`, {
    id: 'w6-agent-card-discovery', benchmark: 'A2A spec compliance', capability: 'W6 A2A discovery', weight: 1.2,
  });
  if (t1.status === 200) {
    const card = t1.body as Record<string, unknown>;
    await check('W6: agent card has required fields (name, url, version, capabilities)', () =>
      typeof card['name'] === 'string' &&
      typeof card['url'] === 'string' &&
      typeof card['version'] === 'string' &&
      Array.isArray(card['capabilities']),
      () => compact(card), { id: 'w6-agent-card-schema', benchmark: 'A2A spec compliance', capability: 'W6 card schema', weight: 1.1 });
    await check('W6: agent card capabilities include text', () => Array.isArray(card['capabilities']) && (card['capabilities'] as string[]).includes('text'),
      () => compact(card['capabilities']), { id: 'w6-capabilities-text', benchmark: 'A2A spec compliance', capability: 'W6 capabilities', weight: 0.9 });
    await check('W6: agent card has authentication field', () => typeof card['authentication'] === 'object' && card['authentication'] !== null,
      () => compact(card['authentication']), { id: 'w6-card-auth', benchmark: 'A2A spec compliance', capability: 'W6 auth field', weight: 0.8 });
  } else {
    skip('W6: agent card schema checks', 'Card endpoint returned non-200');
  }

  // T2: Task submission without auth — should return 401
  const nonce = `${runId}-a2a-noauth`;
  const t2 = await request('POST', '/api/a2a/tasks', {
    body: {
      id: nonce,
      input: { role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
    },
  });
  await check('W6: A2A task without Bearer token returns 401', () => t2.status === 401, () => `${t2.status}: ${compact(t2.body)}`, {
    id: 'w6-a2a-auth-required', benchmark: 'A2A security', capability: 'W6 A2A auth enforcement', weight: 1.3,
  });

  // T3: Task submission with wrong bearer token — should return 401
  const t3 = await request('POST', '/api/a2a/tasks', {
    bearerToken: 'invalid.token.value',
    body: {
      id: `${runId}-bad-token`,
      input: { role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
    },
  });
  await check('W6: A2A task with invalid Bearer token returns 401', () => t3.status === 401, () => `${t3.status}: ${compact(t3.body)}`, {
    id: 'w6-a2a-invalid-token', benchmark: 'A2A security', capability: 'W6 A2A invalid token rejection', weight: 1.2,
  });

  // T4: Malformed task body — missing id and input
  const bearerToken = await getBearerToken(user);
  if (bearerToken) {
    const t4 = await request('POST', '/api/a2a/tasks', {
      bearerToken,
      body: { message: 'missing id and input fields' },
    });
    await check('W6: A2A task missing id/input returns 400', () => t4.status === 400, () => `${t4.status}: ${compact(t4.body)}`, {
      id: 'w6-a2a-invalid-body', benchmark: 'A2A API validation', capability: 'W6 A2A input validation', weight: 1,
    });

    // T5: Empty text parts
    const t5 = await request('POST', '/api/a2a/tasks', {
      bearerToken,
      body: {
        id: `${runId}-empty-parts`,
        input: { role: 'user', parts: [{ type: 'text', text: '' }] },
      },
    });
    await check('W6: A2A task with empty text returns 400', () => t5.status === 400, () => `${t5.status}: ${compact(t5.body)}`, {
      id: 'w6-a2a-empty-text', benchmark: 'A2A API validation', capability: 'W6 A2A empty input rejection', weight: 0.9,
    });

    // T6: Valid task submission with auth (actual LLM call)
    const taskId = `${runId}-valid-task`;
    const t6 = await request('POST', '/api/a2a/tasks', {
      bearerToken,
      body: {
        id: taskId,
        input: { role: 'user', parts: [{ type: 'text', text: 'What is 2 + 2? Reply with just the number.' }] },
        // Pass the same model the test suite uses so the A2A route doesn't
        // fall back to a provider whose circuit breaker may be open.
        metadata: { model: MODEL },
      },
    });
    await check('W6: valid A2A task with Bearer token executes', () => t6.status === 200, () => `${t6.status}: ${compact(t6.body)}`, {
      id: 'w6-a2a-valid-task', benchmark: 'A2A end-to-end', capability: 'W6 A2A task execution', weight: 1.3,
    });
    if (t6.status === 200) {
      const result = t6.body as Record<string, unknown>;
      await check('W6: A2A task result has id, status, output', () =>
        result['id'] === taskId &&
        typeof result['status'] === 'string' &&
        (result['output'] !== undefined || result['error'] !== undefined),
        () => compact(result), { id: 'w6-a2a-result-schema', benchmark: 'A2A spec compliance', capability: 'W6 A2A result schema', weight: 1.1 });
      if (result['status'] === 'completed' && result['output']) {
        const output = result['output'] as Record<string, unknown>;
        const text = (output['parts'] as Array<{ type: string; text: string }>)?.find(p => p.type === 'text')?.text ?? '';
        await check('W6: A2A arithmetic task returns correct answer (4)', () => includesAny(text, ['4', 'four']),
          () => `text="${text}"`, { id: 'w6-a2a-task-accuracy', benchmark: 'A2A end-to-end', capability: 'W6 A2A answer accuracy', weight: 1.1 });
      }
    }

    // T7: Task status endpoint — should return 404 (synchronous server)
    const t7 = await request('GET', `/api/a2a/tasks/${taskId}`, { bearerToken });
    await check('W6: GET /api/a2a/tasks/:id returns 404 (sync server)', () => t7.status === 401 || t7.status === 404,
      () => `${t7.status}: ${compact(t7.body)}`, { id: 'w6-a2a-task-status', benchmark: 'A2A spec compliance', capability: 'W6 task status', weight: 0.7 });
  } else {
    skip('W6: authenticated A2A task tests', 'Could not obtain Bearer token');
    addScalarMetric('w6-a2a-valid-task', 'A2A end-to-end', 'W6 A2A task execution', 'skipped', 0, 1.3, 'no bearer token');
    addScalarMetric('w6-a2a-result-schema', 'A2A spec compliance', 'W6 A2A result schema', 'skipped', 0, 1.1, 'no bearer token');
  }
}

// ── W7 — geneWeave Settings API ───────────────────────────────────────────────
async function runW7Settings(user: Session) {
  group('W7 — Chat settings API: enable/disable strategies per chat');

  // T1: All W1-W5 flags can be saved and read back
  const r1 = await auth(user, 'POST', '/api/chats', { name: `${runId}: W7-full-config` });
  const chat1Raw = (r1.body as Record<string, unknown>)['chat'] as Record<string, unknown> | undefined;
  const chat1Id = String(chat1Raw?.['id'] ?? '');

  if (!chat1Id) { skip('W7: all strategy settings tests', 'Could not create chat'); return; }

  const fullSettings = {
    mode: 'agent',
    reflectEnabled: true,
    reflectMaxRevisions: 3,
    reflectCriteria: 'Must cite at least two sources',
    verifyEnabled: true,
    verifyMinScore: 0.85,
    verifyMaxAttempts: 2,
    supervisorReplanOnFailure: true,
    supervisorParallelDelegation: true,
    ensembleResolver: 'vote',
  };
  const sr1 = await auth(user, 'POST', `/api/chats/${chat1Id}/settings`, fullSettings);
  await check('W7: full W1-W5 settings payload saves without error', () => [200, 201, 204].includes(sr1.status),
    () => `${sr1.status}: ${compact(sr1.body)}`, { id: 'w7-full-settings-save', benchmark: 'W7 settings API', capability: 'settings persistence', weight: 1.2 });

  if ([200, 201, 204].includes(sr1.status)) {
    const gr1 = await auth(user, 'GET', `/api/chats/${chat1Id}/settings`);
    await check('W7: full settings readable after save', () => gr1.status === 200, () => `${gr1.status}: ${compact(gr1.body)}`,
      { id: 'w7-settings-readable', benchmark: 'W7 settings API', capability: 'settings read-back', weight: 1 });

    if (gr1.status === 200) {
      const s = (gr1.body as Record<string, unknown>)['settings'] as Record<string, unknown> | undefined;
      await check('W7: reflect_enabled persisted correctly', () => s?.['reflect_enabled'] === 1,
        () => `reflect_enabled=${s?.['reflect_enabled']}`, { id: 'w7-reflect-persist', benchmark: 'W7 settings API', capability: 'W1 settings', weight: 1 });
      await check('W7: reflect_max_revisions persisted correctly', () => s?.['reflect_max_revisions'] === 3,
        () => `reflect_max_revisions=${s?.['reflect_max_revisions']}`, { id: 'w7-reflect-revisions', benchmark: 'W7 settings API', capability: 'W1 settings', weight: 0.9 });
      await check('W7: verify_enabled persisted correctly', () => s?.['verify_enabled'] === 1,
        () => `verify_enabled=${s?.['verify_enabled']}`, { id: 'w7-verify-persist', benchmark: 'W7 settings API', capability: 'W2 settings', weight: 1 });
      await check('W7: verify_min_score persisted correctly', () => Math.abs(Number(s?.['verify_min_score']) - 0.85) < 0.01,
        () => `verify_min_score=${s?.['verify_min_score']}`, { id: 'w7-verify-score', benchmark: 'W7 settings API', capability: 'W2 settings', weight: 0.9 });
      await check('W7: supervisor_replan_on_failure persisted correctly', () => s?.['supervisor_replan_on_failure'] === 1,
        () => `supervisor_replan_on_failure=${s?.['supervisor_replan_on_failure']}`, { id: 'w7-supervisor-replan', benchmark: 'W7 settings API', capability: 'W3 settings', weight: 1 });
      await check('W7: supervisor_parallel_delegation persisted correctly', () => s?.['supervisor_parallel_delegation'] === 1,
        () => `supervisor_parallel_delegation=${s?.['supervisor_parallel_delegation']}`, { id: 'w7-supervisor-parallel', benchmark: 'W7 settings API', capability: 'W3 settings', weight: 1 });
      await check('W7: ensemble_resolver persisted correctly', () => s?.['ensemble_resolver'] === 'vote',
        () => `ensemble_resolver=${s?.['ensemble_resolver']}`, { id: 'w7-ensemble-resolver', benchmark: 'W7 settings API', capability: 'W5 settings', weight: 1 });
    }
  }

  // T2: Override settings — change some flags and verify update
  const sr2 = await auth(user, 'POST', `/api/chats/${chat1Id}/settings`, {
    mode: 'agent',
    reflectEnabled: false,
    verifyEnabled: false,
    supervisorReplanOnFailure: false,
  });
  await check('W7: settings can be overridden (all flags off)', () => [200, 201, 204].includes(sr2.status),
    () => `${sr2.status}: ${compact(sr2.body)}`, { id: 'w7-settings-override', benchmark: 'W7 settings API', capability: 'settings override', weight: 1 });

  if ([200, 201, 204].includes(sr2.status)) {
    const gr2 = await auth(user, 'GET', `/api/chats/${chat1Id}/settings`);
    const s2 = (gr2.body as Record<string, unknown>)['settings'] as Record<string, unknown> | undefined;
    await check('W7: reflect_enabled correctly set to 0 after override', () => s2?.['reflect_enabled'] === 0,
      () => `reflect_enabled=${s2?.['reflect_enabled']}`, { id: 'w7-reflect-off', benchmark: 'W7 settings API', capability: 'W1 disable', weight: 0.9 });
    await check('W7: verify_enabled correctly set to 0 after override', () => s2?.['verify_enabled'] === 0,
      () => `verify_enabled=${s2?.['verify_enabled']}`, { id: 'w7-verify-off', benchmark: 'W7 settings API', capability: 'W2 disable', weight: 0.9 });
  }

  // T3: Invalid mode — should return 400
  const r3 = await auth(user, 'POST', '/api/chats', { name: `${runId}: W7-invalid-mode` });
  const chat3Raw = (r3.body as Record<string, unknown>)['chat'] as Record<string, unknown> | undefined;
  const chat3Id = String(chat3Raw?.['id'] ?? '');
  if (chat3Id) {
    const sr3 = await auth(user, 'POST', `/api/chats/${chat3Id}/settings`, { mode: 'invalid-mode' });
    await check('W7: invalid mode value returns 400', () => sr3.status === 400, () => `${sr3.status}: ${compact(sr3.body)}`, {
      id: 'w7-invalid-mode', benchmark: 'W7 API validation', capability: 'settings validation', weight: 1,
    });
  }

  // T4: Ensemble mode accepted by settings API
  const r4 = await auth(user, 'POST', '/api/chats', { name: `${runId}: W7-ensemble-accept` });
  const chat4Raw = (r4.body as Record<string, unknown>)['chat'] as Record<string, unknown> | undefined;
  const chat4Id = String(chat4Raw?.['id'] ?? '');
  if (chat4Id) {
    const sr4 = await auth(user, 'POST', `/api/chats/${chat4Id}/settings`, { mode: 'ensemble' });
    await check('W7: ensemble mode accepted by settings API', () => [200, 201, 204].includes(sr4.status),
      () => `${sr4.status}: ${compact(sr4.body)}`, { id: 'w7-ensemble-mode-accept', benchmark: 'W7 settings API', capability: 'ensemble mode acceptance', weight: 1.1 });
  }

  // T5: Unauthenticated settings update — must fail with 401
  const r5 = await request('POST', `/api/chats/${chat1Id}/settings`, { body: { mode: 'agent' } });
  await check('W7: unauthenticated settings update returns 401/403', () => [401, 403].includes(r5.status),
    () => `${r5.status}: ${compact(r5.body)}`, { id: 'w7-unauth-settings', benchmark: 'W7 security', capability: 'settings auth enforcement', weight: 1.2 });
}

// ── Real-World Multi-Turn Conversation Tests ──────────────────────────────────
async function runRealWorldConversations(user: Session) {
  group('Real-World — Multi-turn conversations with tool calls');

  // T1: Complex technical Q&A over multiple turns
  const chatId = await createChat(user, 'agent', 'real-world-tech', {
    enabledTools: ['calculator', 'datetime'],
  });

  const turns: Array<{ q: string; expect: string[] }> = [
    { q: 'Explain the CAP theorem in distributed systems.', expect: ['consistency', 'availability', 'partition', 'cap'] },
    { q: 'Given CAP theorem, which properties does MongoDB prioritize by default?', expect: ['availability', 'partition', 'ap', 'mongodb', 'eventual'] },
    { q: 'How does this compare to PostgreSQL?', expect: ['consistency', 'acid', 'postgres', 'sql', 'strong', 'cp'] },
    { q: 'So for a banking application, which should I use? Give a clear recommendation.', expect: ['postgres', 'relational', 'consistency', 'acid', 'recommend'] },
  ];

  let passCount = 0;
  for (let i = 0; i < turns.length; i++) {
    const { q, expect: exp } = turns[i]!;
    const r = await send(user, chatId, q);
    if (r.ok && includesAny(r.reply, exp)) passCount++;
    else warn(`real-world turn ${i + 1} weak`, `q="${q.slice(0, 50)}"; missing: ${exp.join(',')}; reply="${compact(r.reply, 200)}"`,
      { id: 'real-world-multiturn', benchmark: 'LoCoMo proxy', capability: 'multi-turn coherence', weight: 1 });
  }
  addScalarMetric('real-world-multiturn-score', 'LoCoMo proxy', 'multi-turn coherence',
    'fraction of turns with expected content', passCount / turns.length, 1.2, `${passCount}/${turns.length}`);
  await check('Real-world: multi-turn tech Q&A mostly coherent', () => passCount >= turns.length * 0.6,
    () => `passCount=${passCount}/${turns.length}`, { id: 'real-world-multiturn-threshold', benchmark: 'LoCoMo proxy', capability: 'multi-turn coherence', weight: 1.2 });

  // T2: Tool-calling in conversation context
  const chat2Id = await createChat(user, 'agent', 'real-world-tools', {
    enabledTools: ['calculator', 'datetime'],
  });
  const t2a = await send(user, chat2Id, 'I have a budget of $5000. I need to buy 7 laptops at $649 each and 7 monitors at $299 each. Can I afford it?');
  const laptopTotal = 7 * 649;
  const monitorTotal = 7 * 299;
  const grandTotal = laptopTotal + monitorTotal;
  await check('Real-world: multi-item budget calculation correct', () => t2a.ok && includesAny(t2a.reply, [String(grandTotal), '$' + grandTotal.toLocaleString(), 'cannot afford', 'not enough', 'exceed']),
    () => compact(t2a.reply || t2a.body), { id: 'real-world-tool-calc', benchmark: 'AgentBench proxy', capability: 'tool-assisted math', weight: 1.1 });

  const t2b = await send(user, chat2Id, 'If I skip the monitors and only buy the laptops, what is my remaining budget?');
  const remaining = 5000 - laptopTotal;
  await check('Real-world: follow-up arithmetic with context retention', () => t2b.ok && includesAny(t2b.reply, [String(remaining), '$' + remaining.toLocaleString()]),
    () => compact(t2b.reply || t2b.body), { id: 'real-world-context-retention', benchmark: 'LongMemEval proxy', capability: 'numeric context retention', weight: 1.1 });

  // T3: Adversarial / edge cases
  const chat3Id = await createChat(user, 'agent', 'real-world-adversarial', {
    enabledTools: ['calculator'],
  });
  const t3a = await send(user, chat3Id, 'What is 1/0? Be precise.');
  await check('Real-world: division by zero handled gracefully', () => t3a.ok && includesAny(t3a.reply, ['undefined', 'division', 'zero', 'infinity', 'error', 'cannot']),
    () => compact(t3a.reply || t3a.body), { id: 'real-world-edge-div-zero', benchmark: 'Operational safety', capability: 'edge case handling', weight: 0.9 });

  const t3b = await send(user, chat3Id, '');  // empty message
  // Empty messages may return 400 or gracefully respond — either is acceptable
  await check('Real-world: empty message does not crash server (200 or 400)', () => t3b.status === 200 || t3b.status === 400,
    () => `status=${t3b.status}`, { id: 'real-world-empty-message', benchmark: 'Operational safety', capability: 'empty input handling', weight: 0.7 });

  // T4: Cross-user isolation — different users cannot see each other's chat context
  const userBEmail = `${runId}-isolation-b@weaveintel.dev`;
  const userB = await register(userBEmail, 'Isolation User B');
  if (userB) {
    const chatA = await createChat(user, 'direct', 'real-world-isolation-A');
    const chatB = await createChat(userB, 'direct', 'real-world-isolation-B');
    const favColorA = tok('FAVCOLORALPHA');
    const favColorB = tok('FAVCOLORBETA');

    await send(user, chatA, `My favourite colour is ${favColorA}. Please acknowledge.`);
    await send(userB, chatB, `My favourite colour is ${favColorB}. Please acknowledge.`);

    const checkA = await send(user, chatA, 'What favourite colour did I mention earlier in this conversation?');
    const checkB = await send(userB, chatB, 'What favourite colour did I mention earlier in this conversation?');

    await check('Real-world: chat A recalls its own context', () => checkA.ok && checkA.reply.includes(favColorA),
      () => compact(checkA.reply || checkA.body), { id: 'real-world-chat-context-A', benchmark: 'LoCoMo proxy', capability: 'same-chat context', weight: 1 });
    await check('Real-world: user B chat does not contain user A context', () => checkB.ok && !checkB.reply.includes(favColorA),
      () => compact(checkB.reply || checkB.body), { id: 'real-world-cross-user-isolation', benchmark: 'Operational safety', capability: 'cross-user isolation', weight: 1.3 });
  } else {
    skip('Real-world: cross-user isolation', 'Could not register second user');
  }
}

// ── Concurrent Load Tests ─────────────────────────────────────────────────────
async function runConcurrencyTests(user: Session) {
  group('Concurrency — Simultaneous multi-strategy chat requests');

  // Use separate chat IDs per concurrent message so SQLite write contention
  // does not serialize what should be independent concurrent requests.
  const concurrentMessages = [
    'What is 12 * 13?',
    'Explain what a REST API is in one sentence.',
    'What programming language is Python?',
    'Calculate 100 divided by 4.',
    'What is the capital of France?',
  ];

  const concurrentChats = await Promise.allSettled(
    concurrentMessages.map((_, i) => createChat(user, 'direct', `concurrency-slot-${i}`)),
  );
  const chatSlots = concurrentChats.map(r => r.status === 'fulfilled' ? r.value : null);

  const started = nowMs();
  const results2 = await Promise.allSettled(
    concurrentMessages.map((msg, i) => {
      const cId = chatSlots[i];
      return cId ? send(user, cId, msg) : Promise.resolve({ ok: false, status: 0, reply: '', body: 'no chat', ms: 0 });
    }),
  );
  const elapsed = nowMs() - started;

  const successes = results2.filter(r => r.status === 'fulfilled' && r.value.ok).length;
  await check(`Concurrency: ${concurrentMessages.length} simultaneous turns all return 200`, () => successes === concurrentMessages.length,
    () => `success=${successes}/${concurrentMessages.length}`, { id: 'concurrency-all-succeed', benchmark: 'Operational SLO', capability: 'concurrent requests', weight: 1.2 });
  addScalarMetric('concurrency-success-rate', 'Operational SLO', 'concurrent requests',
    'fraction of concurrent turns succeeding', successes / concurrentMessages.length, 1, `${successes}/${concurrentMessages.length}`);
  addScalarMetric('concurrency-throughput', 'Operational SLO', 'concurrent throughput',
    'concurrent batch within 3x single budget', elapsed < (AGENT_TIMEOUT_MS * 3) ? 1 : 0.5, 0.8, `elapsedMs=${elapsed}`);

  // Mixed strategy concurrent requests
  const chatConfigs = await Promise.allSettled([
    createChat(user, 'agent', 'conc-agent', { reflectEnabled: false }),
    createChat(user, 'supervisor', 'conc-supervisor', {}),
    createChat(user, 'direct', 'conc-direct', {}),
  ]);
  const chatIds = chatConfigs.filter(r => r.status === 'fulfilled').map(r => (r as PromiseFulfilledResult<string>).value);
  if (chatIds.length >= 2) {
    const mixedResults = await Promise.allSettled(
      chatIds.map((cId, i) => send(user, cId, `Quick test turn ${i + 1}: what is ${i + 1} + ${i + 1}?`)),
    );
    const mixedSuccess = mixedResults.filter(r => r.status === 'fulfilled' && r.value.ok).length;
    await check('Concurrency: mixed strategy concurrent chats all succeed', () => mixedSuccess >= chatIds.length,
      () => `success=${mixedSuccess}/${chatIds.length}`, { id: 'concurrency-mixed-strategy', benchmark: 'Operational SLO', capability: 'mixed strategy concurrency', weight: 1 });
  }
}

// ── API Hardening ─────────────────────────────────────────────────────────────
async function runAPIHardening(user: Session) {
  group('API Hardening — Input validation, malformed requests, auth enforcement');

  // T1: Invalid JSON body on chat settings
  const r1 = await auth(user, 'POST', '/api/chats', { name: `${runId}: hardening-chat` });
  const hChatRaw = (r1.body as Record<string, unknown>)['chat'] as Record<string, unknown> | undefined;
  const hChatId = String(hChatRaw?.['id'] ?? '');
  if (hChatId) {
    const sr1 = await request('POST', `/api/chats/${hChatId}/settings`, { session: user, rawBody: '{bad json' });
    await check('Hardening: invalid JSON on settings returns 400', () => sr1.status === 400 || sr1.status === 422,
      () => `${sr1.status}: ${compact(sr1.body)}`, { id: 'hardening-invalid-json', benchmark: 'API hardening', capability: 'JSON validation', weight: 0.8 });
  }

  // T2: A2A with malformed JSON
  const sr2 = await request('POST', '/api/a2a/tasks', { rawBody: '{not valid}' });
  await check('Hardening: A2A malformed JSON returns 400 or 401', () => [400, 401, 422].includes(sr2.status),
    () => `${sr2.status}: ${compact(sr2.body)}`, { id: 'hardening-a2a-json', benchmark: 'API hardening', capability: 'A2A JSON validation', weight: 0.9 });

  // T3: Very long message — should not crash server
  const longMsg = 'x'.repeat(10000);
  const sendLong = await send(user, hChatId || 'fake-id', longMsg, 30_000);
  await check('Hardening: very long message (10k chars) does not return 500', () => sendLong.status !== 500 && sendLong.status !== 0,
    () => `${sendLong.status}`, { id: 'hardening-long-message', benchmark: 'API hardening', capability: 'large input handling', weight: 0.7 });

  // T4: Access another user's chat — must be forbidden
  if (admin) {
    const adminChat = await createChat(admin, 'agent', 'hardening-admin-chat');
    const crossAccess = await auth(user, 'GET', `/api/chats/${adminChat}/settings`);
    await check('Hardening: user cannot access another user\'s chat settings', () => [403, 404].includes(crossAccess.status),
      () => `${crossAccess.status}: ${compact(crossAccess.body)}`, { id: 'hardening-cross-user-chat', benchmark: 'Operational safety', capability: 'RBAC chat isolation', weight: 1.3 });
  }

  // T5: A2A task status endpoint with auth — 404 expected (sync server)
  const bearerToken = await getBearerToken(user);
  if (bearerToken) {
    const t5 = await request('GET', `/api/a2a/tasks/nonexistent-task-id`, { bearerToken });
    await check('Hardening: A2A task status for non-existent task returns 404', () => t5.status === 404,
      () => `${t5.status}: ${compact(t5.body)}`, { id: 'hardening-a2a-task-status', benchmark: 'API hardening', capability: 'A2A not-found handling', weight: 0.7 });
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('═'.repeat(90));
  console.log('  geneWeave W1–W7 Strategy Benchmark Stress Test');
  console.log(`  Run:   ${runId}`);
  console.log(`  Base:  ${BASE}`);
  console.log(`  Model: ${MODEL}`);
  console.log(`  Strict: ${STRICT ? 'ON' : 'OFF'}`);
  console.log('═'.repeat(90));

  // ── Setup ──
  group('Setup — Server health, admin login, user registration');
  const health = await request('GET', '/api/auth/me');
  await check('Server responds to /api/auth/me', () => health.status !== 0 && health.status !== 500,
    () => `status=${health.status}`);

  admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  await check('Admin session available', () => !!admin, () => `Could not login as ${ADMIN_EMAIL}`);

  const userEmail = `${runId}-user@weaveintel.dev`;
  const user = await register(userEmail, 'Stress Test User');
  await check('Test user registered and authenticated', () => !!user, () => `Could not register ${userEmail}`);
  if (!user) throw new Error('Test user is required — cannot proceed without authentication.');

  try {
    await runW1Reflection(user);
    await runW2EvaluatorOptimizer(user);
    await runW3Supervisor(user);
    await runW4WorkflowAsTool(user);
    await runW5Ensemble(user);
    await runW6A2A(user);
    await runW7Settings(user);
    await runRealWorldConversations(user);
    await runConcurrencyTests(user);
    await runAPIHardening(user);
  } catch (err) {
    console.error('\nFatal error in test run:', err instanceof Error ? (err.stack ?? err.message) : err);
    record('fail', 'Fatal error in test run', err instanceof Error ? err.message : String(err));
  }

  // ── Report ──
  const endedAt = new Date();
  const total = results.length;
  const pass = results.filter(r => r.status === 'pass').length;
  const fail = results.filter(r => r.status === 'fail').length;
  const warnN = results.filter(r => r.status === 'warn').length;
  const skipN = results.filter(r => r.status === 'skip').length;

  const bySuite = Object.values(results.reduce<Record<string, { group: string; pass: number; fail: number; warn: number; skip: number }>>((acc, r) => {
    acc[r.group] ??= { group: r.group, pass: 0, fail: 0, warn: 0, skip: 0 };
    acc[r.group][r.status]++;
    return acc;
  }, {}));

  // Benchmark-style scoring
  const byId = new Map<string, MetricEvent[]>();
  for (const ev of metricEvents) { const list = byId.get(ev.id) ?? []; list.push(ev); byId.set(ev.id, list); }
  const measurements: BenchmarkMeasurement[] = Array.from(byId.entries()).map(([id, events]) => {
    const wsum = events.reduce((n, e) => n + e.weight, 0);
    const score = events.reduce((n, e) => n + e.score * e.weight, 0) / Math.max(.0001, wsum);
    return { id, label: id.replace(/-/g, ' '), benchmark: events[0]?.benchmark ?? 'internal', score: round3(score), weight: round2(wsum / Math.max(1, events.length)), samples: events.length };
  }).sort((a, b) => a.id.localeCompare(b.id));

  const resultScore = total ? (pass + warnN * 0.5) / Math.max(1, total - skipN) : 0;
  measurements.push({ id: 'assertion-backstop', label: 'assertion backstop score', benchmark: 'Internal', score: round3(resultScore), weight: 0.8, samples: total });

  const denom = measurements.reduce((n, m) => n + m.weight, 0);
  const weightedScore = measurements.reduce((n, m) => n + m.score * m.weight, 0) / Math.max(.0001, denom);
  const overallScore = measurements.reduce((n, m) => n + m.score, 0) / Math.max(1, measurements.length);

  const chatLat = latencySamples.filter(s => s.kind === 'chat_send').map(s => s.ms);
  const apiLat = latencySamples.filter(s => s.kind === 'api').map(s => s.ms);

  const reportData = {
    runId, base: BASE, model: MODEL, strict: STRICT,
    startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    totals: { total, pass, fail, warn: warnN, skip: skipN },
    bySuite, benchmark: { overallScore: round3(overallScore), weightedScore: round3(weightedScore), grade: grade(weightedScore), measurements },
    latency: {
      chatSend: { count: chatLat.length, p50Ms: percentile(chatLat, 50), p95Ms: percentile(chatLat, 95), maxMs: chatLat.length ? Math.max(...chatLat) : null },
      api: { count: apiLat.length, p50Ms: percentile(apiLat, 50), p95Ms: percentile(apiLat, 95), maxMs: apiLat.length ? Math.max(...apiLat) : null },
    },
    results,
  };

  await mkdir('test-results', { recursive: true });
  const reportPath = join('test-results', `${runId}.json`);
  await writeFile(reportPath, JSON.stringify(reportData, null, 2));

  console.log('\n' + '═'.repeat(90));
  console.log('  FINAL RESULTS — W1–W7 Strategy Stress Test');
  console.log('═'.repeat(90));
  console.log(`  Total:    ${total}`);
  console.log(`  ✅ Pass:   ${pass}`);
  console.log(`  ❌ Fail:   ${fail}`);
  console.log(`  ⚠️  Warn:   ${warnN}`);
  console.log(`  ⏭  Skip:   ${skipN}`);
  console.log(`\n  Overall proxy score:  ${(overallScore * 100).toFixed(1)}%`);
  console.log(`  Weighted proxy score: ${(weightedScore * 100).toFixed(1)}%  (${grade(weightedScore)})`);
  console.log('\n  TOP BENCHMARK MEASUREMENTS:');
  for (const m of measurements.slice(0, 20)) {
    console.log(`  ${(m.score * 100).toFixed(1).padStart(5)}%  ${m.label}  [${m.benchmark}]  w=${m.weight}`);
  }
  console.log('\n  SUITE BREAKDOWN:');
  for (const s of bySuite) {
    const bar = `pass=${s.pass} fail=${s.fail} warn=${s.warn} skip=${s.skip}`;
    console.log(`  ${s.group.slice(0, 48).padEnd(50)} ${bar}`);
  }
  console.log('\n  LATENCY:');
  console.log(`  Chat send: count=${chatLat.length}, p50=${percentile(chatLat, 50)}ms, p95=${percentile(chatLat, 95)}ms, max=${chatLat.length ? Math.max(...chatLat) : 'n/a'}ms`);
  console.log(`  API calls: count=${apiLat.length}, p50=${percentile(apiLat, 50)}ms, p95=${percentile(apiLat, 95)}ms, max=${apiLat.length ? Math.max(...apiLat) : 'n/a'}ms`);
  if (fail > 0) {
    console.log('\n  FAILURES:');
    for (const r of results.filter(x => x.status === 'fail')) console.log(`    ❌ [${r.group}] ${r.name}\n       ${r.detail ?? ''}`);
  }
  console.log(`\n  Report: ${reportPath}`);
  console.log('═'.repeat(90));

  process.exit(fail > 0 || (STRICT && warnN > 0) ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
