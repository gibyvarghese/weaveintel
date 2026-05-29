/**
 * geneWeave — Developer Documentation HTML
 * Served at GET /docs by server.ts.
 */

// ── TypeScript helpers (render at build time) ─────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function code(lang: string, src: string): string {
  return `<div class="code-block"><div class="code-header"><span class="code-lang">${lang}</span><button class="copy-btn" onclick="copyCode(this)">&#128203; Copy</button></div><pre><code class="language-${lang}">${esc(src.trim())}</code></pre></div>`;
}

function callout(type: 'info' | 'tip' | 'warn', title: string, body: string): string {
  return `<div class="callout ${type}"><strong>${title}</strong> ${body}</div>`;
}

function params(rows: [string, string, string, string][]): string {
  const trs = rows.map(([name, type, req, desc]) =>
    `<tr><td><code>${name}</code></td><td><code>${type}</code></td><td><span class="${req === 'required' ? 'req' : 'opt'}">${req}</span></td><td>${desc}</td></tr>`
  ).join('');
  return `<table class="param-table"><thead><tr><th>Parameter</th><th>Type</th><th>Required</th><th>Description</th></tr></thead><tbody>${trs}</tbody></table>`;
}

function featureCard(title: string, desc: string): string {
  return `<div class="feature-card"><h4>${title}</h4><p>${desc}</p></div>`;
}

// ── Section content ───────────────────────────────────────────────────────

function sHome(): string {
  const cards = [
    { id: 'agents', icon: '🤖', name: 'agents', desc: 'Agentic loops with tool calling, supervisor mode, worker delegation' },
    { id: 'workflows', icon: '⚙️', name: 'workflows', desc: 'Durable, deterministic workflow orchestration (W1–W7)' },
    { id: 'models', icon: '🧠', name: 'models', desc: 'Provider-agnostic model routing and registration' },
    { id: 'prompts', icon: '💬', name: 'prompts', desc: 'Prompt versioning, rendering, contracts, evaluation' },
    { id: 'memory', icon: '🧩', name: 'memory', desc: 'Conversation, semantic, entity and working memory' },
    { id: 'retrieval', icon: '🔍', name: 'retrieval', desc: 'Chunking, embedding, hybrid RAG search' },
    { id: 'tools', icon: '🔧', name: 'tools', desc: 'Policy, audit, approval gates for any tool' },
    { id: 'evals', icon: '📊', name: 'evals', desc: 'Rubric-based evaluation runner with LLM judges' },
    { id: 'guardrails', icon: '🛡', name: 'guardrails', desc: 'Pre/post-execution risk and confidence gates' },
    { id: 'resilience', icon: '♻️', name: 'resilience', desc: 'Token bucket, circuit breaker, retry, concurrency' },
    { id: 'cost-governor', icon: '💰', name: 'cost-governor', desc: '8-lever cost optimisation across model, tools, prompts' },
    { id: 'mcp', icon: '🔌', name: 'mcp', desc: 'MCP client and server for cross-system tool protocol' },
    { id: 'observability', icon: '📈', name: 'observability', desc: 'Tracing, spans, usage tracking, budget monitoring' },
    { id: 'sandbox', icon: '📦', name: 'sandbox', desc: 'Safe in-process or container code execution' },
    { id: 'core', icon: '⚛️', name: 'core', desc: 'Zero-dep contract layer — all packages depend on this' },
  ].map(p => `<div class="home-card" onclick="navigate('${p.id}')"><div class="icon">${p.icon}</div><div class="name">@weaveintel/${p.name}</div><div class="desc">${p.desc}</div></div>`).join('');

  return `
<div class="pkg-header">
  <div style="font-size:40px;margin-bottom:12px">⚡</div>
  <div class="pkg-title">WeaveIntel Developer Documentation</div>
  <div class="pkg-desc">A modular, production-grade TypeScript monorepo for building AI-powered applications. Every capability is a standalone package — compose exactly what you need.</div>
</div>
${callout('tip', 'Zero vendor lock-in.', 'Every model, tool, memory backend, and vector store is swappable via the <code>@weaveintel/core</code> contract interfaces.')}
<h2>Packages</h2>
<div class="home-grid">${cards}</div>`;
}

