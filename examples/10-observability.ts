/**
 * Example 10: Observability
 *
 * Demonstrates tracing, event bus, and usage tracking
 * to monitor and debug AI workflows.
 */
import {
  weaveContext,
  weaveEventBus,
  EventTypes,
  weaveToolRegistry,
  weaveTool,
} from '@weaveintel/core';
import {
  weaveConsoleTracer,
  weaveInMemoryTracer,
  weaveUsageTracker,
} from '@weaveintel/observability';
import { weaveAgent } from '@weaveintel/agents';
import { weaveFakeModel } from '@weaveintel/testing';

async function main() {
  const bus = weaveEventBus();
  const ctx = weaveContext({ userId: 'demo-user' });

  // --- Console Tracer ---
  console.log('=== Console Tracer ===');
  const consoleTracer = weaveConsoleTracer();

  const span1 = consoleTracer.startSpan(ctx, 'model-call', { model: 'gpt-4o-mini' });
  // Simulate some work
  span1.addEvent('request-sent', { tokens: 150 });
  span1.addEvent('response-received', { tokens: 85 });
  span1.end();

  // --- In-Memory Tracer ---
  console.log('\n=== In-Memory Tracer ===');
  const memTracer = weaveInMemoryTracer();

  const span2 = memTracer.startSpan(ctx, 'rag-pipeline', { query: 'What is weaveIntel?' });
  const childSpan = memTracer.startSpan(
    { ...ctx, parentSpanId: span2.spanId } as any,
    'embedding',
    { model: 'text-embedding-3-small' },
  );
  childSpan.end();

  const childSpan2 = memTracer.startSpan(
    { ...ctx, parentSpanId: span2.spanId } as any,
    'vector-search',
    { topK: 3 },
  );
  childSpan2.end();
  span2.end();

  const traces = memTracer.spans;
  console.log(`Recorded ${traces.length} spans:`);
  for (const t of traces) {
    const indent = t.parentSpanId ? '  ' : '';
    const dur = t.endTime - t.startTime;
    console.log(`${indent}[${t.name}] ${dur}ms - ${t.status}`);
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
  const tools = weaveToolRegistry();
  tools.register(
    weaveTool({
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

  const model = weaveFakeModel({
    responses: [
      {
        content: '',
        toolCalls: [
          { id: 'c1', function: { name: 'lookup', arguments: '{"topic":"weaveIntel"}' } },
        ],
      },
      { content: 'weaveIntel is great!' },
    ],
  });

  const agent = weaveAgent({
    model,
    tools,
    bus,
    systemPrompt: 'You help look up information.',
    maxSteps: 5,
  });

  await agent.run(ctx, { messages: [{ role: 'user', content: 'Tell me about weaveIntel' }] });

  console.log(`Captured ${events.length} events:`);
  for (const e of events) {
    console.log(`  ${e}`);
  }

  // --- Usage Tracker ---
  console.log('\n=== Usage Tracker ===');
  const tracker = weaveUsageTracker();

  tracker.record({
    executionId: ctx.executionId,
    model: 'gpt-4o-mini',
    provider: 'openai',
    promptTokens: 150,
    completionTokens: 85,
    totalTokens: 235,
    costUsd: 0.0003,
    timestamp: Date.now(),
  });

  tracker.record({
    executionId: ctx.executionId,
    model: 'text-embedding-3-small',
    provider: 'openai',
    promptTokens: 500,
    completionTokens: 0,
    totalTokens: 500,
    costUsd: 0.00005,
    timestamp: Date.now(),
  });

  const totals = tracker.getTotal(ctx.executionId);
  console.log('Execution totals:');
  console.log(`  Total tokens: ${totals?.totalTokens ?? 0}`);
  console.log(`  Total cost: $${(totals?.costUsd ?? 0).toFixed(5)}`);

  const allRecords = tracker.getAll();
  console.log(`\nDetailed records (${allRecords.length}):`);
  for (const rec of allRecords) {
    console.log(`  ${rec.model}: ${rec.totalTokens} tokens, $${(rec.costUsd ?? 0).toFixed(5)}`);
  }
}

main().catch(console.error);
