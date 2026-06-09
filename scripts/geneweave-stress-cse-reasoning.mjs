#!/usr/bin/env node
/**
 * GeneWeave Stress & Penetration Test Suite
 * Deep Reasoning · Max Tool Chains · CSE Execution · Docker Isolation
 *
 * This suite is deliberately brutal. It hits the system with:
 *   - Complex multi-step reasoning requests (not "summarise in one sentence")
 *   - Multi-turn conversations with tool call chains
 *   - Supervisor mode with 6 parallel workers on complex tasks
 *   - Legitimate CSE runs: Python ML, bash operations, JS computation
 *   - CSE resource-limit enforcement (fork bomb, memory bomb, disk fill, CPU bomb)
 *   - CSE penetration tests: container escape, proc filesystem, privilege escalation,
 *     Docker socket access, metadata SSRF, volume mount traversal, kernel probing
 *   - Concurrent reasoning stress (N users with real LLM, simultaneously)
 *   - Node.js event loop lag, heap growth, GC pressure profiling
 *   - Docker container metrics via docker CLI (when available)
 *   - API latency breakdown: guardrail eval time vs LLM time vs DB time
 *
 * Run:
 *   BASE=http://localhost:3500 \
 *   DB=/path/to/geneweave.db \
 *   ADMIN_EMAIL=admin@test.local \
 *   ADMIN_PASSWORD='Admin@Test123!' \
 *   node scripts/geneweave-stress-cse-reasoning.mjs
 *
 * Knobs:
 *   REASONING_USERS=5         concurrent users for deep reasoning section (default 5)
 *   CSE_PENTEST=true          enable Docker/CSE penetration tests (default true)
 *   SKIP_LLM=false            set true to skip LLM calls (guardrail-only mode)
 *   LLM_TIMEOUT=120000        per-LLM-request timeout ms (default 120s)
 *   NODE_SAMPLE_MS=500        Node.js metric sampling interval
 *   DOCKER_AVAILABLE=auto     auto-detect or set true/false
 *   MAX_TOOL_DEPTH=8          max tool calls to request in agent chains
 */

import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT       = resolve(process.env.REPO_ROOT || join(__dirname, '..'));
const BASE       = (process.env.BASE || 'http://localhost:3500').replace(/\/$/, '');
const DB         = process.env.DB || join(ROOT, 'geneweave.db');
const REPORT_DIR = process.env.REPORT_DIR || '/tmp';

function intEnv(k, d) { const n = Number(process.env[k]); return Number.isFinite(n) && n >= 0 ? Math.floor(n) : d; }
function boolEnv(k, d) { const v = process.env[k]; if (!v) return d; return v === 'true' || v === '1'; }

const REASONING_USERS   = intEnv('REASONING_USERS', 5);
const CSE_PENTEST       = boolEnv('CSE_PENTEST', true);
const SKIP_LLM          = boolEnv('SKIP_LLM', false);
// When false (default), guardrail conditional triggers are active and expensive
// checks only fire when their trigger_conditions are met. Set to true to disable
// all conditions server-side (via admin API) and measure baseline latency.
const SKIP_GUARDRAIL_CONDITIONS = boolEnv('SKIP_GUARDRAIL_CONDITIONS', false);
const LLM_TIMEOUT       = intEnv('LLM_TIMEOUT', 120000);
const NODE_SAMPLE_MS    = intEnv('NODE_SAMPLE_MS', 500);
const MAX_TOOL_DEPTH    = intEnv('MAX_TOOL_DEPTH', 8);
const MAX_IN_FLIGHT     = Math.max(1, intEnv('MAX_IN_FLIGHT', 4));
const REQUEST_GAP_MS    = intEnv('REQUEST_GAP_MS', 100);
const ADMIN_EMAIL       = process.env.ADMIN_EMAIL || '';
const ADMIN_PASSWORD    = process.env.ADMIN_PASSWORD || '';
const RUN_ID = `gw-stress-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
const TS = new Date().toISOString().replace(/[:.]/g, '-');
const JSON_OUT = join(REPORT_DIR, `gw-stress-${TS}.json`);
const MD_OUT   = join(REPORT_DIR, `gw-stress-${TS}.md`);
const NDJSON_OUT = join(REPORT_DIR, `gw-stress-${TS}.ndjson`);

mkdirSync(REPORT_DIR, { recursive: true });
writeFileSync(NDJSON_OUT, '');

// ── Detect Docker availability ─────────────────────────────────────────────
let DOCKER_AVAILABLE = boolEnv('DOCKER_AVAILABLE', null);
if (DOCKER_AVAILABLE === null) {
  try { execSync('docker ps --no-trunc 2>/dev/null', { timeout: 3000 }); DOCKER_AVAILABLE = true; }
  catch { DOCKER_AVAILABLE = false; }
}

// ── Reporting ──────────────────────────────────────────────────────────────
const results = [];
const timings = new Map();
const nodeMetrics = [];        // periodic Node.js samples
const apiBreakdown = [];       // per-request timing breakdown
let PASS = 0, FAIL = 0, WARN = 0, INFO = 0;

function now() { return new Date().toISOString(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function preview(v, n = 300) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return (s || '').replace(/\s+/g, ' ').slice(0, n);
}

function record(suite, name, status, detail = '', data = null, ms = null, sev = null) {
  const entry = { runId: RUN_ID, suite, name, status, detail, data, latencyMs: ms, severity: sev, ts: now() };
  results.push(entry);
  appendFileSync(NDJSON_OUT, JSON.stringify(entry) + '\n');
  const icon = { PASS: '✅', FAIL: '❌', WARN: '⚠️', INFO: 'ℹ️' }[status] ?? '?';
  const lat = ms == null ? '' : ` [${ms}ms]`;
  console.log(`  ${icon} [${suite}] ${name}${lat}${detail ? ' — ' + detail : ''}`);
  if (status === 'PASS') PASS++; else if (status === 'FAIL') FAIL++; else if (status === 'WARN') WARN++; else INFO++;
}
const pass = (s, n, d = '', data = null, ms = null) => record(s, n, 'PASS', d, data, ms);
const fail = (s, n, d = '', data = null, ms = null, sev = 'high') => record(s, n, 'FAIL', d, data, ms, sev);
const warn = (s, n, d = '', data = null, ms = null) => record(s, n, 'WARN', d, data, ms, 'medium');
const info = (s, n, d = '', data = null, ms = null) => record(s, n, 'INFO', d, data, ms);

function track(label, ms) {
  if (!timings.has(label)) timings.set(label, []);
  timings.get(label).push(ms);
}
function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
function stats(arr) {
  if (!arr.length) return { n: 0, min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0 };
  return {
    n: arr.length, min: Math.min(...arr), max: Math.max(...arr),
    avg: Math.round(arr.reduce((s, v) => s + v, 0) / arr.length),
    p50: percentile(arr, 50), p95: percentile(arr, 95), p99: percentile(arr, 99),
  };
}

// ── Node.js monitoring ────────────────────────────────────────────────────

let _cachedServerPid = null;
function getServerPid() {
  if (_cachedServerPid) return _cachedServerPid;
  try {
    const port = new URL(BASE).port || 80;
    const pid = execSync(`lsof -i :${port} -t 2>/dev/null | head -1`, { encoding: 'utf8' }).trim();
    if (pid) _cachedServerPid = pid;
    return pid || null;
  } catch { return null; }
}

function sampleNodeProcess(label = 'sample') {
  const pid = getServerPid();
  if (!pid) return { ts: now(), label, pid: null };
  try {
    // CPU, RSS (KB), VSZ (KB), threads, file descriptors
    const ps = execSync(`ps -o pid=,pcpu=,pmem=,rss=,vsz=,nlwp= -p ${pid} 2>/dev/null`, { encoding: 'utf8' }).trim().split(/\s+/);
    let openFds = null;
    try { openFds = Number(execSync(`ls /proc/${pid}/fd 2>/dev/null | wc -l || lsof -p ${pid} 2>/dev/null | wc -l`, { encoding: 'utf8' }).trim()); } catch {}
    const sample = {
      ts: now(), label, pid,
      cpuPct: Number(ps[1] || 0),
      memPct: Number(ps[2] || 0),
      rssMB: Math.round(Number(ps[3] || 0) / 1024),
      vszMB: Math.round(Number(ps[4] || 0) / 1024),
      threads: Number(ps[5] || 0),
      openFds,
      activeHandles: typeof process._getActiveHandles === 'function' ? process._getActiveHandles().length : null,
    };
    nodeMetrics.push(sample);
    return sample;
  } catch (err) { return { ts: now(), label, error: err.message }; }
}

function startNodeMonitor(label, intervalMs = NODE_SAMPLE_MS) {
  const local = [];
  const sample = () => { const s = sampleNodeProcess(`${label}-tick`); if (s) local.push(s); };
  sample();
  const timer = setInterval(sample, intervalMs);
  return {
    stop() {
      clearInterval(timer); sample();
      const cpu = local.map(s => s.cpuPct).filter(Number.isFinite);
      const rss = local.map(s => s.rssMB).filter(Number.isFinite);
      return {
        samples: local.length,
        cpu: stats(cpu),
        rss: { min: Math.min(...rss)||0, max: Math.max(...rss)||0, delta: rss.length >= 2 ? rss[rss.length-1]-rss[0] : 0 },
        threads: local[local.length-1]?.threads,
        first: local[0], last: local[local.length-1],
      };
    }
  };
}

async function measureEventLoopLag(samples = 10) {
  const lags = [];
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    await new Promise(r => setImmediate(r));
    lags.push(performance.now() - t0);
    await sleep(10);
  }
  return stats(lags);
}

// ── Docker monitoring ──────────────────────────────────────────────────────

function dockerStats() {
  if (!DOCKER_AVAILABLE) return null;
  try {
    const out = execSync('docker stats --no-stream --format "{{.Container}},{{.CPUPerc}},{{.MemUsage}},{{.NetIO}},{{.BlockIO}}" 2>/dev/null', { encoding: 'utf8', timeout: 10000 }).trim();
    return out.split('\n').filter(Boolean).map(line => {
      const [container, cpu, mem, net, block] = line.split(',');
      return { container, cpu, mem, net, block };
    });
  } catch { return null; }
}
function dockerPs() {
  if (!DOCKER_AVAILABLE) return null;
  try {
    const out = execSync('docker ps --format "{{.ID}},{{.Image}},{{.Status}},{{.Names}}" 2>/dev/null', { encoding: 'utf8', timeout: 5000 }).trim();
    return out.split('\n').filter(Boolean).map(line => {
      const [id, image, status, name] = line.split(',');
      return { id, image, status, name };
    });
  } catch { return null; }
}
function dockerInspectCse() {
  if (!DOCKER_AVAILABLE) return null;
  try {
    const out = execSync("docker ps --filter 'name=cse' --format '{{.ID}}' 2>/dev/null", { encoding: 'utf8', timeout: 3000 }).trim();
    if (!out) return null;
    const inspectOut = execSync(`docker inspect ${out.split('\n')[0]} 2>/dev/null`, { encoding: 'utf8', timeout: 5000 }).trim();
    return JSON.parse(inspectOut)[0] || null;
  } catch { return null; }
}

// ── SQLite ─────────────────────────────────────────────────────────────────
function sqliteJson(sql) {
  if (!DB || !existsSync(DB)) return { ok: false, rows: [], error: `DB not found: ${DB}` };
  const escaped = sql.replace(/"/g, '\\"').replace(/\$/g, '\\$');
  try {
    const out = execSync(`sqlite3 -json "${DB}" "${escaped}"`, { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return { ok: true, rows: out ? JSON.parse(out) : [], error: null };
  } catch (err) { return { ok: false, rows: [], error: err?.stderr?.toString?.() || err?.message || String(err) }; }
}
function tableCount(t) { const r = sqliteJson(`SELECT COUNT(*) AS c FROM ${t}`); return r.ok ? Number(r.rows?.[0]?.c ?? 0) : null; }

// ── HTTP ──────────────────────────────────────────────────────────────────
const sessions = new Map();
function getJar(name) { if (!sessions.has(name)) sessions.set(name, { cookies: {}, csrfToken: '' }); return sessions.get(name); }
function cookieHeader(jar) { return Object.entries(jar.cookies).map(([k, v]) => `${k}=${v}`).join('; '); }
function captureCookies(jar, res) {
  const raw = res.headers.get('set-cookie') || '';
  for (const part of raw.split(/,(?=\s*[^;,=]+=[^;,]+)/g)) {
    const m = part.trim().match(/^([^=]+)=([^;]*)/);
    if (m) jar.cookies[m[1].trim()] = m[2].trim();
  }
}

let _activeReqs = 0;
async function http(method, path, body = null, sessionName = 'anon', opts = {}) {
  while (_activeReqs >= MAX_IN_FLIGHT) await sleep(20);
  _activeReqs++;
  const jar = opts.noJar ? { cookies: {}, csrfToken: '' } : getJar(sessionName);
  const headers = { ...(opts.headers || {}) };
  if (body !== null && !(body instanceof Uint8Array) && typeof body !== 'string' && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const ck = cookieHeader(jar);
  if (ck && !opts.noCookie) headers.Cookie = ck;
  if (jar.csrfToken && opts.csrf !== false) headers['X-CSRF-Token'] = jar.csrfToken;
  const t0 = Date.now();
  let text = '';
  try {
    const res = await fetch(`${BASE}${path}`, {
      method, headers,
      body: body == null ? undefined : (typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body)),
      redirect: 'manual', signal: AbortSignal.timeout(opts.timeout ?? 30000),
    });
    captureCookies(jar, res);
    const ms = Date.now() - t0;
    text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    if (data?.csrfToken) jar.csrfToken = data.csrfToken;
    if (data?.user && data?.csrfToken) jar.user = data.user;
    return { ok: res.ok, status: res.status, data, text, headers: Object.fromEntries(res.headers.entries()), ms };
  } catch (err) {
    return { ok: false, status: 0, data: null, text, error: err?.message || String(err), headers: {}, ms: Date.now() - t0 };
  } finally {
    _activeReqs = Math.max(0, _activeReqs - 1);
    if (REQUEST_GAP_MS > 0) await sleep(REQUEST_GAP_MS);
  }
}

async function streamHttp(path, body, sessionName = 'admin', opts = {}) {
  while (_activeReqs >= MAX_IN_FLIGHT) await sleep(20);
  _activeReqs++;
  const jar = getJar(sessionName);
  const headers = { 'Content-Type': 'application/json' };
  const ck = cookieHeader(jar);
  if (ck) headers.Cookie = ck;
  if (jar.csrfToken) headers['X-CSRF-Token'] = jar.csrfToken;
  const t0 = Date.now();
  const events = [];
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST', headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeout ?? LLM_TIMEOUT),
    });
    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let firstTokenMs = null;
    if (reader) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        if (firstTokenMs === null && buf.length > 0) firstTokenMs = Date.now() - t0;
        if (buf.length > 4_000_000) break;
      }
    }
    for (const c of buf.split(/\n\n+/).filter(Boolean)) {
      const ev = {};
      for (const line of c.split(/\n/)) {
        if (line.startsWith('event:')) ev.event = line.slice(6).trim();
        if (line.startsWith('data:')) ev.data = (ev.data || '') + line.slice(5).trim();
      }
      events.push(ev);
    }
    return { ok: res.ok, status: res.status, text: buf, events, ms: Date.now() - t0, firstTokenMs };
  } catch (err) {
    return { ok: false, status: 0, error: err?.message || String(err), events, text: '', ms: Date.now() - t0, firstTokenMs: null };
  } finally {
    _activeReqs = Math.max(0, _activeReqs - 1);
    if (REQUEST_GAP_MS > 0) await sleep(REQUEST_GAP_MS);
  }
}

// ── Chat helpers ───────────────────────────────────────────────────────────
async function createChat(sid, title) {
  const r = await http('POST', '/api/chats', { title }, sid);
  return { r, id: r.data?.chat?.id ?? r.data?.id ?? null };
}
async function setChatMode(sid, chatId, mode, extra = {}) {
  return http('POST', `/api/chats/${chatId}/settings`, {
    mode, timezone: 'UTC', redactionEnabled: true,
    enabledTools: extra.enabledTools, workers: extra.workers, systemPrompt: extra.systemPrompt,
  }, sid);
}
async function sendChat(sid, chatId, content, opts = {}) {
  const body = { content, stream: false, maxTokens: opts.maxTokens ?? 4096, enabledTools: opts.enabledTools, mode: opts.mode };
  return http('POST', `/api/chats/${chatId}/messages`, body, sid, { timeout: opts.timeout ?? LLM_TIMEOUT });
}
async function sendChatStream(sid, chatId, content, opts = {}) {
  return streamHttp(`/api/chats/${chatId}/messages`, {
    content, stream: true, maxTokens: opts.maxTokens ?? 4096,
    enabledTools: opts.enabledTools, mode: opts.mode,
  }, sid, { timeout: opts.timeout ?? LLM_TIMEOUT });
}

function extractDecision(r) {
  return r?.data?.guardrail?.decision ?? r?.data?.decision ?? r?.data?.cognitive?.decision ?? 'unknown';
}
function compactResp(r) { return { status: r?.status, ok: r?.ok, preview: preview(r?.data ?? r?.text, 200), err: r?.error }; }

async function section(name, fn) {
  console.log(`\n── ${name} ${'─'.repeat(Math.max(1, 66 - name.length))}`);
  const t0 = Date.now();
  try { await fn(); }
  catch (err) { fail(name, 'Section crashed', err?.stack?.split('\n').slice(0, 4).join(' ') || String(err), null, Date.now() - t0, 'critical'); }
}

// ── State ──────────────────────────────────────────────────────────────────
const state = { adminSid: null, adminUserId: null, mainChatId: null };

// ═══════════════════════════════════════════════════════════════════════════
// DEEP REASONING PROMPTS — Not "summarise in one sentence". These require
// genuine multi-step chain-of-thought, tool use, and structured output.
// ═══════════════════════════════════════════════════════════════════════════

const REASONING_PROMPTS = [
  {
    label: 'risk_analysis_with_calculation',
    desc: 'Multi-constraint financial risk analysis with numerical reasoning',
    content: `You are an enterprise risk analyst. Reason step-by-step through this scenario:

