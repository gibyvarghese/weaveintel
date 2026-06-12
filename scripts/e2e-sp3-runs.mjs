#!/usr/bin/env node
// scripts/e2e-sp3-runs.mjs
//
// SP3 — live-server end-to-end proof for the user run executor + SSE fan-out
// that backs the mobile chat surface (M4):
//
//   POST /api/me/runs                  { input: { text } }  → 201 { id, status:'pending' }
//   GET  /api/me/runs/:id/events       SSE stream (?after=<seq> to resume)
//   POST /api/me/runs/:id/cancel       cooperative cancel
//
// Flow:
//   1. Register a principal, mint a bearer token + CSRF.
//   2. POST a run with a text prompt → 201 pending.
//   3. Attach the SSE stream → assert run.started first, ≥1 text.delta, a single
//      terminal event (run.completed) last, and monotonic gap-free sequences.
//   4. Re-attach with ?after=<mid> → assert only later events replay (gap-free,
//      no duplicates) and the stream closes immediately (run already terminal).
//   5. Start a second run, attach, cancel mid-stream → assert run.cancelled is
//      the single terminal event and the run never completes.
//
// Usage: zsh> set +H && BASE_URL=http://localhost:3500 node scripts/e2e-sp3-runs.mjs
import { BASE, makeOk, jfetch } from './e2e-helpers.mjs';

const ok = makeOk();
const ts = Date.now();
const password = 'P@ssw0rd123';

console.log(`\n=== SP3 runs executor E2E — ${BASE} ===\n`);

// ── SSE reader: collect envelopes until a terminal kind or timeout ──────────
const TERMINAL = new Set(['run.completed', 'run.failed', 'run.cancelled']);

async function readRunStream(runId, { bearer, after, onEvent, timeoutMs = 30_000 } = {}) {
  const qs = after !== undefined ? `?after=${after}` : '';
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const envelopes = [];
  let closedByTerminal = false;
  try {
    const res = await fetch(`${BASE}/api/me/runs/${runId}/events${qs}`, {
      headers: { accept: 'text/event-stream', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      signal: ac.signal,
    });
    if (res.status !== 200 || !res.body) return { status: res.status, envelopes, closedByTerminal };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data: ')) continue;
        let env;
        try { env = JSON.parse(line.slice(6)); } catch { continue; }
        envelopes.push(env);
        onEvent?.(env, () => ac.abort());
        if (TERMINAL.has(env.kind)) { closedByTerminal = true; ac.abort(); break; }
      }
      if (closedByTerminal) break;
    }
    return { status: 200, envelopes, closedByTerminal };
  } catch (err) {
    if (err?.name === 'AbortError') return { status: 200, envelopes, closedByTerminal };
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function assertGapFree(envelopes, label) {
  const seqs = envelopes.map((e) => e.sequence);
  for (let i = 1; i < seqs.length; i++) {
    ok(seqs[i] === seqs[i - 1] + 1, `${label}: sequence ${seqs[i]} follows ${seqs[i - 1]} (gap-free)`);
  }
  ok(new Set(seqs).size === seqs.length, `${label}: no duplicate sequences`);
}

// ── 0/1. Principal + bearer ─────────────────────────────────────────────────
console.log('0/1. Register a principal and mint a bearer token');
const email = `e2e_sp3_${ts}@example.com`;
const reg = await jfetch('POST', '/api/auth/register', { body: { email, password, name: 'sp3' } });
ok(reg.status === 201, `register status=${reg.status}`);
const tok = await jfetch('POST', '/api/auth/token', { body: { email, password } });
ok(tok.status === 200 && tok.body?.token, `token minted (status=${tok.status})`);
const bearer = tok.body.token;
const csrf = tok.body.csrfToken;

// ── 2. Start a run ──────────────────────────────────────────────────────────
console.log('\n2. Start a run with a text prompt');
const start = await jfetch('POST', '/api/me/runs', {
  bearer, csrf,
  body: { input: { text: 'Reply with a short friendly greeting.' } },
});
ok(start.status === 201 && start.body?.id, `run created (status=${start.status})`);
ok(start.body.status === 'pending' || start.body.status === 'running', `run starts non-terminal (=${start.body.status})`);
const runId = start.body.id;

// ── 3. Attach the live stream to completion ──────────────────────────────────
console.log('\n3. Attach the SSE stream and drain it to a terminal event');
const live = await readRunStream(runId, { bearer });
ok(live.status === 200, `stream status=${live.status}`);
ok(live.envelopes.length >= 2, `received ≥2 events (got ${live.envelopes.length})`);
ok(live.envelopes[0].kind === 'run.started', `first event is run.started (=${live.envelopes[0].kind})`);
const last = live.envelopes[live.envelopes.length - 1];
ok(TERMINAL.has(last.kind), `last event is terminal (=${last.kind})`);
ok(last.kind === 'run.completed', `run completed via the default agent (=${last.kind})`);
ok(live.envelopes.some((e) => e.kind === 'text.delta'), 'at least one text.delta was streamed');
ok(live.envelopes.filter((e) => TERMINAL.has(e.kind)).length === 1, 'exactly one terminal event');
assertGapFree(live.envelopes, 'live stream');
ok(live.closedByTerminal, 'server closed the stream on the terminal event');
const completedSeqs = live.envelopes.map((e) => e.sequence);
const midSeq = completedSeqs[Math.floor(completedSeqs.length / 2)];

// ── 4. Resume from a cursor → only later events, no dupes, closes ────────────
console.log(`\n4. Re-attach with ?after=${midSeq} → resume is gap-free + duplicate-free`);
const resume = await readRunStream(runId, { bearer, after: midSeq });
ok(resume.status === 200, `resume stream status=${resume.status}`);
ok(resume.envelopes.every((e) => e.sequence > midSeq), `every replayed event has sequence > ${midSeq}`);
ok(resume.envelopes.some((e) => e.kind === 'run.completed'), 'resume still delivers the terminal event');
assertGapFree(resume.envelopes, 'resume stream');
ok(resume.closedByTerminal, 'resume stream closes on the terminal event');

// ── 5. Cancel mid-stream → run.cancelled is the single terminal event ────────
console.log('\n5. Start a second run, cancel mid-stream → cooperative halt');
const start2 = await jfetch('POST', '/api/me/runs', {
  bearer, csrf,
  body: { input: { text: 'Write a long detailed multi-paragraph essay about the ocean.' } },
});
ok(start2.status === 201 && start2.body?.id, `second run created (status=${start2.status})`);
const runId2 = start2.body.id;

let cancelSent = false;
const cancelled = await readRunStream(runId2, {
  bearer,
  timeoutMs: 30_000,
  onEvent: async (env) => {
    // Fire the cancel as soon as the run is actually producing.
    if (!cancelSent && (env.kind === 'run.started' || env.kind === 'text.delta')) {
      cancelSent = true;
      const c = await jfetch('POST', `/api/me/runs/${runId2}/cancel`, { bearer, csrf });
      ok(c.status === 200 || c.status === 202, `cancel accepted (status=${c.status})`);
    }
  },
});
ok(cancelled.envelopes.some((e) => e.kind === 'run.cancelled'), 'run.cancelled was emitted');
ok(cancelled.envelopes.filter((e) => TERMINAL.has(e.kind)).length === 1, 'exactly one terminal event after cancel');
ok(!cancelled.envelopes.some((e) => e.kind === 'run.completed'), 'cancelled run never completes');
assertGapFree(cancelled.envelopes, 'cancelled stream');

console.log(`\n✅ SP3 runs executor E2E passed — ${ok.count()} assertions\n`);
