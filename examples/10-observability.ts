/**
 * Example 10: Observability
 *
 * Demonstrates tracing, event bus, usage tracking, and tool-call observability
 * to monitor and debug AI workflows end-to-end.
 *
 * WeaveIntel packages used:
 *   @weaveintel/core          — ExecutionContext, EventBus, EventTypes constants, ToolRegistry
 *   @weaveintel/observability — Three observability primitives:
 *     • weaveConsoleTracer   — Logs span lifecycle (start/event/end) to stdout; great for dev
 *     • weaveInMemoryTracer  — Stores spans in an array for programmatic inspection / export
 *     • weaveUsageTracker    — Accumulates token counts and costs per model per execution
 *   @weaveintel/agents        — weaveAgent() to generate realistic events for the bus
 *   @weaveintel/testing       — weaveFakeModel() for deterministic agent runs
 *
 * Tracing follows the OpenTelemetry span model: each span has a name, optional
 * parent, events, attributes, start/end timestamps, and status. Spans can nest
 * to form a tree (e.g. rag-pipeline → embedding → vector-search).
 *
 * NEW: Tool-call observability pattern
 *   The event bus emits tool.call.start / tool.call.end / tool.call.error events
 *   for every tool invocation inside an agent. Subscribing to these events lets you
 *   capture per-tool spans with full payload, latency, and status — separate from the
 *   generic agent step spans. This mirrors how geneWeave persists tool_call.* traces
 *   in its SQLite traces table.
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
  // weaveConsoleTracer() logs every span start, event, and end to the console.
  // Useful during development to see the full execution trace in real time.
  console.log('=== Console Tracer ===');
  const consoleTracer = weaveConsoleTracer();

  // startSpan() begins a new trace span. The first argument is the context
  // (carries traceId/userId), the second is the span name, and the third is
  // an optional attributes object for structured metadata.
  const span1 = consoleTracer.startSpan(ctx, 'model-call', { model: 'gpt-4o-mini' });
  // addEvent() attaches named events to a span — like milestones within one operation.
  span1.addEvent('request-sent', { tokens: 150 });
  span1.addEvent('response-received', { tokens: 85 });
  // end() closes the span, recording its duration.
  span1.end();

  // --- In-Memory Tracer ---
  // weaveInMemoryTracer() stores all spans in a .spans array that you can
  // inspect, export to JSON, or send to an external tracing backend.
  // Spans can be nested via parentSpanId to form a tree.
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
  // weaveEventBus is weaveIntel's global pub/sub system. Every subsystem
  // emits typed events (MODEL_REQUEST_START, TOOL_CALL_END, AGENT_STEP, etc.)
  // that you can subscribe to for logging, metrics, or custom side effects.
  // EventTypes is a const enum of all standard event names.
  console.log('\n=== Event Bus ===');
  const events: string[] = [];

  bus.on(EventTypes.ModelRequestStart, (event) => {
    events.push(`model-start: ${JSON.stringify(event.data)}`);
  });

  bus.on(EventTypes.ModelRequestEnd, (event) => {
    events.push(`model-end: ${JSON.stringify(event.data)}`);
  });

  bus.on(EventTypes.ToolCallStart, (event) => {
    events.push(`tool-start: ${JSON.stringify(event.data)}`);
  });

  bus.on(EventTypes.ToolCallEnd, (event) => {
    events.push(`tool-end: ${JSON.stringify(event.data)}`);
  });

  bus.on(EventTypes.AgentStepEnd, (event) => {
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
  // weaveUsageTracker() accumulates token counts and dollar costs per model
  // per executionId. Call .record() after each LLM call, then .getTotal()
  // to aggregate. Useful for budgeting, cost alerts, and billing dashboards.
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

  // --- Tool-Call Observability (NEW) ---
  // The event bus emits tool.call.start / tool.call.end / tool.call.error events
  // for every tool invocation inside an agent run. By subscribing to these three
  // events you can capture per-tool spans with full payload, latency, and status.
  //
  // Pattern used inside geneWeave (chat.ts) to persist tool_call.* SQLite trace rows:
  //   • Subscribe before running the agent
  //   • Collect ToolCallObservableEvent items into an array
  //   • After the run, persist them as individual trace spans named "tool_call.<toolName>"
  //   • Unsubscribe in a finally block to avoid memory leaks
  //
  // This gives you fine-grained visibility into which tools were called, with what
  // arguments, what they returned, and how long each one took — independently of the
  // coarser agent step spans.
  console.log('\n=== Tool-Call Observability ===');

  interface ToolCallEvent {
    phase: 'start' | 'end' | 'error';
    tool: string;
    executionId: string;
    startTime?: number;
    endTime?: number;
    input?: unknown;
    result?: unknown;
    error?: string;
  }

  const toolCallBus = weaveEventBus();
  const toolCallCtx = weaveContext({ userId: 'obs-user' });
  const collectedToolCalls: ToolCallEvent[] = [];

  // Subscribe to all three tool lifecycle events.
  // EventTypes.ToolCallStart fires before execute(), .ToolCallEnd after,
  // .ToolCallError on any thrown exception.
  const startTimes: Record<string, number> = {};

  toolCallBus.on(EventTypes.ToolCallStart, (event) => {
    const data = event.data as { tool: string; executionId: string; input?: unknown };
    startTimes[data.tool] = Date.now();
    collectedToolCalls.push({ phase: 'start', tool: data.tool, executionId: data.executionId, startTime: startTimes[data.tool], input: data.input });
  });

  toolCallBus.on(EventTypes.ToolCallEnd, (event) => {
    const data = event.data as { tool: string; executionId: string; result?: unknown };
    collectedToolCalls.push({ phase: 'end', tool: data.tool, executionId: data.executionId, endTime: Date.now(), result: data.result });
  });

  toolCallBus.on(EventTypes.ToolCallError, (event) => {
    const data = event.data as { tool: string; executionId: string; error?: string };
    collectedToolCalls.push({ phase: 'error', tool: data.tool, executionId: data.executionId, endTime: Date.now(), error: data.error });
  });

  // Run an agent with multiple tool calls so we can observe them.
  const obsTools = weaveToolRegistry();
  obsTools.register(
    weaveTool({
      name: 'web_search',
      description: 'Search the web',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
      execute: async (args) => `Results for: ${(args as { query: string }).query}`,
    }),
  );
  obsTools.register(
    weaveTool({
      name: 'calculator',
      description: 'Evaluate a math expression',
      parameters: {
        type: 'object',
        properties: { expression: { type: 'string' } },
        required: ['expression'],
      },
      execute: async (args) => String(eval((args as { expression: string }).expression)),
    }),
  );

  const obsModel = weaveFakeModel({
    responses: [
      { content: '', toolCalls: [{ id: 't1', function: { name: 'web_search', arguments: '{"query":"weaveIntel pricing"}' } }] },
      { content: '', toolCalls: [{ id: 't2', function: { name: 'calculator', arguments: '{"expression":"42 * 1.1"}' } }] },
      { content: 'The price is approximately 46.2 units.' },
    ],
  });

  const obsAgent = weaveAgent({ model: obsModel, tools: obsTools, bus: toolCallBus, maxSteps: 6 });
  await obsAgent.run(toolCallCtx, { messages: [{ role: 'user', content: 'What is weaveIntel pricing and compute 42 * 1.1?' }] });

  // Aggregate the collected events into per-tool spans.
  // In production this is where you'd persist to a traces table:
  //   INSERT INTO traces (name, status, attributes) VALUES ('tool_call.web_search', 'ok', ...)
  const endEvents = collectedToolCalls.filter((e) => e.phase === 'end' || e.phase === 'error');
  console.log(`Captured ${endEvents.length} completed tool-call spans:`);
  for (const ev of endEvents) {
    const spanName = `tool_call.${ev.tool}`;
    const status = ev.phase === 'error' ? 'error' : 'ok';
    const startEvent = collectedToolCalls.find((e) => e.phase === 'start' && e.tool === ev.tool);
    const latencyMs = startEvent?.startTime ? (ev.endTime ?? Date.now()) - startEvent.startTime : 0;
    console.log(`  [${spanName}] status=${status} latency=${latencyMs}ms`);
    if (ev.result !== undefined) {
      console.log(`    result: ${JSON.stringify(ev.result).slice(0, 80)}`);
    }
    if (ev.error) {
      console.log(`    error: ${ev.error}`);
    }
  }

  // Why this matters:
  // Without tool-call observability you only see coarse "agent step" spans.
  // With it, you can answer: "Was web_search called? What did it return? How long did it take?"
  // This is especially valuable in multi-agent supervisor workflows where workers
  // run tools in parallel and attribution can be tricky.
}

main().catch(console.error);