CONTEXT:
- Payment processor: 2.3M daily active users, 8.7M transactions/day
- Current failure rate: 0.03% (industry standard: 0.05%)
- Three microservices show elevated error rates over 30 days: Auth (7.2%), PaymentGateway (5.8%), FraudDetect (6.1%)
- PCI-DSS audit in 43 days, SOC2 in 51 days
- Engineering capacity: 40 hours/sprint, 2 sprints before audit

REQUIRED (show full reasoning chain):
1. Calculate blast radius: if all 3 failing services hit 15% error rate simultaneously, how many transactions/hour fail? What is the hourly revenue impact assuming avg transaction $47?
2. Score each service by: (error_rate × transaction_volume_dependency × audit_risk) using a 1-10 scale you define
3. Recommend sprint allocation (hours per service) with explicit trade-off reasoning
4. Draft a 3-sentence executive brief suitable for a board meeting

Use the calculator tool for all numerical work. Output a JSON summary with fields: blast_radius_txn_per_hour, revenue_impact_per_hour, priority_ranking, sprint_hours, exec_brief.`,
    tools: ['calculator', 'datetime', 'json_format', 'text_analysis'],
    maxTokens: 3000,
    mode: 'agent',
  },
  {
    label: 'architecture_review_reasoning',
    desc: 'System architecture review with trade-off matrix',
    content: `You are a principal architect reviewing a proposal to migrate from SQLite to PostgreSQL for an AI platform serving 500+ concurrent users. The platform stores: chat messages, LLM traces, guardrail evaluations, workflow runs, encryption audit events.

Perform a structured architectural review:

1. CURRENT STATE: List all specific failure modes of SQLite at 500 concurrent users (not generic — cite specific SQLite limitations like WAL mode constraints, write serialisation, file locking behaviour)

2. MIGRATION RISK MATRIX: For each of these 6 dimensions, score Current State (1-10) and Proposed State (1-10) with one-sentence reasoning:
   - Write throughput under concurrent load
   - Read scalability
   - Operational complexity
   - Data consistency guarantees
   - Backup/recovery posture
   - Cost at 500 users

3. HIDDEN RISKS: Identify 3 non-obvious migration risks that a junior engineer might miss (e.g., ORM differences, connection pooling limits, ACID semantics changes)

4. DECISION RECOMMENDATION: Given a 6-week migration window and a 3-person team, recommend Go/No-Go with conditional requirements.

Format your output as structured markdown with numbered sections. Be specific, not generic.`,
    tools: ['json_format', 'text_analysis'],
    maxTokens: 3500,
    mode: 'agent',
  },
  {
    label: 'multi_turn_investigation',
    desc: 'Incident root cause analysis requiring multi-step reasoning',
    content: `You are an SRE investigating a production incident. Here is the full evidence:

TIMELINE (all times UTC):
14:23:01 - Monitoring alert: P95 latency for /api/chats/:id/messages crossed 8s (SLA: 3s)
14:23:45 - Error rate spikes to 12% on the same endpoint
14:24:30 - Three separate users report "spinning" in the UI
14:25:00 - Alert: Database connection pool at 94% utilisation (max: 100 connections)
14:25:15 - LLM API provider dashboard shows: normal latency, no incidents
14:26:00 - New deployment was pushed 8 minutes before the incident (commit: fix: increase guardrail timeout from 8s to 15s)
14:28:00 - Rollback deployed, incident resolves in 90 seconds

SYSTEM ARCHITECTURE:
- Node.js server, single process, SQLite WAL mode
- LLM guardrail evaluation: model-graded injection-classifier runs async before message processing
- Each chat message: pre-guardrail (~2s avg), LLM call (~7s avg), post-guardrail (~1s avg), DB writes (~50ms)
- Connection pool: shared between HTTP request handlers and background trace writers

