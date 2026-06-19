/**
 * Example 141: OTel GenAI Observability (Phase 1)
 *
 * Demonstrates how to wire the OpenTelemetry GenAI-semantic-convention tracer
 * into WeaveIntel so every LLM call, agent step, and tool invocation is visible
 * in Grafana Cloud, Honeycomb, Jaeger, or any OTLP-compatible backend.
 *
 * Packages used:
 *   @weaveintel/core          — weaveRuntime, weaveContext, weaveAudit
 *   @weaveintel/observability — createOtelTracer, weaveOtlpSink, GEN_AI
 *   @weaveintel/agents        — weaveAgent (to generate realistic LLM spans)
 *   @weaveintel/testing       — weaveFakeModel (deterministic, no API key needed)
 *
 * GenAI semantic convention attributes emitted on every LLM span:
 *   gen_ai.system              — AI provider (e.g. 'anthropic', 'openai')
 *   gen_ai.request.model       — requested model id
 *   gen_ai.usage.input_tokens  — prompt token count
 *   gen_ai.usage.output_tokens — completion token count
 *   gen_ai.operation.name      — 'chat', 'tool_call', 'embedding'
 *
 * Quick-start:
 *   export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318   # Jaeger
 *   npx tsx examples/141-otel-genai-observability.ts
 *
 * See docs/observability-otel-setup.md for Grafana Cloud / Honeycomb steps.
 */

import { weaveContext, weaveRuntime, weaveAudit, RuntimeCapabilities } from '@weaveintel/core';
import { createOtelTracer, weaveInMemoryTracer, GEN_AI } from '@weaveintel/observability';

// ─── 1. Create the OTel tracer ────────────────────────────────────────────────
//
// When OTEL_EXPORTER_OTLP_ENDPOINT is set, spans are exported to the OTLP
// backend in real time. When not set, we fall back to an in-memory tracer for
// this example so you can inspect captured spans in your console.

const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];

const tracer = endpoint
  ? createOtelTracer({
      endpoint,
      serviceName: process.env['OTEL_SERVICE_NAME'] ?? 'weaveintel-example',
      // Optional: pass an API key for backends that require auth
      apiKey: process.env['OTEL_EXPORTER_OTLP_HEADERS_AUTHORIZATION'],
    })
  : weaveInMemoryTracer(); // no collector needed for the example

if (endpoint) {
  console.log(`Exporting spans to OTLP endpoint: ${endpoint}/v1/traces`);
} else {
  console.log('No OTEL_EXPORTER_OTLP_ENDPOINT set — using in-memory tracer.');
  console.log('Set it to send spans to Jaeger, Grafana Cloud, or Honeycomb.\n');
}

// ─── 2. Wire the tracer into a WeaveRuntime ───────────────────────────────────

const runtime = weaveRuntime({ tracer });
const ctx = weaveContext({ runtime, userId: 'example-user' });

console.log('Runtime capabilities:', Array.from(runtime.capabilities).join(', '));

// ─── 3. Emit a GenAI span manually ───────────────────────────────────────────
//
// In production geneWeave wraps every model.generate() call automatically via
// withLLMSpan(). This example shows the raw API so you can see what's emitted.

async function simulateLLMCall(modelId: string, provider: string): Promise<void> {
  await runtime.tracer.withSpan(
    ctx,
    'gen_ai.chat',
    async (span) => {
      // Attach GenAI semantic convention attributes
      span.setAttribute(GEN_AI.SYSTEM, provider);
      span.setAttribute(GEN_AI.REQUEST_MODEL, modelId);
      span.setAttribute(GEN_AI.OPERATION_NAME, 'chat');
      span.setAttribute(GEN_AI.REQUEST_MAX_TOKENS, 1024);
      span.setAttribute(GEN_AI.REQUEST_TEMPERATURE, 0.7);

      // Simulate LLM latency
      await new Promise((r) => setTimeout(r, 80));

      // Record usage after the response
      span.setAttribute(GEN_AI.USAGE_INPUT_TOKENS, 120);
      span.setAttribute(GEN_AI.USAGE_OUTPUT_TOKENS, 42);
      span.setAttribute(GEN_AI.USAGE_COST_USD, 0.00027);

      span.addEvent('first-token', { latencyMs: 35 });
    },
    {
      [GEN_AI.SYSTEM]: provider,
      [GEN_AI.REQUEST_MODEL]: modelId,
    },
  );
}

