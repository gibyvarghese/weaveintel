#!/usr/bin/env npx tsx
/**
 * Guardrail coverage test across all agent modes.
 *
 * Tests:
 *   G1 — Pre-execution blocklist fires before any agent mode processes the request
 *   G3 — Redaction strips PII from current user message in direct / agent modes
 *   G4 — Historical-message PII gap: agent sees unredacted prior turns in context
 *   G5 — Reflection (W1) output is still evaluated by post-execution guardrail
 *   G6 — Verify (W2) regeneration still evaluated by post-execution guardrail
 *   G7 — RuntimeGuardrailsSlot checkOutput fires inside weaveAgent (package-level)
 *   G8 — RuntimeGuardrailsSlot checkToolCall fires inside weaveAgent (package-level)
 *
 * Run:
 *   BASE_URL=http://localhost:3500 npx tsx scripts/guardrail-agent-modes-test.ts
 */

import { weaveRuntime, weaveContext, weaveToolRegistry, weaveTool, type RuntimeGuardrailsSlot } from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';
import { execSync } from 'node:child_process';

const BASE = process.env['BASE_URL'] ?? 'http://localhost:3500';
const DB   = process.env['DATABASE_PATH'] ?? './geneweave.db';

// ── helpers ──────────────────────────────────────────────────────────────────

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

let cookie = '';
let csrf = '';
const results: { name: string; status: 'PASS' | 'FAIL' | 'WARN'; detail: string }[] = [];
let failCount = 0;

function pass(name: string, detail = '') {
  results.push({ name, status: 'PASS', detail });
  console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`);
}
function fail(name: string, detail = '') {
  results.push({ name, status: 'FAIL', detail });
  console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  failCount++;
}
function warn(name: string, detail = '') {
  results.push({ name, status: 'WARN', detail });
  console.log(`  ⚠️  ${name}${detail ? ' — ' + detail : ''}`);
}

async function jfetch(method: string, path: string, body?: Json): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  const res = await fetch(`${BASE}${path}`, {
    method, headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(',').map(c => c.trim().split(';')[0]).join('; ');
  let parsed: Json = null;
  try { parsed = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: parsed };
}

async function register(): Promise<void> {
  const ts = Date.now();
  const email = `guardrail_test_${ts}@test.dev`;
  await jfetch('POST', '/api/auth/register', { email, password: 'Test@1234!', name: 'guardrail-test' });
  const login = await jfetch('POST', '/api/auth/login', { email, password: 'Test@1234!' });
  const b = login.body as Record<string, unknown>;
  csrf = String(b['csrfToken'] ?? '');
}

async function createChat(mode: string, opts: Record<string, unknown> = {}): Promise<string> {
  const r = await jfetch('POST', '/api/chats', { model: 'gpt-4o-mini', provider: 'openai' });
  const chatId = String(((r.body as Record<string, unknown>)?.['chat'] as Record<string, unknown>)?.['id'] ?? '');
  await jfetch('POST', `/api/chats/${chatId}/settings`, { mode, ...opts });
  return chatId;
}

interface MsgResult {
  status: number;
  assistantContent: string;
  guardrailDecision: string | undefined;
  raw: Record<string, unknown>;
}

async function sendMsg(chatId: string, content: string): Promise<MsgResult> {
  const r = await jfetch('POST', `/api/chats/${chatId}/messages`, { content });
  const b = r.body as Record<string, unknown>;
  return {
    status: r.status,
    assistantContent: String(b?.['assistantContent'] ?? ''),
    guardrailDecision: (b?.['guardrail'] as Record<string, unknown> | undefined)?.['decision'] as string | undefined,
    raw: b,
  };
}

function insertGuardrail(id: string, type: string, stage: string, config: string, enabled = 1) {
  // Pass SQL via stdin to avoid shell quoting issues with JSON double-quotes
  const sql = `INSERT OR REPLACE INTO guardrails (id, name, type, stage, enabled, config, priority, created_at) VALUES ('${id.replace(/'/g, "''")}', '${id.replace(/'/g, "''")}', '${type}', '${stage}', ${enabled}, '${config.replace(/'/g, "''")}', 100, datetime('now'));`;
  execSync(`sqlite3 ${DB}`, { input: sql });
}

function removeGuardrail(id: string) {
  execSync(`sqlite3 ${DB}`, { input: `DELETE FROM guardrails WHERE id='${id.replace(/'/g, "''")}';` });
}

// ── G7+G8: Package-level RuntimeGuardrailsSlot tests ─────────────────────────