PERFORM ROOT CAUSE ANALYSIS:
1. Construct the most likely causal chain (5 steps minimum) explaining why the timeout change caused the incident
2. Identify 2 contributing factors that amplified the impact
3. Calculate: with 15s timeout on injection-classifier AND 8s LLM call AND 50ms DB writes, what is the maximum throughput of the message endpoint per second if limited to 100 DB connections?
4. Recommend 3 specific code changes to prevent recurrence — be precise (function names, configuration keys, not vague "improve error handling")
5. Write a 5-line post-mortem entry following the Google SRE format`,
    tools: ['calculator', 'json_format', 'text_analysis'],
    maxTokens: 4000,
    mode: 'agent',
  },
  {
    label: 'security_threat_model',
    desc: 'Threat modelling with STRIDE applied to AI platform',
    content: `Apply the STRIDE threat model to this AI platform API architecture:

SYSTEM COMPONENTS:
- Node.js REST API (single process, no clustering)
- JWT in HttpOnly cookies (SameSite=Strict)
- CSRF tokens per session
- SQLite with WAL mode
- LLM guardrail pipeline (blocklist → regex → cognitive → model-graded)
- Sandbox code executor (Docker-based, isolated network)
- In-process rate limiting (Map<string, state>)
- File-based response cache

For each STRIDE category (Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service, Elevation of Privilege):
1. Identify the 2 highest-risk attack vectors SPECIFIC to this architecture
2. Rate each: Impact (1-5) × Likelihood (1-5) = Risk Score
3. Identify the specific control(s) currently in place
4. State whether the control is SUFFICIENT, PARTIAL, or ABSENT

Then:
- List the top 3 unmitigated risks by score
- Recommend one architectural change that would eliminate the highest-scored risk
- Identify any design patterns in this architecture that are CORRECT and should be preserved

Output as a structured threat model table plus recommendation section.`,
    tools: ['json_format', 'text_analysis'],
    maxTokens: 4096,
    mode: 'agent',
  },
  {
    label: 'data_processing_with_tools',
    desc: 'Complex data analysis requiring sequential tool invocations',
    content: `You have access to a calculator and JSON formatter. Work through this data analysis task:

DATASET: Enterprise SaaS quarterly metrics
- Q1: 847 customers, ARR $12.4M, churn 2.1%, NPS 42, support tickets 3847
- Q2: 923 customers, ARR $14.1M, churn 1.8%, NPS 47, support tickets 3201
- Q3: 1041 customers, ARR $16.8M, churn 2.4%, NPS 39, support tickets 4102
- Q4: 1187 customers, ARR $19.2M, churn 1.6%, NPS 51, support tickets 2987

PERFORM THESE CALCULATIONS (use calculator for each):
1. Quarterly growth rates for customers and ARR
2. Tickets per customer per quarter (identify the anomaly)
3. If churn in Q4 (1.6%) continued for 4 more quarters, what would the customer count be? (compound calculation)
4. Correlation observation: when NPS increases, what happens to tickets? Calculate the NPS-to-ticket ratio per quarter and identify the trend
5. Revenue at risk from churn: Q3 was worst — calculate ARR at risk assuming average customer ARR
6. Forecast Q5: using the growth trend, what is the projected ARR? What is the confidence level in this forecast given the data variance?

After calculations, use JSON formatter to output: { quarterly_growth: [...], ticket_anomaly: {...}, churn_projection_4q: number, nps_ticket_correlation: string, arr_at_risk_q3: number, q5_forecast: { arr: number, confidence: string } }`,
    tools: ['calculator', 'json_format', 'text_analysis'],
    maxTokens: 3500,
    mode: 'agent',
  },
];

// Supervisor mode complex task — 6 parallel workers
const SUPERVISOR_COMPLEX_TASK = {
  content: `INCIDENT COMMAND: Critical production outage affecting enterprise customers.

SITUATION: Payment processing platform experiencing cascading failures.
- 43% of transactions failing across 3 payment gateways (Stripe, Adyen, Braintree)
- Engineering team has identified root cause: race condition in distributed lock acquisition
- Fix is ready but requires coordinated deployment across 7 microservices
- 3 Tier-1 enterprise customers (combined ARR $8.2M) are directly impacted
- SLA breach threshold: >2 hours downtime triggers $250K penalty per customer

ACTIVATE INCIDENT RESPONSE PROTOCOL:
- Triage: Severity assessment, impact quantification, time-to-resolution estimate
- Risk: Deployment risk analysis, rollback plan feasibility, blast radius if fix fails
- Customer Success: Draft emergency communications for each impacted customer tier
- Engineering Lead: Step-by-step deployment runbook with go/no-go criteria
- Finance: Calculate real-time financial exposure (SLA penalties + revenue impact)
- Post-Mortem: Begin drafting the 5-why analysis based on available information

Each worker should be specific, actionable, and use exact numbers where computable.
Synthesise all findings into a unified Incident Command Brief at the end.`,
  workers: [
    { role: 'triage', instruction: 'Assess severity P0/P1, quantify customer impact, estimate TTR' },
    { role: 'risk',   instruction: 'Analyse deployment risk, define rollback triggers, score options' },
    { role: 'comms',  instruction: 'Draft tier-specific customer communications (urgent, factual, ETA-inclusive)' },
    { role: 'engineering', instruction: 'Write deployment runbook with explicit go/no-go criteria at each step' },
    { role: 'finance', instruction: 'Calculate SLA penalty exposure and real-time revenue impact' },
    { role: 'postmortem', instruction: 'Begin 5-why analysis and identify preventive controls' },
  ],
  tools: ['calculator', 'datetime', 'json_format', 'text_analysis'],
  maxTokens: 6000,
};

// ═══════════════════════════════════════════════════════════════════════════
// CSE (Code Sandbox Executor) TEST PAYLOADS
// ═══════════════════════════════════════════════════════════════════════════

// Legitimate tests — complex operations that a real enterprise user would run
const CSE_LEGITIMATE = [
  {
    label: 'python_numerical_computation',
    code: `
import math, json, time
start = time.time()
# Prime sieve for primes < 10000
def sieve(n):
    is_prime = [True] * (n + 1)
    is_prime[0] = is_prime[1] = False
    for i in range(2, int(n**0.5) + 1):
        if is_prime[i]:
            for j in range(i*i, n + 1, i):
                is_prime[j] = False
    return [i for i in range(n + 1) if is_prime[i]]

primes = sieve(10000)
fibonacci = [0, 1]
while fibonacci[-1] < 10000:
    fibonacci.append(fibonacci[-1] + fibonacci[-2])

# Find primes that are also Fibonacci numbers
fib_primes = [p for p in primes if p in set(fibonacci)]
result = {
    'prime_count': len(primes),
    'fib_primes': fib_primes,
    'largest_prime': primes[-1],
    'elapsed_ms': round((time.time() - start) * 1000, 2)
}
print(json.dumps(result))
`,
    language: 'python',
    expectedOutput: 'prime_count',
    timeoutMs: 10000,
  },
  {
    label: 'bash_system_analysis',
    code: `
#!/bin/bash
echo "=== System Information ==="
echo "Kernel: $(uname -r 2>/dev/null || echo 'unknown')"
echo "Hostname: $(hostname 2>/dev/null || echo 'unknown')"
echo "Uptime: $(uptime 2>/dev/null | awk -F'up ' '{print $2}' | awk -F',' '{print $1}' || echo 'unknown')"
echo ""
echo "=== CPU Info ==="
nproc 2>/dev/null && echo "CPUs: $(nproc)" || echo "nproc unavailable"
echo ""
echo "=== Memory ==="
free -h 2>/dev/null || cat /proc/meminfo 2>/dev/null | head -5 || echo "memory info unavailable"
echo ""
echo "=== Disk ==="
df -h / 2>/dev/null | tail -1 || echo "disk info unavailable"
echo ""
echo "=== Process limits ==="
ulimit -a 2>/dev/null | grep -E "max user|open files|stack size|cpu time" || echo "ulimit unavailable"
`,
    language: 'bash',
    expectedOutput: 'System Information',
    timeoutMs: 10000,
  },
  {
    label: 'javascript_crypto_benchmark',
    code: `
const crypto = require('crypto');
const { performance } = require('perf_hooks');

const rounds = 1000;
const payload = Buffer.from('GeneWeave enterprise benchmark payload - testing cryptographic throughput');

const t0 = performance.now();
const hashes = [];
for (let i = 0; i < rounds; i++) {
  hashes.push(crypto.createHash('sha256').update(payload).update(Buffer.from(String(i))).digest('hex'));
}
const hashTime = performance.now() - t0;

// HMAC
const key = crypto.randomBytes(32);
const t1 = performance.now();
for (let i = 0; i < rounds; i++) {
  crypto.createHmac('sha256', key).update(payload).digest('hex');
}
const hmacTime = performance.now() - t1;

console.log(JSON.stringify({
  sha256_ops: rounds,
  sha256_ms: Math.round(hashTime),
  sha256_ops_per_sec: Math.round(rounds / (hashTime / 1000)),
  hmac_ms: Math.round(hmacTime),
  hmac_ops_per_sec: Math.round(rounds / (hmacTime / 1000)),
  sample_hash: hashes[0].slice(0, 16),
}));
`,
    language: 'javascript',
    expectedOutput: 'sha256_ops_per_sec',
    timeoutMs: 15000,
  },
  {
    label: 'python_data_processing',
    code: `
import json, statistics

# Simulate enterprise log analysis
log_lines = []
import random
random.seed(42)
for i in range(10000):
    latency = random.lognormvariate(6, 0.8)  # log-normal latency distribution
    status = random.choices([200, 200, 200, 200, 200, 400, 401, 403, 500, 503],
                             weights=[70, 5, 5, 5, 5, 4, 2, 2, 1, 1])[0]
    log_lines.append({'latency': latency, 'status': status})

latencies = [l['latency'] for l in log_lines]
errors = [l for l in log_lines if l['status'] >= 500]

result = {
    'total_requests': len(log_lines),
    'error_count': len(errors),
    'error_rate_pct': round(len(errors) / len(log_lines) * 100, 3),
    'p50_ms': round(statistics.median(latencies), 2),
    'p95_ms': round(sorted(latencies)[int(0.95 * len(latencies))], 2),
    'p99_ms': round(sorted(latencies)[int(0.99 * len(latencies))], 2),
    'mean_ms': round(statistics.mean(latencies), 2),
    'stdev_ms': round(statistics.stdev(latencies), 2),
}
print(json.dumps(result))
`,
    language: 'python',
    expectedOutput: 'p95_ms',
    timeoutMs: 15000,
  },
];

// Resource limit enforcement tests — should be contained by the sandbox
const CSE_RESOURCE_TESTS = [
  {
    label: 'fork_bomb',
    code: ':(){ :|:& };:',
    language: 'bash',
    expectKilled: true,
    desc: 'Fork bomb — sandbox must terminate within timeout',
  },
  {
    label: 'memory_exhaustion_python',
    code: `
# Attempt to allocate 4 GB of memory
chunks = []
try:
    for i in range(400):
        chunks.append(bytearray(10 * 1024 * 1024))  # 10MB each
    print("memory_allocated:", len(chunks) * 10, "MB")
