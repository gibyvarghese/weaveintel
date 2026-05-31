/**
 * Example 123 — `weaveRuntime` golden path (Phase 2).
 *
 * Turns on nothing exotic. No DB, no LLM, no external service. Yet the
 * single `weaveRuntime()` construction gives you:
 *
 *   - observability   (tracer + spans propagated through ExecutionContext)
 *   - safe egress     (hardenedFetch with SSRF + redirect re-validation +
 *                      HTTPS floor + outer timeout + streaming size cap)
 *   - secret resolution (env-backed, swappable for vault / KMS later)
 *   - audit logging   (no-op by default; structured slot for adopters)
 *   - capability gating (tools that declare `requires` are asserted)
 *
 * Run:
 *   npx tsx examples/123-runtime-golden-path.ts
 *
 * Expected output: two spans logged for the wrapper work, a secret
 * resolved from `process.env`, a tool invocation that succeeds because
 * the runtime advertises `runtime.net.egress`, and a tool invocation
 * that fails fast because the runtime does NOT advertise
 * `runtime.persistence`.
 */

import {
  weaveRuntime,
  weaveContext,
  weaveTool as defineTool,
  RuntimeCapabilities,
} from '@weaveintel/core';
import { weaveConsoleTracer } from '@weaveintel/observability';

// ─── 1. Construct the single ambient runtime ─────────────────────────
//
// Zero domain config. The defaults give you a noop tracer; we pass a real
// console tracer so you can see the spans in stdout.

const runtime = weaveRuntime({
  tracer: weaveConsoleTracer(),
});

console.log('runtime capabilities:', [...runtime.capabilities]);

// ─── 2. Derive an ExecutionContext that carries the runtime ──────────

const ctx = weaveContext({ runtime });

// ─── 3. Resolve a secret through the runtime, not process.env ────────

process.env['WEAVE_DEMO_KEY'] = 'demo-value-123';
const secret = await runtime.secrets.resolve('WEAVE_DEMO_KEY');
console.log('resolved WEAVE_DEMO_KEY via runtime.secrets:', secret);

// ─── 4. Egress via hardened fetch — SSRF/redirect/timeout/size enforced ──

await runtime.tracer.withSpan(ctx, 'demo:egress', async (span) => {
  span.setAttribute('demo.url', 'https://example.com');
  try {
    const r = await runtime.egress.fetch('https://example.com', undefined, {
      errorTag: 'example-123',
      timeoutMs: 10_000,
    });
    span.setAttribute('http.status', r.status);
    console.log('egress status:', r.status);
  } catch (err) {
    // Offline runs still demonstrate the chokepoint without crashing the example.
    span.setError(err as Error);
    console.log('egress threw (acceptable offline):', (err as Error).message);
  }
});

// ─── 5. Capability gating on tools — the satisfied case ──────────────

const pingTool = defineTool({
  name: 'demo_ping',
  description: 'Demonstrates a tool that declares egress as its only need.',
  parameters: { type: 'object', properties: {} },
  requires: [RuntimeCapabilities.NetEgress],
  async execute(_args, c) {
    // Per-tool egress: pull the closure from the ambient runtime.
    void c;
    return 'pong';
  },
});

const pingOut = await pingTool.invoke(ctx, { name: 'demo_ping', arguments: {} });
console.log('demo_ping result:', pingOut.content);

// ─── 6. Capability gating on tools — the rejected case ───────────────

const dlqTool = defineTool({
  name: 'demo_dlq_write',
  description: 'Writes a dead-letter envelope. Requires persistence.',
  parameters: { type: 'object', properties: {} },
  requires: [RuntimeCapabilities.Persistence],
  async execute() { return 'should-not-run'; },
});

try {
  await dlqTool.invoke(ctx, { name: 'demo_dlq_write', arguments: {} });
  console.error('ERROR: dlq tool should have been rejected');
  process.exit(1);
} catch (err) {
  console.log('demo_dlq_write correctly rejected:', (err as Error).message);
}

console.log('\ngolden path complete.');