function sQuickstart(): string {
  return `
<div class="pkg-header">
  <div class="pkg-badge">Getting Started</div>
  <div class="pkg-title">Quick Start</div>
  <div class="pkg-desc">Get a tool-calling agent running in under 10 lines.</div>
</div>
<h2>Installation</h2>
${code('bash', `npm install @weaveintel/agents @weaveintel/provider-anthropic @weaveintel/core`)}
<h2>Minimal Agent</h2>
${code('typescript', `import { weaveAgent } from '@weaveintel/agents';
import { weaveAnthropicModel } from '@weaveintel/provider-anthropic';
import { weaveContext, weaveToolRegistry, weaveTool } from '@weaveintel/core';

const model = weaveAnthropicModel('claude-haiku-4-5-20251001');

const tools = weaveToolRegistry();
tools.register(weaveTool({
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  parameters: {
    type: 'object', required: ['city'],
    properties: { city: { type: 'string' } },
  },
  execute: async ({ city }) => \`Weather in \${city}: 22°C, sunny.\`,
}));

const agent = weaveAgent({ model, tools, maxSteps: 5 });
const ctx = weaveContext({ userId: 'demo' });
const result = await agent.run(ctx, {
  messages: [{ role: 'user', content: "What's the weather in Auckland?" }],
});
console.log(result.output);`)}
<h2>Add a Workflow</h2>
${code('typescript', `import { DefaultWorkflowEngine, defineWorkflow } from '@weaveintel/workflows';

const engine = new DefaultWorkflowEngine();

engine.registerHandler('validate', async (vars) => {
  if (!vars['email']) throw new Error('Email required');
  return { valid: true };
});
engine.registerHandler('welcome', async (vars) => ({ message: \`Welcome \${vars['name']}!\` }));

const def = defineWorkflow('User Onboarding')
  .setId('user-onboarding')
  .addStep({ id: 'validate', name: 'Validate', type: 'deterministic',
             handler: 'validate', next: 'welcome' })
  .addStep({ id: 'welcome', name: 'Welcome', type: 'deterministic', handler: 'welcome' })
  .build();

await engine.createDefinition(def);
const run = await engine.startRun(def.id, { name: 'Alice', email: 'alice@example.com' });
console.log(run.status); // 'completed'`)}`;
}

function sArchitecture(): string {
  return `
<div class="pkg-header">
  <div class="pkg-badge">Concepts</div>
  <div class="pkg-title">Architecture</div>
  <div class="pkg-desc">WeaveIntel is a layered monorepo. Each layer depends only on packages below it.</div>
</div>
${code('text', `┌─────────────────────────────────────────────────────────────┐
│  Applications  (geneweave, your app)                          │
├─────────────────────────────────────────────────────────────┤
│  Agent Layer   agents · workflows · cost-governor            │
├─────────────────────────────────────────────────────────────┤
│  Capability    prompts · memory · retrieval · evals           │
│  Layer         guardrails · resilience · tools                │
├─────────────────────────────────────────────────────────────┤
│  Integration   models · mcp-client · mcp-server              │
│  Layer         tools-* · sandbox · observability              │
├─────────────────────────────────────────────────────────────┤
│  @weaveintel/core  — contracts only, zero runtime deps        │
└─────────────────────────────────────────────────────────────┘`)}
<h2>Key Principles</h2>
<ul>
<li><strong>Contract-first</strong> — <code>@weaveintel/core</code> defines every interface. No package imports a concrete implementation.</li>
<li><strong>Dependency injection</strong> — engines, registries, and resolvers accept their dependencies. Nothing is a singleton.</li>
<li><strong>Composable</strong> — install one package or all. Each works standalone.</li>
<li><strong>TypeScript-native</strong> — strict types throughout, zero <code>any</code> in public API.</li>
</ul>`;
}

function sAgents(): string {
  return `
<div class="pkg-header">
  <div class="pkg-badge">@weaveintel/agents</div>
  <div class="pkg-title">Agents</div>
  <div class="pkg-desc">Build tool-calling agents, supervisor hierarchies, and worker delegation systems with a single composable API.</div>
</div>
${callout('info', 'When to use', 'Use <code>@weaveintel/agents</code> when you need an LLM to autonomously decide which tools to call (ReAct loop), or to orchestrate sub-agents via a supervisor pattern.')}
<h2 id="weave-agent">weaveAgent — Single Agent</h2>
<p>Creates a ReAct-style tool-calling agent. The agent loops: think → call tool → observe → repeat, until a final answer or <code>maxSteps</code> is reached.</p>
${code('typescript', `import { weaveAgent } from '@weaveintel/agents';

const agent = weaveAgent({
  name: 'research-agent',
  model,                          // any Model from @weaveintel/core
  tools,                          // ToolRegistry
  systemPrompt: 'You are a helpful research assistant.',
  maxSteps: 10,
});

const result = await agent.run(ctx, {
  messages: [{ role: 'user', content: 'Summarise the latest AI news.' }],
});
// result.output — final text answer
// result.steps  — AgentStep[] with tool calls and intermediate responses`)}
${params([
  ['model', 'Model', 'required', 'Any Model instance from @weaveintel/models or providers'],
  ['tools', 'ToolRegistry', 'optional', 'Registry of tools the agent can call'],
  ['workers', 'WorkerDefinition[]', 'optional', 'Enables supervisor mode — agent gets delegate_to_worker tool'],
  ['systemPrompt', 'string', 'optional', 'System instructions prepended to every request'],
  ['maxSteps', 'number', 'optional', 'Maximum tool-call iterations. Default: 20'],
  ['name', 'string', 'optional', 'Agent name for tracing and delegation'],
  ['bus', 'EventBus', 'optional', 'Event bus for step-level observability'],
  ['memory', 'AgentMemory', 'optional', 'Attach a memory store for cross-session context'],
])}
<h2 id="supervisor">Supervisor Mode</h2>
<p>Pass <code>workers</code> to enable supervisor mode. The supervisor gets <code>delegate_to_worker</code>, <code>think</code>, and <code>plan</code> tools automatically. Each worker is an independent agent with its own model and tool registry.</p>
${code('typescript', `import { weaveAgent } from '@weaveintel/agents';
import type { WorkerDefinition } from '@weaveintel/agents';

const plannerWorker: WorkerDefinition = {
  name: 'planner',
  description: 'Builds step-by-step execution plans from a goal.',
  model: plannerModel,
  tools: plannerTools,
  maxSteps: 8,
};

const supervisor = weaveAgent({
  name: 'supervisor',
  model: supervisorModel,
  workers: [plannerWorker, researchWorker],
  systemPrompt: 'Delegate tasks to specialist workers. Synthesise their results.',
  maxSteps: 6,
});

const result = await supervisor.run(ctx, {
  messages: [{ role: 'user', content: 'Research and plan a launch strategy.' }],
});`)}
<h2 id="workers">WorkerDefinition</h2>
${params([
  ['name', 'string', 'required', 'Worker identifier used in delegate_to_worker calls'],
  ['description', 'string', 'required', 'What this worker specialises in — the supervisor sees this'],
  ['model', 'Model', 'required', 'Independent model for this worker'],
  ['tools', 'ToolRegistry', 'optional', 'Tools this worker can use'],
  ['maxSteps', 'number', 'optional', 'Step limit for this worker. Default: 10'],
])}
<h2 id="tools-in-agents">Tool Binding</h2>
${code('typescript', `import { weaveToolRegistry, weaveTool } from '@weaveintel/core';

const tools = weaveToolRegistry();
tools.register(weaveTool({
  name: 'search_web',
  description: 'Search the web and return top results.',
  parameters: {
    type: 'object', required: ['query'],
    properties: {
      query: { type: 'string' },
      limit: { type: 'number' },
    },
  },
  execute: async ({ query, limit = 5 }, ctx) => {
    const results = await searchProvider.search(query, limit);
    return JSON.stringify(results);
  },
}));`)}
${callout('tip', 'Tool output format.', 'Tools must return a <code>string</code> or <code>ToolOutput</code>. JSON-stringify structured data before returning.')}`;
}

function sWorkflows(): string {
  return `
<div class="pkg-header">
  <div class="pkg-badge">@weaveintel/workflows</div>
  <div class="pkg-title">Workflows</div>
  <div class="pkg-desc">Durable, deterministic workflow orchestration. Steps are checkpointed, retried, and resumed across process restarts. Supports human-in-the-loop, parallel branches, dynamic sub-graphs, and governance.</div>
</div>
${callout('info', 'When to use', 'Use workflows when you need <strong>durability</strong> (survive restarts), <strong>determinism</strong>, <strong>auditability</strong> (step history), or <strong>human approval gates</strong>.')}
<div style="margin:16px 0">
  <span class="phase-chip">W1 Control Flow</span>
  <span class="phase-chip">W2 Reliability</span>
  <span class="phase-chip">W3 Data</span>
  <span class="phase-chip">W4 Durability</span>
  <span class="phase-chip">W5 Governance</span>
  <span class="phase-chip">W6 Observability</span>
  <span class="phase-chip">W7 Dynamic Graphs</span>
</div>
<h2>Engine Setup</h2>
${code('typescript', `import { DefaultWorkflowEngine } from '@weaveintel/workflows';
import { InMemoryWorkflowRunRepository, InMemoryCheckpointStore } from '@weaveintel/workflows';

const engine = new DefaultWorkflowEngine({
  runRepository:   new InMemoryWorkflowRunRepository(),
  checkpointStore: new InMemoryCheckpointStore(),
  defaultPolicy: {
    maxSteps: 50,
    costCeiling: 10,
    maxExpansionDepth: 3,
  },
});`)}
<h2 id="step-types">Step Types</h2>
<table class="param-table">
<thead><tr><th>Type</th><th>When to use</th><th>Key config</th></tr></thead>
<tbody>
<tr><td><code>deterministic</code></td><td>Pure computation, API calls, data transforms</td><td>handler, next</td></tr>
<tr><td><code>agentic</code></td><td>LLM-driven steps with variable output</td><td>handler, next</td></tr>
<tr><td><code>condition</code></td><td>True/false branching on handler boolean output</td><td>next: [trueBranch, falseBranch]</td></tr>
<tr><td><code>switch</code></td><td>Multi-case routing by string key returned from handler</td><td>config.cases: Record&lt;key, stepId&gt;</td></tr>
<tr><td><code>forEach</code></td><td>Iterate handler output array with optional concurrency</td><td>handler, bodyHandler, maxConcurrency</td></tr>
<tr><td><code>parallel</code></td><td>Concurrent named handlers; results keyed by lane name</td><td>config.lanes or config.parallelHandlers</td></tr>
<tr><td><code>fork / join</code></td><td>Fire N branches concurrently, aggregate at join</td><td>fork: config.branches; join: config.forkStepId</td></tr>
<tr><td><code>wait</code></td><td>Pause for external event or human resume</td><td>wakeAfterMs (auto-resume)</td></tr>
<tr><td><code>human-task</code></td><td>Create a human task queue entry, pause for decision</td><td>config.taskType, title, priority</td></tr>
<tr><td><code>dynamic</code></td><td>Handler returns DynamicExpansion — sub-graph spliced at runtime (W7)</td><td>handler, next (rejoin)</td></tr>
</tbody>
</table>
${code('typescript', `const def = defineWorkflow('Order Processing')
  .setId('order-v1')
  .setPolicy({ maxSteps: 30 })
  .addStep({ id: 'validate', name: 'Validate', type: 'deterministic',
             handler: 'validate-order', next: 'classify' })
  .switch('classify', 'Classify Order', {
    handler: 'classify-order',
    cases: { digital: 'process-digital', physical: 'process-physical',
             default: 'process-physical' },
  })
  .parallelLanes('enrich', 'Enrich', {
    lanes: { pricing: 'pricing-handler', inventory: 'inventory-handler' },
    next: 'confirm',
  })
  .humanTask('confirm', 'Manager Approval', {
    taskType: 'approval', title: 'Approve order?', priority: 'high', next: 'fulfill',
  })
  .forEach('fulfill', 'Fulfill Items', {
    handler: 'list-items', bodyHandler: 'fulfill-item', maxConcurrency: 3, next: 'done',
  })
  .addStep({ id: 'done', name: 'Done', type: 'deterministic', handler: 'noop' })
  .build();`)}
<h2 id="resolvers">Handler Resolvers</h2>
<p>The resolver registry maps handler string references (like <code>tool:my-tool</code>) to async functions at runtime. Register once, use in any step.</p>
${code('typescript', `import {
  HandlerResolverRegistry, createNoopResolver, createToolResolver,
  createPromptResolver, createAgentResolver, createMcpResolver,
  createPlannerResolver,
} from '@weaveintel/workflows';

const reg = new HandlerResolverRegistry();
reg.register(createNoopResolver());
reg.register(createToolResolver({
  getTool: async (key) => myToolMap.get(key),
}));
reg.register(createPromptResolver({
  executePrompt: async (key, vars, cfg) => callLLM(key, vars),
}));
reg.register(createPlannerResolver({   // W7 only
  plan: async (goal, context) => myLLM.generateExpansion(goal, context),
}));

const engine = new DefaultWorkflowEngine({ resolverRegistry: reg });`)}
<h2 id="governance">Governance — Per-Step Controls</h2>
${code('typescript', `const def = defineWorkflow('Resilient Pipeline')
  .addStep({
    id: 'call-api',
    name: 'Call API',
    type: 'deterministic',
    handler: 'call-api',
    retries: 3,
    retryDelayMs: 500,
    retryBackoffMultiplier: 2,
    retryMaxDelayMs: 10000,
    retryJitter: true,
    timeout: 5000,
    fallbackHandler: 'use-cache',
    onError: 'error-step',
    skipIf: '{{vars.skip_api}}',
  })
  .build();`)}
<h2 id="dynamic">Dynamic Graphs (Phase W7)</h2>
<p>A <code>dynamic</code> step returns a <code>DynamicExpansion</code>. The engine validates, splices it into the live run, routes to <code>entry</code>, and rejoins at <code>rejoin</code> when the sub-graph terminates.</p>
${code('typescript', `import type { DynamicExpansion } from '@weaveintel/core';

engine.registerHandler('ai-planner', async (vars) => {
  const items = vars['items'] as string[];
  const expansion: DynamicExpansion = {
    steps: items.map((item, i) => ({
      id: \`process-\${i}\`,
      name: \`Process \${item}\`,
      type: 'deterministic',
      handler: 'item-processor',
    })),
    entry: 'process-0',
    rejoin: 'summarise',
  };
  return expansion;
});

const def = defineWorkflow('Data-Driven')
  .dynamic('plan', 'Plan Steps', { handler: 'ai-planner', next: 'summarise' })
  .addStep({ id: 'summarise', name: 'Summarise', type: 'deterministic', handler: 'summarise' })
  .build();`)}
${callout('warn', 'Governance validation.', 'Every DynamicExpansion is checked: <code>MAX_EXPANSION_DEPTH</code>, <code>MAX_GENERATED_STEPS</code>, <code>ID_COLLISION</code>, <code>DISALLOWED_HANDLER_KIND</code>, <code>LINT_ERROR</code>. Throws <code>WorkflowExpansionError</code> on violation.')}
<h2 id="persistence">File-Backed Persistence</h2>
${code('typescript', `import {
  JsonFileWorkflowRunRepository,
  JsonFileCheckpointStore,
} from '@weaveintel/workflows';

const engine = new DefaultWorkflowEngine({
  runRepository:   new JsonFileWorkflowRunRepository('./data/runs.json'),
  checkpointStore: new JsonFileCheckpointStore('./data/checkpoints.json'),
});

// Resume a paused run after process restart
const run = await engine.resumeRun(runId, { decision: 'approved' });`)}
<h2 id="policy">WorkflowPolicy</h2>
${params([
  ['maxSteps', 'number', 'optional', 'Hard cap on total steps per run. Default: 100'],
  ['costCeiling', 'number', 'optional', 'USD ceiling. Run fails if cumulative cost exceeds this'],
  ['maxExpansionDepth', 'number', 'optional', 'W7: max dynamic graph nesting depth. Default: 5'],
  ['maxGeneratedSteps', 'number', 'optional', 'W7: total dynamic steps per run budget'],
  ['dynamicHandlerKinds', 'string[]', 'optional', "W7: allowed resolver kinds in generated steps. Default: ['noop','tool','prompt','agent','mcp']"],
  ['maxConcurrentRuns', 'number', 'optional', 'Max concurrent runs per workflow definition'],
])}`;
}

function sModels(): string {
  return `
<div class="pkg-header">
  <div class="pkg-badge">@weaveintel/models</div>
  <div class="pkg-title">Models</div>
  <div class="pkg-desc">Provider-agnostic model registration and routing. Supports text, embedding, image, and audio models from any provider.</div>
</div>
<h2 id="register">Registration</h2>
${code('typescript', `import { weaveRegisterModel, weaveGetModel } from '@weaveintel/models';
import { weaveAnthropicModel } from '@weaveintel/provider-anthropic';

weaveRegisterModel('fast',  weaveAnthropicModel('claude-haiku-4-5-20251001'));
weaveRegisterModel('smart', weaveAnthropicModel('claude-sonnet-4-6'));

const model = weaveGetModel('fast');
const result = await model.generate({ messages: [...] });`)}
<h2 id="routing">Smart Routing</h2>
${code('typescript', `import { weaveSelectModel } from '@weaveintel/models';

const model = weaveSelectModel({
  capabilities: ['tool_calling', 'vision'],
  maxCostPerMToken: 0.5,
  preferredProvider: 'anthropic',
});`)}
<h2 id="providers">Supported Providers</h2>
<table class="param-table">
<thead><tr><th>Package</th><th>Function</th><th>Models</th></tr></thead>
<tbody>
<tr><td><code>@weaveintel/provider-anthropic</code></td><td><code>weaveAnthropicModel(id)</code></td><td>claude-haiku, sonnet, opus</td></tr>
<tr><td><code>@weaveintel/provider-openai</code></td><td><code>weaveOpenAIModel(id)</code></td><td>gpt-4o, gpt-4-turbo, o1</td></tr>
<tr><td><code>@weaveintel/provider-google</code></td><td><code>weaveGoogleModel(id)</code></td><td>gemini-pro, gemini-flash</td></tr>
<tr><td><code>@weaveintel/provider-ollama</code></td><td><code>weaveOllamaModel(id)</code></td><td>Any Ollama-hosted model</td></tr>
<tr><td><code>@weaveintel/provider-llamacpp</code></td><td><code>weaveLlamacppModel(id)</code></td><td>Local GGUF models</td></tr>
</tbody>
</table>`;
}

function sPrompts(): string {
  return `
<div class="pkg-header">
  <div class="pkg-badge">@weaveintel/prompts</div>
  <div class="pkg-title">Prompts</div>
  <div class="pkg-desc">Version-controlled prompt management with rendering, output contract validation, A/B experiments, and quality evaluation.</div>
</div>
<h2 id="registry">Prompt Registry</h2>
${code('typescript', `import { InMemoryPromptRegistry } from '@weaveintel/prompts';

const registry = new InMemoryPromptRegistry();
registry.register({
  key: 'summarise-article',
  version: '1.0.0',
  template: 'Summarise the following article in {{maxWords}} words:\\n\\n{{article}}',
  variables: { maxWords: 'number', article: 'string' },
  tags: ['summarisation'],
});`)}
<h2 id="rendering">Rendering</h2>
${code('typescript', `import { renderPromptVersion } from '@weaveintel/prompts';

const rendered = renderPromptVersion(promptVersion, {
  maxWords: 200,
  article: articleText,
});
// Returns string with all {{variables}} substituted`)}
<h2 id="contracts">Output Contracts</h2>
${code('typescript', `import { createContract, DefaultCompletionValidator } from '@weaveintel/contracts';

const contract = createContract({
  type: 'JSON',
  schema: { type: 'object', required: ['summary', 'sentiment'] },
});

const validator = new DefaultCompletionValidator();
const result = await validator.validate(llmOutput, contract);
if (!result.valid) {
  // result.errors — validation failures
  // validator can attempt to repair malformed JSON
}`)}
<h2 id="frameworks">Prompt Frameworks</h2>
<table class="param-table">
<thead><tr><th>Framework</th><th>Purpose</th></tr></thead>
<tbody>
<tr><td><code>RTCE</code></td><td>Role + Task + Context + Examples — structured system prompts</td></tr>
<tr><td><code>FULL</code></td><td>All structured prompt fields in one template</td></tr>
<tr><td><code>CRITIQUE</code></td><td>Self-critique loop for iterative quality improvement</td></tr>
<tr><td><code>JUDGE</code></td><td>LLM-as-judge evaluation template</td></tr>
</tbody>
</table>`;
}

function sMemory(): string {
  return `
<div class="pkg-header">
  <div class="pkg-badge">@weaveintel/memory</div>
  <div class="pkg-title">Memory</div>
  <div class="pkg-desc">Multi-type memory store with semantic search, automatic extraction from conversations, and pluggable backends (Postgres, Redis, SQLite, MongoDB).</div>
</div>
${callout('info', 'When to use', 'Give agents long-term memory: remember facts about users, past decisions, retrieved documents, or working state across sessions.')}
<h2 id="types">Memory Types</h2>
<div class="feature-grid">
  ${featureCard('Conversation', 'Stores full message history with compression and windowing')}
  ${featureCard('Semantic', 'Vector-indexed memories searchable by meaning, not just keywords')}
  ${featureCard('Entity', 'Structured facts about named entities (people, places, products)')}
  ${featureCard('Working', 'Ephemeral scratch-pad for in-progress task state')}
</div>
${code('typescript', `import { weaveSemanticMemory, weaveMemoryStore } from '@weaveintel/memory';

const memory = weaveSemanticMemory({
  embeddingModel,
  store: weaveMemoryStore({ backend: 'sqlite', path: './memory.db' }),
  extractionPolicy: { minConfidence: 0.7, maxMemoriesPerTurn: 5 },
});

await memory.add({
  content: 'User prefers concise responses under 200 words.',
  tags: ['preference', 'style'],
  userId: 'alice',
});

const memories = await memory.search('response style', {
  userId: 'alice', limit: 5, minScore: 0.6,
});`)}
<h2 id="extraction">Automatic Extraction</h2>
${code('typescript', `import { weaveConversationMemory } from '@weaveintel/memory';

const convMemory = weaveConversationMemory({
  store: semanticStore,
  extractionRules: [
    { pattern: 'user preference', tags: ['preference'] },
    { pattern: 'user location',   tags: ['location'] },
  ],
  deduplicate: true,
  maxHistory: 50,
});

await convMemory.addMessage({ role: 'user', content: 'I live in Auckland.' });`)}`;
}

function sRetrieval(): string {
  return `
<div class="pkg-header">
  <div class="pkg-badge">@weaveintel/retrieval</div>
  <div class="pkg-title">Retrieval</div>
  <div class="pkg-desc">RAG pipeline: document chunking, embedding, vector indexing, and hybrid dense+keyword search. Integrates with any vector store.</div>
</div>
<h2 id="chunking">Chunking</h2>
${code('typescript', `import { weaveChunker } from '@weaveintel/retrieval';

const chunker = weaveChunker({
  strategy: 'recursive',   // 'fixed' | 'recursive' | 'semantic' | 'markdown'
  chunkSize: 512,          // tokens
  chunkOverlap: 64,
});

const chunks = await chunker.chunk(documentText, { metadata: { source: 'policy.pdf' } });`)}
<h2 id="embedding">Embedding Pipeline</h2>
${code('typescript', `import { weaveEmbeddingPipeline } from '@weaveintel/retrieval';

const pipeline = weaveEmbeddingPipeline({
  embeddingModel,
  vectorStore,
  chunkingOptions: { strategy: 'recursive', chunkSize: 512 },
  batchSize: 100,
});

await pipeline.index({ id: 'doc-001', content: documentText, metadata: { source: 'wiki' } });`)}
<h2 id="hybrid">Hybrid Search</h2>
${code('typescript', `import { weaveHybridRetriever, weaveQueryRewriter } from '@weaveintel/retrieval';

const retriever = weaveHybridRetriever({
  denseRetriever:   vectorStore,
  keywordRetriever: bm25Index,
  fusionMethod: 'rrf',
  weights: { dense: 0.7, keyword: 0.3 },
  topK: 10,
});

const rewriter = weaveQueryRewriter({ model });
const query = await rewriter.rewrite('what is the return policy?');
const results = await retriever.retrieve(query, { limit: 5, minScore: 0.5 });`)}`;
}

function sEvals(): string {
  return `
<div class="pkg-header">
  <div class="pkg-badge">@weaveintel/evals</div>
  <div class="pkg-title">Evals</div>
  <div class="pkg-desc">LLM-as-judge evaluation with rubric scoring, dataset comparison, and weighted aggregation. Run evals inline or as a CI pipeline.</div>
</div>
${code('typescript', `import { weaveEvalRunner } from '@weaveintel/evals';

const runner = weaveEvalRunner({
  judgeModel,
  rubric: [
    { criterion: 'factual_accuracy', weight: 0.4, description: 'Is the answer factually correct?' },
    { criterion: 'conciseness',      weight: 0.3, description: 'Is the answer appropriately brief?' },
    { criterion: 'helpfulness',      weight: 0.3, description: 'Does it address the user need?' },
  ],
});

const cases = [
  { input: { question: 'What is the capital of France?' }, expected: 'Paris' },
];

const results = await runner.run(cases, async (input) => {
  return await myAgent.answer(input.question);
});

// results[0].scores  — { factual_accuracy: 0.95, ... }
// results[0].overall — 0.886 (weighted average)`)}`;
}

function sGuardrails(): string {
  return `
<div class="pkg-header">
  <div class="pkg-badge">@weaveintel/guardrails</div>
  <div class="pkg-title">Guardrails</div>
  <div class="pkg-desc">Pre- and post-execution safety pipeline: risk classification, confidence gating, PII detection, cost guards, and action-level controls.</div>
</div>
${callout('warn', 'Defence in depth.', 'Guardrails are a runtime safety net, not a replacement for careful prompt engineering.')}
${code('typescript', `import { createGuardrailPipeline, DefaultRiskClassifier,
         DefaultConfidenceGate, CostGuard } from '@weaveintel/guardrails';

const pipeline = createGuardrailPipeline({
  preChecks: [
    new DefaultRiskClassifier({
      rules: [
        { pattern: /credit.card/i, category: 'pii',       action: 'deny' },
        { pattern: /sql.*drop/i,   category: 'injection', action: 'deny' },
      ],
    }),
  ],
  postChecks: [
    new DefaultConfidenceGate({ minConfidence: 0.7 }),
    new CostGuard({ maxCostUsd: 0.10 }),
  ],
});

const preResult = await pipeline.evaluate(userInput, 'pre-execution', { userId });
if (preResult.action === 'deny') return { error: preResult.reason };

const response = await model.generate({ messages });
const postResult = await pipeline.evaluate(response.content, 'post-execution', { userId });`)}`;
}

function sResilience(): string {
  return `
<div class="pkg-header">
  <div class="pkg-badge">@weaveintel/resilience</div>
  <div class="pkg-title">Resilience</div>
  <div class="pkg-desc">Token bucket rate limiting, circuit breaker, concurrency limiter, and retry with exponential backoff — composable for any async function.</div>
</div>
<h2>All-in-One: runResilient</h2>
${code('typescript', `import { runResilient } from '@weaveintel/resilience';

const result = await runResilient(
  'anthropic-api',
  () => model.generate({ messages }),
  {
    tokenBucket: { capacity: 60, refillRate: 60 },
    circuitBreaker: { failureThreshold: 5, successThreshold: 2, timeout: 30000 },
    retry: { maxAttempts: 3, initialDelayMs: 500, backoffMultiplier: 2 },
    concurrency: { maxConcurrent: 10 },
  }
);`)}
<h2>Individual Primitives</h2>
${code('typescript', `import { createTokenBucket, createCircuitBreaker } from '@weaveintel/resilience';

const bucket  = createTokenBucket({ capacity: 100, refillRate: 60 });
const breaker = createCircuitBreaker({ failureThreshold: 5, timeout: 30000 });

if (!await bucket.consume(1)) throw new Error('Rate limited');
if (!breaker.canExecute())    throw new Error('Circuit open');

try {
  const result = await callExternalService();
  breaker.recordSuccess();
  return result;
} catch (e) {
  breaker.recordFailure();
  throw e;
}`)}`;
}

function sReliability(): string {
  return `
<div class="pkg-header">
  <div class="pkg-badge">@weaveintel/reliability</div>
  <div class="pkg-title">Reliability</div>
  <div class="pkg-desc">Idempotency tracking, retry budget enforcement, dead-letter queues, and health checks for long-running systems.</div>
</div>
${callout('info', 'Reliability vs Resilience.', '<code>resilience</code> is call-level (rate limits, circuit breakers). <code>reliability</code> is system-level (idempotency, dead letters, health checks).')}
${code('typescript', `import { createIdempotencyPolicy } from '@weaveintel/reliability';

const policy = createIdempotencyPolicy({
  store: redisStore,
  ttlSeconds: 3600,
});

// Deduplicates based on the key — returns cached result on repeat calls
const result = await policy.executeOnce(
  idempotencyKey,
  () => processPayment(amount),
);`)}`;
}

function sCostGovernor(): string {
  return `
<div class="pkg-header">
  <div class="pkg-badge">@weaveintel/cost-governor</div>
  <div class="pkg-title">Cost Governor</div>
  <div class="pkg-desc">8-lever cost optimisation that wraps models and tools with budget enforcement, tier-based policies, and automatic cost reduction strategies.</div>
</div>
<h2>8 Cost Levers</h2>
<table class="param-table">
<thead><tr><th>Lever</th><th>Strategy</th><th>Typical Savings</th></tr></thead>
<tbody>
<tr><td>L1 Model Cascade</td><td>Try cheaper model first, escalate on low confidence</td><td>40–70%</td></tr>
<tr><td>L2 Tool Subset</td><td>Only expose relevant tools via intent-based RAG</td><td>10–30%</td></tr>
<tr><td>L3 Prompt Caching</td><td>Reuse cached prefixes for repeated system prompts</td><td>15–25%</td></tr>
<tr><td>L4 Intel Gating</td><td>Skip expensive enrichment for simple queries</td><td>20–40%</td></tr>
<tr><td>L5 History Compaction</td><td>Summarise old messages to reduce context tokens</td><td>20–50%</td></tr>
<tr><td>L6 Max Steps</td><td>Cap agent tool-call iterations per tier</td><td>Variable</td></tr>
<tr><td>L7 Reasoning Effort</td><td>Reduce thinking tokens for simple queries</td><td>10–40%</td></tr>
<tr><td>L8 Output Truncation</td><td>Cap response length by tier</td><td>5–20%</td></tr>
</tbody>
</table>
${code('typescript', `import { weaveCostGovernor } from '@weaveintel/cost-governor';

const governor = weaveCostGovernor({
  policy: {
    tiers: [
      { name: 'free',       monthlyBudgetUsd: 5,   levers: ['L1','L2','L5','L6'] },
      { name: 'pro',        monthlyBudgetUsd: 50,  levers: ['L3','L4'] },
      { name: 'enterprise', monthlyBudgetUsd: 500, levers: [] },
    ],
    defaultTier: 'free',
    escalation: { threshold: 0.8, action: 'downgrade-model' },
  },
  modelCascade: [
    { model: 'fast',  costPerMToken: 0.25 },
    { model: 'smart', costPerMToken: 3.00 },
  ],
});

const governedModel = governor.wrapModel(model, { userId, tier: 'pro' });
const result = await governedModel.generate({ messages });`)}`;
}

function sTools(): string {
  return `
<div class="pkg-header">
  <div class="pkg-badge">@weaveintel/tools</div>
  <div class="pkg-title">Tool Framework</div>
  <div class="pkg-desc">Policy enforcement, audit logging, approval gates, rate limiting, and health tracking for any tool. Wraps existing tools without modifying them.</div>
</div>
${code('typescript', `import { createPolicyEnforcedRegistry } from '@weaveintel/tools';
import { weaveToolRegistry } from '@weaveintel/core';

const base = weaveToolRegistry();
base.register(fetchTool);
base.register(writeTool);

const enforced = createPolicyEnforcedRegistry(base, {
  allowedTools: ['fetch_page', 'search_web'],
  rateLimit: { maxPerMinute: 30, maxPerHour: 500 },
  requireApproval: ['write_file', 'delete_file'],
  networkGuard: { blockPrivateIps: true },
}, {
  auditEmitter: myAuditLog,
  approvalGate: myApprovalGate,
});`)}
${code('typescript', `import { weaveHealthTracker } from '@weaveintel/tools';

const tracker = weaveHealthTracker({ windowMs: 60_000 });
tracker.record('fetch_page', { success: true, latencyMs: 120 });

const health = tracker.getHealth('fetch_page');
// { successRate: 0.98, avgLatencyMs: 125, recentErrors: [] }`)}`;
}

function sToolsTime(): string {
  return `
<div class="pkg-header">
  <div class="pkg-badge">@weaveintel/tools-time</div>
  <div class="pkg-title">tools-time</div>
  <div class="pkg-desc">16 time-aware tools: datetime, timezone conversion, timers, stopwatches, and reminders. Stateful with a pluggable TemporalStore backend.</div>
</div>
${code('typescript', `import { createTimeTools, createInMemoryTemporalStore } from '@weaveintel/tools-time';

const tools = createTimeTools({
  defaultTimezone: 'Pacific/Auckland',
  locale: 'en-NZ',
  store: createInMemoryTemporalStore(),
});

// tools is Tool[] — register on any ToolRegistry
agentTools.registerAll(tools);`)}
<h2>Included Tools</h2>
<table class="param-table">
<thead><tr><th>Tool</th><th>Description</th></tr></thead>
<tbody>
<tr><td><code>datetime</code></td><td>Current date/time in any timezone and format</td></tr>
<tr><td><code>timezone_info</code></td><td>UTC offset, DST, locale info for a timezone</td></tr>
<tr><td><code>datetime_add</code></td><td>Add/subtract duration to a datetime</td></tr>
<tr><td><code>timer_start / timer_stop / timer_check</code></td><td>Named countdown timers with state persistence</td></tr>
<tr><td><code>stopwatch_start / stopwatch_stop / stopwatch_lap</code></td><td>Named stopwatches with lap tracking</td></tr>
<tr><td><code>reminder_set / reminder_list / reminder_cancel</code></td><td>Scheduled reminders stored in TemporalStore</td></tr>
</tbody>
</table>`;
}

function sToolsBrowser(): string {
  return `
<div class="pkg-header">
  <div class="pkg-badge">@weaveintel/tools-browser</div>
  <div class="pkg-title">tools-browser</div>
  <div class="pkg-desc">Web fetching, content extraction, scraping, and Playwright-powered browser automation with session pooling and OAuth authentication.</div>
</div>
${code('typescript', `import { createBrowserTools, createAutomationTools } from '@weaveintel/tools-browser';

const webTools = createBrowserTools({
  allowedDomains: ['example.com'],
  userAgent: 'MyBot/1.0',
  timeout: 10000,
});

const automationTools = createAutomationTools({
  headless: true,
  poolSize: 3,
  sessionTimeout: 60000,
});`)}
<h2>Included Tools</h2>
<table class="param-table">
<thead><tr><th>Tool</th><th>Description</th></tr></thead>
<tbody>
<tr><td><code>fetch_page</code></td><td>Fetch and return page HTML or text content</td></tr>
<tr><td><code>extract_content</code></td><td>Extract readable article text via Mozilla Readability</td></tr>
<tr><td><code>scrape_elements</code></td><td>CSS-selector-based element scraping</td></tr>
<tr><td><code>screenshot</code></td><td>Capture full-page screenshot as base64</td></tr>
<tr><td><code>browser_navigate / browser_click / browser_fill</code></td><td>Playwright-driven automation actions</td></tr>
</tbody>
</table>`;
}

function sToolsHttp(): string {
  return `
<div class="pkg-header">
  <div class="pkg-badge">@weaveintel/tools-http</div>
  <div class="pkg-title">tools-http</div>
  <div class="pkg-desc">Configurable HTTP endpoint tools with auth (API key, OAuth, Bearer), retry, and per-endpoint parameter schemas.</div>
</div>
${code('typescript', `import { weaveHttpTools } from '@weaveintel/tools-http';

const tools = weaveHttpTools([
  {
    name: 'get_customer',
    description: 'Fetch a customer record by ID.',
    url: 'https://api.crm.example.com/customers/{{customerId}}',
    method: 'GET',
    auth: { type: 'bearer', tokenEnv: 'CRM_API_KEY' },
    retry: { maxAttempts: 3, initialDelayMs: 300 },
    rateLimit: { maxPerMinute: 60 },
    parameters: {
      type: 'object', required: ['customerId'],
      properties: { customerId: { type: 'string' } },
    },
  },
]);`)}`;
}

function sToolsSearch(): string {
  return `
<div class="pkg-header">
  <div class="pkg-badge">@weaveintel/tools-search</div>
  <div class="pkg-title">tools-search</div>
  <div class="pkg-desc">Multi-provider web search with automatic failover. Supports DuckDuckGo (free), Brave, Tavily, Google PSE, Bing, SearXNG, Jina, Exa, and Serper.</div>
</div>
${code('typescript', `import { weaveSearchRouter, BraveSearchProvider,
         DuckDuckGoProvider, TavilyProvider } from '@weaveintel/tools-search';

const router = weaveSearchRouter([
  new BraveSearchProvider({ apiKey: process.env.BRAVE_KEY! }),
  new TavilyProvider({ apiKey: process.env.TAVILY_KEY! }),
  new DuckDuckGoProvider(),  // fallback — no API key needed
], {
  strategy: 'health-first',  // routes to healthiest provider automatically
  timeout: 5000,
});

// Returns Tool[] — register on your agent
const [searchTool] = router.asTools();`)}`;
}

function sToolsNews(): string {
  return `
<div class="pkg-header">
  <div class="pkg-badge">@weaveintel/tools-news</div>
  <div class="pkg-title">tools-news</div>
  <div class="pkg-desc">Market and financial news via Finnhub, Financial Modelling Prep (FMP), or local fixtures for testing without API keys.</div>
</div>
${code('typescript', `import { createNewsMCPServer } from '@weaveintel/tools-news';
import { finnhubAdapter, fixtureAdapter } from '@weaveintel/tools-news/adapters';

const server = createNewsMCPServer({
  adapter: process.env.FINNHUB_KEY
    ? finnhubAdapter({ apiKey: process.env.FINNHUB_KEY })
    : fixtureAdapter(),   // ← use local fixtures when no API key
});

await server.start({ port: 3001 });
// Exposes: get_market_news, get_company_news, get_earnings_transcript`)}`;
}

function sMcp(): string {
  return `
<div class="pkg-header">
  <div class="pkg-badge">@weaveintel/mcp-client · @weaveintel/mcp-server</div>
  <div class="pkg-title">MCP Integration</div>
  <div class="pkg-desc">Model Context Protocol client and server. Connect to any MCP server as a tool source, or expose WeaveIntel tools to any MCP-compatible host.</div>
</div>
<h2 id="client">MCP Client</h2>
${code('typescript', `import { weaveMCPClient, weaveMCPTools,
         createMCPStdioClientTransport } from '@weaveintel/mcp-client';

// Connect to a stdio MCP server (subprocess)
const transport = createMCPStdioClientTransport({
  command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/data'],
});

const client = await weaveMCPClient(transport);
const mcpTools = await weaveMCPTools(client);

// Use mcpTools like any ToolRegistry
const agent = weaveAgent({ model, tools: mcpTools });`)}
<h2 id="server">MCP Server</h2>
${code('typescript', `import { weaveMCPServer } from '@weaveintel/mcp-server';

const server = weaveMCPServer({
  name: 'my-toolserver',
  version: '1.0.0',
  tools: myToolRegistry,
});

await server.startHTTP({ port: 3000, path: '/mcp' });
// Or: await server.startStdio();`)}`;
}

function sObservability(): string {
  return `
<div class="pkg-header">
  <div class="pkg-badge">@weaveintel/observability</div>
  <div class="pkg-title">Observability</div>
  <div class="pkg-desc">Distributed tracing, usage tracking, budget monitoring, trace graphs, and run timelines for agents and workflows.</div>
</div>
${code('typescript', `import { weaveInMemoryTracer, weaveUsageTracker, weaveBudgetTracker } from '@weaveintel/observability';

const tracer = weaveInMemoryTracer();

// Attach to an agent via its event bus
const agent = weaveAgent({ model, tools, bus: tracer.bus });
await agent.run(ctx, { messages });

const spans = tracer.getSpans(ctx.traceId);
// spans[0].name, spans[0].startMs, spans[0].durationMs`)}
${code('typescript', `const budget = weaveBudgetTracker({
  monthlyBudgetUsd: 100,
  alertThresholds: [0.5, 0.8, 0.95],
  onAlert: (threshold, spent) => notify(\`\${Math.round(threshold * 100)}% budget used: $\${spent.toFixed(2)}\`),
});`)}`;
}

function sSandbox(): string {
  return `
<div class="pkg-header">
  <div class="pkg-badge">@weaveintel/sandbox</div>
  <div class="pkg-title">Sandbox</div>
  <div class="pkg-desc">Safe execution of LLM-generated code. In-process VM with resource limits, or container-based isolation for stronger guarantees.</div>
</div>
${callout('warn', 'Security note.', 'In-process mode provides meaningful isolation but is not suitable for adversarial untrusted code. Use container mode for that.')}
${code('typescript', `import { createSandbox } from '@weaveintel/sandbox';

const sandbox = createSandbox({
  mode: 'in-process',        // or 'container'
  limits: {
    timeoutMs: 5000,
    memoryMb: 128,
    allowedModules: ['math'],
  },
  policy: {
    allowNetworkAccess: false,
    allowFileSystem: false,
    allowProcessSpawn: false,
  },
});

const result = await sandbox.execute(\`
  const nums = [1, 2, 3, 4, 5];
  return nums.reduce((sum, n) => sum + n, 0);
\`);
// result.output     — 15
// result.durationMs — execution time
// result.memoryUsedMb`)}`;
}

function sCore(): string {
  return `
<div class="pkg-header">
  <div class="pkg-badge">@weaveintel/core</div>
  <div class="pkg-title">@weaveintel/core</div>
  <div class="pkg-desc">Zero-dependency contract layer. Defines every interface — Model, Tool, Memory, EventBus, ExecutionContext, Agent. All other packages depend on this; none import concrete implementations.</div>
</div>
${callout('info', 'Import contracts, not implementations.', 'Core defines <em>interfaces</em>. Use the three utility functions it exports: <code>weaveContext()</code>, <code>weaveTool()</code>, <code>weaveToolRegistry()</code>.')}
<h2 id="context">ExecutionContext</h2>
${code('typescript', `import { weaveContext } from '@weaveintel/core';

const ctx = weaveContext({
  userId:    'user-123',
  sessionId: 'sess-abc',
  tenantId:  'org-xyz',
  traceId:   'trace-001',
  metadata:  { tier: 'pro' },
});
// ctx is passed to every tool.invoke call`)}
<h2 id="tools-core">Tool Interfaces</h2>
${code('typescript', `import { weaveTool, weaveToolRegistry } from '@weaveintel/core';
import type { Tool, ToolRegistry } from '@weaveintel/core';

const myTool = weaveTool({
  name: 'send_email',
  description: 'Send an email.',
  parameters: {
    type: 'object', required: ['to', 'subject', 'body'],
    properties: {
      to:      { type: 'string' },
      subject: { type: 'string' },
      body:    { type: 'string' },
    },
  },
  requiresApproval: true,
  riskLevel: 'medium',
  tags: ['email', 'communication'],
  execute: async ({ to, subject, body }, ctx) => {
    await emailService.send(to, subject, body);
    return 'Email sent successfully.';
  },
});

const registry = weaveToolRegistry();
registry.register(myTool);`)}
<h2 id="events">EventBus</h2>
${code('typescript', `import { weaveEventBus, EventTypes } from '@weaveintel/core';

const bus = weaveEventBus();

bus.on(EventTypes.AGENT_STEP, (event) => {
  console.log(\`Step: \${event.type}\`);
});

bus.on(EventTypes.MODEL_CALL, (event) => {
  const { inputTokens, outputTokens } = event.usage ?? {};
  console.log(\`Tokens: in=\${inputTokens} out=\${outputTokens}\`);
});`)}
<h2 id="models-core">Model Contract</h2>
${code('typescript', `// Every provider implements this interface
interface Model {
  id: string;
  provider: string;
  capabilities: ModelCapability[];
  generate(req: ModelRequest): Promise<ModelResponse>;
  stream(req: ModelRequest): AsyncIterable<StreamChunk>;
}

interface ModelRequest {
  messages:     Message[];
  tools?:       ToolDefinition[];
  temperature?: number;
  maxTokens?:   number;
  system?:      string;
}

interface ModelResponse {
  content:     string;
  toolCalls?:  ToolCall[];
  usage:       { inputTokens: number; outputTokens: number; totalTokens: number };
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
}`)}`;
}

// ── Build section map ─────────────────────────────────────────────────────

const SECTION_MAP: Record<string, string> = {
  home:         sHome(),
  quickstart:   sQuickstart(),
  architecture: sArchitecture(),
  agents:       sAgents(),
  workflows:    sWorkflows(),
  models:       sModels(),
  prompts:      sPrompts(),
  memory:       sMemory(),
  retrieval:    sRetrieval(),
  evals:        sEvals(),
  guardrails:   sGuardrails(),
  resilience:   sResilience(),
  reliability:  sReliability(),
  'cost-governor': sCostGovernor(),
  tools:        sTools(),
  'tools-time':    sToolsTime(),
  'tools-browser': sToolsBrowser(),
  'tools-http':    sToolsHttp(),
  'tools-search':  sToolsSearch(),
  'tools-news':    sToolsNews(),
  mcp:          sMcp(),
  observability: sObservability(),
  sandbox:      sSandbox(),
  core:         sCore(),
};

export function getDocsHTML(): string {
  const sectionsJson = JSON.stringify(SECTION_MAP).replace(/<\/script>/g, '<\\/script>');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WeaveIntel Developer Documentation</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js"></script>
<style>
:root{--bg:#0f1117;--bg2:#161b27;--bg3:#1e2535;--bg4:#2a3347;--fg:#e8eaf0;--fg2:#9aa3b8;--fg3:#5d6880;--accent:#6c8cf5;--accent2:#4fc3f7;--green:#4caf93;--orange:#f59e0b;--red:#ef4444;--purple:#a78bfa;--border:#2a3347;--radius:10px;--font:'Inter',system-ui,sans-serif;--mono:'JetBrains Mono','Fira Code',monospace;--sidebar:280px;--shadow:0 4px 24px rgba(0,0,0,.4)}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--font);background:var(--bg);color:var(--fg);line-height:1.65;font-size:15px;display:flex;flex-direction:column;min-height:100vh}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.topbar{height:52px;background:var(--bg2);border-bottom:1px solid var(--border);display:flex;align-items:center;padding:0 20px;gap:16px;position:sticky;top:0;z-index:100;flex-shrink:0}
.topbar-logo{font-weight:700;font-size:16px;color:var(--fg);display:flex;align-items:center;gap:8px}
.topbar-logo .brand{background:linear-gradient(135deg,var(--accent),var(--accent2));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.breadcrumbs{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--fg3);flex:1}
.breadcrumbs .sep{color:var(--fg3)}
.breadcrumbs a,.breadcrumbs span{color:var(--fg2);cursor:pointer}
.breadcrumbs a:hover{color:var(--accent)}
.breadcrumbs .current{color:var(--fg);font-weight:500}
.search-wrap{margin-left:auto;position:relative}
.search-wrap input{background:var(--bg3);border:1px solid var(--border);border-radius:8px;color:var(--fg);padding:7px 12px 7px 32px;font-size:13px;width:220px;outline:none;transition:width .2s,border-color .2s}
.search-wrap input:focus{border-color:var(--accent);width:280px}
.search-wrap .ico{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--fg3)}
.layout{display:flex;flex:1;overflow:hidden;height:calc(100vh - 52px)}
.sidebar{width:var(--sidebar);background:var(--bg2);border-right:1px solid var(--border);overflow-y:auto;flex-shrink:0;padding:12px 0}
.sidebar::-webkit-scrollbar{width:3px}.sidebar::-webkit-scrollbar-thumb{background:var(--border)}
.sg{padding:8px 16px 4px;font-size:10px;font-weight:700;letter-spacing:.08em;color:var(--fg3);text-transform:uppercase}
.si{display:flex;align-items:center;gap:8px;padding:7px 16px;font-size:13px;color:var(--fg2);cursor:pointer;transition:all .12s;border-left:2px solid transparent}
.si:hover{background:var(--bg3);color:var(--fg)}
.si.active{color:var(--accent);background:rgba(108,140,245,.08);border-left-color:var(--accent);font-weight:500}
.sub .si{font-size:12px;padding:5px 16px 5px 28px}
.main{flex:1;overflow-y:auto;padding:40px 48px}
.main::-webkit-scrollbar{width:5px}.main::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
.pkg-header{margin-bottom:28px;padding-bottom:18px;border-bottom:1px solid var(--border)}
.pkg-badge{display:inline-flex;background:rgba(108,140,245,.12);border:1px solid rgba(108,140,245,.25);color:var(--accent);border-radius:6px;padding:4px 10px;font-size:11px;font-weight:600;font-family:var(--mono);margin-bottom:10px}
.pkg-title{font-size:28px;font-weight:700;color:var(--fg);margin-bottom:8px}
.pkg-desc{font-size:15px;color:var(--fg2);line-height:1.6;max-width:680px}
.callout{border-radius:var(--radius);padding:13px 17px;margin:18px 0;border-left:3px solid;font-size:14px;line-height:1.6}
.callout.info{background:rgba(79,195,247,.05);border-color:var(--accent2);color:var(--fg2)}
.callout.tip{background:rgba(76,175,147,.05);border-color:var(--green);color:var(--fg2)}
.callout.warn{background:rgba(245,158,11,.05);border-color:var(--orange);color:var(--fg2)}
.callout strong{color:var(--fg)}
.callout code{font-family:var(--mono);font-size:12px;background:var(--bg3);padding:1px 5px;border-radius:4px}
h2{font-size:20px;font-weight:700;color:var(--fg);margin:32px 0 12px;display:flex;align-items:center;gap:10px}
h2::before{content:'';display:inline-block;width:3px;height:20px;background:linear-gradient(180deg,var(--accent),var(--accent2));border-radius:2px;flex-shrink:0}
h3{font-size:16px;font-weight:600;color:var(--fg);margin:24px 0 8px}
h4{font-size:13px;font-weight:600;color:var(--fg2);margin:18px 0 6px;text-transform:uppercase;letter-spacing:.05em}
p{color:var(--fg2);margin-bottom:12px;line-height:1.7}
ul,ol{color:var(--fg2);padding-left:20px;margin-bottom:12px}
li{margin-bottom:4px;line-height:1.6}
li code,p code,td code{font-family:var(--mono);font-size:12px;background:var(--bg3);border:1px solid var(--border);padding:1px 6px;border-radius:4px;color:var(--accent2)}
strong{color:var(--fg);font-weight:600}
.code-block{position:relative;margin:14px 0 22px;border-radius:var(--radius);overflow:hidden;border:1px solid var(--border)}
.code-header{display:flex;align-items:center;justify-content:space-between;background:var(--bg3);padding:7px 14px;border-bottom:1px solid var(--border)}
.code-lang{font-size:11px;color:var(--fg3);font-family:var(--mono);font-weight:600;text-transform:uppercase;letter-spacing:.06em}
.copy-btn{background:var(--bg4);border:1px solid var(--border);color:var(--fg3);border-radius:5px;padding:3px 10px;font-size:11px;cursor:pointer;transition:all .15s}
.copy-btn:hover{background:var(--bg);color:var(--fg);border-color:var(--accent)}
.copy-btn.ok{color:var(--green);border-color:var(--green)}
.code-block pre{margin:0;padding:16px;overflow-x:auto;background:var(--bg2)}
.code-block pre code.hljs{font-family:var(--mono);font-size:13px;line-height:1.6;background:transparent!important;padding:0}
.param-table{width:100%;border-collapse:collapse;margin:14px 0 22px;font-size:13px}
.param-table th{background:var(--bg3);color:var(--fg2);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;padding:9px 13px;text-align:left;border:1px solid var(--border)}
.param-table td{padding:9px 13px;border:1px solid var(--border);vertical-align:top;color:var(--fg2)}
.param-table tr:nth-child(even) td{background:rgba(255,255,255,.012)}
.req{color:var(--orange);font-size:10px;font-weight:700;border:1px solid currentColor;border-radius:3px;padding:1px 4px}
.opt{color:var(--fg3);font-size:10px}
.feature-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin:16px 0}
.feature-card{background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius);padding:14px;transition:border-color .15s}
.feature-card:hover{border-color:var(--accent)}
.feature-card h4{margin:0 0 5px;color:var(--fg);font-size:13px;text-transform:none;letter-spacing:0}
.feature-card p{margin:0;font-size:12px;color:var(--fg3)}
.phase-chip{display:inline-flex;background:rgba(167,139,250,.1);border:1px solid rgba(167,139,250,.2);color:var(--purple);border-radius:5px;padding:2px 8px;font-size:11px;font-weight:600;margin:2px}
.home-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin:20px 0}
.home-card{background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius);padding:18px;cursor:pointer;transition:all .15s}
.home-card:hover{border-color:var(--accent);transform:translateY(-1px)}
.home-card .icon{font-size:22px;margin-bottom:8px}
.home-card .name{font-size:13px;font-weight:600;color:var(--fg);margin-bottom:4px;font-family:var(--mono)}
.home-card .desc{font-size:12px;color:var(--fg3);line-height:1.4}
.search-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:200;align-items:flex-start;justify-content:center;padding-top:100px}
.search-overlay.open{display:flex}
.search-box{background:var(--bg2);border:1px solid var(--border);border-radius:14px;width:540px;overflow:hidden;box-shadow:var(--shadow)}
.search-box input{width:100%;background:transparent;border:none;color:var(--fg);padding:15px 18px;font-size:15px;outline:none}
.sr{max-height:340px;overflow-y:auto;border-top:1px solid var(--border)}
.sri{padding:11px 18px;cursor:pointer;border-bottom:1px solid var(--border)}
.sri:hover{background:var(--bg3)}
.sri .t{font-size:14px;color:var(--fg);font-weight:500}
.sri .s{font-size:12px;color:var(--fg3);margin-top:2px}
</style>
</head>
<body>

<div class="topbar">
  <div class="topbar-logo">
    <span class="brand">WeaveIntel</span>
    <span style="color:var(--fg3);font-weight:400;font-size:13px">Developer Docs</span>
  </div>
  <div class="breadcrumbs" id="bc">
    <a onclick="nav('home')">Docs</a>
  </div>
  <div class="search-wrap">
    <span class="ico">&#8981;</span>
    <input type="text" placeholder="Search (&#8984;K)" id="si" readonly onclick="openSearch()" onkeydown="if(e.key==='Escape')closeSearch()">
  </div>
</div>

<div class="search-overlay" id="so" onclick="closeSearch(event)">
  <div class="search-box" onclick="event.stopPropagation()">
    <input type="text" id="sbi" placeholder="Search packages, functions, parameters…" oninput="doSearch(this.value)">
    <div class="sr" id="sr"></div>
  </div>
</div>

<div class="layout">
  <nav class="sidebar">
    <div class="sg">Overview</div>
    <div class="si" id="nav-home"         onclick="nav('home')">&#127968; Home</div>
    <div class="si" id="nav-quickstart"   onclick="nav('quickstart')">&#9889; Quick Start</div>
    <div class="si" id="nav-architecture" onclick="nav('architecture')">&#127959; Architecture</div>

    <div class="sg" style="margin-top:8px">Agent Layer</div>
    <div class="si" id="nav-agents"    onclick="nav('agents')">&#129302; Agents</div>
    <div class="sub">
      <div class="si" onclick="nav('agents','weave-agent')">weaveAgent</div>
      <div class="si" onclick="nav('agents','supervisor')">Supervisor Mode</div>
      <div class="si" onclick="nav('agents','workers')">Worker Definitions</div>
      <div class="si" onclick="nav('agents','tools-in-agents')">Tool Binding</div>
    </div>
    <div class="si" id="nav-workflows" onclick="nav('workflows')">&#9881;&#65039; Workflows</div>
    <div class="sub">
      <div class="si" onclick="nav('workflows','step-types')">Step Types</div>
      <div class="si" onclick="nav('workflows','resolvers')">Handler Resolvers</div>
      <div class="si" onclick="nav('workflows','governance')">Governance</div>
      <div class="si" onclick="nav('workflows','dynamic')">Dynamic Graphs (W7)</div>
      <div class="si" onclick="nav('workflows','persistence')">Persistence</div>
      <div class="si" onclick="nav('workflows','policy')">Policy</div>
    </div>

    <div class="sg" style="margin-top:8px">Model Layer</div>
    <div class="si" id="nav-models"  onclick="nav('models')">&#129504; Models</div>
    <div class="si" id="nav-prompts" onclick="nav('prompts')">&#128172; Prompts</div>
    <div class="si" id="nav-cost-governor" onclick="nav('cost-governor')">&#128176; Cost Governor</div>

    <div class="sg" style="margin-top:8px">Memory &amp; Knowledge</div>
    <div class="si" id="nav-memory"    onclick="nav('memory')">&#129321; Memory</div>
    <div class="si" id="nav-retrieval" onclick="nav('retrieval')">&#128269; Retrieval</div>

    <div class="sg" style="margin-top:8px">Tools</div>
    <div class="si" id="nav-tools"         onclick="nav('tools')">&#128295; Tool Framework</div>
    <div class="si" id="nav-tools-time"    onclick="nav('tools-time')">&#128336; tools-time</div>
    <div class="si" id="nav-tools-browser" onclick="nav('tools-browser')">&#127760; tools-browser</div>
    <div class="si" id="nav-tools-http"    onclick="nav('tools-http')">&#128225; tools-http</div>
    <div class="si" id="nav-tools-search"  onclick="nav('tools-search')">&#128270; tools-search</div>
    <div class="si" id="nav-tools-news"    onclick="nav('tools-news')">&#128240; tools-news</div>
    <div class="si" id="nav-mcp"           onclick="nav('mcp')">&#128268; MCP Integration</div>

    <div class="sg" style="margin-top:8px">Quality &amp; Reliability</div>
    <div class="si" id="nav-guardrails"   onclick="nav('guardrails')">&#128737; Guardrails</div>
    <div class="si" id="nav-evals"        onclick="nav('evals')">&#128202; Evals</div>
    <div class="si" id="nav-resilience"   onclick="nav('resilience')">&#9851;&#65039; Resilience</div>
    <div class="si" id="nav-reliability"  onclick="nav('reliability')">&#128274; Reliability</div>
    <div class="si" id="nav-observability" onclick="nav('observability')">&#128200; Observability</div>
    <div class="si" id="nav-sandbox"      onclick="nav('sandbox')">&#128230; Sandbox</div>

    <div class="sg" style="margin-top:8px">Core</div>
    <div class="si" id="nav-core" onclick="nav('core')">&#9883;&#65039; @weaveintel/core</div>
    <div class="sub">
      <div class="si" onclick="nav('core','context')">ExecutionContext</div>
      <div class="si" onclick="nav('core','tools-core')">Tool Interfaces</div>
      <div class="si" onclick="nav('core','events')">EventBus</div>
      <div class="si" onclick="nav('core','models-core')">Model Contract</div>
    </div>
  </nav>

  <main class="main" id="main"></main>
</div>

<script>
const SECTIONS = ${sectionsJson};

const TITLES = {
  home:'Home',quickstart:'Quick Start',architecture:'Architecture',
  agents:'Agents',workflows:'Workflows',models:'Models',prompts:'Prompts',
  memory:'Memory',retrieval:'Retrieval',evals:'Evals',guardrails:'Guardrails',
  resilience:'Resilience',reliability:'Reliability','cost-governor':'Cost Governor',
  tools:'Tool Framework','tools-time':'tools-time','tools-browser':'tools-browser',
  'tools-http':'tools-http','tools-search':'tools-search','tools-news':'tools-news',
  mcp:'MCP Integration',observability:'Observability',sandbox:'Sandbox',core:'@weaveintel/core',
};

function nav(section, sub) {
  document.querySelectorAll('.si').forEach(el => el.classList.remove('active'));
  const navEl = document.getElementById('nav-' + section);
  if (navEl) navEl.classList.add('active');

  const main = document.getElementById('main');
  main.innerHTML = SECTIONS[section] || '<p>Section not found.</p>';
  hljs.highlightAll();

  if (sub) {
    setTimeout(() => {
      const el = document.getElementById(sub);
      if (el) el.scrollIntoView({ behavior:'smooth', block:'start' });
    }, 60);
  } else {
    main.scrollTop = 0;
  }

  const bc = document.getElementById('bc');
  if (section === 'home') {
    bc.innerHTML = '<a onclick="nav(\\'home\\')">Docs</a>';
  } else {
    const t = TITLES[section] || section;
    bc.innerHTML = '<a onclick="nav(\\'home\\')">Docs</a><span class="sep">›</span><span class="current">' + t + '</span>' +
      (sub ? '<span class="sep">›</span><span class="current">' + sub.replace(/-/g,' ') + '</span>' : '');
  }
}

function copyCode(btn) {
  const pre = btn.closest('.code-block').querySelector('code');
  navigator.clipboard.writeText(pre.innerText).then(() => {
    btn.textContent = '✓ Copied'; btn.classList.add('ok');
    setTimeout(() => { btn.textContent = '📋 Copy'; btn.classList.remove('ok'); }, 2000);
  });
}

const IDX = [
  {s:'agents',    t:'weaveAgent',        k:'agent tool calling react loop'},
  {s:'agents',    t:'Supervisor Mode',   k:'supervisor workers delegate hierarchy', sub:'supervisor'},
  {s:'workflows', t:'Workflow Engine',   k:'workflow engine step durable checkpoint'},
  {s:'workflows', t:'Dynamic Graphs W7', k:'dynamic expansion planner sub-graph', sub:'dynamic'},
  {s:'workflows', t:'Step Types',        k:'deterministic agentic condition foreach parallel fork wait human-task', sub:'step-types'},
  {s:'models',    t:'Model Registration',k:'model provider anthropic openai register routing'},
  {s:'prompts',   t:'Prompt Registry',   k:'prompt template version render rendering'},
  {s:'memory',    t:'Memory Store',      k:'memory semantic conversation entity search'},
  {s:'retrieval', t:'RAG / Retrieval',   k:'retrieval rag embedding chunking hybrid vector'},
  {s:'evals',     t:'Eval Runner',       k:'eval evaluation rubric judge score'},
  {s:'guardrails',t:'Guardrails Pipeline',k:'guardrail safety risk pii confidence'},
  {s:'resilience',t:'Resilience',        k:'resilience retry circuit breaker rate limit token bucket'},
  {s:'cost-governor',t:'Cost Governor',  k:'cost budget governor tier cascade lever'},
  {s:'tools',     t:'Tool Policy',       k:'tool policy audit approval rate limit'},
  {s:'tools-time',t:'Time Tools',        k:'time datetime timer stopwatch timezone'},
  {s:'tools-browser',t:'Browser Tools',  k:'browser fetch scrape automation playwright'},
  {s:'mcp',       t:'MCP Client/Server', k:'mcp model context protocol tool server stdio http'},
  {s:'observability',t:'Observability',  k:'trace span usage budget telemetry'},
  {s:'sandbox',   t:'Sandbox',           k:'sandbox code execution safe container vm'},
  {s:'core',      t:'Core Contracts',    k:'core interface context eventbus model'},
];

function openSearch() {
  document.getElementById('so').classList.add('open');
  setTimeout(() => document.getElementById('sbi').focus(), 40);
}
function closeSearch(e) {
  if (!e || e.target === document.getElementById('so')) {
    document.getElementById('so').classList.remove('open');
    document.getElementById('sbi').value = '';
    document.getElementById('sr').innerHTML = '';
  }
}
document.addEventListener('keydown', function(e) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); openSearch(); }
  if (e.key === 'Escape') closeSearch();
});
function doSearch(q) {
  const lq = q.toLowerCase();
  if (!lq) { document.getElementById('sr').innerHTML = ''; return; }
  const hits = IDX.filter(i => i.t.toLowerCase().includes(lq) || i.k.includes(lq)).slice(0,8);
  document.getElementById('sr').innerHTML = hits.length
    ? hits.map(h => '<div class="sri" onclick="closeSearch();nav(\\'' + h.s + '\\'' + (h.sub ? ',\\'' + h.sub + '\\'' : '') + ')"><div class="t">' + h.t + '</div><div class="s">' + (TITLES[h.s] || h.s) + '</div></div>').join('')
    : '<div class="sri"><div class="s">No results for &ldquo;' + q + '&rdquo;</div></div>';
}

nav('home');
</script>
</body>
</html>`;
}