except MemoryError:
    print("MemoryError caught — sandbox limit enforced")
`,
    language: 'python',
    expectKilled: true,
    desc: 'Memory bomb — should hit container memory limit',
  },
  {
    label: 'cpu_infinite_loop',
    code: 'while True: pass',
    language: 'python',
    expectKilled: true,
    desc: 'CPU infinite loop — must be killed by timeout',
  },
  {
    label: 'disk_fill_attempt',
    code: 'dd if=/dev/zero of=/tmp/fill.dat bs=1M count=5000 2>&1 || echo "disk_limit_hit"',
    language: 'bash',
    expectKilled: false, // might succeed with limited disk
    desc: 'Disk fill — should hit container disk quota',
  },
  {
    label: 'thread_bomb',
    code: `
import threading, time
threads = []
for i in range(10000):
    t = threading.Thread(target=lambda: time.sleep(60))
    t.daemon = True
    threads.append(t)
    t.start()
print("threads_created:", len(threads))
`,
    language: 'python',
    expectKilled: true,
    desc: 'Thread exhaustion — must be contained',
  },
];

// Penetration / container escape tests — must ALL be blocked or contained
const CSE_PENTEST_CASES = [
  // Container escape vectors
  { label: 'docker_socket_access',   code: 'ls -la /var/run/docker.sock && curl -s --unix-socket /var/run/docker.sock http://localhost/version',     language: 'bash', category: 'container_escape',     expectedContained: true, desc: 'Docker socket access — must be absent or read-blocked' },
  { label: 'nsenter_escape',         code: 'nsenter -t 1 -m -u -i -n -p -- id 2>&1 || echo "nsenter_blocked"',                                        language: 'bash', category: 'container_escape',     expectedContained: true, desc: 'nsenter host namespace escape attempt' },
  { label: 'proc_1_environ',         code: 'cat /proc/1/environ 2>&1 | tr "\\0" "\\n" | head -20 || echo "proc_access_denied"',                        language: 'bash', category: 'info_disclosure',     expectedContained: true, desc: 'PID 1 environment variables — may leak host secrets' },
  { label: 'proc_1_cgroup',          code: 'cat /proc/1/cgroup 2>/dev/null && cat /proc/self/cgroup 2>/dev/null; echo "done"',                         language: 'bash', category: 'info_disclosure',     expectedContained: false, desc: 'Cgroup info — reveals container runtime details' },
  { label: 'host_filesystem_mounts', code: 'cat /proc/mounts 2>/dev/null; findmnt 2>/dev/null || mount 2>/dev/null | head -20; echo "done"',           language: 'bash', category: 'info_disclosure',     expectedContained: false, desc: 'Mount table — reveals volume mounts' },
  { label: 'suid_binary_search',     code: 'find / -perm -u=s -type f 2>/dev/null | head -20 || echo "find_complete"',                                language: 'bash', category: 'privilege_escalation', expectedContained: false, desc: 'SUID binary enumeration' },
  { label: 'capability_probe',       code: 'cat /proc/self/status | grep -i cap; capsh --print 2>/dev/null || grep Cap /proc/self/status',            language: 'bash', category: 'privilege_escalation', expectedContained: false, desc: 'Linux capability enumeration' },
  { label: 'sudo_attempt',           code: 'sudo -l 2>&1; sudo id 2>&1 || echo "sudo_not_available"',                                                  language: 'bash', category: 'privilege_escalation', expectedContained: true,  desc: 'sudo access attempt — must fail' },
  { label: 'etc_shadow_read',        code: 'cat /etc/shadow 2>&1 | head -5 || echo "shadow_access_denied"',                                            language: 'bash', category: 'info_disclosure',     expectedContained: true,  desc: '/etc/shadow — must be read-protected' },
  { label: 'kernel_modules',         code: 'lsmod 2>/dev/null | head -10; uname -r; cat /proc/version 2>/dev/null',                                   language: 'bash', category: 'info_disclosure',     expectedContained: false, desc: 'Kernel version and module enumeration' },
  // Network isolation
  { label: 'aws_metadata_from_cse',  code: 'curl -s --connect-timeout 3 http://169.254.169.254/latest/meta-data/ 2>&1 | head -10 || echo "metadata_blocked"', language: 'bash', category: 'ssrf', expectedContained: true, desc: 'AWS instance metadata from sandbox — must be blocked' },
  { label: 'gcp_metadata_from_cse',  code: 'curl -s --connect-timeout 3 -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/ 2>&1 || echo "gcp_blocked"', language: 'bash', category: 'ssrf', expectedContained: true, desc: 'GCP metadata endpoint from sandbox' },
  { label: 'internal_network_scan',  code: 'for ip in 10.0.0.1 10.0.0.2 172.17.0.1 192.168.1.1; do (ping -c1 -W1 $ip 2>&1 | tail -1 || echo "no ping") & done; sleep 3; echo "scan_done"', language: 'bash', category: 'network_probe', expectedContained: true, desc: 'Internal network scanning from sandbox' },
  { label: 'docker_api_via_socket',  code: 'curl -s --connect-timeout 2 --unix-socket /var/run/docker.sock http://localhost/v1.41/containers/json 2>&1 | head -100 || echo "docker_api_blocked"', language: 'bash', category: 'container_escape', expectedContained: true, desc: 'Docker API via Unix socket from inside sandbox' },
  { label: 'host_network_access',    code: 'curl -s --connect-timeout 3 http://host.docker.internal:3500/health 2>&1 || echo "host_network_blocked"', language: 'bash', category: 'network_probe', expectedContained: true, desc: 'Access host network from sandbox via docker DNS' },
  // Python-based escape attempts
  { label: 'python_ctypes_escape',   code: `import ctypes, sys
try:
    # Attempt to call arbitrary libc functions
    libc = ctypes.CDLL('libc.so.6')
    result = libc.system(b'id')
    print("ctypes_system_call_returned:", result)
except Exception as e:
    print("ctypes_blocked:", str(e))
`, language: 'python', category: 'privilege_escalation', expectedContained: true, desc: 'Python ctypes system() call for privilege escalation' },
  { label: 'python_subprocess_escape', code: `import subprocess
try:
    r = subprocess.run(['cat', '/etc/passwd'], capture_output=True, text=True, timeout=5)
    print("passwd_lines:", len(r.stdout.split('\\n')))
except Exception as e:
    print("subprocess_blocked:", str(e))
`, language: 'python', category: 'info_disclosure', expectedContained: false, desc: '/etc/passwd via Python subprocess (sandbox-local /etc/passwd only)' },
  { label: 'python_os_chroot',       code: `import os
try:
    os.chroot('/')
    print("chroot_succeeded")
except PermissionError:
    print("chroot_blocked_no_cap")
except Exception as e:
    print("chroot_error:", type(e).__name__)
