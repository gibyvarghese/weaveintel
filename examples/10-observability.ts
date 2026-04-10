/**
 * Example 10: Observability
 *
 * Demonstrates tracing, event bus, and usage tracking
 * to monitor and debug AI workflows.
 */
import {
  createExecutionContext,
  createEventBus,
  EventTypes,
  createToolRegistry,
  defineTool,
} from '@weaveintel/core';
import {
  createConsoleTracer,
  createInMemoryTracer,
  createUsageTracker,
} from '@weaveintel/observability';
import { createToolCallingAgent } from '@weaveintel/agents';
import { createFakeModel } from '@weaveintel/testing';

async function main() {
  const bus = createEventBus();
  const ctx = createExecutionContext({ userId: 'demo-user' });

  // --- Console Tracer ---
  console.log('=== Console Tracer ===');
  const consoleTracer = createConsoleTracer();

  const span1 = consoleTracer.startSpan('model-call', { model: 'gpt-4o-mini' });
  // Simulate some work
  span1.addEvent('request-sent', { tokens: 150 });
  span1.addEvent('response-received', { tokens: 85 });
  consoleTracer.endSpan(span1.id, { status: 'ok' });

  // --- In-Memory Tracer ---
  console.log('\n=== In-Memory Tracer ===');
  const memTracer = createInMemoryTracer();

  const span2 = memTracer.startSpan('rag-pipeline', { query: 'What is WeaveIntel?' });
  const childSpan = memTracer.startSpan('embedding', { parentId: span2.id, model: 'text-embedding-3-small' });
  memTracer.endSpan(childSpan.id, { status: 'ok', chunkCount: 5 });
  const childSpan2 = memTracer.startSpan('vector-search', { parentId: span2.id, topK: 3 });
  memTracer.endSpan(childSpan2.id, { status: 'ok', results: 3 });
  memTracer.endSpan(span2.id, { status: 'ok' });

  const traces = memTracer.getSpans();
  console.log(`Recorded ${traces.length} spans:`);
  for (const t of traces) {
    const indent = t.parentId ? '  ' : '';
    console.log(`${indent}[${t.name}] ${t.durationMs?.toFixed(1) ?? '?'}ms - ${t.attributes?.status ?? 'pending'}`);
  }

  // --- Event Bus ---
  console.log('\n=== Event Bus ===');
  const events: string[] = [];

  bus.on(EventTypes.MODEL_REQUEST_START, (event) => {
    events.push(`model-start: ${JSON.stringify(event.data)}`);
  });

  bus.on(EventTypes.MODEL_REQUEST_END, (event) => {
    events.push(`model-end: ${JSON.stringify(event.data)}`);
  });

  bus.on(EventTypes.TOOL_CALL_START, (event) => {
    events.push(`tool-start: ${JSON.stringify(event.data)}`);
  });

  bus.on(EventTypes.TOOL_CALL_END, (event) => {
    events.push(`tool-end: ${JSON.stringify(event.data)}`);
  });

  bus.on(EventTypes.AGENT_STEP, (event) => {
    events.push(`agent-step: ${JSON.stringify(event.data)}`);
  });

  // Run an agent to generate events
  const tools = createToolRegistry();
  tools.register(
    defineTool({
      name: 'lookup',
      description: 'Look up information',
      parameters: {
        type: 'object',
        properties: { topic: { type: 'string' } },
        required: ['topic'],
      },
      execute: async (args) => `Info about ${(args as { topic: string }).topic}: It is great.`,
    }),
  );

  const model = createFakeModel({
    responses: [
      {
        content: '',
        toolCalls: [
          { id: 'c1', function: { name: 'lookup', arguments: '{"topic":"WeaveIntel"}' } },
        ],
      },
      { content: 'WeaveIntel is great!', toolCalls: [] },
    ],
  });

  const agent = createToolCallingAgent({
    model,
    tools,
    bus,
    systemPrompt: 'You help look up information.',
    maxSteps: 5,
  });

  await agent.run(
    { messages: [{ role: 'user', content: 'Tell me about WeaveIntel' }] },
    ctx,
  );

  console.log(`Captured ${events.length} events:`);
  for (const e of events) {
    console.log(`  ${e}`);
  }

  // --- Usage Tracker ---
  console.log('\n=== Usage Tracker ===');
  const tracker = createUsageTracker();

  tracker.track({
    executionId: ctx.executionId,
    model: 'gpt-4o-mini',
    promptTokens: 150,
    completionTokens: 85,
    totalTokens: 235,
    costUsd: 0.0003,
    latencyMs: 320,
  });

  tracker.track({
    executionId: ctx.executionId,
    model: 'text-embedding-3-small',
    promptTokens: 500,
    completionTokens: 0,
    totalTokens: 500,
    costUsd: 0.00005,
    latencyMs: 45,
  });

  const totals = tracker.getTotals(ctx.executionId);
  console.log('Execution totals:');
  console.log(`  Total tokens: ${totals.totalTokens}`);
  console.log(`  Total cost: $${totals.costUsd.toFixed(5)}`);
  console.log(`  Total latency: ${totals.latencyMs}ms`);

  const allRecords = tracker.getRecords(ctx.executionId);
  console.log(`\nDetailed records (${allRecords.length}):`);
  for (const rec of allRecords) {
    console.log(`  ${rec.model}: ${rec.totalTokens} tokens, $${rec.costUsd.toFixed(5)}, ${rec.latencyMs}ms`);
  }
}

main().catch(console.error);
