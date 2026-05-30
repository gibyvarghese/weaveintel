/**
 * geneWeave — Developer Documentation HTML
 * Served at GET /docs. Full geneWeave branding, independent scroll, hierarchical nav.
 */

// ── Build-time helpers ────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function code(lang: string, src: string): string {
  return `<div class="cb"><div class="cb-hdr"><span class="cb-lang">${lang}</span><button class="copy-btn" onclick="copyCode(this)">Copy</button></div><pre><code class="language-${lang}">${esc(src.trim())}</code></pre></div>`;
}

function callout(type: 'info' | 'tip' | 'warn' | 'danger', icon: string, title: string, body: string): string {
  return `<div class="callout callout-${type}"><span class="callout-icon">${icon}</span><div><strong>${title}</strong> ${body}</div></div>`;
}

function params(rows: [string, string, string, string][]): string {
  const trs = rows.map(([n, t, r, d]) =>
    `<tr><td class="pname"><code>${n}</code></td><td class="ptype"><code>${t}</code></td><td>${r === 'required' ? '<span class="req">required</span>' : '<span class="opt">optional</span>'}</td><td class="pdesc">${d}</td></tr>`
  ).join('');
  return `<div class="tbl-wrap"><table class="ptable"><thead><tr><th>Parameter</th><th>Type</th><th>Required</th><th>Description</th></tr></thead><tbody>${trs}</tbody></table></div>`;
}

function returns(rows: [string, string][]): string {
  const trs = rows.map(([f, d]) => `<tr><td><code>${f}</code></td><td>${d}</td></tr>`).join('');
  return `<div class="tbl-wrap"><table class="ptable"><thead><tr><th>Field</th><th>Description</th></tr></thead><tbody>${trs}</tbody></table></div>`;
}

function exlinks(links: [string, string][]): string {
  const items = links.map(([file, title]) =>
    `<a class="ex-link" href="https://github.com/weaveintel/weaveintel/blob/main/examples/${file}" target="_blank" rel="noopener">
      <span class="ex-icon">&#128196;</span>
      <span class="ex-title">${title}</span>
      <span class="ex-ext">&#8599;</span>
    </a>`
  ).join('');
  return `<div class="ex-links"><div class="ex-links-label">Related Examples</div><div class="ex-links-list">${items}</div></div>`;
}

function section(id: string, title: string, body: string): string {
  return `<section id="${id}" class="doc-section"><h2 class="sec-title"><span class="sec-anchor">#</span>${title}</h2>${body}</section>`;
}

function subsection(id: string, title: string, body: string): string {
  return `<div id="${id}" class="doc-subsection"><h3 class="subsec-title">${title}</h3>${body}</div>`;
}

function featureCards(cards: [string, string][]): string {
  const items = cards.map(([t, d]) => `<div class="fcard"><div class="fcard-title">${t}</div><div class="fcard-desc">${d}</div></div>`).join('');
  return `<div class="fcard-grid">${items}</div>`;
}

function typeTable(rows: [string, string][]): string {
  const trs = rows.map(([t, d]) => `<tr><td><code>${t}</code></td><td>${d}</td></tr>`).join('');
  return `<div class="tbl-wrap"><table class="ptable"><thead><tr><th>Value</th><th>Description</th></tr></thead><tbody>${trs}</tbody></table></div>`;
}

// ── Section: Home ─────────────────────────────────────────────────────────

function sHome(): string {
  const pkgs = [
    ['agents', '🤖', 'Agents', 'ReAct tool-calling loops, supervisor mode, worker delegation'],
    ['workflows', '⚙️', 'Workflows', 'Durable multi-step orchestration with checkpointing and human gates'],
    ['models', '🧠', 'Models', 'Provider-agnostic model factory with routing and cost tracking'],
    ['prompts', '💬', 'Prompts', 'Versioned prompts, output contracts, A/B experiments, evaluation'],
    ['memory', '🧩', 'Memory', 'Semantic, entity, conversation and working memory with vector search'],
    ['retrieval', '🔍', 'Retrieval', 'Chunking, embedding pipelines, hybrid RAG, query rewriting'],
    ['tools', '🔧', 'Tool Framework', 'Policy, audit, approval gates and health tracking for any tool'],
    ['evals', '📊', 'Evals', 'Rubric-based LLM-as-judge evaluation with dataset comparison'],
    ['guardrails', '🛡️', 'Guardrails', 'Pre/post-execution risk, PII, confidence and cost gates'],
    ['resilience', '♻️', 'Resilience', 'Token bucket, circuit breaker, retry and concurrency primitives'],
    ['cost-governor', '💰', 'Cost Governor', '8-lever cost optimisation with tier policies and model cascade'],
    ['tools-time', '🕐', 'tools-time', '16 time-aware tools: datetime, timers, stopwatches, reminders'],
    ['tools-browser', '🌐', 'tools-browser', 'Web fetch, content extraction, scraping, Playwright automation'],
    ['tools-search', '🔎', 'tools-search', 'Multi-provider search with auto-failover (9 providers)'],
    ['mcp', '🔌', 'MCP', 'Model Context Protocol client and server — cross-system tool sharing'],
    ['observability', '📈', 'Observability', 'Tracing, usage tracking, budget monitoring and span export'],
    ['sandbox', '📦', 'Sandbox', 'Safe execution of LLM-generated code with resource limits'],
    ['core', '⚛️', 'Core', 'Zero-dependency contract layer — every interface lives here'],
  ].map(([id, icon, name, desc]) =>
    `<div class="pkg-card" onclick="nav('${id}')"><div class="pkg-icon">${icon}</div><div class="pkg-name">${name}</div><div class="pkg-desc">${desc}</div></div>`
  ).join('');

  return `
<div class="hero">
  <div class="hero-icon">🧬</div>
  <h1 class="hero-title">WeaveIntel Developer Documentation</h1>
  <p class="hero-sub">A modular, production-grade TypeScript monorepo for building AI-powered applications. Every capability is a standalone package — use one or all.</p>
  <div class="hero-badges">
    <span class="badge badge-accent">TypeScript-native</span>
    <span class="badge badge-muted">Zero vendor lock-in</span>
    <span class="badge badge-muted">Dependency injection</span>
    <span class="badge badge-muted">Production-ready</span>
  </div>
</div>

${callout('info', '💡', 'Architecture principle.', 'Every interface lives in <code>@weaveintel/core</code>. No package imports a concrete implementation — swap any model, store, or transport without touching business logic.')}

<h2 class="sec-title"><span class="sec-anchor">#</span>Packages</h2>
<div class="pkg-grid">${pkgs}</div>

<h2 class="sec-title" style="margin-top:40px"><span class="sec-anchor">#</span>Layer overview</h2>
${code('text', `Applications (geneweave, your app)
  └─ Agent Layer    @weaveintel/agents · @weaveintel/workflows · @weaveintel/cost-governor
  └─ Capability     @weaveintel/prompts · @weaveintel/memory · @weaveintel/retrieval
                    @weaveintel/evals · @weaveintel/guardrails · @weaveintel/resilience
  └─ Integration    @weaveintel/models · @weaveintel/mcp-client · @weaveintel/mcp-server
                    @weaveintel/tools-* · @weaveintel/sandbox · @weaveintel/observability
  └─ Contracts      @weaveintel/core  (zero runtime dependencies)`)}`;
}

// ── Section: Agents ───────────────────────────────────────────────────────