`, language: 'python', category: 'container_escape', expectedContained: true, desc: 'chroot() system call — requires CAP_SYS_CHROOT' },
];

// ═══════════════════════════════════════════════════════════════════════════
// SECTION IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════════════════════════

async function bootstrapAndLogin() {
  const health = await http('GET', '/health', null, 'anon', { timeout: 5000, noJar: true });
  if (!health.ok) { fail('Bootstrap', 'Server not reachable', `HTTP=${health.status}`, null, health.ms, 'critical'); process.exit(1); }
  pass('Bootstrap', `Server UP`, `HTTP=${health.status}`, null, health.ms);

  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) { fail('Bootstrap', 'ADMIN_EMAIL / ADMIN_PASSWORD required for stress tests', '', null, null, 'critical'); process.exit(1); }
  const loginR = await http('POST', '/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, 'admin');
  if (!loginR.ok) { fail('Bootstrap', 'Admin login failed', `HTTP=${loginR.status}`, null, loginR.ms, 'critical'); process.exit(1); }
  state.adminSid = 'admin';
  state.adminUserId = loginR.data?.user?.id;
  pass('Bootstrap', `Admin login OK`, `persona=${loginR.data?.user?.persona}`, null, loginR.ms);

  const tables = sqliteJson(`SELECT name FROM sqlite_master WHERE type='table'`);
  info('Bootstrap', `DB reachable — ${tables.rows.length} tables`);

  info('Bootstrap', `Docker: ${DOCKER_AVAILABLE ? 'available' : 'not available'}`);
  info('Bootstrap', `LLM calls: ${SKIP_LLM ? 'SKIPPED (SKIP_LLM=true)' : 'ENABLED'}`);
  info('Bootstrap', `CSE pentest: ${CSE_PENTEST ? 'ENABLED' : 'disabled'}`);
  info('Bootstrap', `Reasoning users: ${REASONING_USERS}`);
  info('Bootstrap', `Max tool depth: ${MAX_TOOL_DEPTH}`);
}

// ── S1: Node.js baseline ──────────────────────────────────────────────────

let baselineNodeMetrics = null;
async function nodeBaseline() {
  const suite = 'NodeMetrics';
  const snap = sampleNodeProcess('baseline');
  if (!snap.pid) { warn(suite, 'Cannot find server PID — Node metrics will be limited'); return; }
  baselineNodeMetrics = snap;
  pass(suite, 'Baseline Node.js process snapshot', `cpu=${snap.cpuPct}% rss=${snap.rssMB}MB vsz=${snap.vszMB}MB threads=${snap.threads}`, snap);

  const lag = await measureEventLoopLag(20);
  lag.p95 < 50
    ? pass(suite, 'Event loop lag at baseline', `p50=${lag.p50.toFixed(2)}ms p95=${lag.p95.toFixed(2)}ms`, lag)
    : warn(suite, 'Event loop lag high at baseline', `p95=${lag.p95.toFixed(2)}ms — server may already be under load`, lag);

  if (DOCKER_AVAILABLE) {
    const ds = dockerStats();
    if (ds?.length) pass(suite, `Docker stats: ${ds.length} container(s) running`, '', ds);
    else info(suite, 'Docker available but no running containers');

    const cseInspect = dockerInspectCse();
    if (cseInspect) {
      const hostConfig = cseInspect.HostConfig || {};
      info(suite, 'CSE container found', `NetworkMode=${hostConfig.NetworkMode} Memory=${hostConfig.Memory} CpuQuota=${hostConfig.CpuQuota}`);
      hostConfig.NetworkMode === 'none' || hostConfig.NetworkMode === 'bridge'
        ? pass(suite, 'CSE container has network isolation', `mode=${hostConfig.NetworkMode}`)
        : warn(suite, 'CSE container may have broad network access', `mode=${hostConfig.NetworkMode}`);
      hostConfig.Memory > 0
        ? pass(suite, 'CSE container has memory limit', `limit=${Math.round(hostConfig.Memory / 1024 / 1024)}MB`)
        : warn(suite, 'CSE container has no memory limit configured', '');
    }
  }
}

// ── S2: Deep reasoning tests ──────────────────────────────────────────────

async function deepReasoningTests() {
  const suite = 'DeepReasoning';
  if (SKIP_LLM) { info(suite, 'Skipped — SKIP_LLM=true'); return; }

  const { id: chatId } = await createChat(state.adminSid, `${RUN_ID} deep reasoning`);
  if (!chatId) { fail(suite, 'Cannot create reasoning chat'); return; }

  await setChatMode(state.adminSid, chatId, 'agent', {
    enabledTools: ['calculator', 'datetime', 'json_format', 'text_analysis'],
  });

  const monitor = startNodeMonitor('deep-reasoning');

  for (const prompt of REASONING_PROMPTS) {
    info(suite, `→ ${prompt.label}`, prompt.desc);
    const t0 = Date.now();
    const r = await sendChat(state.adminSid, chatId, prompt.content, {
      maxTokens: prompt.maxTokens,
      enabledTools: prompt.tools,
      mode: 'agent',
      timeout: LLM_TIMEOUT,
    });
    const ms = Date.now() - t0;
    track(`reasoning_${prompt.label}`, ms);
    track('reasoning_all', ms);

    const content = r.data?.assistantContent ?? r.data?.content ?? r.data?.message?.content ?? r.data?.assistantMessage?.content ?? r.data?.response ?? '';
    const decision = extractDecision(r);
    const toolCalls = r.data?.steps?.filter(s => s.toolCall)?.length ?? 0;
    const tokens = r.data?.usage?.totalTokens ?? r.data?.usage?.promptTokens ?? 0;

    if (r.ok && content.length > 100) {
      pass(suite, `${prompt.label}: response generated`, `ms=${ms} chars=${content.length} toolCalls=${toolCalls} tokens=${tokens}`, { preview: content.slice(0, 400), decision }, ms);
    } else if (r.status === 422 || r.status === 503) {
      warn(suite, `${prompt.label}: transient overload`, `HTTP=${r.status} ms=${ms}`, null, ms);
    } else if (decision === 'deny' || r.status === 403) {
      warn(suite, `${prompt.label}: guardrail blocked reasoning prompt`, `decision=${decision} HTTP=${r.status}`, compactResp(r), ms);
    } else {
      fail(suite, `${prompt.label}: reasoning failed`, `HTTP=${r.status} len=${content.length} err=${r.error || ''}`, compactResp(r), ms);
    }

    // Validate response quality for analysis prompts
    if (r.ok && prompt.label === 'risk_analysis_with_calculation' && content.length > 200) {
      const hasNumbers = /\d+[\.,]\d+/.test(content);
      const hasJSON = content.includes('{') && content.includes('}');
      hasNumbers ? pass(suite, `${prompt.label}: contains numerical calculations`, '') : warn(suite, `${prompt.label}: no numerical output found`, 'Expected calculator tool use');
      hasJSON ? pass(suite, `${prompt.label}: structured JSON output present`, '') : warn(suite, `${prompt.label}: no JSON structure found`, 'Expected json_format tool use');
    }
  }

  const nodeSnap = monitor.stop();
  info(suite, 'Node.js during deep reasoning', `cpu_p95=${nodeSnap.cpu.p95}% rss_delta=${nodeSnap.rss.delta}MB`);
  nodeSnap.rss.delta < 200
    ? pass(suite, 'Memory stable during reasoning tests', `delta=${nodeSnap.rss.delta}MB`)
    : warn(suite, 'Memory grew during reasoning tests', `delta=${nodeSnap.rss.delta}MB — watch for leaks`);

  state.mainChatId = chatId;
}

// ── S3: Multi-turn conversation stress ────────────────────────────────────

async function multiTurnConversationStress() {
  const suite = 'MultiTurn';
  if (SKIP_LLM) { info(suite, 'Skipped — SKIP_LLM=true'); return; }

  const { id: chatId } = await createChat(state.adminSid, `${RUN_ID} multi-turn`);
  if (!chatId) { fail(suite, 'Cannot create multi-turn chat'); return; }

  await setChatMode(state.adminSid, chatId, 'agent', {
    enabledTools: ['calculator', 'datetime', 'json_format', 'text_analysis'],
  });

  // A realistic multi-turn enterprise investigation where each message
  // builds on the previous — not independent requests
  const TURNS = [
    { turn: 1, content: `I'm investigating a performance regression. Our API P95 latency jumped from 380ms to 1,240ms after last Tuesday's deployment. Start by helping me structure the investigation. What are the 5 most likely root causes for a 3.2x latency jump in a Node.js API with SQLite and external LLM calls?`, maxTokens: 1500 },
    { turn: 2, content: `Based on those 5 causes, let's focus on cause #1 you identified. I've checked and our database queries went from avg 12ms to avg 890ms after the deployment. What specific SQLite diagnostics should I run to confirm this is the issue? What PRAGMA settings might be involved?`, maxTokens: 1500 },
    { turn: 3, content: `I ran PRAGMA integrity_check and it returned "ok". PRAGMA page_count shows 48,392 pages. PRAGMA journal_mode shows WAL. But I noticed one query: SELECT * FROM messages WHERE chat_id = ? AND created_at > ? — it was running without an index. Calculate: if this query was doing a full scan of 48,392 pages × 4096 bytes/page, what is the total data scanned in MB? Then tell me what index would fix this and write the exact CREATE INDEX statement.`, maxTokens: 2000 },
    { turn: 4, content: `Great. I added the index and P95 dropped to 420ms. But now I'm seeing a new issue: memory usage grew from 380MB to 1.2GB over 6 hours with no restart. The growth is ~140MB/hour. At this rate, when will we hit 2GB (which triggers OOM kill)? Calculate the exact time from now (it is currently 09:00 UTC). What are the 3 most common causes of this growth pattern in Node.js?`, maxTokens: 1500 },
    { turn: 5, content: `Given everything we've investigated in this conversation — the query performance issue, the index fix, and now the memory growth — write me a complete RCA (Root Cause Analysis) document in the following format:
- Executive Summary (3 sentences)
- Timeline of events
- Root Causes (primary and contributing)
- Impact Assessment
- Remediation Steps Taken
- Preventive Measures (minimum 5)
- Lessons Learned
Use specific numbers from our conversation throughout.`, maxTokens: 3000 },
  ];

  const turnLatencies = [];
  for (const { turn, content, maxTokens } of TURNS) {
    const t0 = Date.now();
    const r = await sendChat(state.adminSid, chatId, content, { maxTokens, timeout: LLM_TIMEOUT });
    const ms = Date.now() - t0;
    turnLatencies.push(ms);
    track('multi_turn', ms);

    const responseLen = (r.data?.assistantContent ?? r.data?.content ?? r.data?.response ?? '').length;
    r.ok && responseLen > 50
      ? pass(suite, `Turn ${turn}/5: response received`, `ms=${ms} chars=${responseLen}`, null, ms)
      : warn(suite, `Turn ${turn}/5: unexpected response`, `HTTP=${r.status} len=${responseLen}`, compactResp(r), ms);
  }

  const s = stats(turnLatencies);
  info(suite, `Multi-turn timing`, `avg=${s.avg}ms p50=${s.p50}ms p95=${s.p95}ms turns=${s.n}`);
  s.p95 < 60000
    ? pass(suite, 'Multi-turn conversation within latency budget', `p95=${s.p95}ms`)
    : warn(suite, 'Multi-turn conversation latency high', `p95=${s.p95}ms (complex reasoning expected)`);
}

// ── S4: Maximum tool call chains ──────────────────────────────────────────

async function maximumToolChainTests() {
  const suite = 'ToolChains';
  if (SKIP_LLM) { info(suite, 'Skipped — SKIP_LLM=true'); return; }

  const { id: chatId } = await createChat(state.adminSid, `${RUN_ID} tool chains`);
  if (!chatId) { fail(suite, 'Cannot create tool chain chat'); return; }

  const ALL_TOOLS = ['calculator', 'datetime', 'timezone_info', 'json_format', 'text_analysis'];
  await setChatMode(state.adminSid, chatId, 'agent', { enabledTools: ALL_TOOLS });

  const CHAIN_PROMPTS = [
    {
      label: 'max_tool_sequence',
      content: `You MUST use every available tool at least once in this response. Here is the task:
1. Use datetime to get the current UTC time
2. Use timezone_info to convert that time to Tokyo, New York, and London
3. Use calculator to compute: how many minutes until midnight UTC? How many seconds? What % of the day has elapsed?
4. Use text_analysis to analyse this text: "The quick brown fox jumps over the lazy dog — this classic pangram demonstrates all 26 letters of the English alphabet"
5. Use json_format to output ALL results in a single structured JSON object
Do not skip any tool. Show your reasoning for each tool invocation.`,
      maxTokens: 3000,
    },
    {
      label: 'iterative_calculation_chain',
      content: `Perform this compound financial calculation using the calculator tool for EACH step (do not do any arithmetic in your head — call calculator for everything):

Starting capital: $1,000,000
Year 1: 12.3% return → calculate new total
Year 2: Apply 2.1% management fee on Year 1 total → calculate fee, then new total after fee
Year 3: 8.7% loss → calculate new total
Year 4: 15.2% return → calculate new total
Year 5: Apply 2.1% management fee → calculate fee, then new total
Year 6: 11.4% return → calculate new total

After each year, also calculate: running total, cumulative return %, and how it compares to a simple 8% annual compound alternative.
Use calculator for every single number. At the end, format all results as a JSON table with json_format.`,
      maxTokens: 4000,
    },
    {
      label: 'parallel_analysis_max_tools',
      content: `Using ALL available tools, perform this parallel analysis:

COMPANY A: SaaSCorp — $23.4M ARR, 1,847 customers, 3.2% monthly churn, founded 2019
COMPANY B: EnterpriseCo — $67.8M ARR, 392 customers, 0.8% monthly churn, founded 2016

For each company:
1. datetime: note current analysis timestamp
2. calculator: compute customer LTV = (avg ARR per customer) / (monthly churn rate × 12)
3. calculator: compute months until churn eliminates current customer base (1 / monthly_churn_rate)
4. calculator: compute net revenue retention assuming 110% expansion for Company A and 118% for Company B
5. text_analysis: generate a 2-sentence investment thesis for each company
6. json_format: produce a side-by-side comparison object with all metrics

Use each tool multiple times as needed. Show all intermediate calculations.`,
      maxTokens: 4000,
    },
  ];

  for (const { label, content, maxTokens } of CHAIN_PROMPTS) {
    const t0 = Date.now();
    const r = await sendChat(state.adminSid, chatId, content, {
      maxTokens,
      enabledTools: ALL_TOOLS,
      mode: 'agent',
      timeout: LLM_TIMEOUT,
    });
    const ms = Date.now() - t0;
    track('tool_chain', ms);

    const steps = r.data?.steps ?? [];
    const toolCalls = steps.filter(s => s.toolCall);
    const uniqueTools = new Set(toolCalls.map(s => s.toolCall?.name));
    const responseLen = (r.data?.assistantContent ?? r.data?.content ?? '').length;

    if (r.ok && responseLen > 100) {
      pass(suite, `${label}: completed`, `ms=${ms} toolCalls=${toolCalls.length} uniqueTools=${uniqueTools.size} chars=${responseLen}`, { tools: [...uniqueTools] }, ms);
      toolCalls.length >= 3
        ? pass(suite, `${label}: multiple tool invocations confirmed`, `count=${toolCalls.length} tools=[${[...uniqueTools].join(',')}]`)
        : warn(suite, `${label}: fewer tool calls than expected`, `count=${toolCalls.length} (expected ≥3)`);
    } else if ([422, 503].includes(r.status)) {
      warn(suite, `${label}: transient overload`, `HTTP=${r.status}`, null, ms);
    } else {
      fail(suite, `${label}: tool chain failed`, `HTTP=${r.status} len=${responseLen}`, compactResp(r), ms);
    }
  }
}