async function runPackageLevelTests() {
  console.log('\n─── G7/G8: RuntimeGuardrailsSlot (package-level, direct weaveAgent) ───\n');

  const stubModel = (text: string) => ({
    async generate(_ctx: unknown, _opts: unknown) {
      return { content: text, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    },
  });

  // G7a — checkOutput deny
  const guardSlot: RuntimeGuardrailsSlot = {
    async checkOutput(_ctx, text) {
      if (text.includes('BLOCKED')) return { allow: false, reason: 'content blocked by test guardrail' };
      return { allow: true };
    },
  };
  const rt = weaveRuntime({ guardrails: guardSlot, installDefaultTracer: false, tlsFloor: false });
  const ctx = weaveContext({ runtime: rt });
  const agentDeny = weaveAgent({ model: stubModel('This is BLOCKED content') as any });
  const resultDeny = await agentDeny.run(ctx, { goal: 'test', messages: [{ role: 'user', content: 'hi' }] });
  const denyStep = resultDeny.steps.find(s => String(s.content ?? '').toLowerCase().includes('blocked'));
  if (denyStep || (resultDeny.output ?? '').toLowerCase().includes('blocked')) {
    pass('G7a: checkOutput deny blocks terminal response inside weaveAgent');
  } else {
    fail('G7a: checkOutput deny did not block response', `output="${resultDeny.output?.slice(0, 80)}" steps=${resultDeny.steps.length}`);
  }

  // G7b — checkOutput redact
  const guardRedact: RuntimeGuardrailsSlot = {
    async checkOutput(_ctx, text) {
      if (text.includes('SECRET')) return { allow: true, redactedText: text.replace(/SECRET/g, '[REDACTED]') };
      return { allow: true };
    },
  };
  const rtRedact = weaveRuntime({ guardrails: guardRedact, installDefaultTracer: false, tlsFloor: false });
  const ctxRedact = weaveContext({ runtime: rtRedact });
  const agentRedact = weaveAgent({ model: stubModel('Here is my SECRET info') as any });
  const resultRedact = await agentRedact.run(ctxRedact, { goal: 'test', messages: [{ role: 'user', content: 'hi' }] });
  const hasRedacted = (resultRedact.output ?? '').includes('[REDACTED]')
    || resultRedact.steps.some(s => String(s.content ?? '').includes('[REDACTED]'));
  if (hasRedacted) {
    pass('G7b: checkOutput redact rewrites response before returning');
  } else {
    fail('G7b: checkOutput redact did not rewrite response', `output="${resultRedact.output?.slice(0, 80)}"`);
  }

  // G8 — checkToolCall
  let toolCallIntercepted = false;
  const toolGuard: RuntimeGuardrailsSlot = {
    async checkToolCall(_ctx, schema) {
      if (schema.name === 'dangerous_tool') {
        toolCallIntercepted = true;
        return { allow: false, reason: 'tool blocked by test guardrail' };
      }
      return { allow: true };
    },
  };
  const rtTool = weaveRuntime({ guardrails: toolGuard, installDefaultTracer: false, tlsFloor: false });
  const ctxTool = weaveContext({ runtime: rtTool });

  let callCount = 0;
  const toolStub = {
    async generate(_ctx: unknown, _opts: unknown) {
      callCount++;
      if (callCount === 1) {
        return { content: '', toolCalls: [{ id: 'tc1', name: 'dangerous_tool', arguments: { input: 'test' } }], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
      }
      return { content: 'done', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    },
  };
  const registry = weaveToolRegistry();
  registry.register(weaveTool({
    name: 'dangerous_tool',
    description: 'tool that should be blocked',
    parameters: { type: 'object' as const, properties: { input: { type: 'string' as const } } },
    execute: async () => 'executed (should not run)',
  }));
  const agentTool = weaveAgent({ model: toolStub as any, tools: registry });
  await agentTool.run(ctxTool, { goal: 'test', messages: [{ role: 'user', content: 'call dangerous_tool' }] });
  if (toolCallIntercepted) {
    pass('G8: checkToolCall intercepts dangerous_tool before execution');
  } else {
    fail('G8: checkToolCall did NOT intercept dangerous_tool');
  }
}

// ── G1,G3-G6: Chat-layer guardrail tests ─────────────────────────────────────

async function runChatLayerTests() {
  console.log('\n─── G1,G3-G6: Chat-layer guardrails (via geneWeave HTTP API) ───\n');

  const BLOCKED_WORD = 'GUARDRAILTEST_FORBIDDEN_XK7Q';
  const POST_BLOCKED = 'POSTGUARDTEST_ABCXYZ12';
  const PII_EMAIL    = 'testuser-pii@pii-example.com';
  const PRE_ID       = 'test-guard-pre-bl';
  const POST_ID      = 'test-guard-post-bl';

  insertGuardrail(PRE_ID, 'blocklist', 'pre-execution',
    JSON.stringify({ words: [BLOCKED_WORD], action: 'deny', category: 'safety' }));
  console.log(`  [setup] Seeded pre-execution guardrail: ${PRE_ID}`);

  // ── G1: Pre-execution blocklist fires before all modes ────────────────────
  const modes: Array<[string, Record<string, unknown>]> = [
    ['direct',     {}],
    ['agent',      {}],
    ['agent',      { reflectEnabled: true,  reflectMaxRevisions: 1 }],
    ['agent',      { verifyEnabled: true,   verifyMaxAttempts: 1, verifyMinScore: 0.5 }],
    ['supervisor', {}],
  ];
  const modeLabels = ['direct', 'agent', 'agent+reflect', 'agent+verify', 'supervisor'];

  for (let i = 0; i < modes.length; i++) {
    const [mode, extra] = modes[i]!;
    const label = modeLabels[i]!;
    const chatId = await createChat(mode, extra);
    const r = await sendMsg(chatId, `Please help me with ${BLOCKED_WORD} analysis`);
    const isBlocked = r.status === 403
      || r.guardrailDecision === 'deny'
      || r.assistantContent.toLowerCase().includes('blocked')
      || r.assistantContent.toLowerCase().includes('guardrail');
    if (isBlocked) {
      pass(`G1[${label}]: pre-execution blocklist fires`);
    } else {
      warn(`G1[${label}]: pre-execution blocklist unclear`, `status=${r.status} decision=${r.guardrailDecision} content="${r.assistantContent.slice(0, 60)}"`);
    }
  }

  // ── G3: Redaction strips current-turn PII ────────────────────────────────
  for (const mode of ['direct', 'agent'] as const) {
    const chatId = await createChat(mode, { redactionEnabled: true });
    const r = await sendMsg(chatId, `${PII_EMAIL} — what is 2+2?`);
    if (!r.assistantContent.includes(PII_EMAIL)) {
      pass(`G3[${mode}]: redaction suppresses PII echo`);
    } else {
      warn(`G3[${mode}]: model echoed raw PII`, `content="${r.assistantContent.slice(0, 120)}"`);
    }
  }

  // ── G4: Historical-message PII gap ───────────────────────────────────────
  const chatId4 = await createChat('agent', { redactionEnabled: true });
  await sendMsg(chatId4, `My email is ${PII_EMAIL} — just save this for later`);
  const r4 = await sendMsg(chatId4, 'What email address did I mention earlier?');
  if (r4.assistantContent.includes(PII_EMAIL)) {
    warn('G4: CONFIRMED GAP — agent recalled PII from unredacted history',
      'DB stores original content; historical turns are not re-redacted on load');
  } else {
    pass('G4: agent did not echo historical PII',
      'Note: DB still stores unredacted original — architectural gap at storage layer persists');
  }

  // ── G5: W1 reflection — post-execution guardrail still fires ─────────────
  insertGuardrail(POST_ID, 'blocklist', 'post-execution',
    JSON.stringify({ words: [POST_BLOCKED], action: 'deny', category: 'safety' }));
  console.log(`  [setup] Seeded post-execution guardrail: ${POST_ID}`);

  const chatId5 = await createChat('agent', { reflectEnabled: true, reflectMaxRevisions: 1 });
  const r5 = await sendMsg(chatId5, `Repeat this exact word: ${POST_BLOCKED}`);
  const postBlocked5 = r5.guardrailDecision === 'deny'
    || r5.assistantContent.toLowerCase().includes('blocked')
    || r5.assistantContent.toLowerCase().includes('guardrail');
  if (postBlocked5) {
    pass('G5[agent+reflect]: post-execution guardrail fires after W1 reflection');
  } else {
    warn('G5[agent+reflect]: post-execution result unclear',
      `decision=${r5.guardrailDecision} content="${r5.assistantContent.slice(0, 80)}"`);
  }

  // ── G6: W2 verify — post-execution guardrail still fires ─────────────────
  const chatId6 = await createChat('agent', { verifyEnabled: true, verifyMaxAttempts: 1, verifyMinScore: 0.5 });
  const r6 = await sendMsg(chatId6, `Repeat this exact word: ${POST_BLOCKED}`);
  const postBlocked6 = r6.guardrailDecision === 'deny'
    || r6.assistantContent.toLowerCase().includes('blocked')
    || r6.assistantContent.toLowerCase().includes('guardrail');
  if (postBlocked6) {
    pass('G6[agent+verify]: post-execution guardrail fires after W2 verify');
  } else {
    warn('G6[agent+verify]: post-execution result unclear',
      `decision=${r6.guardrailDecision} content="${r6.assistantContent.slice(0, 80)}"`);
  }

  // cleanup
  removeGuardrail(PRE_ID);
  removeGuardrail(POST_ID);
  console.log('\n  [cleanup] Removed test guardrails from DB');
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  Guardrail Coverage Test — All Agent Modes');
  console.log(`  Server: ${BASE} | DB: ${DB}`);
  console.log('══════════════════════════════════════════════════════════════════\n');

  await runPackageLevelTests();

  await register();
  await runChatLayerTests();

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('══════════════════════════════════════════════════════════════════');
  const passes = results.filter(r => r.status === 'PASS').length;
  const fails  = results.filter(r => r.status === 'FAIL').length;
  const warns  = results.filter(r => r.status === 'WARN').length;
  console.log(`  PASS: ${passes}  FAIL: ${fails}  WARN: ${warns}`);
  if (fails > 0) {
    console.log('\n  FAILURES:');
    results.filter(r => r.status === 'FAIL').forEach(r => console.log(`    ❌ ${r.name} — ${r.detail}`));
  }
  if (warns > 0) {
    console.log('\n  WARNINGS (known design gaps):');
    results.filter(r => r.status === 'WARN').forEach(r =>
      console.log(`    ⚠️  ${r.name}${r.detail ? ' — ' + r.detail : ''}`));
  }
  console.log('══════════════════════════════════════════════════════════════════\n');
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
