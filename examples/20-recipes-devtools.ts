/**
 * Example 20 — Recipes, DevTools & UI Primitives
 *
 * Demonstrates:
 *  • Pre-built agent recipes (governed assistant, workflow, event-driven)
 *  • Project scaffolding from templates
 *  • Configuration validation with rules
 *  • Mock runtime for testing (model, bus, tools)
 *  • Agent inspection and report generation
 *  • UI stream events (text, status, errors, tool calls)
 *  • Citations (document and web)
 *  • Artifacts (JSON, code)
 *  • Widgets (tables, charts, timelines)
 *  • Progress tracking
 *  • Tool approval payloads
 *
 * WeaveIntel packages used:
 *   @weaveintel/recipes       — Pre-built high-level agent patterns:
 *     • createGovernedAssistant()  — Agent with automatic governance rule enforcement
 *     • createEventDrivenAgent()   — Agent that reacts to EventBus events (pub/sub-driven)
 *     • createSafeExecutionAgent() — Agent with tool deny-lists and execution timeouts
 *   @weaveintel/devtools       — Developer productivity tools:
 *     • scaffold() / listTemplates()— Generate full project boilerplates from templates
 *     • createValidator()          — Build rule-based config validators (requiredFields,
 *                                    maxStepsInRange, etc.)
 *     • createMockModel/Bus/Runtime— Test doubles for model, event bus, and tool registry
 *     • inspect() / formatReport() — Introspect agent wiring (tools, events, configuration)
 *     • planMigration()            — Generate step-by-step upgrade plans between versions
 *   @weaveintel/ui-primitives  — Typed UI events for streaming agent UIs:
 *     • textEvent / statusEvent / errorEvent / toolCallEvent / stepUpdateEvent
 *       — Typed stream events for real-time agent output
 *     • envelope() / createStreamBuilder() — Sequenced wrapper with session/agent metadata
 *     • toolApproval()             — Human-in-the-loop approval payload for risky tool calls
 *     • documentCitation() / webCitation() — Source attribution for RAG responses
 *     • jsonArtifact() / codeArtifact()    — Structured output attachments
 *     • tableWidget / chartWidget / timelineWidget — Rich visual widgets
 *     • createProgressTracker()    — Task progress with increment/complete lifecycle
 *
 * No API keys needed — uses mock model and in-memory primitives.
 *
 * Run: npx tsx examples/20-recipes-devtools.ts
 */

import {
  createGovernedAssistant,
  createEventDrivenAgent,
  createSafeExecutionAgent,
} from '@weaveintel/recipes';

import {
  scaffold,
  listTemplates,
  inspect,
  formatReport,
  createValidator,
  requiredFields,
  maxStepsInRange,
  createMockModel,
  createMockEventBus,
  createMockRuntime,
  planMigration,
  formatMigrationPlan,
} from '@weaveintel/devtools';

import {
  textEvent,
  errorEvent,
  statusEvent,
  toolCallEvent,
  stepUpdateEvent,
  envelope,
  createStreamBuilder,
  toolApproval,
  documentCitation,
  webCitation,
  jsonArtifact,
  codeArtifact,
  tableWidget,
  chartWidget,
  timelineWidget,
  createProgressTracker,
} from '@weaveintel/ui-primitives';
import { weaveContext } from '@weaveintel/core';

/* ── Helpers ──────────────────────────────────────────── */

function header(title: string) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