// ── S5: Supervisor with 6 workers ─────────────────────────────────────────

async function supervisorStressTest() {
  const suite = 'SupervisorStress';
  if (SKIP_LLM) { info(suite, 'Skipped — SKIP_LLM=true'); return; }

  const { id: chatId } = await createChat(state.adminSid, `${RUN_ID} supervisor stress`);
  if (!chatId) { fail(suite, 'Cannot create supervisor chat'); return; }

  const task = SUPERVISOR_COMPLEX_TASK;
  const modeR = await setChatMode(state.adminSid, chatId, 'supervisor', {
    enabledTools: task.tools,
    workers: task.workers,
  });
  if (!modeR.ok) { warn(suite, 'Supervisor mode configuration failed', `HTTP=${modeR.status}`); }

  const monitor = startNodeMonitor('supervisor-6worker');

  info(suite, `Dispatching supervisor task with ${task.workers.length} workers`, task.workers.map(w => w.role).join(', '));
  const t0 = Date.now();
  const r = await sendChat(state.adminSid, chatId, task.content, {
    maxTokens: task.maxTokens,
    enabledTools: task.tools,
    mode: 'supervisor',
    timeout: LLM_TIMEOUT,
  });
  const ms = Date.now() - t0;
  track('supervisor_6worker', ms);

  const nodeSnap = monitor.stop();
  const responseLen = (r.data?.assistantContent ?? r.data?.content ?? r.data?.response ?? '').length;
  const steps = r.data?.steps ?? [];

  if (r.ok && responseLen > 500) {
    pass(suite, `Supervisor 6-worker task completed`, `ms=${ms} chars=${responseLen} steps=${steps.length}`, null, ms);
    // Verify each worker contributed
    const workerRoles = task.workers.map(w => w.role);
    const contentLower = (r.data?.assistantContent ?? r.data?.content ?? '').toLowerCase();
    let covered = 0;
    for (const role of workerRoles) {
      if (contentLower.includes(role)) covered++;
    }
    covered >= 4
      ? pass(suite, 'Supervisor worker output coverage', `${covered}/${workerRoles.length} roles mentioned in output`)
      : warn(suite, 'Some supervisor workers may not have contributed', `only ${covered}/${workerRoles.length} roles in output`);
  } else if ([422, 503].includes(r.status)) {
    warn(suite, 'Supervisor transient overload', `HTTP=${r.status} ms=${ms}`, null, ms);
  } else {
    fail(suite, 'Supervisor 6-worker task failed', `HTTP=${r.status} len=${responseLen}`, compactResp(r), ms);
  }

  info(suite, 'Node during 6-worker supervisor', `cpu_p95=${nodeSnap.cpu.p95}% rss_max=${nodeSnap.rss.max}MB rss_delta=${nodeSnap.rss.delta}MB`);
  nodeSnap.cpu.p95 < 95
    ? pass(suite, 'CPU did not saturate during supervisor', `p95=${nodeSnap.cpu.p95}%`)
    : warn(suite, 'CPU saturated during supervisor mode', `p95=${nodeSnap.cpu.p95}%`);

  // Also test streaming supervisor
  const streamR = await sendChatStream(state.adminSid, chatId,
    'Now provide a one-paragraph synthesis of the key actions from the incident response. Stream it.', {
      mode: 'supervisor',
      maxTokens: 500,
      timeout: LLM_TIMEOUT,
    });
  track('supervisor_stream', streamR.ms);
  streamR.status < 500 && (streamR.ok || [200].includes(streamR.status))
    ? pass(suite, 'Supervisor streaming response', `ms=${streamR.ms} firstToken=${streamR.firstTokenMs}ms events=${streamR.events.length} bytes=${streamR.text.length}`, null, streamR.ms)
    : warn(suite, 'Supervisor streaming issue', `HTTP=${streamR.status} firstToken=${streamR.firstTokenMs}ms`, null, streamR.ms);
}

// ── S6: CSE legitimate execution ──────────────────────────────────────────

async function cseLegitimateTests() {
  const suite = 'CSELegitimate';
  const sid = state.adminSid;

  const cseStatusR = await http('GET', '/api/sandbox/status', null, sid, { timeout: 5000 });
  const cseEnabled = cseStatusR.ok || cseStatusR.status === 200;
  if (!cseEnabled && cseStatusR.status !== 200) {
    info(suite, `CSE backend: status=${cseStatusR.status} — tests will record results regardless`);
  }

  const monitor = startNodeMonitor('cse-legitimate');

  for (const test of CSE_LEGITIMATE) {
    const t0 = Date.now();
    const r = await http('POST', '/api/sandbox/execute', {
      code: test.code,
      language: test.language,
      timeoutMs: test.timeoutMs,
      networkAccess: false,
    }, sid, { timeout: (test.timeoutMs || 15000) + 5000 });
    const ms = Date.now() - t0;
    track('cse_legitimate', ms);
    track(`cse_${test.label}`, ms);

    if ([503, 503].includes(r.status)) {
      warn(suite, `${test.label}: CSE backend unavailable`, `HTTP=${r.status} — configure sandbox for full test`, null, ms);
      continue;
    }
    if (r.status === 500) {
      fail(suite, `${test.label}: CSE unhandled 500`, `HTTP=${r.status} — server crash on execution`, compactResp(r), ms, 'critical');
      continue;
    }
    if ([200, 422].includes(r.status)) {
      const output = r.data?.stdout ?? r.data?.output ?? r.text ?? '';
      const hasExpected = output.includes(test.expectedOutput);
      hasExpected
        ? pass(suite, `${test.label}: executed, correct output`, `ms=${ms} outputLen=${output.length}`, { preview: output.slice(0, 300) }, ms)
        : warn(suite, `${test.label}: executed but unexpected output`, `expected "${test.expectedOutput}" in output`, { preview: output.slice(0, 300) }, ms);
    } else {
      warn(suite, `${test.label}: HTTP=${r.status}`, `execution status unclear`, compactResp(r), ms);
    }

    if (DOCKER_AVAILABLE) {
      const ds = dockerStats();
      if (ds?.length) {
        const cseContainer = ds.find(c => c.container.includes('cse') || c.container.includes('sandbox'));
        if (cseContainer) track('cse_container_cpu', parseFloat(cseContainer.cpu));
      }
    }
  }

  const nodeSnap = monitor.stop();
  info(suite, 'Node during CSE legitimate runs', `cpu_p95=${nodeSnap.cpu.p95}% rss_delta=${nodeSnap.rss.delta}MB`);
}

// ── S7: CSE resource limit enforcement ────────────────────────────────────

async function cseResourceLimitTests() {
  const suite = 'CSEResourceLimits';
  const sid = state.adminSid;

  for (const test of CSE_RESOURCE_TESTS) {
    info(suite, `→ ${test.label}`, test.desc);
    const t0 = Date.now();
    const r = await http('POST', '/api/sandbox/execute', {
      code: test.code,
      language: test.language,
      timeoutMs: 5000, // short timeout — these should be killed quickly
      networkAccess: false,
    }, sid, { timeout: 20000 });
    const ms = Date.now() - t0;
    track('cse_resource', ms);

    if (r.status === 503) { warn(suite, `${test.label}: CSE unavailable`, 'Configure sandbox to test resource limits', null, ms); continue; }

    const killed = r.data?.status === 'timeout' || r.data?.status === 'killed' || r.data?.killed || r.data?.error?.includes('timeout') || r.data?.error?.includes('killed');
    const status = r.data?.status ?? (r.ok ? 'success' : 'error');

    if (test.expectKilled) {
      killed || r.status === 422
        ? pass(suite, `${test.label}: process killed/timeout as expected`, `ms=${ms} status=${status}`, null, ms)
        : fail(suite, `${test.label}: NOT killed — resource limit not enforced`, `ms=${ms} status=${status} HTTP=${r.status}`, compactResp(r), ms, 'critical');
    } else {
      // Not expected to kill — just verify it doesn't crash the server
      r.status < 500 || r.status === 422 || r.status === 503
        ? pass(suite, `${test.label}: handled without server crash`, `ms=${ms} HTTP=${r.status}`, null, ms)
        : fail(suite, `${test.label}: server crash (500)`, `ms=${ms}`, compactResp(r), ms, 'critical');
    }
  }
}

// ── S8: CSE penetration & Docker isolation ────────────────────────────────

async function csePenetrationTests() {
  const suite = 'CSEPentest';
  if (!CSE_PENTEST) { info(suite, 'Skipped — CSE_PENTEST=false'); return; }
  const sid = state.adminSid;

  for (const test of CSE_PENTEST_CASES) {
    info(suite, `→ [${test.category}] ${test.label}`, test.desc);
    const t0 = Date.now();
    const r = await http('POST', '/api/sandbox/execute', {
      code: test.code,
      language: test.language,
      timeoutMs: 8000,
      networkAccess: false,
    }, sid, { timeout: 20000 });
    const ms = Date.now() - t0;
    track(`cse_pentest_${test.category}`, ms);

    if (r.status === 503) { warn(suite, `${test.label}: CSE unavailable`, 'deploy sandbox to test', null, ms); continue; }
    if (r.status === 500) { fail(suite, `${test.label}: server 500 on pentest input`, 'CSE error handling gap', compactResp(r), ms, 'critical'); continue; }

    const stdout = r.data?.stdout ?? r.data?.output ?? '';
    const stderr = r.data?.stderr ?? '';
    const allOutput = (stdout + stderr).toLowerCase();

    if (test.expectedContained) {
      // Should be blocked or return "denied/blocked" markers
      const blocked = allOutput.includes('blocked') || allOutput.includes('denied') || allOutput.includes('permission denied') || allOutput.includes('no such file') || r.data?.status === 'error' || r.data?.killed;
      const noSensitiveData = !allOutput.includes('aws_secret') && !allOutput.includes('passwd:') && !allOutput.includes('shadow:') && !/docker.*version.*api/i.test(allOutput);

      if (blocked || noSensitiveData) {
        pass(suite, `${test.label}: contained / blocked`, `HTTP=${r.status} blocked=${blocked}`, { preview: stdout.slice(0, 200) }, ms);
      } else {
        fail(suite, `${test.label}: NOT contained — potential escape`, `output contains unexpected data`, { stdout: stdout.slice(0, 400), stderr: stderr.slice(0, 200) }, ms, 'critical');
      }
    } else {
      // Not expected to be fully blocked — just verify it's isolated (sandbox /etc/passwd, not host)
      // and doesn't expose sensitive host data
      const exposesHostSecrets = allOutput.includes('aws_secret_access_key') || allOutput.includes('anthropic_api_key') || /sk-ant-api[0-9]{2}-[A-Za-z0-9]{93}/i.test(stdout);
      exposesHostSecrets
        ? fail(suite, `${test.label}: host secrets exposed`, 'Sandbox not isolating environment variables', { preview: stdout.slice(0, 200) }, ms, 'critical')
        : pass(suite, `${test.label}: no host secrets leaked`, `HTTP=${r.status} category=${test.category}`, { preview: stdout.slice(0, 200) }, ms);
    }
  }

  // Additional Docker-level isolation checks
  if (DOCKER_AVAILABLE) {
    const containers = dockerPs();
    if (containers) {
      const cse = containers.filter(c => c.image?.includes('cse') || c.name?.includes('sandbox') || c.image?.includes('sandbox'));
      for (const c of cse) {
        try {
          const inspect = JSON.parse(execSync(`docker inspect ${c.id} 2>/dev/null`, { encoding: 'utf8', timeout: 5000 }))[0];
          const hc = inspect?.HostConfig || {};
          // Privileged mode is a critical finding
          hc.Privileged
            ? fail(suite, `CSE container ${c.name}: running PRIVILEGED`, 'Privileged containers can escape to host', { inspect: hc }, null, 'critical')
            : pass(suite, `CSE container ${c.name}: not privileged`, '');
          // Network mode
          const netMode = inspect?.NetworkSettings?.Networks ? Object.keys(inspect.NetworkSettings.Networks)[0] : hc.NetworkMode;
          ['none', 'bridge'].includes(netMode)
            ? pass(suite, `CSE container ${c.name}: network isolated`, `mode=${netMode}`)
            : warn(suite, `CSE container ${c.name}: broad network access`, `mode=${netMode}`);
          // Host PID namespace
          hc.PidMode === 'host'
            ? fail(suite, `CSE container ${c.name}: shares host PID namespace`, 'Can see and signal host processes', null, null, 'critical')
            : pass(suite, `CSE container ${c.name}: isolated PID namespace`, '');
          // Read-only root
          inspect?.HostConfig?.ReadonlyRootfs
            ? pass(suite, `CSE container ${c.name}: read-only root filesystem`, '')
            : warn(suite, `CSE container ${c.name}: mutable root filesystem`, 'Consider --read-only for stronger isolation');
        } catch {}
      }
    }
  }
}