// ─── 4. Emit a tool-call child span ──────────────────────────────────────────

async function simulateToolCall(toolName: string, parentSpanId: string): Promise<void> {
  const childCtx = { ...ctx, parentSpanId };
  await runtime.tracer.withSpan(
    childCtx,
    `gen_ai.tool_call.${toolName}`,
    async (span) => {
      span.setAttribute(GEN_AI.OPERATION_NAME, 'tool_call');
      span.setAttribute('tool.name', toolName);
      await new Promise((r) => setTimeout(r, 20));
    },
  );
}

// ─── 5. Emit an audit entry with spanId (trace joining) ──────────────────────

async function main() {
  console.log('=== Simulating LLM call spans ===\n');

  // Root LLM span
  const parentSpan = runtime.tracer.startSpan(ctx, 'gen_ai.chat', {
    [GEN_AI.SYSTEM]: 'anthropic',
    [GEN_AI.REQUEST_MODEL]: 'claude-sonnet-4-6',
    [GEN_AI.OPERATION_NAME]: 'chat',
  });

  // Emit an audit entry linked to this span
  await weaveAudit(ctx, {
    action: 'chat.send',
    outcome: 'success',
    resource: 'chat:example-123',
    spanId: parentSpan.spanId,
    correlationId: ctx.executionId,
    details: { mode: 'direct', model: 'claude-sonnet-4-6' },
  });
  console.log(`Audit entry emitted with spanId: ${parentSpan.spanId}`);

  // Simulate a tool call as a child span
  await simulateToolCall('web_search', parentSpan.spanId);

  // Add usage to the parent span before ending it
  parentSpan.setAttribute(GEN_AI.USAGE_INPUT_TOKENS, 250);
  parentSpan.setAttribute(GEN_AI.USAGE_OUTPUT_TOKENS, 88);
  parentSpan.end();

  // A few more LLM calls
  await simulateLLMCall('claude-sonnet-4-6', 'anthropic');
  await simulateLLMCall('gpt-4o', 'openai');

  // ─── Show captured spans (in-memory mode only) ────────────────────────────
  if (!endpoint && 'spans' in tracer) {
    const mem = tracer as ReturnType<typeof weaveInMemoryTracer>;
    console.log(`\n=== Captured ${mem.spans.length} spans ===\n`);
    for (const span of mem.spans) {
      const durationMs = span.endTime - span.startTime;
      console.log(`[${span.status.toUpperCase()}] ${span.name} — ${durationMs}ms`);
      const genAiAttrs = Object.entries(span.attributes)
        .filter(([k]) => k.startsWith('gen_ai.'));
      if (genAiAttrs.length > 0) {
        console.log('  GenAI attributes:');
        for (const [k, v] of genAiAttrs) {
          console.log(`    ${k}: ${JSON.stringify(v)}`);
        }
      }
      if (span.events.length > 0) {
        console.log(`  Events: ${span.events.map((e) => e.name).join(', ')}`);
      }
    }
  } else if (endpoint) {
    console.log('\nSpans exported to OTLP endpoint. Check your observability backend.');
  }

  // Flush remaining buffered spans before process exit
  if ('sink' in tracer && typeof (tracer as any).sink?.flush === 'function') {
    await (tracer as any).sink.flush();
    console.log('OTLP span buffer flushed.');
  }
}

main().catch(console.error);