async function main() {

/* ── 1. Agent Recipes ─────────────────────────────────── */

header('1. Pre-Built Agent Recipes');

// createMockModel() returns a deterministic model that cycles through
// pre-configured responses. Used for testing without API keys.
const mockModel = createMockModel({ responses: ['Hello from governed assistant!', 'Event processed.'] });
const mockBus = createMockEventBus();

// createGovernedAssistant() wraps a model with governance rules that are
// injected into the system prompt. Every response is checked against the
// rules before being returned to the user.
const governed = createGovernedAssistant({
  model: mockModel,
  name: 'ComplianceBot',
  governanceRules: ['No PII in responses', 'Cite sources for claims', 'Maximum 500 tokens per response'],
  systemPrompt: 'You are a compliance-aware assistant.',
});
console.log('  Governed assistant created');

// createEventDrivenAgent() creates an agent that subscribes to EventBus
// events (listenTo[]) and processes them through the model. Useful for
// building reactive pipelines where agents respond to system events.
const eventAgent = createEventDrivenAgent({
  model: mockModel,
  bus: mockBus,
  name: 'EventHandler',
  listenTo: ['user:message', 'tool:result', 'error:*'],
  systemPrompt: 'Process incoming events and produce summaries.',
});
console.log('  Event-driven agent created');

// createSafeExecutionAgent() wraps a model with tool deny-lists and
// execution timeouts, preventing dangerous operations (rm, sudo, etc.).
const safeAgent = createSafeExecutionAgent({
  model: mockModel,
  name: 'SafeRunner',
  deniedTools: ['rm', 'delete-all', 'sudo'],
  maxToolExecutionMs: 5000,
  systemPrompt: 'Execute tasks safely.',
});
console.log('  Safe execution agent created');

/* ── 2. Project Scaffolding ───────────────────────────── */

header('2. Project Scaffolding');

// scaffold() generates a full project from a template (package.json,
// src/, tsconfig, Dockerfile, tests). listTemplates() shows available types.
const templates = listTemplates();
console.log(`  Available templates (${templates.length}):`);
for (const t of templates) {
  console.log(`    - ${t.type}: ${t.description}`);
}

const project = scaffold({
  projectName: 'my-ai-agent',
  template: 'tool-calling-agent',
  description: 'A tool-calling AI agent for data analysis',
  includeTests: true,
  includeDocker: true,
});

console.log(`\n  Scaffolded "${project.name}" (${project.type}):`);
console.log(`    Files: ${project.files.length}`);
for (const f of project.files.slice(0, 5)) {
  console.log(`      ${f.path} (${f.content.length} chars)`);
}
if (project.files.length > 5) console.log(`      ... and ${project.files.length - 5} more`);
console.log(`    Dependencies: ${project.dependencies.join(', ')}`);
console.log(`    Dev deps: ${project.devDependencies.join(', ')}`);

/* ── 3. Configuration Validation ──────────────────────── */

header('3. Configuration Validation');

// createValidator() composes validation rules. requiredFields() checks
// that named properties exist; maxStepsInRange() validates the maxSteps
// value is within bounds. .validate() returns { valid, issues[] }.
const validator = createValidator([
  requiredFields('name', 'model', 'maxSteps'),
  maxStepsInRange(1, 100),
]);

const goodConfig = { name: 'MyAgent', model: 'gpt-4', maxSteps: 10 };
const goodResult = validator.validate(goodConfig);
console.log(`  Good config: valid=${goodResult.valid}, issues=${goodResult.issues.length}`);

const badConfig = { model: 'gpt-4' } as Record<string, unknown>;
const badResult = validator.validate(badConfig);
console.log(`  Bad config: valid=${badResult.valid}, issues=${badResult.issues.length}`);
for (const issue of badResult.issues) {
  console.log(`    [${issue.severity}] ${issue.message}${issue.suggestion ? ' — ' + issue.suggestion : ''}`);
}

/* ── 4. Mock Runtime ──────────────────────────────────── */

header('4. Mock Runtime for Testing');

// createMockRuntime() bundles a mock model + mock event bus + mock tools
// into a single test harness. The mock model tracks all .generate() calls
// in .calls[] for assertions; the bus stores emitted events.
const runtime = createMockRuntime({
  responses: ['Analysis complete.', 'Summary: all metrics nominal.'],
  tools: [
    { name: 'analyze', result: { score: 0.95 } },
    { name: 'summarize', result: { text: 'All clear.' } },
  ],
});

console.log(`  Mock model: ${runtime.model.info.modelId}`);
console.log(`  Mock bus events so far: ${runtime.bus.events.length}`);

// Call the mock model
const modelResult = await runtime.model.generate(weaveContext({ userId: 'tester' }), { messages: [{ role: 'user', content: 'Analyze data' }] });
console.log(`  Model response: "${typeof modelResult.content === 'string' ? modelResult.content : JSON.stringify(modelResult.content)}"`);
console.log(`  Model call count: ${runtime.model.calls.length}`);

/* ── 5. Agent Inspection ──────────────────────────────── */

header('5. Agent Inspection & Reports');

// inspect() introspects an agent's wiring (tools, bus handlers, config)
// and returns a structured report. formatReport() renders it as text.
const report = inspect({
  tools: runtime.tools,
  bus: runtime.bus,
});

console.log(`  Inspection report:`);
console.log(`    Tools: ${report.tools.length}`);
for (const t of report.tools) {
  console.log(`      - ${t.name} (params: ${t.parameterCount}, hasExecute: ${t.hasExecute})`);
}
console.log(`    Events: ${report.events.registeredHandlers} handlers`);

const formatted = formatReport(report);
console.log(`\n  Formatted report (${formatted.length} chars):`);
const reportLines = formatted.split('\n').slice(0, 6);
for (const line of reportLines) console.log(`    ${line}`);

/* ── 6. Migration Planning ────────────────────────────── */

header('6. Migration Planning');

// planMigration() generates a step-by-step upgrade plan between two
// WeaveIntel versions, identifying breaking changes and migration steps.
const migration = planMigration('0.1.0', '0.3.0');
console.log(`  Migration from ${migration.from} → ${migration.to}:`);
console.log(`    Total steps: ${migration.totalSteps}`);
console.log(`    Breaking changes: ${migration.breakingChanges}`);

const migrationText = formatMigrationPlan(migration);
const migrationLines = migrationText.split('\n').slice(0, 8);
for (const line of migrationLines) console.log(`    ${line}`);

/* ── 7. UI Stream Events ──────────────────────────────── */

header('7. UI Stream Events');

// UI stream events are typed payloads that a streaming agent UI consumes.
// textEvent() carries LLM output text; statusEvent() signals agent state;
// errorEvent() reports errors with optional codes; toolCallEvent() logs
// tool invocations with args+result; stepUpdateEvent() tracks multi-step progress.
const text = textEvent('Processing your request...');
console.log(`  Text event: type=${text.type}, data="${(text.data as any)?.text ?? text.data}"`);

const status = statusEvent('analyzing', 'Scanning 1,500 documents');
console.log(`  Status event: type=${status.type}`);

const error = errorEvent('Rate limit exceeded', 'RATE_LIMIT');
console.log(`  Error event: type=${error.type}, code=${(error.data as any)?.code ?? 'none'}`);

const toolCall = toolCallEvent('search', { query: 'AI safety' }, { results: 42 });
console.log(`  Tool call event: type=${toolCall.type}`);

const step = stepUpdateEvent('step-3', 'Summarize', 'completed', 'Done in 2.1s');
console.log(`  Step update: type=${step.type}`);

// Envelope wrapping
// envelope() wraps any stream event with sequence number, timestamp,
// sessionId, and agentId for multiplexed streaming. createStreamBuilder()
// creates a stateful builder that auto-increments the sequence.
const env = envelope(text, { sessionId: 'sess-001', agentId: 'agent-x' });
console.log(`  Envelope: seq=${env.sequence}, sessionId=${env.sessionId}`);

// Stream builder
const builder = createStreamBuilder({ sessionId: 'sess-002', agentId: 'bot-y' });
const e1 = builder.text('Starting analysis...');
const e2 = builder.status('working', 'Processing batch 1/3');
const e3 = builder.text('Analysis complete.');
console.log(`  Stream builder: 3 events, sequences ${e1.sequence}→${e2.sequence}→${e3.sequence}`);

/* ── 8. Tool Approvals ────────────────────────────────── */

header('8. Tool Approval Payloads');

const approval = toolApproval('delete-records', { table: 'users', where: 'inactive > 1y' }, 'high');
console.log(`  Approval: "${approval.title}"`);
console.log(`  Risk: ${approval.riskLevel}, actions: ${approval.actions?.map((a: any) => a.label).join(', ') ?? 'default'}`);

/* ── 9. Citations ─────────────────────────────────────── */

header('9. Citations');

// documentCitation() and webCitation() create source-attribution objects
// for RAG responses. Each includes the cited text, source, optional page/URL,
// and a confidence score indicating how well the source supports the claim.
const docCite = documentCitation('Revenue increased 15% YoY', 'Q3-Financial-Report.pdf', 12, 0.95);
console.log(`  Document: "${docCite.text}" — ${docCite.source} p.${docCite.page} (${(docCite.confidence! * 100).toFixed(0)}%)`);

const webCite = webCitation('Transformers outperform RNNs on long sequences', 'https://arxiv.org/abs/1706.03762', 'Attention Is All You Need', 0.99);
console.log(`  Web: "${webCite.text}" — ${webCite.source} (${(webCite.confidence! * 100).toFixed(0)}%)`);

/* ── 10. Artifacts ────────────────────────────────────── */

header('10. Artifacts');

// jsonArtifact() and codeArtifact() create typed output attachments.
// These are sent alongside text in the stream so the UI can render them
// as collapsible JSON viewers or syntax-highlighted code blocks.
const jsonArt = jsonArtifact('Analysis Results', {
  accuracy: 0.94,
  precision: 0.91,
  recall: 0.96,
  f1: 0.935,
});
console.log(`  JSON: "${jsonArt.title}" (type: ${jsonArt.type}, mime: ${jsonArt.mimeType})`);

const codeArt = codeArtifact('Query Builder', `
SELECT users.name, COUNT(orders.id) as order_count
FROM users
LEFT JOIN orders ON users.id = orders.user_id
WHERE users.active = true
GROUP BY users.name
ORDER BY order_count DESC;
`.trim(), 'sql');
console.log(`  Code: "${codeArt.title}" (type: ${codeArt.type}, mime: ${codeArt.mimeType})`);

/* ── 11. Widgets ──────────────────────────────────────── */

header('11. Widgets');

// tableWidget(), chartWidget(), and timelineWidget() create rich visual
// components that the agent UI renders as interactive data displays.
const table = tableWidget('Model Comparison', 
  ['Model', 'Accuracy', 'Latency', 'Cost'],
  [
    ['GPT-4', '94%', '2.1s', '$0.06'],
    ['Claude 3', '93%', '1.8s', '$0.04'],
    ['Gemini Pro', '91%', '1.5s', '$0.03'],
  ],
  { sortable: true },
);
console.log(`  Table: "${table.title}" (${(table.data as any)?.rows?.length ?? 0} rows)`);

const chart = chartWidget('Monthly Usage', 'bar',
  ['Jan', 'Feb', 'Mar', 'Apr', 'May'],
  [
    { label: 'API Calls', data: [1200, 1500, 1800, 2100, 2400] },
    { label: 'Token Usage (K)', data: [50, 65, 80, 95, 110] },
  ],
);
console.log(`  Chart: "${chart.title}" type=${(chart.data as any)?.chartType ?? chart.type}`);

const timeline = timelineWidget('Project Timeline', [
  { time: '2025-01-15', label: 'Kickoff', description: 'Project started', status: 'completed' },
  { time: '2025-02-01', label: 'Alpha', description: 'First prototype', status: 'completed' },
  { time: '2025-03-10', label: 'Beta', description: 'Public beta release', status: 'completed' },
  { time: '2025-04-01', label: 'GA', description: 'General availability', status: 'running' },
]);
console.log(`  Timeline: "${timeline.title}" (${(timeline.data as any)?.events?.length ?? 0} events)`);

/* ── 12. Progress Tracking ────────────────────────────── */

header('12. Progress Tracking');

// createProgressTracker() creates a task-level progress bar. increment()
// advances the counter and emits a progress event; complete() finalizes it.
const progress = createProgressTracker('Document Processing', 100);
console.log(`  Tracker: "${progress.taskId}" — ${progress.current}/${progress.total}`);

const p1 = progress.increment(25, 'Batch 1 complete');
console.log(`  After +25: ${progress.current}/${progress.total} — ${(p1 as any).details ?? ''}`);

const p2 = progress.increment(50, 'Batch 2-3 complete');
console.log(`  After +50: ${progress.current}/${progress.total}`);

const p3 = progress.complete('All documents processed');
console.log(`  Complete: status=${p3.status}`);

/* ── Summary ──────────────────────────────────────────── */

header('Summary');
console.log('✅ Pre-built agent recipes (governed, event-driven, safe execution)');
console.log('✅ Project scaffolding from 7 templates');
console.log('✅ Configuration validation with custom rules');
console.log('✅ Mock runtime for testing (model, bus, tools)');
console.log('✅ Agent inspection and formatted reports');
console.log('✅ Migration planning with breaking change detection');
console.log('✅ UI stream events (text, status, error, tool call, step update)');
console.log('✅ Tool approval payloads');
console.log('✅ Document and web citations');
console.log('✅ JSON and code artifacts');
console.log('✅ Table, chart, and timeline widgets');
console.log('✅ Progress tracking with increment/complete');
}

main().catch(console.error);