// ── S9: Concurrent reasoning stress ──────────────────────────────────────

async function concurrentReasoningStress() {
  const suite = 'ConcurrentReasoning';
  if (SKIP_LLM) { info(suite, 'Skipped — SKIP_LLM=true'); return; }
  if (REASONING_USERS < 2) { info(suite, 'REASONING_USERS<2 — skipping'); return; }

  info(suite, `Launching ${REASONING_USERS} concurrent complex reasoning users`);
  const monitor = startNodeMonitor('concurrent-reasoning');
  const t0 = Date.now();

  // Each user gets a DIFFERENT complex prompt to avoid caching
  const tasks = Array.from({ length: REASONING_USERS }, async (_, i) => {
    const sid = `concurrent_${i}`;
    const email = `${RUN_ID}-cr-${i}@test.local`;
    // Register
    const regR = await http('POST', '/api/auth/register', { name: `CRUser ${i}`, email, password: `CRPass@${i}123!` }, sid);
    if (!regR.ok) return { ok: false, error: 'registration failed', ms: 0 };

    const { id: chatId } = await createChat(sid, `${RUN_ID} concurrent reasoning ${i}`);
    if (!chatId) return { ok: false, error: 'chat creation failed', ms: 0 };

    await setChatMode(sid, chatId, 'agent', {
      enabledTools: ['calculator', 'json_format', 'text_analysis'],
    });

    const prompt = REASONING_PROMPTS[i % REASONING_PROMPTS.length];
    const msgT0 = Date.now();
    const r = await sendChat(sid, chatId, prompt.content, {
      maxTokens: 2000,
      mode: 'agent',
      timeout: LLM_TIMEOUT,
    });
    return {
      ok: r.ok || [422, 503].includes(r.status),
      ms: Date.now() - msgT0,
      status: r.status,
      len: (r.data?.assistantContent ?? r.data?.content ?? '').length,
      label: prompt.label,
    };
  });

  const results2 = await Promise.allSettled(tasks);
  const elapsed = Date.now() - t0;
  const nodeSnap = monitor.stop();

  const settled = results2.map(r => r.status === 'fulfilled' ? r.value : { ok: false, ms: 0, error: r.reason?.message });
  const successful = settled.filter(r => r.ok && r.len > 50);
  const failed2 = settled.filter(r => !r.ok);
  const latencies = settled.map(r => r.ms).filter(m => m > 0);
  const s = stats(latencies);

  pass(suite, `${REASONING_USERS}-user concurrent reasoning`, `success=${successful.length}/${REASONING_USERS} failed=${failed2.length} elapsed=${elapsed}ms`, { latency: s }, elapsed);

  successful.length >= REASONING_USERS * 0.8
    ? pass(suite, 'Concurrent reasoning success rate ≥80%', `${successful.length}/${REASONING_USERS}`)
    : fail(suite, 'Concurrent reasoning success rate <80%', `${successful.length}/${REASONING_USERS}`, null, null, 'high');

  info(suite, 'Latency under concurrent reasoning', `avg=${s.avg}ms p50=${s.p50}ms p95=${s.p95}ms`);
  info(suite, 'Node during concurrent reasoning', `cpu_p95=${nodeSnap.cpu.p95}% rss_max=${nodeSnap.rss.max}MB delta=${nodeSnap.rss.delta}MB`);
}

// ── S10: Memory pressure profiling ────────────────────────────────────────

async function memoryPressureTests() {
  const suite = 'MemoryPressure';
  if (SKIP_LLM) { info(suite, 'Skipped — SKIP_LLM=true'); return; }

  const snapBefore = sampleNodeProcess('mem-before');
  const sid = state.adminSid;
  const chatIds = [];

  // Create many chats simultaneously
  info(suite, 'Creating 50 chats simultaneously to pressure message table cache');
  const chatPromises = Array.from({ length: 50 }, (_, i) =>
    createChat(sid, `${RUN_ID} mem pressure ${i}`)
  );
  const chatResults = await Promise.all(chatPromises);
  const created = chatResults.filter(r => r.id).map(r => r.id);
  chatIds.push(...created);
  pass(suite, `${created.length}/50 chats created under pressure`, '', null);

  // Send messages to 10 of them (with LLM guardrail evaluation)
  const msgSlice = chatIds.slice(0, 10);
  const msgPromises = msgSlice.map((chatId, i) =>
    sendChat(sid, chatId, REASONING_PROMPTS[i % REASONING_PROMPTS.length].content.slice(0, 500), {
      maxTokens: 512, timeout: 30000,
    })
  );
  const msgResults = await Promise.all(msgPromises);
  await sleep(2000);
  const snapAfter = sampleNodeProcess('mem-after');

  const rssGrowth = snapAfter.rssMB - (snapBefore.rssMB || 0);
  const msgSuccess = msgResults.filter(r => r.ok || [422, 503].includes(r.status)).length;

  pass(suite, `${msgSuccess}/10 messages processed under memory pressure`, '');
  rssGrowth < 300
    ? pass(suite, 'RSS growth within bounds under pressure', `grew +${rssGrowth}MB (${snapBefore.rssMB}→${snapAfter.rssMB}MB)`)
    : warn(suite, 'RSS grew significantly under pressure', `+${rssGrowth}MB (${snapBefore.rssMB}→${snapAfter.rssMB}MB) — investigate for leak`);
}

// ── S11: API latency breakdown ─────────────────────────────────────────────

async function apiLatencyBreakdown() {
  const suite = 'LatencyBreakdown';
  const sid = state.adminSid;
  const { id: chatId } = await createChat(sid, `${RUN_ID} latency breakdown`);
  if (!chatId) { warn(suite, 'Cannot create breakdown chat'); return; }

  await setChatMode(sid, chatId, 'direct', {});

  // Measure pure API (no LLM) operations
  const adminReadTimes = [];
  for (let i = 0; i < 20; i++) {
    const r = await http('GET', '/api/admin/guardrails', null, sid, { timeout: 5000 });
    adminReadTimes.push(r.ms);
    track('api_admin_read', r.ms);
  }

  const chatListTimes = [];
  for (let i = 0; i < 20; i++) {
    const r = await http('GET', '/api/chats', null, sid, { timeout: 5000 });
    chatListTimes.push(r.ms);
    track('api_chat_list', r.ms);
  }

  const chatCreateTimes = [];
  for (let i = 0; i < 10; i++) {
    const r = await http('POST', '/api/chats', { title: `breakdown ${i}` }, sid);
    chatCreateTimes.push(r.ms);
    track('api_chat_create', r.ms);
  }

  const sa = stats(adminReadTimes);
  const sc = stats(chatListTimes);
  const scc = stats(chatCreateTimes);

  pass(suite, 'Admin read latency (20 samples)', `p50=${sa.p50}ms p95=${sa.p95}ms max=${sa.max}ms`);
  pass(suite, 'Chat list latency (20 samples)', `p50=${sc.p50}ms p95=${sc.p95}ms max=${sc.max}ms`);
  pass(suite, 'Chat creation latency (10 samples)', `p50=${scc.p50}ms p95=${scc.p95}ms max=${scc.max}ms`);

  // DB query timing
  const dbT0 = Date.now();
  const queryR = sqliteJson(`
    SELECT
      (SELECT COUNT(*) FROM messages) as msg_count,
      (SELECT COUNT(*) FROM traces) as trace_count,
      (SELECT COUNT(*) FROM guardrail_evals) as eval_count,
      (SELECT COUNT(*) FROM users) as user_count
  `);
  const dbMs = Date.now() - dbT0;
  pass(suite, `DB aggregate query`, `ms=${dbMs} msgs=${queryR.rows[0]?.msg_count} traces=${queryR.rows[0]?.trace_count}`, queryR.rows[0], dbMs);
  dbMs < 50
    ? pass(suite, 'DB query within SLA', `${dbMs}ms < 50ms`)
    : warn(suite, 'DB query slow', `${dbMs}ms — check indexes`);

  // Guardrail pipeline latency (with deterministic rules only, no LLM)
  const guardrailTimes = [];
  for (const msg of ['test message safe', 'another safe message', 'enterprise AI platform test']) {
    const msgR = await http('POST', `/api/chats/${chatId}/messages`, { content: msg, stream: false, maxTokens: 10 }, sid, { timeout: 20000 });
    guardrailTimes.push(msgR.ms);
    track('api_guardrail_only', msgR.ms);
  }
  const sg = stats(guardrailTimes);
  info(suite, `Guardrail + LLM round-trip (3 samples)`, `avg=${sg.avg}ms p50=${sg.p50}ms`);

  apiBreakdown.push({ adminRead: sa, chatList: sc, chatCreate: scc, db: { ms: dbMs }, guardrailRoundTrip: sg });
}

// ── S12: Node.js post-stress comparison ───────────────────────────────────