function sAgents(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/agents</span></div>
  <h1 class="pkg-title">Agents</h1>
  <p class="pkg-desc">Build tool-calling agents, supervisor hierarchies, and multi-worker delegation systems. Agents run a ReAct loop — think, call tool, observe, repeat — until they produce a final answer or reach <code>maxSteps</code>.</p>
</div>

${callout('info', '🤖', 'When to use.', 'Use agents when you need an LLM to <em>decide</em> which actions to take at runtime. For deterministic, audited pipelines where every step is predefined, use <strong>Workflows</strong> instead.')}

${exlinks([
  ['02-tool-calling-agent.ts', 'Example 02 — Tool-Calling Agent'],
  ['04-hierarchical-agents.ts', 'Example 04 — Hierarchical Agents'],
  ['07-memory-augmented-agent.ts', 'Example 07 — Memory-Augmented Agent'],
  ['2y-supervisor-dynamic-workflow.ts', 'Example 2Y — Supervisor + Dynamic Workflow'],
])}

${section('weave-agent', 'weaveAgent — Creating an Agent', `
<p>The primary factory function. Returns an <code>Agent</code> that can be run with any input messages.</p>

${code('typescript', `import { weaveAgent } from '@weaveintel/agents';
import { weaveAnthropicModel } from '@weaveintel/provider-anthropic';
import { weaveContext, weaveToolRegistry, weaveTool } from '@weaveintel/core';

const model = weaveAnthropicModel('claude-haiku-4-5-20251001');

const tools = weaveToolRegistry();
tools.register(weaveTool({
  name: 'get_price',
  description: 'Fetch the current stock price for a ticker symbol.',
  parameters: {
    type: 'object',
    required: ['ticker'],
    properties: { ticker: { type: 'string', description: 'Stock ticker, e.g. AAPL' } },
  },
  execute: async ({ ticker }) => {
    const price = await priceService.get(ticker);
    return JSON.stringify({ ticker, price, currency: 'USD' });
  },
}));

const agent = weaveAgent({
  name: 'market-analyst',
  model,
  tools,
  systemPrompt: 'You are a market analyst. Use tools to fetch live data before answering.',
  maxSteps: 8,
});

const ctx = weaveContext({ userId: 'alice', sessionId: 'sess-001' });
const result = await agent.run(ctx, {
  messages: [{ role: 'user', content: 'What is the current price of AAPL and MSFT?' }],
});

console.log(result.output);        // Final text answer
console.log(result.steps.length);  // Number of reasoning + tool-call steps`)}

<h4>weaveAgent options</h4>
${params([
  ['model', 'Model', 'required', 'Any <code>Model</code> instance. Obtained from provider packages or <code>weaveGetModel(key)</code>.'],
  ['tools', 'ToolRegistry', 'optional', 'Registry of tools the agent may call. Build with <code>weaveToolRegistry()</code>.'],
  ['workers', 'WorkerDefinition[]', 'optional', 'Enables supervisor mode. Agent auto-receives <code>delegate_to_worker</code>, <code>think</code>, and <code>plan</code> tools.'],
  ['systemPrompt', 'string', 'optional', 'System instructions prepended to every model call.'],
  ['maxSteps', 'number', 'optional', 'Hard cap on the number of tool-call iterations. Default: 20.'],
  ['name', 'string', 'optional', 'Agent identifier shown in traces and delegation messages.'],
  ['bus', 'EventBus', 'optional', 'Event bus for step-level observability. Every tool call and model response emits an event.'],
  ['memory', 'AgentMemory', 'optional', 'Attach a memory store to inject relevant context before each model call.'],
  ['policy', 'AgentPolicy', 'optional', 'Per-agent rate limiting, cost ceiling, and capability restrictions.'],
  ['additionalTools', 'ToolRegistry', 'optional', 'In supervisor mode: extra tools the supervisor calls directly (not delegated).'],
])}

<h4>AgentResult — what agent.run() returns</h4>
${returns([
  ['output', 'The agent\'s final text answer (last non-tool-call message content).'],
  ['steps', 'AgentStep[] — full reasoning trace (see below).'],
  ['usage', '{ inputTokens, outputTokens, totalTokens } — aggregate across all model calls.'],
  ['durationMs', 'Wall-clock time for the complete agent run.'],
  ['finishReason', '"max_steps" | "final_answer" | "error" — why the loop ended.'],
])}

<h4>AgentStep — individual loop iteration</h4>
${params([
  ['type', '"thinking" | "tool_call" | "tool_result" | "final_answer"', 'required', 'What kind of step this is.'],
  ['content', 'string', 'optional', 'Text content from the model (for thinking / final_answer steps).'],
  ['toolCall', 'ToolCallRecord', 'optional', 'Present for tool_call steps: <code>{ name, arguments, result, durationMs }</code>.'],
])}
`)}

${section('supervisor', 'Supervisor Mode', `
<p>When <code>workers</code> is provided, the agent becomes a supervisor. The WeaveIntel supervisor runtime automatically adds three tools to the supervisor's registry:</p>
<ul>
  <li><code>delegate_to_worker(worker, goal)</code> — runs a named worker agent and returns its output</li>
  <li><code>think(thought)</code> — structured chain-of-thought logging</li>
  <li><code>plan(steps)</code> — explicit decomposition before acting</li>
</ul>
<p>Workers run with complete isolation — their own model, tool registry, and step counter. The supervisor sees only their final <code>output</code> string.</p>

${code('typescript', `import { weaveAgent } from '@weaveintel/agents';
import type { WorkerDefinition } from '@weaveintel/agents';

// Worker 1: searches the web
const researchWorker: WorkerDefinition = {
  name: 'researcher',
  description: 'Searches the web and retrieves relevant information on any topic.',
  model: weaveAnthropicModel('claude-haiku-4-5-20251001'),
  tools: searchToolRegistry,
  maxSteps: 6,
};

// Worker 2: writes polished reports
const writerWorker: WorkerDefinition = {
  name: 'writer',
  description: 'Takes structured notes and produces a well-formatted report.',
  model: weaveAnthropicModel('claude-sonnet-4-6'),
  // No tools — pure generation
  maxSteps: 3,
};

const supervisor = weaveAgent({
  name: 'content-supervisor',
  model: weaveAnthropicModel('claude-sonnet-4-6'),
  workers: [researchWorker, writerWorker],
  systemPrompt:
    'You coordinate research and writing tasks. Delegate research to "researcher", ' +
    'then hand the findings to "writer" for a polished report. Synthesise the final output.',
  maxSteps: 6,
});

const ctx = weaveContext({ userId: 'bob' });
const result = await supervisor.run(ctx, {
  messages: [{ role: 'user', content: 'Write a report on the state of LLM inference in 2025.' }],
});

console.log(result.output);
// Shows reasoning: think → delegate_to_worker(researcher) → delegate_to_worker(writer) → final`)}

<h4>WorkerDefinition</h4>
${params([
  ['name', 'string', 'required', 'Identifier used in <code>delegate_to_worker({ worker: NAME })</code> calls.'],
  ['description', 'string', 'required', 'What this worker specialises in. The supervisor\'s model sees this to decide who to delegate to.'],
  ['model', 'Model', 'required', 'Independent model. Can differ from the supervisor\'s model — e.g. use a cheaper model for narrow tasks.'],
  ['tools', 'ToolRegistry', 'optional', 'Tools this worker may call. If omitted, worker is a pure-generation agent.'],
  ['maxSteps', 'number', 'optional', 'Step limit for this worker independently. Default: 10.'],
  ['systemPrompt', 'string', 'optional', 'System prompt for this worker. If omitted, built from its description.'],
])}

${callout('tip', '💡', 'Supervisor best practices.', 'Keep workers narrow and single-purpose. A researcher should only search; a writer should only write. Broad workers reduce delegation quality because the supervisor cannot predict their behaviour.')}
`)}

${section('agent-tools', 'Tool Binding', `
<p>Any tool registered on a <code>ToolRegistry</code> is available to the agent. The LLM sees the tool name, description, and parameter schema — write these carefully as they directly affect tool selection quality.</p>

${code('typescript', `import { weaveToolRegistry, weaveTool } from '@weaveintel/core';

const tools = weaveToolRegistry();

// Register individually
tools.register(weaveTool({
  name: 'send_slack_message',
  description:
    'Send a message to a Slack channel. Use this when the user asks to notify a team or send an update.',
  parameters: {
    type: 'object',
    required: ['channel', 'message'],
    properties: {
      channel: {
        type: 'string',
        description: 'Channel name without #, e.g. "engineering-alerts"',
      },
      message: { type: 'string' },
      urgent: { type: 'boolean', description: 'Whether to @here the channel' },
    },
  },
  requiresApproval: true,     // Human must approve before execution
  riskLevel: 'medium',
  tags: ['communication', 'slack'],
  execute: async ({ channel, message, urgent = false }, ctx) => {
    // ctx.userId, ctx.traceId, ctx.metadata available here
    await slackClient.post(channel, message, { mention: urgent ? 'here' : undefined });
    return \`Message sent to #\${channel}\`;
  },
}));

// Or register a pre-built pack (e.g. tools-time)
import { createTimeTools } from '@weaveintel/tools-time';
createTimeTools({ defaultTimezone: 'UTC' }).forEach(t => tools.register(t));`)}

${callout('warn', '⚠️', 'Tool description quality matters.', 'The model uses descriptions to decide <em>when</em> to call a tool. Vague descriptions like "does stuff" cause missed calls. Start with the trigger: <em>"Use this when…"</em> or <em>"Call this to…"</em>')}

<h4>Tool output format</h4>
<p>Tools must return a <code>string</code> or <code>ToolOutput = { content: string; isError?: boolean }</code>. For structured data, always <code>JSON.stringify</code> the result — the model parses it from the string:</p>
${code('typescript', `execute: async ({ query }) => {
  const results = await db.search(query);
  // Return structured data as a JSON string
  return JSON.stringify({ count: results.length, items: results });
}`)}
`)}

${section('agent-memory', 'Memory Integration', `
<p>Attach a memory store to give the agent cross-session context. Before each model call, relevant memories are retrieved and injected as additional context messages.</p>

${code('typescript', `import { weaveSemanticMemory } from '@weaveintel/memory';
import { weaveAgent } from '@weaveintel/agents';

const memory = weaveSemanticMemory({ embeddingModel, store: myStore });

const agent = weaveAgent({
  model,
  tools,
  memory: {
    store: memory,
    searchK: 5,          // Inject top 5 relevant memories
    minScore: 0.65,      // Minimum relevance threshold
    role: 'system',      // Inject as system context (or 'user')
  },
});`)}
`)}

${section('agent-events', 'Event Bus & Observability', `
<p>Pass an <code>EventBus</code> to stream every agent step in real time. Events include model calls, tool invocations, and step completions.</p>

${code('typescript', `import { weaveEventBus, EventTypes } from '@weaveintel/core';

const bus = weaveEventBus();

// Stream steps to a client (e.g. SSE endpoint)
bus.on(EventTypes.AGENT_STEP, (event) => {
  if (event.step.type === 'tool_call') {
    console.log(\`Tool: \${event.step.toolCall?.name}\`);
  }
  if (event.step.type === 'final_answer') {
    console.log(\`Answer: \${event.step.content}\`);
  }
});

bus.on(EventTypes.MODEL_CALL, (event) => {
  const { inputTokens, outputTokens } = event.usage ?? {};
  console.log(\`Tokens: \${inputTokens} in / \${outputTokens} out\`);
});

const agent = weaveAgent({ model, tools, bus });`)}
`)}`;
}

// ── Section: Workflows ────────────────────────────────────────────────────

function sWorkflows(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/workflows</span></div>
  <h1 class="pkg-title">Workflows</h1>
  <p class="pkg-desc">Durable, deterministic multi-step orchestration. Every step is checkpointed — runs survive process restarts, support human approval gates, retry with backoff, parallel branches, and runtime-generated sub-graphs.</p>
</div>

${callout('info', '⚙️', 'Workflows vs Agents.', 'Use <strong>Workflows</strong> when every step must be auditable, retryable, and deterministic. Use <strong>Agents</strong> when the LLM must decide what to do at runtime. The two compose: a workflow step can invoke an agent, and an agent can trigger a workflow.')}

${exlinks([
  ['13-workflow-engine.ts', 'Example 13 — Workflow Engine with Guardrails'],
  ['15-workflow-control-flow.ts', 'Example 15 — Control Flow (W1)'],
  ['16-workflow-reliability.ts', 'Example 16 — Reliability (W2)'],
  ['17-workflow-state-data.ts', 'Example 17 — State & Data (W3)'],
  ['18-workflow-durability.ts', 'Example 18 — Durability & Recovery (W4)'],
  ['19-workflow-governance.ts', 'Example 19 — Governance (W5)'],
  ['21-workflow-observability.ts', 'Example 21 — Observability (W6)'],
  ['2x-dynamic-workflows.ts', 'Example 2X — Dynamic Graphs (W7)'],
])}

${section('wf-engine', 'Engine Setup', `
<p>The <code>DefaultWorkflowEngine</code> wires together all stores, registries, and policies. Create one instance per application. Every method is async and safe to call concurrently.</p>

${code('typescript', `import {
  DefaultWorkflowEngine,
  HandlerResolverRegistry,
  createNoopResolver,
  createScriptResolver,
  InMemoryWorkflowRunRepository,
  InMemoryCheckpointStore,
  JsonFileWorkflowRunRepository,
  JsonFileCheckpointStore,
} from '@weaveintel/workflows';

// Development — in-memory, no persistence
const devEngine = new DefaultWorkflowEngine({
  resolverRegistry: myResolverRegistry,
});

// Production — file-backed persistence
const engine = new DefaultWorkflowEngine({
  runRepository:   new JsonFileWorkflowRunRepository('./data/runs.json'),
  checkpointStore: new JsonFileCheckpointStore('./data/checkpoints.json'),
  resolverRegistry: resolverRegistry,
  defaultPolicy: {
    maxSteps:          100,
    costCeiling:       5.00,      // USD — fail run when exceeded
    maxConcurrentRuns: 10,
    maxExpansionDepth: 3,         // W7 dynamic graphs
    maxGeneratedSteps: 50,
  },
  spanEmitter: mySpanEmitter,     // W6 observability
  auditLog: myAuditLog,           // W4 audit trail
  rateLimiter: myRateLimiter,     // W5 rate limiting
});

// Register domain handlers directly
engine.registerHandler('send-email', async (vars, config) => {
  await emailService.send(vars['to'] as string, config['subject'] as string);
  return { sent: true };
});

// Define and start a run
await engine.createDefinition(def);
const run = await engine.startRun(def.id, { orderId: 'ORD-001', amount: 99.99 });
console.log(run.status); // 'completed' | 'paused' | 'failed'`)}

<h4>WorkflowEngineOptions</h4>
${params([
  ['runRepository', 'WorkflowRunRepository', 'optional', 'Stores run records. Default: InMemoryWorkflowRunRepository.'],
  ['checkpointStore', 'CheckpointStore', 'optional', 'Stores step-level state snapshots for restart recovery.'],
  ['definitionStore', 'WorkflowDefinitionStore', 'optional', 'Persists workflow definitions independently of the engine.'],
  ['resolverRegistry', 'HandlerResolverRegistry', 'optional', 'Maps handler refs (e.g. <code>tool:send-email</code>) to async functions.'],
  ['defaultPolicy', 'WorkflowPolicy', 'optional', 'Engine-wide policy applied to all runs unless overridden per-definition.'],
  ['spanEmitter', 'WorkflowSpanEmitter', 'optional', 'W6: emits execution spans for tracing.'],
  ['auditLog', 'WorkflowAuditLog', 'optional', 'W4: records every state transition as an immutable audit event.'],
  ['rateLimiter', 'WorkflowRateLimiter', 'optional', 'W5: token-bucket rate limiting per workflow definition.'],
  ['runQueue', 'WorkflowRunQueue', 'optional', 'W5: priority queue for concurrent run slot management.'],
  ['costMeter', 'CostMeter', 'optional', 'Accumulates per-run cost from step handlers.'],
  ['humanTaskQueue', 'HumanTaskQueue', 'optional', 'Backend for human-task steps (approval queues).'],
  ['bus', 'EventBus', 'optional', 'Event bus for run-level lifecycle events.'],
])}
`)}

${section('wf-builder', 'Defining Workflows', `
<p>Use the fluent <code>defineWorkflow()</code> / <code>WorkflowBuilder</code> API to declare steps. The builder validates step references at build time.</p>

${code('typescript', `import { defineWorkflow } from '@weaveintel/workflows';

const def = defineWorkflow('Customer Onboarding')
  .setId('customer-onboarding-v2')
  .setVersion('2.0.0')
  .setDescription('Validates, enriches, and activates new customer accounts')
  .setPolicy({ maxSteps: 30, costCeiling: 1.00 })

  // Deterministic: pure computation or external call
  .addStep({
    id: 'validate',
    name: 'Validate Input',
    type: 'deterministic',
    handler: 'validate-customer',
    next: 'enrich',
    retries: 2,
    timeout: 5000,
    onError: 'handle-validation-error',
  })

  // Agentic: LLM-driven, output may vary
  .addStep({
    id: 'enrich',
    name: 'Enrich Profile (AI)',
    type: 'agentic',
    handler: 'agent:customer-enricher',  // resolver-kind ref
    next: 'approve',
    retries: 1,
    outputSchema: {                        // W3: validate output shape
      type: 'object',
      required: ['riskScore', 'segment'],
    },
    outputSchemaAction: 'fail',
  })

  // Human gate: pauses until a human approves/rejects
  .humanTask('approve', 'Manager Approval', {
    taskType: 'approval',
    title: 'Approve new customer?',
    priority: 'high',
    next: 'activate',
  })

  .addStep({ id: 'activate', name: 'Activate', type: 'deterministic', handler: 'activate-customer' })
  .addStep({ id: 'handle-validation-error', name: 'Error Handler', type: 'deterministic', handler: 'log-error' })
  .build();`)}
`)}

${section('wf-steps', 'All Step Types', `
<p>Every step type is designed for a specific execution pattern. Choosing the right type ensures the engine applies the correct execution semantics.</p>

${subsection('step-deterministic', 'deterministic', `
<p>Pure computation, external API calls, data transforms. The engine retries on failure and checkpoints after success.</p>
${code('typescript', `.addStep({
  id: 'call-payment-api',
  name: 'Charge Card',
  type: 'deterministic',
  handler: 'charge-card',
  next: 'send-receipt',
  retries: 3,
  retryDelayMs: 1000,
  retryBackoffMultiplier: 2,   // 1s → 2s → 4s
  retryMaxDelayMs: 30000,
  retryJitter: true,
  timeout: 10000,              // ms — step timeout (not retry timeout)
  idempotencyKey: '{{vars.orderId}}:payment',  // W2: deduplication
  fallbackHandler: 'use-cached-charge',        // Run on final failure
  onError: 'payment-failed',                   // Route here on unrecoverable error
  skipIf: '{{vars.alreadyPaid}}',              // JSONLogic expression
})`)}
`)}

${subsection('step-agentic', 'agentic', `
<p>LLM-driven step. Output is non-deterministic; the engine still checkpoints and retries on hard failures.</p>
${code('typescript', `.addStep({
  id: 'classify',
  name: 'Classify Order',
  type: 'agentic',
  handler: 'prompt:classify-order@v2',  // Resolver: executes a versioned prompt
  next: 'process',
  outputSchema: { type: 'object', required: ['category', 'confidence'] },
  outputSchemaAction: 'warn',   // 'fail' | 'warn' | 'coerce'
  maskFields: ['creditCard', 'ssn'],  // W3: mask PII in stored output
})`)}
`)}

${subsection('step-condition', 'condition', `
<p>Boolean branch. The handler must return a truthy or falsy value; the engine routes to <code>next[0]</code> (true) or <code>next[1]</code> (false).</p>
${code('typescript', `.addStep({
  id: 'is-premium',
  name: 'Is Premium Customer?',
  type: 'condition',
  handler: 'check-premium',   // Returns true/false
  next: ['process-premium', 'process-standard'],
})`)}
`)}

${subsection('step-switch', 'switch', `
<p>Multi-case routing. The handler returns a string case key; config.cases maps it to a step ID. Supports a <code>default</code> fallthrough.</p>
${code('typescript', `.switch('route-order', 'Route by Order Type', {
  handler: 'classify-order',
  cases: {
    digital:     'process-digital',
    physical:    'process-physical',
    subscription: 'process-subscription',
    default:     'process-unknown',
  },
})`)}
`)}

${subsection('step-forEach', 'forEach', `
<p>Iterates over an array. The iterator handler returns <code>string[] | object[]</code>; the body handler runs once per item. Supports bounded concurrency.</p>
${code('typescript', `.forEach('process-items', 'Process Line Items', {
  handler: 'list-items',       // Returns array to iterate
  bodyHandler: 'process-item', // Runs per item
  maxConcurrency: 5,           // Run up to 5 items in parallel
  next: 'summarise',
  config: { batchSize: 100 },
})

// Body handler receives:
engine.registerHandler('process-item', async (vars) => {
  const item = vars['__item'] as LineItem;   // Current item
  const index = vars['__itemIndex'] as number;
  return { processed: item.id, qty: item.quantity };
});`)}
`)}

${subsection('step-parallel', 'parallel (lanes)', `
<p>Named concurrent handlers. Results are keyed by lane name and merged into state variables. All lanes run simultaneously.</p>
${code('typescript', `.parallelLanes('enrich', 'Parallel Enrichment', {
  lanes: {
    pricing:   'fetch-pricing',
    inventory: 'check-inventory',
    credit:    'check-credit-score',
  },
  next: 'evaluate',
})

// Each handler runs concurrently. Results in state as:
// vars['__step_enrich'] = { pricing: {...}, inventory: {...}, credit: {...} }`)}
`)}

${subsection('step-fork-join', 'fork / join', `
<p>Fork fires N independent branch handlers concurrently (like parallel lanes but step-based). Join aggregates when all branches complete.</p>
${code('typescript', `.fork('fan-out', 'Fan Out to Regions', {
  branches: {
    us_east:  'process-us-east',
    us_west:  'process-us-west',
    eu_west:  'process-eu-west',
  },
  next: 'aggregate',
})

.join('aggregate', 'Aggregate Results', {
  forkStepId: 'fan-out',
  branches: ['us_east', 'us_west', 'eu_west'],
  next: 'done',
})`)}
`)}

${subsection('step-wait', 'wait', `
<p>Pauses the run until explicitly resumed via <code>engine.resumeRun(runId)</code> or automatically after <code>wakeAfterMs</code>.</p>
${code('typescript', `.wait('await-payment', 'Wait for Payment Confirmation', {
  next: 'fulfil',
  wakeAfterMs: 86_400_000,  // Auto-resume after 24h if not already resumed
})

// Resume from an external webhook:
app.post('/webhook/payment-confirmed', async (req) => {
  const { runId, payload } = req.body;
  await engine.resumeRun(runId, { paymentId: payload.id });
});`)}
`)}

${subsection('step-human-task', 'human-task', `
<p>Creates a structured human task in the queue, pauses the run, and resumes when the human submits a decision.</p>
${code('typescript', `.humanTask('review-kyc', 'KYC Review', {
  taskType: 'review',
  title: 'Review KYC documents for {{vars.customerName}}',
  description: 'Check government-issued ID and proof of address.',
  priority: 'high',
  next: 'post-review',
})

// Complete the task (e.g. from admin UI):
await engine.completeHumanTask(taskId, {
  decision: 'approved',
  data: { reviewerNotes: 'Documents verified.' },
});`)}
`)}

${subsection('step-dynamic', 'dynamic (W7)', `
<p>The handler returns a <code>DynamicExpansion</code> — a runtime-generated sub-graph that the engine validates, splices in, and executes before rejoining the main flow.</p>
${code('typescript', `import type { DynamicExpansion } from '@weaveintel/core';

engine.registerHandler('ai-planner', async (vars) => {
  const tasks = vars['tasks'] as string[];

  const expansion: DynamicExpansion = {
    steps: tasks.map((task, i) => ({
      id: \`task-\${i}\`,
      name: task,
      type: 'deterministic',
      handler: 'execute-task',
    })),
    entry: 'task-0',
    rejoin: 'summarise',  // Return to this step when sub-graph ends
  };
  return expansion;
});

.dynamic('plan', 'AI-Generated Plan', {
  handler: 'ai-planner',
  next: 'summarise',
})`)}

${callout('warn', '⚠️', 'Governance.', 'Every DynamicExpansion passes through <code>validateExpansion</code> before execution. Violations throw <code>WorkflowExpansionError</code> with a typed <code>code</code> field: <code>MAX_EXPANSION_DEPTH</code>, <code>MAX_GENERATED_STEPS</code>, <code>ID_COLLISION</code>, <code>DISALLOWED_HANDLER_KIND</code>, <code>LINT_ERROR</code>.')}
`)}
`)}

${section('wf-resolvers', 'Handler Resolvers', `
<p>Resolvers map string handler references (like <code>tool:my-tool</code>) to async handler functions at run startup. This decouples workflow definitions from concrete implementations.</p>

${code('typescript', `import {
  HandlerResolverRegistry,
  createNoopResolver,
  createScriptResolver,
  createToolResolver,
  createPromptResolver,
  createAgentResolver,
  createMcpResolver,
  createSubWorkflowResolver,
  createPlannerResolver,   // W7 only — opt-in
} from '@weaveintel/workflows';

const reg = new HandlerResolverRegistry();

// Built-ins (no deps)
reg.register(createNoopResolver());    // handler: 'noop'
reg.register(createScriptResolver());  // handler: 'script:return vars.x * 2'

// Dependency-injected
reg.register(createToolResolver({
  getTool: async (key) => toolMap.get(key),  // handler: 'tool:send-email'
}));

reg.register(createPromptResolver({
  executePrompt: async (key, vars, cfg) =>   // handler: 'prompt:summarise@v2'
    promptRunner.execute(key, vars, cfg),
}));

reg.register(createAgentResolver({
  invokeAgent: async (key, vars, cfg) =>     // handler: 'agent:classifier'
    agentRunner.run(key, vars, cfg),
}));

reg.register(createMcpResolver({
  callMcp: async (server, method, input) =>  // handler: 'mcp:my-server:my-method'
    mcpClient.call(server, method, input),
}));

reg.register(createSubWorkflowResolver({
  resolveWorkflowKey: async (key) => db.getWorkflowId(key),
  startRun: async (id, input) => engine.startRun(id, input),
}));

// W7 planner (opt-in, requires LLM)
reg.register(createPlannerResolver({
  plan: async (goal, ctx) => llm.generateExpansion(goal, ctx),
}));`)}

<h4>Handler reference syntax</h4>
${typeTable([
  ['noop', 'No-op: returns <code>config</code>. Useful as a placeholder or terminal step.'],
  ['script:&lt;body&gt;', 'Inline JS. Body has access to <code>variables</code> and <code>config</code>. Must <code>return</code> a value. Trusted operators only.'],
  ['tool:&lt;toolKey&gt;', 'Looks up tool by key, forwards handler input as tool input.'],
  ['prompt:&lt;key&gt;@&lt;version&gt;', 'Renders and executes a registered prompt. <code>@version</code> is optional.'],
  ['agent:&lt;agentKey&gt;', 'Runs a registered agent, forwards variables as task input.'],
  ['mcp:&lt;server&gt;:&lt;method&gt;', 'Calls a method on an MCP server. Input forwarded as method args.'],
  ['subworkflow:&lt;key&gt;', 'Starts a child workflow run synchronously. Returns the child run record.'],
  ['plan:&lt;goal&gt;', 'W7 only. Calls the planner resolver with the goal string.'],
])}
`)}

${section('wf-policy', 'WorkflowPolicy', `
<p>Policies apply engine-wide (via <code>defaultPolicy</code>) or per-definition (via <code>setPolicy()</code>). Per-definition takes precedence.</p>

${params([
  ['maxSteps', 'number', 'optional', 'Hard cap on steps per run. Exceeding it fails the run with "Exceeded max steps". Default: 100.'],
  ['costCeiling', 'number', 'optional', 'USD ceiling. Run fails with cost_ceiling_exceeded when the step cost meter exceeds this.'],
  ['maxConcurrentRuns', 'number', 'optional', 'Max simultaneous runs for this definition. Excess runs queue in the RunQueue (W5).'],
  ['maxRetries', 'number', 'optional', 'Default retry count for all steps. Per-step retries override this.'],
  ['maxStepTimeoutMs', 'number', 'optional', 'Default timeout for all steps in ms. Per-step timeout overrides this.'],
  ['maxExpansionDepth', 'number', 'optional', 'W7: max recursive DynamicExpansion nesting. Default: 5.'],
  ['maxGeneratedSteps', 'number', 'optional', 'W7: cumulative generated steps budget per run. No default.'],
  ['dynamicHandlerKinds', 'string[]', 'optional', "W7: resolver kinds allowed in generated steps. Default: ['noop','tool','prompt','agent','mcp']. 'script' and 'subworkflow' blocked."],
])}
`)}

${section('wf-phases', 'Phase Capability Reference', `
${featureCards([
  ['W1 — Control Flow', 'switch, forEach, parallelLanes, fork/join, onError, skipIf'],
  ['W2 — Reliability', 'idempotency keys, circuit breakers, bulkheads, exponential backoff'],
  ['W3 — Data Layer', 'output schema validation, PII masking, payload offload to object store'],
  ['W4 — Durability', 'step-level locking, durable sleep, full audit log, replay from checkpoint'],
  ['W5 — Governance', 'rate limiting, concurrency queue, admin API (list/cancel/patch runs)'],
  ['W6 — Observability', 'span emitter, workflow linter, getWorkflowGraph, replay recorder'],
  ['W7 — Dynamic Graphs', 'dynamic step type, DynamicExpansion, createPlannerResolver, validateExpansion'],
])}
`)}`;
}

// ── Sections: Models, Prompts (combined for size) ─────────────────────────

function sModels(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/models</span></div>
  <h1 class="pkg-title">Models</h1>
  <p class="pkg-desc">Provider-agnostic model factory with named registration, capability-based routing, middleware, and cost tracking. Supports text generation, embeddings, image, and audio models.</p>
</div>

${exlinks([
  ['11-anthropic-provider.ts', 'Example 11 — Anthropic Provider'],
  ['14-smart-routing.ts', 'Example 14 — Smart Model Routing'],
])}

${section('models-register', 'Registration', `
${code('typescript', `import { weaveRegisterModel, weaveGetModel, weaveListModels } from '@weaveintel/models';
import { weaveAnthropicModel } from '@weaveintel/provider-anthropic';
import { weaveOpenAIModel } from '@weaveintel/provider-openai';
import { weaveGoogleModel } from '@weaveintel/provider-google';
import { weaveOllamaModel } from '@weaveintel/provider-ollama';

// Register named aliases — use consistent names across your codebase
weaveRegisterModel('fast',   weaveAnthropicModel('claude-haiku-4-5-20251001'));
weaveRegisterModel('smart',  weaveAnthropicModel('claude-sonnet-4-6'));
weaveRegisterModel('embed',  weaveOpenAIModel('text-embedding-3-small'));
weaveRegisterModel('vision', weaveOpenAIModel('gpt-4o'));
weaveRegisterModel('local',  weaveOllamaModel('llama3.2'));

// Retrieve anywhere
const model = weaveGetModel('smart');
const result = await model.generate({
  messages: [{ role: 'user', content: 'Explain quantum entanglement in one sentence.' }],
  temperature: 0.2,
  maxTokens: 150,
});
console.log(result.content);
console.log(result.usage); // { inputTokens, outputTokens, totalTokens }`)}
`)}

${section('models-routing', 'Smart Routing', `
${code('typescript', `import { SmartModelRouter, ModelHealthTracker } from '@weaveintel/routing';

const tracker = new ModelHealthTracker();
const router = new SmartModelRouter({
  models: [
    { key: 'fast',  capabilities: ['text', 'tool_calling'], costPerMToken: 0.25 },
    { key: 'smart', capabilities: ['text', 'tool_calling', 'vision'], costPerMToken: 3.00 },
    { key: 'local', capabilities: ['text'], costPerMToken: 0 },
  ],
  healthTracker: tracker,
});

// Route to cheapest model that meets capability requirements
const model = router.select({ requiredCapabilities: ['text', 'tool_calling'], maxCostPerMToken: 1.0 });
// Returns 'fast' — cheapest model with tool_calling support under $1/M tokens`)}
`)}

${section('models-providers', 'Provider Reference', `
<table class="ptable"><thead><tr><th>Package</th><th>Factory</th><th>Key Models</th></tr></thead><tbody>
<tr><td><code>@weaveintel/provider-anthropic</code></td><td><code>weaveAnthropicModel(id)</code></td><td>claude-haiku-4-5-20251001, claude-sonnet-4-6, claude-opus-4-8</td></tr>
<tr><td><code>@weaveintel/provider-openai</code></td><td><code>weaveOpenAIModel(id)</code></td><td>gpt-4o, gpt-4o-mini, gpt-4.1, o3, o4-mini, text-embedding-3-*</td></tr>
<tr><td><code>@weaveintel/provider-google</code></td><td><code>weaveGoogleModel(id)</code></td><td>gemini-2.0-flash, gemini-1.5-pro, text-embedding-004</td></tr>
<tr><td><code>@weaveintel/provider-ollama</code></td><td><code>weaveOllamaModel(id)</code></td><td>Any model served by Ollama (llama3.2, mistral, phi3, etc.)</td></tr>
<tr><td><code>@weaveintel/provider-llamacpp</code></td><td><code>weaveLlamacppModel(id)</code></td><td>Local GGUF models via llama.cpp server</td></tr>
</tbody></table>
`)}`;
}

function sPrompts(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/prompts</span></div>
  <h1 class="pkg-title">Prompts</h1>
  <p class="pkg-desc">Version-controlled prompt management with rendering, output contract validation, A/B experiments, LLM-graded evaluation, and structured frameworks (RTCE, CRITIQUE, JUDGE).</p>
</div>

${exlinks([
  ['17-prompt-management.ts', 'Example 17 — Prompt Management & A/B Testing'],
])}

${section('prompts-registry', 'Registry & Versioning', `
${code('typescript', `import { InMemoryPromptRegistry, renderPromptVersion } from '@weaveintel/prompts';

const registry = new InMemoryPromptRegistry();

registry.register({
  key: 'summarise-article',
  version: '2.1.0',
  template: \`You are a professional editor.

Summarise the following article in {{language}} in no more than {{maxWords}} words.
Focus on: {{focusAreas}}.

Article:
{{article}}\`,
  variables: {
    language:   { type: 'string', default: 'English' },
    maxWords:   { type: 'number', required: true },
    focusAreas: { type: 'string', required: true },
    article:    { type: 'string', required: true },
  },
  tags: ['summarisation', 'editorial'],
  metadata: { author: 'content-team', approved: true },
});

// Render with variables
const rendered = renderPromptVersion(registry.get('summarise-article', '2.1.0')!, {
  language: 'English',
  maxWords: 150,
  focusAreas: 'key findings, business impact',
  article: articleText,
});

// Use in a model call
const result = await model.generate({
  messages: [{ role: 'user', content: rendered }],
});`)}
`)}

${section('prompts-contracts', 'Output Contracts', `
<p>Contracts validate or repair model output against a schema — JSON structure, Markdown formatting, code fences, max length, forbidden phrases.</p>
${code('typescript', `import { createContract, DefaultCompletionValidator } from '@weaveintel/contracts';

const contract = createContract({
  type: 'JSON',
  schema: {
    type: 'object',
    required: ['sentiment', 'confidence', 'reason'],
    properties: {
      sentiment:  { type: 'string', enum: ['positive', 'negative', 'neutral'] },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      reason:     { type: 'string', maxLength: 200 },
    },
  },
  repair: true,   // Attempt to fix malformed JSON before failing
});

const validator = new DefaultCompletionValidator();
const result = await validator.validate(llmOutput, contract);

if (!result.valid) {
  console.log(result.errors); // [{ path, message, rule }]
  console.log(result.repaired); // Attempted repair, if repair: true
} else {
  const data = JSON.parse(result.content) as SentimentResult;
}`)}
`)}

${section('prompts-frameworks', 'Prompt Frameworks', `
${featureCards([
  ['RTCE', 'Role + Task + Context + Examples. Best for structured single-turn prompts where role clarity matters.'],
  ['FULL', 'All structured fields including persona, constraints, chain-of-thought instructions, and output format.'],
  ['CRITIQUE', 'Self-critique loop: model produces initial output → critiques it → revises. Improves quality on complex tasks.'],
  ['JUDGE', 'LLM-as-judge rubric. Evaluates a piece of text against named criteria with numeric scores and reasoning.'],
])}
${code('typescript', `import { buildPromptFromFramework } from '@weaveintel/prompts';

const prompt = buildPromptFromFramework('RTCE', {
  role: 'You are a senior security analyst.',
  task: 'Review the following code diff for security vulnerabilities.',
  context: 'This is a Node.js API endpoint that handles file uploads.',
  examples: [
    { input: 'app.get("/files/:name", (req, res) => res.sendFile(req.params.name))',
      output: 'CRITICAL: Path traversal vulnerability. User input passed directly to sendFile.' },
  ],
});`)}
`)}`;
}

// ── Export map ────────────────────────────────────────────────────────────

export const DOCS_SECTIONS: Record<string, () => string> = {
  home:       sHome,
  agents:     sAgents,
  workflows:  sWorkflows,
  models:     sModels,
  prompts:    sPrompts,
};

// ── More sections ─────────────────────────────────────────────────────────

function sMemory(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/memory</span></div>
  <h1 class="pkg-title">Memory</h1>
  <p class="pkg-desc">Multi-type agent memory with semantic search, automatic extraction from conversations, deduplication, and pluggable backends (SQLite, Postgres, Redis, MongoDB).</p>
</div>

${exlinks([
  ['07-memory-augmented-agent.ts', 'Example 07 — Memory-Augmented Agent'],
  ['22-chat-memory-extraction.ts', 'Example 22 — Chat Memory Extraction'],
])}

${section('memory-types', 'Memory Types', `
${featureCards([
  ['Conversation Memory', 'Stores the full message history with configurable window size and compression for long sessions.'],
  ['Semantic Memory', 'Vector-indexed facts searchable by meaning. Best for cross-session user preferences and domain knowledge.'],
  ['Entity Memory', 'Structured facts about named entities — people, companies, products — with relationship tracking.'],
  ['Working Memory', 'Ephemeral scratch-pad for in-progress task state, cleared after each session or task.'],
])}

${code('typescript', `import {
  weaveSemanticMemory,
  weaveConversationMemory,
  weaveEntityMemory,
  weaveMemoryStore,
} from '@weaveintel/memory';

// Semantic memory — remembers facts by meaning
const semantic = weaveSemanticMemory({
  embeddingModel: weaveOpenAIModel('text-embedding-3-small'),
  store: weaveMemoryStore({
    backend: 'sqlite',
    path: './data/memory.db',
  }),
  extractionPolicy: {
    minConfidence: 0.72,
    maxMemoriesPerTurn: 5,
    categories: ['preference', 'fact', 'instruction', 'correction'],
  },
  deduplication: {
    enabled: true,
    similarityThreshold: 0.92,  // Don't store if >92% similar to existing
  },
});

// Store a memory explicitly
await semantic.add({
  content: 'User prefers concise bullet-point responses, not paragraphs.',
  tags: ['preference', 'format'],
  userId: 'alice',
  expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000), // 90 days
});

// Search — returns scored memories
const memories = await semantic.search('response style preferences', {
  userId: 'alice',
  limit: 5,
  minScore: 0.65,
  tags: ['preference'],
});
// memories[0] = { id, content, score, tags, createdAt, metadata }`)}
`)}

${section('memory-extraction', 'Automatic Extraction', `
<p>Conversation memory automatically extracts structured facts from each message turn using a combination of pattern rules and an optional LLM extractor.</p>
${code('typescript', `const convMemory = weaveConversationMemory({
  store: semantic,
  maxHistory: 40,         // Keep last 40 messages in context window
  compressionThreshold: 80, // Summarise when history exceeds 80 messages
  extractionRules: [
    { pattern: /i (?:live|am based) in (.+)/i,  category: 'location',    tags: ['location'] },
    { pattern: /i prefer (.+)/i,                category: 'preference',  tags: ['preference'] },
    { pattern: /(?:my name is|i'm|i am) (.+)/i, category: 'identity',   tags: ['identity'] },
    { pattern: /always (.+)/i,                  category: 'instruction', tags: ['instruction'] },
  ],
  llmExtractor: {        // Optional: use LLM for nuanced extraction
    model: weaveAnthropicModel('claude-haiku-4-5-20251001'),
    prompt: 'Extract key facts from this message. Return JSON array of {content, category, confidence}.',
    minConfidence: 0.8,
  },
});

// Called once per message turn
await convMemory.addMessage({ role: 'user', content: 'I live in Auckland and prefer dark mode.' });
// Automatically extracts: location=Auckland, preference=dark mode`)}
`)}

${section('memory-backends', 'Backends', `
${params([
  ['backend', '"sqlite" | "postgres" | "redis" | "mongodb" | "memory"', 'required', 'Storage backend for memory records and vector embeddings.'],
  ['path', 'string', 'optional', 'File path (sqlite). Ignored for network backends.'],
  ['connectionString', 'string', 'optional', 'Connection string for postgres/redis/mongodb.'],
  ['vectorExtension', '"pgvector" | "chromadb" | "pinecone" | "weaviate"', 'optional', 'Vector store for semantic search. Defaults to in-process cosine similarity.'],
  ['retentionDays', 'number', 'optional', 'Auto-expire memories older than N days.'],
])}
`)}`;
}

function sRetrieval(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/retrieval</span></div>
  <h1 class="pkg-title">Retrieval</h1>
  <p class="pkg-desc">Complete RAG pipeline: document chunking, embedding, vector indexing, hybrid dense + keyword search, query rewriting, and citation extraction.</p>
</div>

${exlinks([
  ['03-rag-pipeline.ts', 'Example 03 — RAG Pipeline'],
  ['113-extraction-pipeline.ts', 'Example 113 — Document Extraction Pipeline'],
])}

${section('retrieval-chunking', 'Chunking', `
${code('typescript', `import { weaveChunker } from '@weaveintel/retrieval';

const chunker = weaveChunker({
  strategy: 'recursive',    // 'fixed' | 'recursive' | 'semantic' | 'markdown' | 'code'
  chunkSize: 512,           // Target tokens per chunk
  chunkOverlap: 64,         // Token overlap between adjacent chunks
  minChunkSize: 100,        // Discard chunks smaller than this
  splitOn: ['\n\n', '\n', '.', ' '], // Priority-ordered split characters
  tokenizer: 'cl100k_base', // Tiktoken encoding (or 'simple' for char-based)
});

const chunks = await chunker.chunk(documentText, {
  metadata: { source: 'policy-v2.pdf', page: 1 },
});

// chunks[i] = { id, content, metadata, tokenCount, chunkIndex, totalChunks }
console.log(\`Split into \${chunks.length} chunks\`);`)}

${callout('tip', '💡', 'Strategy guide.', '<code>recursive</code> is best for prose. <code>markdown</code> preserves headers as chunk boundaries. <code>code</code> splits on function/class boundaries. <code>semantic</code> uses an embedding model to find natural meaning boundaries (higher quality, slower).')}
`)}

${section('retrieval-embedding', 'Embedding Pipeline', `
${code('typescript', `import { weaveEmbeddingPipeline } from '@weaveintel/retrieval';

const pipeline = weaveEmbeddingPipeline({
  embeddingModel:   weaveOpenAIModel('text-embedding-3-small'),
  vectorStore,                      // Any VectorStore implementation
  chunkingOptions:  { strategy: 'recursive', chunkSize: 512 },
  batchSize:        100,            // Embed 100 chunks per API call
  dimensions:       1536,           // text-embedding-3-small output size
  normalize:        true,           // L2-normalize vectors
  onProgress:       (indexed, total) => console.log(\`\${indexed}/\${total}\`),
});

// Index a single document
await pipeline.index({
  id: 'policy-v2',
  content: documentText,
  metadata: { source: 'policy-v2.pdf', department: 'legal', version: '2024-Q4' },
});

// Index a directory of files
await pipeline.indexBatch(documents, { upsert: true });

// Delete a document and its chunks
await pipeline.delete('policy-v2');`)}
`)}

${section('retrieval-hybrid', 'Hybrid Search', `
${code('typescript', `import {
  weaveHybridRetriever,
  weaveQueryRewriter,
  weaveCitationExtractor,
} from '@weaveintel/retrieval';

// Hybrid = dense (semantic) + sparse (keyword/BM25)
const retriever = weaveHybridRetriever({
  denseRetriever:   vectorStore,
  keywordRetriever: bm25Index,
  fusionMethod: 'rrf',              // Reciprocal Rank Fusion
  weights: { dense: 0.7, keyword: 0.3 },
  topK: 20,
  reranker: crossEncoderReranker,   // Optional: rerank top-20 → top-5
});

// Optional: rewrite query before retrieval
const rewriter = weaveQueryRewriter({
  model: weaveAnthropicModel('claude-haiku-4-5-20251001'),
  strategy: 'decompose',  // 'expand' | 'decompose' | 'hypothetical-document'
});

const rewritten = await rewriter.rewrite('return policy for damaged goods');
// rewritten.queries = ['damaged goods return policy', 'refund for defective product']

// Retrieve with all rewritten queries, merge results
const results = await retriever.retrieve(rewritten.queries, {
  limit: 5,
  minScore: 0.4,
  filter: { department: 'legal' },  // Metadata filter
});

// Extract citation spans from retrieved chunks
const extractor = weaveCitationExtractor();
const citations = extractor.extract(results, generatedAnswer);`)}
`)}`;
}

function sEvals(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/evals</span></div>
  <h1 class="pkg-title">Evals</h1>
  <p class="pkg-desc">LLM-as-judge evaluation with rubric scoring, dataset comparison, and weighted aggregation. Run evals inline, in tests, or as a CI quality gate.</p>
</div>

${exlinks([
  ['09-eval-suite.ts', 'Example 09 — Eval Suite'],
])}

${section('evals-runner', 'Eval Runner', `
${code('typescript', `import { weaveEvalRunner, weightedRubricScore } from '@weaveintel/evals';

const runner = weaveEvalRunner({
  judgeModel: weaveAnthropicModel('claude-sonnet-4-6'),
  rubric: [
    {
      criterion: 'factual_accuracy',
      weight: 0.40,
      description: 'Is every factual claim in the answer verifiable and correct?',
      scale: '1=completely wrong, 5=fully accurate',
    },
    {
      criterion: 'completeness',
      weight: 0.30,
      description: 'Does the answer address all aspects of the question?',
    },
    {
      criterion: 'conciseness',
      weight: 0.20,
      description: 'Is the answer appropriately brief without losing important detail?',
    },
    {
      criterion: 'tone',
      weight: 0.10,
      description: 'Is the tone professional and appropriate for the audience?',
    },
  ],
  parallelism: 4,  // Run 4 eval cases simultaneously
});

const dataset = [
  { id: 'q1', input: 'What is the capital of France?', expected: 'Paris',
    context: { difficulty: 'easy' } },
  { id: 'q2', input: 'Explain quantum entanglement.', expected: 'A correlation between particles...',
    context: { difficulty: 'hard' } },
];

const results = await runner.run(dataset, async ({ input }) => {
  return (await myAgent.answer(input)).output;
});

// results[0] = {
//   id: 'q1',
//   input, expected, actual,
//   scores: { factual_accuracy: 0.96, completeness: 0.88, conciseness: 0.95, tone: 1.0 },
//   overall: 0.937,   // weighted average
//   reasoning: '...',  // judge's explanation
//   passed: true,      // overall >= passingThreshold
// }

// Aggregate
const avgScore = results.reduce((s, r) => s + r.overall, 0) / results.length;
console.log(\`Average score: \${avgScore.toFixed(3)}\`);`)}
`)}`;
}

function sGuardrails(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/guardrails</span></div>
  <h1 class="pkg-title">Guardrails</h1>
  <p class="pkg-desc">Pre- and post-execution safety pipeline: risk classification, PII detection, sycophancy detection, confidence gating, cost guards, and action-level controls. Fully composable.</p>
</div>

${exlinks([
  ['08-pii-redaction.ts', 'Example 08 — PII Redaction'],
  ['23-chat-guardrails-pipeline.ts', 'Example 23 — Guardrails Pipeline'],
  ['21-guardrails-date-evidence.ts', 'Example 21 — Guardrails + Date Evidence'],
])}

${section('guardrails-pipeline', 'Building a Pipeline', `
${code('typescript', `import {
  createGuardrailPipeline,
  DefaultRiskClassifier,
  DefaultConfidenceGate,
  DefaultActionGate,
  CostGuard,
} from '@weaveintel/guardrails';

const pipeline = createGuardrailPipeline({
  preChecks: [
    // Block dangerous input patterns
    new DefaultRiskClassifier({
      rules: [
        { pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/,
          category: 'pii',        action: 'deny',   severity: 'high' },
        { pattern: /\bssn\b|\bsocial security\b/i,
          category: 'pii',        action: 'deny',   severity: 'high' },
        { pattern: /\bpassword\b|\bapi.?key\b/i,
          category: 'credential', action: 'warn',   severity: 'medium' },
        { pattern: /ignore previous|forget instructions|jailbreak/i,
          category: 'injection',  action: 'deny',   severity: 'critical' },
      ],
    }),
    // Block expensive operations for budget tiers
    new CostGuard({ maxCostUsd: 0.20, ledger: costLedger }),
  ],
  postChecks: [
    // Require stated confidence
    new DefaultConfidenceGate({ minConfidence: 0.70, requireExplicit: false }),
    // Block specific action patterns in output
    new DefaultActionGate({
      blockedActions: ['delete_database', 'send_to_all_users', 'override_safety'],
    }),
  ],
  onViolation: async (result, ctx) => {
    // Log to audit system
    await auditLog.record({ userId: ctx.userId, violation: result });
  },
});

// Use in your chat handler:
const preResult = await pipeline.evaluate(userMessage, 'pre-execution', { userId, sessionId });
if (preResult.action === 'deny') {
  return { error: preResult.reason, code: preResult.category };
}

const llmResponse = await model.generate({ messages });

const postResult = await pipeline.evaluate(llmResponse.content, 'post-execution', { userId });
if (postResult.action === 'deny') {
  return { error: 'Response blocked by safety policy.' };
}`)}
`)}

${section('guardrails-checks', 'Built-in Checks', `
${params([
  ['DefaultRiskClassifier', 'Check', 'optional', 'Pattern-based risk classification. Supports regex patterns, categories, severity levels, and deny/warn/flag actions.'],
  ['DefaultConfidenceGate', 'Check', 'optional', 'Blocks responses where model expresses low confidence. Detects hedging phrases or explicit uncertainty markers.'],
  ['DefaultActionGate', 'Check', 'optional', 'Blocks specific named actions appearing in model output (e.g. from tool-use outputs).'],
  ['CostGuard', 'Check', 'optional', 'Fails requests that would push per-session or per-user cost over a USD budget.'],
  ['SycophancyDetector', 'Check', 'optional', 'Detects sycophantic patterns (excessive agreement, flattery) in post-execution responses.'],
  ['GroundingGuard', 'Check', 'optional', 'Checks that factual claims in the response are grounded in provided evidence (tool results, RAG context).'],
])}
`)}`;
}

function sResilience(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/resilience</span></div>
  <h1 class="pkg-title">Resilience</h1>
  <p class="pkg-desc">Call-level resilience primitives: token bucket rate limiting, circuit breaker, concurrency limiter, and retry with exponential backoff + jitter. Compose all four with <code>runResilient()</code>.</p>
</div>

${exlinks([
  ['111-resilience.ts', 'Example 111 — Resilience Patterns'],
])}

${section('resilience-run', 'runResilient — All-in-One', `
${code('typescript', `import { runResilient, type ResilientCallOptions } from '@weaveintel/resilience';

const options: ResilientCallOptions = {
  tokenBucket: {
    capacity: 60,          // Max burst of 60 calls
    refillRate: 60,        // Refill 60 tokens/minute
    waitForToken: true,    // Queue rather than reject when empty
    maxWaitMs: 5000,       // Throw if wait > 5s
  },
  circuitBreaker: {
    failureThreshold: 5,   // Open circuit after 5 consecutive failures
    successThreshold: 2,   // Close circuit after 2 successes (half-open)
    timeout: 30_000,       // Transition to half-open after 30s
    volumeThreshold: 10,   // Minimum calls before opening
  },
  retry: {
    maxAttempts: 3,
    initialDelayMs: 500,
    backoffMultiplier: 2,  // 500ms → 1s → 2s
    maxDelayMs: 10_000,
    jitter: true,          // Add ±20% randomness to avoid thundering herd
    retryOn: (err) => err.status === 429 || err.status >= 500,
  },
  concurrency: {
    maxConcurrent: 20,    // At most 20 in-flight calls
    queueSize: 100,       // Queue up to 100 waiting
    timeout: 10_000,      // Reject queued calls after 10s
  },
};

// All four protections on a single call
const result = await runResilient(
  'anthropic-completions',  // Endpoint key — shared state across all calls with this key
  () => model.generate({ messages }),
  options,
);`)}
`)}

${section('resilience-primitives', 'Individual Primitives', `
${code('typescript', `import {
  createTokenBucket,
  createCircuitBreaker,
  createRetryPolicy,
  createConcurrencyLimiter,
  ResilienceSignalEmitter,
} from '@weaveintel/resilience';

// Token bucket — emit signals on rate limit events
const emitter = new ResilienceSignalEmitter();
emitter.on('rate_limited', (sig) => monitor.alert(\`Rate limited on \${sig.endpoint}\`));
emitter.on('circuit_opened', (sig) => monitor.alert(\`Circuit opened: \${sig.endpoint}\`));

const bucket  = createTokenBucket({ capacity: 100, refillRate: 100, emitter });
const breaker = createCircuitBreaker({ failureThreshold: 5, timeout: 30_000, emitter });
const limiter = createConcurrencyLimiter({ maxConcurrent: 10, emitter });
const retry   = createRetryPolicy({ maxAttempts: 3, initialDelayMs: 200 });

// Use individually
const allowed = await bucket.consume(1);
if (!allowed) throw new RateLimitError('Rate limited');

if (!breaker.canExecute()) throw new CircuitOpenError('Service unavailable');
try {
  const result = await retryPolicy.execute(() => callExternalService());
  breaker.recordSuccess();
  return result;
} catch (err) {
  breaker.recordFailure();
  throw err;
}`)}
`)}`;
}

function sCostGovernor(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/cost-governor</span></div>
  <h1 class="pkg-title">Cost Governor</h1>
  <p class="pkg-desc">8-lever cost optimisation that wraps models and tools with budget enforcement, tier-based policies, intent-RAG tool subset selection, model cascade, and automatic history compaction.</p>
</div>

${exlinks([
  ['103-cost-policy-binding.ts', 'Example 103 — Cost Policy Binding'],
  ['104-prompt-caching.ts', 'Example 104 — Prompt Caching (L3)'],
  ['105-model-cascade.ts', 'Example 105 — Model Cascade (L1)'],
  ['106-tool-subset.ts', 'Example 106 — Tool Subset (L2)'],
  ['107-intel-history.ts', 'Example 107 — Intel Gating + History Compaction (L4/L5)'],
  ['108-budget-governor.ts', 'Example 108 — Max Steps + Reasoning Effort + Budget Gate'],
  ['109-intent-rag-tool-retrieval.ts', 'Example 109 — Intent-RAG Tool Retrieval'],
])}

${section('cost-levers', 'The 8 Levers', `
<table class="ptable"><thead><tr><th>Lever</th><th>Strategy</th><th>Typical Savings</th><th>Config Key</th></tr></thead><tbody>
<tr><td>L1 Model Cascade</td><td>Try cheapest model first; escalate to smarter model if confidence is low</td><td>40–70%</td><td><code>modelCascade</code></td></tr>
<tr><td>L2 Tool Subset</td><td>Use intent-RAG to select only the 3–5 most relevant tools per query</td><td>10–30%</td><td><code>toolSubset</code></td></tr>
<tr><td>L3 Prompt Caching</td><td>Reuse Anthropic/OpenAI prefix cache for repeated system prompts</td><td>15–25%</td><td><code>promptCaching</code></td></tr>
<tr><td>L4 Intel Gating</td><td>Skip expensive context-enrichment sections for simple queries</td><td>20–40%</td><td><code>intelGating</code></td></tr>
<tr><td>L5 History Compaction</td><td>Summarise old message history to reduce context tokens</td><td>20–50%</td><td><code>historyCompaction</code></td></tr>
<tr><td>L6 Max Steps</td><td>Cap agent tool-call iterations per tier</td><td>Variable</td><td><code>maxSteps</code></td></tr>
<tr><td>L7 Reasoning Effort</td><td>Reduce thinking tokens (extended thinking models) for simple queries</td><td>10–40%</td><td><code>reasoningEffort</code></td></tr>
<tr><td>L8 Output Truncation</td><td>Cap response length by tier</td><td>5–20%</td><td><code>outputTruncation</code></td></tr>
</tbody></table>
`)}

${section('cost-setup', 'Setup & Usage', `
${code('typescript', `import { weaveCostGovernor, InMemoryCostLedger } from '@weaveintel/cost-governor';

const governor = weaveCostGovernor({
  ledger: new InMemoryCostLedger(),   // Or DbCostLedger for persistence
  policy: {
    tiers: [
      {
        name: 'free',
        monthlyBudgetUsd: 5.00,
        levers: {
          modelCascade:     { startModel: 'fast', escalationModel: 'smart', confidenceThreshold: 0.75 },
          toolSubset:       { maxTools: 3, strategy: 'intent-rag' },
          historyCompaction:{ maxMessages: 20, summariseAfter: 30 },
          maxSteps:         { value: 5 },
          outputTruncation: { maxChars: 1000 },
        },
      },
      {
        name: 'pro',
        monthlyBudgetUsd: 50.00,
        levers: {
          promptCaching:    { enabled: true },
          intelGating:      { complexityThreshold: 0.4 },
          maxSteps:         { value: 20 },
        },
      },
      {
        name: 'enterprise',
        monthlyBudgetUsd: 500.00,
        levers: {},  // No restrictions
      },
    ],
    escalation: {
      threshold: 0.80,  // Alert + downgrade at 80% of budget
      action: 'downgrade-tier',
    },
  },
});

// Wrap model — governor applies levers based on userId's tier
const governedModel = governor.wrapModel(model, {
  userId: 'alice',
  tier: await getTierForUser('alice'),  // 'free' | 'pro' | 'enterprise'
});

// The model call now enforces all configured levers
const result = await governedModel.generate({ messages });`)}
`)}`;
}

function sTools(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/tools</span></div>
  <h1 class="pkg-title">Tool Framework</h1>
  <p class="pkg-desc">Policy enforcement, audit logging, approval gates, rate limiting, network guards, and health tracking for any tool. Wraps existing tools without modifying them.</p>
</div>

${section('tools-policy', 'Policy-Enforced Registry', `
${code('typescript', `import { createPolicyEnforcedRegistry, weaveHealthTracker } from '@weaveintel/tools';
import { weaveToolRegistry } from '@weaveintel/core';

const base = weaveToolRegistry();
base.register(sendEmailTool);
base.register(writeFileTool);
base.register(fetchPageTool);

const tracker = weaveHealthTracker({ windowMs: 60_000 });

const enforced = createPolicyEnforcedRegistry(base, {
  allowedTools: ['fetch_page', 'search_web', 'send_email'],
  blockedTools: ['delete_database', 'drop_table'],
  rateLimit: { maxPerMinute: 30, maxPerHour: 500 },
  requireApproval: ['send_email', 'write_file'],
  networkGuard: {
    blockPrivateIps: true,        // Block 10.x, 192.168.x, 127.x
    allowedDomains: ['api.example.com', 'cdn.example.com'],
  },
  costLimit: { maxCostUsd: 0.05, ledger: costLedger },
}, {
  auditEmitter: myAuditEmitter,
  approvalGate: myApprovalGate,
  healthTracker: tracker,
});

// Every call through 'enforced' is policy-checked, audited, and tracked
const health = tracker.getHealth('send_email');
// { successRate: 0.99, avgLatencyMs: 320, recentErrors: [] }`)}
`)}`;
}

function sToolsTime(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/tools-time</span></div>
  <h1 class="pkg-title">tools-time</h1>
  <p class="pkg-desc">16 time-aware tools: datetime retrieval, timezone conversion, arithmetic, named timers, stopwatches, and scheduled reminders. Fully stateful with a pluggable <code>TemporalStore</code> backend.</p>
</div>

${exlinks([
  ['117-tools-time.ts', 'Example 117 — tools-time end-to-end'],
])}

${section('tools-time-setup', 'Setup', `
${code('typescript', `import { createTimeTools, createInMemoryTemporalStore } from '@weaveintel/tools-time';

const tools = createTimeTools({
  defaultTimezone: 'Pacific/Auckland',
  locale: 'en-NZ',
  store: createInMemoryTemporalStore(),  // Or DbTemporalStore for persistence
  allowedTimezones: ['UTC', 'America/New_York', 'Pacific/Auckland'],  // Optional whitelist
});

// Register all 16 tools at once
tools.forEach(t => agentToolRegistry.register(t));`)}

<h4>All 16 tools</h4>
<table class="ptable"><thead><tr><th>Tool</th><th>Description</th></tr></thead><tbody>
<tr><td><code>datetime</code></td><td>Current date/time in any IANA timezone with configurable format</td></tr>
<tr><td><code>timezone_info</code></td><td>UTC offset, DST status, abbreviation, and locale for any timezone</td></tr>
<tr><td><code>datetime_add</code></td><td>Add or subtract a duration (years, months, days, hours, minutes, seconds)</td></tr>
<tr><td><code>datetime_diff</code></td><td>Calculate the difference between two datetimes in any unit</td></tr>
<tr><td><code>datetime_format</code></td><td>Reformat a datetime string using a format pattern</td></tr>
<tr><td><code>timer_start</code></td><td>Start a named countdown timer with a duration</td></tr>
<tr><td><code>timer_stop</code></td><td>Stop a running timer and return elapsed time</td></tr>
<tr><td><code>timer_check</code></td><td>Check remaining time on a running timer</td></tr>
<tr><td><code>stopwatch_start</code></td><td>Start a named stopwatch</td></tr>
<tr><td><code>stopwatch_stop</code></td><td>Stop a stopwatch and return total elapsed time</td></tr>
<tr><td><code>stopwatch_lap</code></td><td>Record a lap split without stopping the stopwatch</td></tr>
<tr><td><code>stopwatch_check</code></td><td>Get current elapsed time without stopping</td></tr>
<tr><td><code>reminder_set</code></td><td>Schedule a named reminder at a specific datetime or after a duration</td></tr>
<tr><td><code>reminder_list</code></td><td>List all pending reminders, optionally filtered by tag</td></tr>
<tr><td><code>reminder_cancel</code></td><td>Cancel a pending reminder by name or ID</td></tr>
<tr><td><code>reminder_check</code></td><td>Check if a specific reminder has fired</td></tr>
</tbody></table>
`)}`;
}

function sMcp(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/mcp-client &amp; mcp-server</span></div>
  <h1 class="pkg-title">MCP Integration</h1>
  <p class="pkg-desc">Model Context Protocol client and server. Connect to any external MCP server as a tool source, or expose WeaveIntel tools to any MCP-compatible host (Claude Desktop, Cursor, etc.).</p>
</div>

${exlinks([
  ['05-mcp-integration.ts', 'Example 05 — MCP Integration'],
  ['05-mcp-integration-real.ts', 'Example 05 — MCP Integration (Real Servers)'],
])}

${section('mcp-client', 'MCP Client', `
${code('typescript', `import {
  weaveMCPClient,
  weaveMCPTools,
  createMCPStdioClientTransport,
  createMCPStreamableHttpTransport,
} from '@weaveintel/mcp-client';

// Connect to a stdio MCP server (subprocess)
const stdioTransport = createMCPStdioClientTransport({
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/alice/docs'],
  env: { HOME: process.env.HOME! },
});

// Connect to an HTTP MCP server
const httpTransport = createMCPStreamableHttpTransport({
  url: 'https://mcp.example.com/v1',
  headers: { Authorization: \`Bearer \${process.env.MCP_TOKEN}\` },
  timeout: 10_000,
});

const client = await weaveMCPClient(stdioTransport);

// Get all tools as a ToolRegistry
const mcpToolRegistry = await weaveMCPTools(client);

// Use in a weaveAgent
const agent = weaveAgent({ model, tools: mcpToolRegistry });

// Or register alongside other tools
mcpToolRegistry.list().forEach(t => myRegistry.register(t));

// Clean up
await client.close();`)}
`)}

${section('mcp-server', 'MCP Server', `
${code('typescript', `import { weaveMCPServer } from '@weaveintel/mcp-server';

const server = weaveMCPServer({
  name: 'my-company-tools',
  version: '1.0.0',
  description: 'Internal WeaveIntel tools exposed via MCP.',
  tools: myToolRegistry,           // Any ToolRegistry
  resources: myResourceRegistry,   // Optional: file/data resources
  prompts: myPromptRegistry,       // Optional: prompt templates
  capabilities: {
    tools: { listChanged: true },  // Enable tool list change notifications
    logging: {},
  },
});

// Expose via HTTP (for remote clients, Claude Desktop, etc.)
await server.startHTTP({
  port: 3001,
  path: '/mcp',
  cors: { origin: 'https://claude.ai' },
});

// Or via stdio (for subprocess usage)
await server.startStdio();`)}
`)}`;
}

function sObservability(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/observability</span></div>
  <h1 class="pkg-title">Observability</h1>
  <p class="pkg-desc">Distributed tracing, usage tracking, budget monitoring, trace graph reconstruction, and run timelines for agents and workflows. Pluggable span emitters (console, file, OpenTelemetry).</p>
</div>

${exlinks([
  ['10-observability.ts', 'Example 10 — Observability'],
  ['21-workflow-observability.ts', 'Example 21 — Workflow Observability (W6)'],
])}

${section('obs-tracer', 'Tracing', `
${code('typescript', `import {
  weaveInMemoryTracer,
  weaveConsoleTracer,
  weaveUsageTracker,
  weaveBudgetTracker,
} from '@weaveintel/observability';

// In-memory tracer — retrieve spans after a run
const tracer = weaveInMemoryTracer();

const agent = weaveAgent({ model, tools, bus: tracer.bus });
const ctx = weaveContext({ userId: 'alice' });
await agent.run(ctx, { messages });

const spans = tracer.getSpans(ctx.traceId);
spans.forEach(s => {
  console.log(\`[\${s.name}] \${s.durationMs}ms — \${s.status}\`);
});

// Budget tracker with alerts
const budget = weaveBudgetTracker({
  bus: tracer.bus,
  monthlyBudgetUsd: 100,
  alertThresholds: [0.5, 0.8, 0.95],
  onAlert: async (pct, spent) => {
    await slack.notify(\`⚠️ \${Math.round(pct * 100)}% of monthly AI budget used ($\${spent.toFixed(2)})\`);
  },
});`)}
`)}`;
}

function sCore(): string {
  return `
<div class="pkg-hdr">
  <div class="pkg-badge-wrap"><span class="pkg-badge">@weaveintel/core</span></div>
  <h1 class="pkg-title">@weaveintel/core</h1>
  <p class="pkg-desc">Zero-dependency contract layer. Defines every interface used across the monorepo — Model, Tool, Memory, EventBus, ExecutionContext, Agent, Workflow types. No package imports a concrete implementation from another package; all use these contracts.</p>
</div>

${callout('info', '💡', 'Import rule.', 'Application code should <em>only</em> import three things from core: <code>weaveContext()</code>, <code>weaveTool()</code>, and <code>weaveToolRegistry()</code>. Everything else is an interface — get implementations from the relevant package.')}

${section('core-context', 'ExecutionContext', `
${code('typescript', `import { weaveContext, createExecutionContext } from '@weaveintel/core';

// Quick factory
const ctx = weaveContext({
  userId:    'user-alice',      // Propagated to every tool.invoke() call
  sessionId: 'sess-2025-abc',   // Groups events in the tracer
  tenantId:  'org-acme',        // Multi-tenant isolation
  traceId:   'trace-001',       // Distributed trace correlation
  metadata:  {
    tier: 'pro',
    region: 'ap-southeast-2',
    ipAddress: '203.0.113.5',
  },
});

// ctx is immutable. To derive a child context for a sub-operation:
const childCtx = { ...ctx, traceId: newTraceId(), sessionId: ctx.sessionId + ':child' };`)}
`)}

${section('core-tools', 'Tool Interfaces', `
${code('typescript', `import { weaveTool, weaveToolRegistry, defineTool } from '@weaveintel/core';
import type { Tool, ToolRegistry, ToolInput, ToolOutput, ToolSchema } from '@weaveintel/core';

// Full tool definition
const bookFlightTool = weaveTool({
  name: 'book_flight',
  description:
    'Book a flight for a passenger. Use this when the user wants to reserve a specific flight.',
  parameters: {
    type: 'object',
    required: ['from', 'to', 'date', 'passengerId'],
    properties: {
      from:        { type: 'string', description: 'IATA departure airport code' },
      to:          { type: 'string', description: 'IATA destination airport code' },
      date:        { type: 'string', format: 'date', description: 'Travel date YYYY-MM-DD' },
      passengerId: { type: 'string' },
      cabinClass:  { type: 'string', enum: ['economy', 'business', 'first'] },
    },
  },
  requiresApproval: true,           // Human must confirm before execution
  riskLevel: 'high',                // 'low' | 'medium' | 'high' | 'critical'
  tags: ['travel', 'booking', 'pii'],
  execute: async ({ from, to, date, passengerId, cabinClass = 'economy' }, ctx) => {
    const booking = await flightService.book({ from, to, date, passengerId, cabinClass });
    return JSON.stringify({ bookingId: booking.id, status: 'confirmed', total: booking.totalUsd });
  },
});

const registry = weaveToolRegistry();
registry.register(bookFlightTool);
registry.register(cancelFlightTool);
registry.unregister('cancel_flight');  // Remove dynamically

const tool = registry.get('book_flight');
const defs = registry.toDefinitions();  // For sending to LLM`)}
`)}

${section('core-events', 'EventBus', `
${code('typescript', `import { weaveEventBus, EventTypes } from '@weaveintel/core';
import type { EventBus, AgentStepEvent, ModelCallEvent } from '@weaveintel/core';

const bus = weaveEventBus();

// Subscribe to all agent steps (ReAct loop iterations)
const unsubAgent = bus.on(EventTypes.AGENT_STEP, (event: AgentStepEvent) => {
  if (event.step.type === 'tool_call') {
    console.log(\`Tool: \${event.step.toolCall?.name}(\${JSON.stringify(event.step.toolCall?.arguments)})\`);
  }
});

// Subscribe to model calls for token counting
const unsubModel = bus.on(EventTypes.MODEL_CALL, (event: ModelCallEvent) => {
  metricsClient.histogram('llm.tokens', event.usage?.totalTokens ?? 0, {
    model: event.modelId, provider: event.provider,
  });
});

// Clean up subscriptions
unsubAgent();
unsubModel();`)}
`)}`;
}

// ── Register all sections ─────────────────────────────────────────────────

(DOCS_SECTIONS as Record<string, () => string>)['memory']       = sMemory;
(DOCS_SECTIONS as Record<string, () => string>)['retrieval']    = sRetrieval;
(DOCS_SECTIONS as Record<string, () => string>)['evals']        = sEvals;
(DOCS_SECTIONS as Record<string, () => string>)['guardrails']   = sGuardrails;
(DOCS_SECTIONS as Record<string, () => string>)['resilience']   = sResilience;
(DOCS_SECTIONS as Record<string, () => string>)['cost-governor']= sCostGovernor;
(DOCS_SECTIONS as Record<string, () => string>)['tools']        = sTools;
(DOCS_SECTIONS as Record<string, () => string>)['tools-time']   = sToolsTime;
(DOCS_SECTIONS as Record<string, () => string>)['mcp']          = sMcp;
(DOCS_SECTIONS as Record<string, () => string>)['observability']= sObservability;
(DOCS_SECTIONS as Record<string, () => string>)['core']         = sCore;

// ── Full HTML export ──────────────────────────────────────────────────────

export function getDocsHTML(): string {
  // Pre-render all sections at build time
  const rendered: Record<string, string> = {};
  for (const [key, fn] of Object.entries(DOCS_SECTIONS)) {
    rendered[key] = fn();
  }
  const sectionsJson = JSON.stringify(rendered).replace(/<\/script>/g, '<\\/script>');

  const NAV_STRUCTURE = JSON.stringify([
    { id: 'home',         label: 'Home',            icon: '🏠', group: 'Overview' },
    { id: 'agents',       label: 'Agents',           icon: '🤖', group: 'Agent Layer',
      subs: ['weave-agent','supervisor','agent-tools','agent-memory','agent-events'] },
    { id: 'workflows',    label: 'Workflows',        icon: '⚙️', group: 'Agent Layer',
      subs: ['wf-engine','wf-builder','wf-steps','wf-resolvers','wf-policy','wf-phases'] },
    { id: 'models',       label: 'Models',           icon: '🧠', group: 'Model Layer',
      subs: ['models-register','models-routing','models-providers'] },
    { id: 'prompts',      label: 'Prompts',          icon: '💬', group: 'Model Layer',
      subs: ['prompts-registry','prompts-contracts','prompts-frameworks'] },
    { id: 'cost-governor',label: 'Cost Governor',    icon: '💰', group: 'Model Layer',
      subs: ['cost-levers','cost-setup'] },
    { id: 'memory',       label: 'Memory',           icon: '🧩', group: 'Memory & Knowledge',
      subs: ['memory-types','memory-extraction','memory-backends'] },
    { id: 'retrieval',    label: 'Retrieval',        icon: '🔍', group: 'Memory & Knowledge',
      subs: ['retrieval-chunking','retrieval-embedding','retrieval-hybrid'] },
    { id: 'tools',        label: 'Tool Framework',   icon: '🔧', group: 'Tools',
      subs: ['tools-policy'] },
    { id: 'tools-time',   label: 'tools-time',       icon: '🕐', group: 'Tools',
      subs: ['tools-time-setup'] },
    { id: 'mcp',          label: 'MCP',              icon: '🔌', group: 'Tools',
      subs: ['mcp-client','mcp-server'] },
    { id: 'guardrails',   label: 'Guardrails',       icon: '🛡️', group: 'Quality & Safety',
      subs: ['guardrails-pipeline','guardrails-checks'] },
    { id: 'evals',        label: 'Evals',            icon: '📊', group: 'Quality & Safety',
      subs: ['evals-runner'] },
    { id: 'resilience',   label: 'Resilience',       icon: '♻️', group: 'Quality & Safety',
      subs: ['resilience-run','resilience-primitives'] },
    { id: 'observability',label: 'Observability',    icon: '📈', group: 'Quality & Safety',
      subs: ['obs-tracer'] },
    { id: 'core',         label: '@weaveintel/core', icon: '⚛️', group: 'Core',
      subs: ['core-context','core-tools','core-events'] },
  ]);

  const SUB_LABELS = JSON.stringify({
    'weave-agent':'weaveAgent','supervisor':'Supervisor Mode','agent-tools':'Tool Binding',
    'agent-memory':'Memory Integration','agent-events':'Event Bus',
    'wf-engine':'Engine Setup','wf-builder':'Defining Workflows','wf-steps':'All Step Types',
    'wf-resolvers':'Handler Resolvers','wf-policy':'WorkflowPolicy','wf-phases':'Phase Reference',
    'step-deterministic':'deterministic','step-agentic':'agentic','step-condition':'condition',
    'step-switch':'switch','step-forEach':'forEach','step-parallel':'parallel (lanes)',
    'step-fork-join':'fork / join','step-wait':'wait','step-human-task':'human-task',
    'step-dynamic':'dynamic (W7)',
    'models-register':'Registration','models-routing':'Smart Routing','models-providers':'Providers',
    'prompts-registry':'Registry & Versioning','prompts-contracts':'Output Contracts',
    'prompts-frameworks':'Frameworks',
    'cost-levers':'8 Levers','cost-setup':'Setup & Usage',
    'memory-types':'Memory Types','memory-extraction':'Extraction','memory-backends':'Backends',
    'retrieval-chunking':'Chunking','retrieval-embedding':'Embedding Pipeline',
    'retrieval-hybrid':'Hybrid Search',
    'tools-policy':'Policy-Enforced Registry','tools-time-setup':'Setup & Tools',
    'mcp-client':'MCP Client','mcp-server':'MCP Server',
    'guardrails-pipeline':'Building a Pipeline','guardrails-checks':'Built-in Checks',
    'evals-runner':'Eval Runner','resilience-run':'runResilient','resilience-primitives':'Primitives',
    'obs-tracer':'Tracing',
    'core-context':'ExecutionContext','core-tools':'Tool Interfaces','core-events':'EventBus',
  });

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WeaveIntel Docs</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@500;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css" id="hljs-theme">
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<style>
/* ── geneWeave design tokens ─────────────────────────────────────── */
:root{
  --bg:#EDF5F0;--bg2:#F7FBF8;--bg3:#F5F7F6;--bg4:#E2EAE5;
  --fg:#1A2B23;--fg2:#5A6B63;--fg3:#8A9B93;
  --accent:#2AB090;--accent2:#1E8A6F;--accent-dim:#E0F5EE;
  --solid:#1A2B23;--solid-hover:#24382F;--solid-contrast:#FFFFFF;
  --danger:#dc2626;--success:#16a34a;--warn:#d97706;
  --radius:12px;--radius-lg:16px;
  --font:'DM Sans','Plus Jakarta Sans',system-ui,sans-serif;
  --font-display:'Plus Jakarta Sans','DM Sans',sans-serif;
  --mono:'JetBrains Mono','Fira Code',monospace;
  --shadow-soft:0 1px 3px rgba(26,43,35,.06),0 8px 20px rgba(26,43,35,.06);
  --shadow-hover:0 2px 8px rgba(26,43,35,.10),0 14px 28px rgba(26,43,35,.10);
  --topbar:52px;--sidebar:268px;
}
html[data-theme='dark']{
  --bg:#0E1713;--bg2:#121E19;--bg3:#1A2B23;--bg4:#2E4339;
  --fg:#E5F2EC;--fg2:#B4CBC0;--fg3:#88A498;
  --accent:#34C9A5;--accent2:#2AB090;--accent-dim:#1C3A31;
  --solid:#28453A;--solid-hover:#315447;--solid-contrast:#F7FBF8;
  --danger:#F87171;--success:#4ADE80;--warn:#FBBF24;
  --shadow-soft:0 1px 2px rgba(0,0,0,.35),0 8px 24px rgba(0,0,0,.35);
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;font-family:var(--font);background:var(--bg);color:var(--fg);-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
button{font-family:inherit;cursor:pointer;border:none;outline:none;background:none}
input{font-family:inherit;outline:none}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--bg4);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--fg3)}

/* ── Top bar ─────────────────────────────────────────────────────── */
.topbar{
  position:fixed;top:0;left:0;right:0;height:var(--topbar);z-index:200;
  background:var(--bg2);border-bottom:1px solid var(--bg4);
  display:flex;align-items:center;padding:0 18px;gap:14px;
  box-shadow:var(--shadow-soft);
}
.tb-brand{display:flex;align-items:center;gap:8px;font-family:var(--font-display);font-weight:700;font-size:17px;color:var(--fg);text-decoration:none;flex-shrink:0}
.tb-brand-mark{width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0}
.tb-brand span{color:var(--accent)}
.tb-divider{width:1px;height:20px;background:var(--bg4);flex-shrink:0}
.tb-label{font-size:13px;color:var(--fg3);font-weight:500;flex-shrink:0}
.breadcrumbs{display:flex;align-items:center;gap:5px;font-size:12px;color:var(--fg3);flex:1;min-width:0;overflow:hidden}
.bc-item{color:var(--fg3);cursor:pointer;white-space:nowrap;transition:color .14s}
.bc-item:hover{color:var(--accent)}
.bc-item.current{color:var(--fg2);font-weight:500}
.bc-sep{color:var(--fg3);font-size:10px;flex-shrink:0}
.tb-actions{display:flex;align-items:center;gap:8px;margin-left:auto;flex-shrink:0}
.tb-btn{padding:6px 12px;border-radius:999px;font-size:12px;color:var(--fg2);background:var(--bg3);border:1px solid var(--bg4);font-weight:500;transition:all .15s;cursor:pointer;white-space:nowrap}
.tb-btn:hover{background:var(--bg4);color:var(--fg);border-color:var(--fg3)}
.search-wrap{position:relative}
.search-wrap input{
  background:var(--bg3);border:1px solid var(--bg4);border-radius:8px;
  color:var(--fg);padding:6px 12px 6px 30px;font-size:12px;width:200px;
  transition:width .2s,border-color .2s;
}
.search-wrap input:focus{border-color:var(--accent);width:260px}
.search-wrap .s-icon{position:absolute;left:9px;top:50%;transform:translateY(-50%);color:var(--fg3);font-size:13px;pointer-events:none}
.search-wrap .kbd{position:absolute;right:8px;top:50%;transform:translateY(-50%);font-size:10px;color:var(--fg3);background:var(--bg4);border-radius:4px;padding:1px 5px}

/* ── Layout ─────────────────────────────────────────────────────── */
.layout{
  display:flex;
  position:fixed;top:var(--topbar);left:0;right:0;bottom:0;
}

/* ── Sidebar — independently scrollable ─────────────────────────── */
.sidebar{
  width:var(--sidebar);flex-shrink:0;
  background:var(--bg2);border-right:1px solid var(--bg4);
  height:100%;overflow-y:auto;overflow-x:hidden;
  padding:12px 0 24px;
}
.sg-label{padding:10px 16px 4px;font-size:10px;font-weight:700;letter-spacing:.07em;color:var(--fg3);text-transform:uppercase}
.nav-item{
  display:flex;align-items:center;gap:9px;
  padding:8px 14px;font-size:13px;font-weight:500;color:var(--fg2);
  cursor:pointer;transition:all .13s;border-left:2px solid transparent;
  user-select:none;
}
.nav-item:hover{background:var(--bg3);color:var(--fg)}
.nav-item.active{color:var(--accent);background:var(--accent-dim);border-left-color:var(--accent);font-weight:600}
.nav-item .ni-icon{font-size:14px;flex-shrink:0;width:18px;text-align:center}
.nav-item .ni-caret{margin-left:auto;font-size:10px;color:var(--fg3);transition:transform .14s}
.nav-item.open .ni-caret{transform:rotate(90deg)}
.nav-subs{overflow:hidden;max-height:0;transition:max-height .2s ease}
.nav-subs.open{max-height:600px}
.nav-sub-item{
  display:flex;align-items:center;gap:8px;
  padding:6px 14px 6px 38px;font-size:12px;color:var(--fg3);
  cursor:pointer;transition:all .12s;border-left:2px solid transparent;
}
.nav-sub-item::before{content:'';width:4px;height:4px;border-radius:50%;background:var(--fg3);flex-shrink:0}
.nav-sub-item:hover{background:var(--bg3);color:var(--fg2)}
.nav-sub-item.active{color:var(--accent2);border-left-color:var(--accent);font-weight:500}
.nav-sub-item.active::before{background:var(--accent)}

/* ── Main content — independently scrollable ────────────────────── */
.main{
  flex:1;height:100%;overflow-y:auto;overflow-x:hidden;
  padding:0 0 80px;min-width:0;
}
.main-inner{max-width:900px;padding:36px 48px;margin:0 auto}

/* ── Content styles ─────────────────────────────────────────────── */
.hero{text-align:center;padding:40px 0 32px;margin-bottom:8px}
.hero-icon{font-size:48px;margin-bottom:16px}
.hero-title{font-family:var(--font-display);font-size:32px;font-weight:700;color:var(--fg);margin-bottom:12px;line-height:1.2}
.hero-sub{font-size:16px;color:var(--fg2);max-width:600px;margin:0 auto 20px;line-height:1.6}
.hero-badges{display:flex;flex-wrap:wrap;gap:8px;justify-content:center}
.badge{display:inline-flex;padding:4px 12px;border-radius:999px;font-size:12px;font-weight:600}
.badge-accent{background:var(--accent-dim);color:var(--accent2);border:1px solid color-mix(in oklab,var(--accent) 30%,transparent)}
.badge-muted{background:var(--bg3);color:var(--fg3);border:1px solid var(--bg4)}
.pkg-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin:16px 0}
.pkg-card{background:var(--bg2);border:1px solid var(--bg4);border-radius:var(--radius);padding:16px;cursor:pointer;transition:all .15s}
.pkg-card:hover{border-color:var(--accent);box-shadow:var(--shadow-hover);transform:translateY(-1px)}
.pkg-icon{font-size:20px;margin-bottom:8px}
.pkg-name{font-size:13px;font-weight:600;color:var(--fg);margin-bottom:4px}
.pkg-desc{font-size:12px;color:var(--fg3);line-height:1.4}

.pkg-hdr{margin-bottom:28px;padding-bottom:20px;border-bottom:1px solid var(--bg4)}
.pkg-badge-wrap{margin-bottom:10px}
.pkg-badge{display:inline-flex;background:var(--accent-dim);color:var(--accent2);border:1px solid color-mix(in oklab,var(--accent) 25%,transparent);border-radius:6px;padding:3px 10px;font-size:11px;font-weight:700;font-family:var(--mono)}
.pkg-title{font-family:var(--font-display);font-size:28px;font-weight:700;color:var(--fg);margin-bottom:10px;line-height:1.2}
.pkg-desc{font-size:15px;color:var(--fg2);line-height:1.6;max-width:700px}

.sec-title{display:flex;align-items:center;gap:10px;font-size:20px;font-weight:700;color:var(--fg);margin:32px 0 14px}
.sec-anchor{color:var(--accent);font-size:14px;font-weight:400;opacity:.7;cursor:pointer;text-decoration:none}
.sec-anchor:hover{opacity:1}
.subsec-title{font-size:16px;font-weight:600;color:var(--fg);margin:22px 0 10px;padding-left:12px;border-left:3px solid var(--accent)}
h4{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--fg3);margin:18px 0 8px}
p{color:var(--fg2);margin-bottom:12px;line-height:1.7;font-size:14px}
ul,ol{color:var(--fg2);padding-left:20px;margin-bottom:12px}
li{margin-bottom:4px;line-height:1.6;font-size:14px}
li code,p code,td code{font-family:var(--mono);font-size:12px;background:var(--bg3);border:1px solid var(--bg4);padding:1px 6px;border-radius:4px;color:var(--accent2)}
strong{color:var(--fg);font-weight:600}

.callout{display:flex;gap:12px;border-radius:var(--radius);padding:13px 16px;margin:16px 0;border:1px solid;font-size:14px;line-height:1.6}
.callout-icon{font-size:16px;flex-shrink:0;margin-top:1px}
.callout-info{background:color-mix(in oklab,var(--accent-dim) 60%,var(--bg2));border-color:color-mix(in oklab,var(--accent) 25%,transparent);color:var(--fg2)}
.callout-tip{background:color-mix(in oklab,rgba(76,175,147,.08) 100%,transparent);border-color:rgba(76,175,147,.3);color:var(--fg2)}
.callout-warn{background:color-mix(in oklab,rgba(217,119,6,.06) 100%,transparent);border-color:rgba(217,119,6,.3);color:var(--fg2)}
.callout-danger{background:rgba(220,38,38,.05);border-color:rgba(220,38,38,.3);color:var(--fg2)}
.callout strong{color:var(--fg)}
.callout code{font-family:var(--mono);font-size:12px;background:var(--bg3);padding:1px 5px;border-radius:3px}
.callout a{color:var(--accent)}

.cb{margin:14px 0 20px;border-radius:var(--radius);overflow:hidden;border:1px solid var(--bg4)}
.cb-hdr{display:flex;align-items:center;justify-content:space-between;background:var(--bg3);padding:8px 14px;border-bottom:1px solid var(--bg4)}
.cb-lang{font-size:10px;color:var(--fg3);font-family:var(--mono);font-weight:700;text-transform:uppercase;letter-spacing:.07em}
.copy-btn{background:var(--bg4);border:1px solid var(--bg4);color:var(--fg3);border-radius:6px;padding:3px 10px;font-size:11px;cursor:pointer;transition:all .14s}
.copy-btn:hover{background:var(--bg);color:var(--fg);border-color:var(--fg3)}
.copy-btn.ok{color:var(--success);border-color:var(--success)}
.cb pre{margin:0;padding:16px;overflow-x:auto;background:var(--bg2)}
.cb pre code.hljs{font-family:var(--mono);font-size:13px;line-height:1.6;background:transparent!important;padding:0}
.tbl-wrap{overflow-x:auto;margin:14px 0 20px}
.ptable{width:100%;border-collapse:collapse;font-size:13px}
.ptable th{background:var(--bg3);color:var(--fg2);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;padding:9px 13px;text-align:left;border:1px solid var(--bg4);white-space:nowrap}
.ptable td{padding:9px 13px;border:1px solid var(--bg4);vertical-align:top;color:var(--fg2);line-height:1.5;font-size:13px}
.ptable tr:nth-child(even) td{background:color-mix(in oklab,var(--bg3) 50%,transparent)}
.pname code{font-family:var(--mono);font-size:12px;color:var(--accent2);white-space:nowrap}
.ptype code{font-family:var(--mono);font-size:11px;color:var(--fg3)}
.pdesc code{font-family:var(--mono);font-size:11px;background:var(--bg3);border:1px solid var(--bg4);padding:1px 4px;border-radius:3px;color:var(--accent2)}
.req{display:inline-block;background:color-mix(in oklab,var(--warn) 12%,transparent);color:var(--warn);border:1px solid color-mix(in oklab,var(--warn) 30%,transparent);border-radius:4px;padding:1px 6px;font-size:10px;font-weight:700;white-space:nowrap}
.opt{display:inline-block;background:var(--bg3);color:var(--fg3);border:1px solid var(--bg4);border-radius:4px;padding:1px 6px;font-size:10px;white-space:nowrap}
.fcard-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin:14px 0 20px}
.fcard{background:var(--bg2);border:1px solid var(--bg4);border-radius:var(--radius);padding:14px}
.fcard-title{font-weight:600;color:var(--fg);font-size:13px;margin-bottom:5px}
.fcard-desc{font-size:12px;color:var(--fg3);line-height:1.4}
.ex-links{background:var(--bg3);border:1px solid var(--bg4);border-radius:var(--radius);padding:14px 16px;margin:16px 0}
.ex-links-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--fg3);margin-bottom:10px}
.ex-links-list{display:flex;flex-wrap:wrap;gap:8px}
.ex-link{display:inline-flex;align-items:center;gap:6px;background:var(--bg2);border:1px solid var(--bg4);border-radius:8px;padding:5px 10px;font-size:12px;color:var(--fg2);text-decoration:none;transition:all .13s}
.ex-link:hover{border-color:var(--accent);color:var(--accent);text-decoration:none}
.ex-icon{font-size:13px}
.ex-title{font-weight:500}
.ex-ext{font-size:10px;color:var(--fg3)}
.doc-section{margin-bottom:40px}
.doc-subsection{margin-top:20px;padding-top:16px;border-top:1px solid var(--bg4)}

/* ── Search overlay ─────────────────────────────────────────────── */
.s-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:500;align-items:flex-start;justify-content:center;padding-top:80px}
.s-overlay.open{display:flex}
.s-box{background:var(--bg2);border:1px solid var(--bg4);border-radius:var(--radius-lg);width:560px;overflow:hidden;box-shadow:var(--shadow-hover)}
.s-box input{width:100%;background:transparent;border:none;color:var(--fg);padding:16px 18px;font-size:15px;outline:none;font-family:var(--font)}
.s-results{max-height:380px;overflow-y:auto;border-top:1px solid var(--bg4)}
.s-result{padding:11px 18px;cursor:pointer;border-bottom:1px solid var(--bg4);transition:background .12s}
.s-result:hover{background:var(--bg3)}
.s-result .sr-title{font-size:14px;color:var(--fg);font-weight:500;margin-bottom:2px}
.s-result .sr-pkg{font-size:12px;color:var(--fg3)}
.s-empty{padding:14px 18px;color:var(--fg3);font-size:13px}
</style>
</head>
<body>

<!-- Top bar -->
<div class="topbar">
  <a class="tb-brand" href="/" target="_blank" rel="noopener" title="Open geneWeave">
    <div class="tb-brand-mark">🧬</div>
    <span>gene<span>Weave</span></span>
  </a>
  <div class="tb-divider"></div>
  <span class="tb-label">Developer Docs</span>
  <div class="breadcrumbs" id="bc">
    <span class="bc-item current" onclick="nav('home')">Docs</span>
  </div>
  <div class="tb-actions">
    <div class="search-wrap">
      <span class="s-icon">⌕</span>
      <input type="text" placeholder="Search…" id="searchTrigger" readonly onclick="openSearch()" title="Search (⌘K)">
      <span class="kbd">⌘K</span>
    </div>
    <button class="tb-btn" id="themeBtn" onclick="toggleTheme()" title="Toggle theme">🌙</button>
    <button class="tb-btn" onclick="window.close()">✕ Close</button>
  </div>
</div>

<!-- Search overlay -->
<div class="s-overlay" id="sOverlay" onclick="closeSO(event)">
  <div class="s-box" onclick="event.stopPropagation()">
    <input type="text" id="sInput" placeholder="Search packages, functions, parameters…" oninput="doSearch(this.value)" autocomplete="off">
    <div class="s-results" id="sResults"></div>
  </div>
</div>

<!-- Layout -->
<div class="layout">
  <!-- Sidebar -->
  <nav class="sidebar" id="sidebar"></nav>

  <!-- Main content -->
  <main class="main" id="main">
    <div class="main-inner" id="mainInner"></div>
  </main>
</div>

<script>
const SECTIONS   = ${sectionsJson};
const NAV        = ${NAV_STRUCTURE};
const SUB_LABELS = ${SUB_LABELS};

const TITLES = {};
NAV.forEach(n => { TITLES[n.id] = n.label; });

let currentSection = 'home';
let currentSub     = '';
let expandedGroups = {};

// ── Sidebar rendering ────────────────────────────────────────────
function buildSidebar() {
  const sidebar = document.getElementById('sidebar');
  let groupLabel = '';
  let html = '';

  NAV.forEach(item => {
    if (item.group !== groupLabel) {
      groupLabel = item.group;
      html += '<div class="sg-label">' + groupLabel + '</div>';
    }
    const isActive = currentSection === item.id;
    const hasSubs  = item.subs && item.subs.length > 0;
    const isOpen   = expandedGroups[item.id] || isActive;
    html += '<div class="nav-item' + (isActive ? ' active' : '') + (hasSubs && isOpen ? ' open' : '') +
      '" id="navitem-' + item.id + '" onclick="navItemClick(\'' + item.id + '\')">' +
      '<span class="ni-icon">' + item.icon + '</span>' +
      '<span>' + item.label + '</span>' +
      (hasSubs ? '<span class="ni-caret">' + (isOpen ? '▾' : '▸') + '</span>' : '') +
      '</div>';
    if (hasSubs && isOpen) {
      html += '<div class="nav-subs open" id="subs-' + item.id + '">';
      item.subs.forEach(function(subId) {
        const isSubActive = currentSub === subId;
        const label = SUB_LABELS[subId] || subId.replace(/-/g, ' ');
        html += '<div class="nav-sub-item' + (isSubActive ? ' active' : '') +
          '" onclick="navToSub(\'' + item.id + "','" + subId + '\')">' + label + '</div>';
      });
      html += '</div>';
    }
  });

  sidebar.innerHTML = html;
}

function navItemClick(id) {
  if (currentSection === id) {
    // Toggle expand/collapse if already on this section
    expandedGroups[id] = !expandedGroups[id];
    buildSidebar();
  } else {
    nav(id);
  }
}

function navToSub(sectionId, subId) {
  if (currentSection !== sectionId) nav(sectionId, false);
  currentSub = subId;
  buildSidebar();
  setTimeout(function() {
    var el = document.getElementById(subId);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 80);
  updateBreadcrumbs(sectionId, subId);
}

// ── Navigation ───────────────────────────────────────────────────
function nav(id, scroll) {
  currentSection = id;
  currentSub = '';
  expandedGroups[id] = true;

  const content = SECTIONS[id];
  const inner = document.getElementById('mainInner');
  inner.innerHTML = content || '<p style="color:var(--fg3)">Section not found.</p>';
  hljs.highlightAll();
  document.getElementById('main').scrollTop = 0;

  buildSidebar();
  updateBreadcrumbs(id, '');

  if (scroll !== false) {
    var navEl = document.getElementById('navitem-' + id);
    if (navEl) navEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function updateBreadcrumbs(sectionId, subId) {
  var bc = document.getElementById('bc');
  var html = '<span class="bc-item" onclick="nav(\'home\')">Docs</span>';
  if (sectionId !== 'home') {
    var t = TITLES[sectionId] || sectionId;
    html += '<span class="bc-sep">›</span>';
    html += '<span class="bc-item' + (subId ? '' : ' current') + '" onclick="nav(\'' + sectionId + '\')">' + t + '</span>';
    if (subId) {
      var st = SUB_LABELS[subId] || subId.replace(/-/g, ' ');
      html += '<span class="bc-sep">›</span>';
      html += '<span class="bc-item current">' + st + '</span>';
    }
  } else {
    html += '<span class="bc-sep">›</span><span class="bc-item current">Home</span>';
  }
  bc.innerHTML = html;
}

// ── Copy code ────────────────────────────────────────────────────
function copyCode(btn) {
  var pre = btn.closest('.cb').querySelector('code');
  navigator.clipboard.writeText(pre.innerText).then(function() {
    btn.textContent = '✓ Copied';
    btn.classList.add('ok');
    setTimeout(function() { btn.textContent = 'Copy'; btn.classList.remove('ok'); }, 2000);
  });
}

// ── Theme toggle ─────────────────────────────────────────────────
function toggleTheme() {
  var html = document.documentElement;
  var isDark = html.getAttribute('data-theme') === 'dark';
  html.setAttribute('data-theme', isDark ? 'light' : 'dark');
  document.getElementById('themeBtn').textContent = isDark ? '🌙' : '☀️';
  var hljsLink = document.getElementById('hljs-theme');
  hljsLink.href = isDark
    ? 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github.min.css'
    : 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css';
}

// ── Search ───────────────────────────────────────────────────────
var SEARCH_IDX = [
  {s:'agents',    t:'weaveAgent — Creating an Agent',   k:'weaveagent agent tool calling model tools system prompt'},
  {s:'agents',    t:'Supervisor Mode',                  k:'supervisor workers delegate delegation hierarchy multi-agent', sub:'supervisor'},
  {s:'agents',    t:'Tool Binding',                     k:'tool register weavetool tool registry execute', sub:'agent-tools'},
  {s:'agents',    t:'Memory Integration',               k:'memory agent cross-session context semantic', sub:'agent-memory'},
  {s:'workflows', t:'Workflow Engine Setup',            k:'workflow engine defaultworkflowengine setup checkpoint run repository'},
  {s:'workflows', t:'Step Types',                       k:'deterministic agentic condition switch foreach parallel fork join wait human-task dynamic', sub:'wf-steps'},
  {s:'workflows', t:'Handler Resolvers',                k:'resolver noop script tool prompt agent mcp subworkflow plan', sub:'wf-resolvers'},
  {s:'workflows', t:'Dynamic Graphs (W7)',              k:'dynamic expansion planner sub-graph w7 dynamicexpansion', sub:'step-dynamic'},
  {s:'workflows', t:'WorkflowPolicy',                   k:'policy maxsteps costceiling concurrency expansion', sub:'wf-policy'},
  {s:'models',    t:'Model Registration',               k:'register model weaveregistermodel weavegetmodel anthropic openai'},
  {s:'models',    t:'Smart Routing',                    k:'routing smart model router capability cost'},
  {s:'prompts',   t:'Prompt Registry & Versioning',     k:'prompt registry version render template variables'},
  {s:'prompts',   t:'Output Contracts',                 k:'contract validate json schema repair output'},
  {s:'memory',    t:'Memory Types',                     k:'semantic conversation entity working memory store'},
  {s:'memory',    t:'Automatic Extraction',             k:'extract memory conversation turn rules llm'},
  {s:'retrieval', t:'Hybrid Search',                    k:'hybrid rag retrieval dense sparse bm25 rrf rerank'},
  {s:'retrieval', t:'Embedding Pipeline',               k:'embedding pipeline index vector store chunk'},
  {s:'evals',     t:'Eval Runner',                      k:'eval evaluation rubric judge score accuracy'},
  {s:'guardrails',t:'Guardrails Pipeline',              k:'guardrail safety risk pii injection confidence'},
  {s:'resilience',t:'runResilient',                     k:'resilient retry circuit breaker rate limit token bucket concurrency'},
  {s:'cost-governor',t:'8 Cost Levers',                 k:'cost governor lever model cascade tool subset prompt cache'},
  {s:'tools',     t:'Policy-Enforced Registry',         k:'tool policy audit approval gate rate limit network'},
  {s:'tools-time',t:'Time Tools',                       k:'time datetime timezone timer stopwatch reminder'},
  {s:'mcp',       t:'MCP Client',                       k:'mcp client stdio http transport tools protocol', sub:'mcp-client'},
  {s:'mcp',       t:'MCP Server',                       k:'mcp server expose tools host claude desktop', sub:'mcp-server'},
  {s:'observability',t:'Tracing & Budget',              k:'trace span usage budget tracker observability'},
  {s:'core',      t:'ExecutionContext',                  k:'context userid sessionid traceid metadata', sub:'core-context'},
  {s:'core',      t:'Tool Interfaces',                  k:'weavetool toolregistry toolschema execute parameters', sub:'core-tools'},
  {s:'core',      t:'EventBus',                         k:'eventbus events subscribe agent model call step', sub:'core-events'},
];

function openSearch() {
  document.getElementById('sOverlay').classList.add('open');
  setTimeout(function() { document.getElementById('sInput').focus(); }, 50);
}
function closeSO(e) {
  if (e && e.target !== document.getElementById('sOverlay')) return;
  document.getElementById('sOverlay').classList.remove('open');
  document.getElementById('sInput').value = '';
  document.getElementById('sResults').innerHTML = '';
}
document.addEventListener('keydown', function(e) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); openSearch(); }
  if (e.key === 'Escape') closeSO({ target: document.getElementById('sOverlay') });
});

function doSearch(q) {
  var lq = q.toLowerCase().trim();
  if (!lq) { document.getElementById('sResults').innerHTML = ''; return; }
  var hits = SEARCH_IDX.filter(function(i) {
    return i.t.toLowerCase().includes(lq) || i.k.includes(lq);
  }).slice(0, 10);

  document.getElementById('sResults').innerHTML = hits.length
    ? hits.map(function(h) {
        return '<div class="s-result" onclick="closeSO({target:document.getElementById(\'sOverlay\')});' +
          (h.sub ? 'navToSub(\'' + h.s + "','" + h.sub + '\')">' : 'nav(\'' + h.s + '\')">' ) +
          '<div class="sr-title">' + h.t + '</div>' +
          '<div class="sr-pkg">@weaveintel/' + h.s + '</div></div>';
      }).join('')
    : '<div class="s-empty">No results for "' + q + '"</div>';
}

// ── Init ─────────────────────────────────────────────────────────
nav('home', false);
</script>
</body>
</html>`;
}