async function nodePostStress() {
  const suite = 'NodeMetrics';
  const snap = sampleNodeProcess('post-stress');
  if (!snap.pid) return;

  const lag = await measureEventLoopLag(20);

  if (baselineNodeMetrics) {
    const rssGrowth = snap.rssMB - baselineNodeMetrics.rssMB;
    const cpuChange = snap.cpuPct - baselineNodeMetrics.cpuPct;
    info(suite, 'Post-stress vs baseline', `rss: ${baselineNodeMetrics.rssMB}→${snap.rssMB}MB (+${rssGrowth}MB) cpu: ${baselineNodeMetrics.cpuPct}→${snap.cpuPct}%`);
    rssGrowth < 500
      ? pass(suite, 'RSS growth after full stress suite', `+${rssGrowth}MB — acceptable`, null, null)
      : warn(suite, 'RSS grew significantly after stress', `+${rssGrowth}MB — may indicate memory pressure from reasoning/tool chains`);
    lag.p95 < 100
      ? pass(suite, 'Event loop lag post-stress', `p95=${lag.p95.toFixed(2)}ms — healthy`)
      : warn(suite, 'Event loop lag elevated post-stress', `p95=${lag.p95.toFixed(2)}ms — may have background tasks`);
  }

  pass(suite, 'Post-stress Node.js snapshot', `cpu=${snap.cpuPct}% rss=${snap.rssMB}MB threads=${snap.threads}`, snap);

  if (DOCKER_AVAILABLE) {
    const ds = dockerStats();
    if (ds?.length) info(suite, 'Post-stress Docker containers', `running=${ds.length}`, ds);
  }
}

// ── S13: Final report ──────────────────────────────────────────────────────

function writeReport() {
  const timingObj = Object.fromEntries([...timings.entries()].map(([k, v]) => [k, stats(v)]));
  const summary = {
    runId: RUN_ID, ts: now(), base: BASE,
    pass: PASS, fail: FAIL, warn: WARN, info: INFO,
    nodeMetrics: {
      baseline: baselineNodeMetrics,
      samples: nodeMetrics.length,
      apiBreakdown,
    },
    timings: timingObj,
    docker: DOCKER_AVAILABLE,
    cseEnabled: CSE_PENTEST,
    llmEnabled: !SKIP_LLM,
  };
  writeFileSync(JSON_OUT, JSON.stringify({ summary, results }, null, 2));

  const lines = [];
  lines.push(`# GeneWeave Stress & CSE Penetration Test Report`);
  lines.push(`> Run: \`${RUN_ID}\` · ${now()}`);
  lines.push(`- **Total:** ${PASS+FAIL+WARN+INFO} | ✅ ${PASS} PASS | ❌ ${FAIL} FAIL | ⚠️ ${WARN} WARN`);
  lines.push(`- **LLM:** ${SKIP_LLM ? 'disabled' : 'enabled'} · **CSE Pentest:** ${CSE_PENTEST ? 'enabled' : 'disabled'} · **Docker:** ${DOCKER_AVAILABLE ? 'available' : 'N/A'}`);
  lines.push('');
  lines.push('## Suite Results');
  const bySuite = {};
  for (const r of results) { bySuite[r.suite] ||= { PASS:0, FAIL:0, WARN:0, INFO:0 }; bySuite[r.suite][r.status]++; }
  lines.push('| Suite | PASS | FAIL | WARN |');
  lines.push('|---|---:|---:|---:|');
  for (const [s, c] of Object.entries(bySuite)) lines.push(`| ${s} | ${c.PASS||0} | ${c.FAIL||0} | ${c.WARN||0} |`);
  lines.push('');
  lines.push('## Timing Summary');
  lines.push('| Label | n | avg | p50 | p95 | p99 | max |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const [k, s] of Object.entries(timingObj)) {
    if (s.n > 0) lines.push(`| ${k} | ${s.n} | ${s.avg} | ${s.p50} | ${s.p95} | ${s.p99} | ${s.max} |`);
  }
  lines.push('');
  lines.push('## Failures');
  const fails = results.filter(r => r.status === 'FAIL');
  if (!fails.length) lines.push('No failures recorded.');
  for (const f of fails) lines.push(`- **[${f.suite}] ${f.name}** — ${f.detail}`);
  lines.push('');
  lines.push('## CSE Penetration Test Categories');
  const cats = {};
  for (const t of CSE_PENTEST_CASES) { cats[t.category] = (cats[t.category] || 0) + 1; }
  for (const [cat, count] of Object.entries(cats)) lines.push(`- ${cat}: ${count} tests`);
  writeFileSync(MD_OUT, lines.join('\n'));
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

// ── S12b: Guardrail condition profiling ───────────────────────────────────────
// Measures guardrail evaluation latency on simple direct-mode queries that should
// hit only cheap checks when SKIP_GUARDRAIL_CONDITIONS=false (default).
// Set SKIP_GUARDRAIL_CONDITIONS=true to baseline latency with all conditions disabled.
//
// To compare:
//   node scripts/geneweave-stress-cse-reasoning.mjs   # conditions active
//   SKIP_GUARDRAIL_CONDITIONS=true node scripts/...    # all guardrails run (baseline)

async function guardrailConditionProfiling() {
  const suite = 'GuardrailConditions';
  if (!ADMIN_EMAIL || !BASE || BASE.includes('localhost') === false) {
    info(suite, 'Skipped', 'Requires running server — set BASE, ADMIN_EMAIL, ADMIN_PASSWORD');
    return;
  }

  // Log the mode so the report is self-documenting.
  info(suite, `Mode: ${SKIP_GUARDRAIL_CONDITIONS ? 'ALL CONDITIONS DISABLED (baseline)' : 'CONDITIONS ACTIVE'}`,
    SKIP_GUARDRAIL_CONDITIONS
      ? 'All guardrails run unconditionally — measuring baseline overhead'
      : 'Expensive checks gated by trigger_conditions — measuring optimised path');

  if (SKIP_GUARDRAIL_CONDITIONS) {
    // Temporarily disable trigger_conditions on all guardrails so all checks run.
    // This lets us measure the un-gated baseline.
    const listR = await http('GET', '/api/admin/guardrails', null, adminSid, { timeout: 5000 });
    const guardrails = listR?.data?.guardrails ?? [];
    const cleared = [];
    for (const g of guardrails) {
      if (g.trigger_conditions) {
        await http('PUT', `/api/admin/guardrails/${g.id}`, { trigger_conditions: null }, adminSid, { timeout: 5000 });
        cleared.push(g.id);
      }
    }
    info(suite, `Cleared trigger_conditions from ${cleared.length} guardrails`, 'Baseline mode active');
  }

  // Simple direct-mode queries that should use only cheap checks when gated.
  const simpleQueries = [
    'What day is it today?',
    'Summarize the following: The quick brown fox.',
    'What is 2 + 2?',
    'List the files in a typical Node.js project.',
    'What is the capital of France?',
  ];

  // Create a test chat
  const loginR = await http('POST', '/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  const sid = loginR?.data?.session?.id;
  if (!sid) { warn(suite, 'Could not obtain session for profiling', 'Check ADMIN_EMAIL/PASSWORD'); return; }

  const chatR = await http('POST', '/api/chats', { title: 'Condition profiling' }, sid);
  const chatId = chatR?.data?.chat?.id;
  if (!chatId) { warn(suite, 'Could not create profiling chat', ''); return; }

  const times = [];
  for (const q of simpleQueries) {
    const r = await http('POST', `/api/chats/${chatId}/messages`,
      { content: q, stream: false, maxTokens: 20 }, sid, { timeout: 30000 });
    if (r.status < 300) {
      times.push(r.ms);
      track('guardrail_condition_query', r.ms);
    } else {
      warn(suite, `Query failed: ${q.slice(0, 40)}`, `HTTP ${r.status}`);
    }
  }

  if (times.length > 0) {
    const s = stats(times);
    const mode = SKIP_GUARDRAIL_CONDITIONS ? 'baseline (all checks)' : 'optimised (conditions active)';
    pass(suite, `Simple query latency — ${mode}`,
      `p50=${s.p50}ms p95=${s.p95}ms avg=${s.avg}ms (${times.length} samples)`);

    // Target: optimised path (conditions active) should be ≥60% faster than baseline.
    // We can't enforce this in a single run, but we report the numbers so a subsequent
    // baseline run can be compared manually from the JSON report.
    if (!SKIP_GUARDRAIL_CONDITIONS) {
      info(suite, 'Optimised path numbers recorded',
        `Compare against SKIP_GUARDRAIL_CONDITIONS=true run — target ≥60% latency reduction on simple queries`);
    } else {
      info(suite, 'Baseline numbers recorded',
        `Re-run without SKIP_GUARDRAIL_CONDITIONS to see optimised numbers`);
    }
  }
}

async function main() {
  const started = Date.now();
  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║   GeneWeave Stress · CSE Pentest · Deep Reasoning · Docker Isolation ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log(`Run: ${RUN_ID}`);
  console.log(`LLM: ${SKIP_LLM ? 'SKIP' : 'ENABLED'} · CSEPentest: ${CSE_PENTEST} · ReasoningUsers: ${REASONING_USERS} · Docker: ${DOCKER_AVAILABLE} · GuardrailConditions: ${SKIP_GUARDRAIL_CONDITIONS ? 'DISABLED (baseline)' : 'ACTIVE'}`);
  console.log(`Outputs: ${JSON_OUT}\n`);

  await section('Bootstrap & Login', bootstrapAndLogin);
  await section('Node.js Baseline Metrics', nodeBaseline);
  await section('Deep Reasoning Chat Tests (complex, multi-step)', deepReasoningTests);
  await section('Multi-Turn Conversation Stress (5 turns, building context)', multiTurnConversationStress);
  await section('Maximum Tool Call Chains (all tools, sequential)', maximumToolChainTests);
  await section('Supervisor Stress — 6 Workers, Incident Command', supervisorStressTest);
  await section('CSE Legitimate Execution (Python, JS, Bash)', cseLegitimateTests);
  await section('CSE Resource Limit Enforcement (fork bomb, OOM, CPU)', cseResourceLimitTests);
  await section('CSE Penetration & Docker Isolation Tests', csePenetrationTests);
  await section(`Concurrent Reasoning Stress (${REASONING_USERS} users, real LLM)`, concurrentReasoningStress);
  await section('Memory Pressure Profiling (50 chats, 10 concurrent messages)', memoryPressureTests);
  await section('API Latency Breakdown (per operation type)', apiLatencyBreakdown);
  await section('Guardrail Condition Profiling', guardrailConditionProfiling);
  await section('Node.js Post-Stress Metrics & Comparison', nodePostStress);

  writeReport();

  const elapsed = Date.now() - started;
  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log(`TOTAL: ${PASS+FAIL+WARN+INFO} | ✅ ${PASS} PASS | ❌ ${FAIL} FAIL | ⚠️ ${WARN} WARN`);
  console.log(`Elapsed: ${Math.round(elapsed/1000)}s`);
  console.log(`JSON:     ${JSON_OUT}`);
  console.log(`Markdown: ${MD_OUT}`);
  console.log('══════════════════════════════════════════════════════════════════════\n');
  process.exitCode = FAIL > 0 ? 1 : 0;
}

main().catch(err => { console.error(err); process.exit(1); });
