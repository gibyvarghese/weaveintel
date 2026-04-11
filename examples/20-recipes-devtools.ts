/**
 * Example 20 — Recipes, DevTools & UI Primitives
 *
 * Demonstrates:
 *  • Recipe factories — pre-built agent patterns (governed, approval-driven, workflow)
 *  • DevTools scaffolding and template listing
 *  • Agent inspection and report formatting
 *  • Validation rules for agent configurations
 *  • Mock runtime for testing agents without real APIs
 *  • UI primitives — streaming events, widgets, artifacts, citations
 *  • Progress tracking for long-running operations
 *
 * No API keys needed — all in-memory.
 *
 * Run: npx tsx examples/20-recipes-devtools.ts
 */

import {
  createGovernedAssistant,
  createApprovalDrivenAgent,
  createWorkflowAgent,
  createEvalRoutedAssistant,
  createSafeExecutionAgent,
} from '@weaveintel/recipes';

import {
  scaffold,
  listTemplates,
  inspect,
  formatReport,
  createValidator,
  createMockModel,
  createMockEventBus,
  createMockRuntime,
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
  deduplicateCitations,
  jsonArtifact,
  codeArtifact,
  csvArtifact,
  markdownArtifact,
  tableWidget,
  chartWidget,
  createProgress,
  createProgressTracker,
} from '@weaveintel/ui-primitives';

/* ── Helpers ──────────────────────────────────────────── */

function header(title: string) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

/* ── 1. Recipe Factories ──────────────────────────────── */

header('1. Pre-Built Agent Recipes');

// Governed Assistant — built-in guardrails + audit logging
const governed = createGovernedAssistant({
  name: 'Support Bot',
  description: 'Customer support with governance policies',
  guardrails: ['pii-filter', 'topic-restrict', 'cost-limit'],
  auditLevel: 'full',
  maxBudgetPerRequest: 0.10,
});

console.log(`📦 ${governed.name}: ${governed.description}`);
console.log(`   Guardrails: ${governed.guardrails.join(', ')}`);
console.log(`   Audit: ${governed.auditLevel}`);
console.log(`   Budget: $${governed.maxBudgetPerRequest}/request`);

// Approval-Driven Agent — requires human approval for high-risk actions
const approvalAgent = createApprovalDrivenAgent({
  name: 'Data Manager',
  description: 'Manages data with approval gates for destructive operations',
  approvalRequired: ['delete', 'export', 'modify_schema'],
  autoApprove: ['read', 'list', 'search'],
  escalationPolicy: { maxWaitMinutes: 30, fallback: 'deny' },
});

console.log(`\n📦 ${approvalAgent.name}: ${approvalAgent.description}`);
console.log(`   Requires approval: ${approvalAgent.approvalRequired.join(', ')}`);
console.log(`   Auto-approved: ${approvalAgent.autoApprove.join(', ')}`);
console.log(`   Escalation: wait ${approvalAgent.escalationPolicy.maxWaitMinutes}min, fallback=${approvalAgent.escalationPolicy.fallback}`);

// Workflow Agent — multi-step with checkpointing
const workflowAgent = createWorkflowAgent({
  name: 'Report Generator',
  description: 'Generates weekly reports with data collection, analysis, and distribution',
  steps: ['collect_data', 'analyze', 'generate_charts', 'compile_report', 'distribute'],
  checkpointEnabled: true,
  compensationEnabled: true,
});

console.log(`\n📦 ${workflowAgent.name}: ${workflowAgent.description}`);
console.log(`   Steps: ${workflowAgent.steps.join(' → ')}`);
console.log(`   Checkpoint: ${workflowAgent.checkpointEnabled ? 'Yes' : 'No'}`);
console.log(`   Compensation: ${workflowAgent.compensationEnabled ? 'Yes' : 'No'}`);

// Eval-Routed Assistant — routes to different models based on eval scores
const evalRouted = createEvalRoutedAssistant({
  name: 'Smart Router',
  description: 'Routes requests to the best-performing model per task type',
  routes: [
    { taskType: 'code', preferredModel: 'gpt-4o', minEvalScore: 0.85 },
    { taskType: 'creative', preferredModel: 'claude-3.5-sonnet', minEvalScore: 0.80 },
    { taskType: 'analysis', preferredModel: 'gpt-4o', minEvalScore: 0.90 },
    { taskType: 'simple', preferredModel: 'gpt-4o-mini', minEvalScore: 0.70 },
  ],
});

console.log(`\n📦 ${evalRouted.name}: ${evalRouted.description}`);
console.log('   Routes:');
for (const r of evalRouted.routes) {
  console.log(`     ${r.taskType} → ${r.preferredModel} (min score: ${r.minEvalScore})`);
}

// Safe Execution Agent — sandboxed + rate-limited
const safeAgent = createSafeExecutionAgent({
  name: 'Code Runner',
  description: 'Executes user code in a sandboxed environment',
  sandboxPolicy: 'strict',
  maxExecutionMs: 10_000,
  maxMemoryMb: 256,
  rateLimit: { requestsPerMinute: 30 },
});

console.log(`\n📦 ${safeAgent.name}: ${safeAgent.description}`);
console.log(`   Policy: ${safeAgent.sandboxPolicy}`);
console.log(`   Limits: ${safeAgent.maxExecutionMs}ms, ${safeAgent.maxMemoryMb}MB`);
console.log(`   Rate: ${safeAgent.rateLimit.requestsPerMinute} req/min`);

/* ── 2. DevTools — Templates & Scaffolding ────────────── */

header('2. DevTools — Scaffolding');

const templates = listTemplates();
console.log(`Available templates: ${templates.length}`);
for (const t of templates) {
  console.log(`  📁 ${t.name}: ${t.description}`);
}

// Scaffold a new agent project
const scaffolded = scaffold({
  template: 'basic-agent',
  name: 'my-support-agent',
  options: { tools: true, memory: true, observability: true },
});

console.log(`\nScaffolded project: ${scaffolded.name}`);
console.log('Generated files:');
for (const file of scaffolded.files) {
  console.log(`  📄 ${file.path} (${file.content.length} chars)`);
}

/* ── 3. DevTools — Inspection ─────────────────────────── */

header('3. DevTools — Agent Inspection');

const inspectionTarget = {
  name: 'Support Bot',
  model: 'gpt-4o',
  tools: ['search_docs', 'create_ticket', 'escalate'],
  memory: { type: 'conversational', maxTokens: 4096 },
  guardrails: ['pii-filter', 'cost-limit'],
  systemPrompt: 'You are a helpful support agent...',
};

const inspectionResult = inspect(inspectionTarget);
console.log('Inspection result:');
console.log(`  Name: ${inspectionResult.name}`);
console.log(`  Model: ${inspectionResult.model}`);
console.log(`  Tools: ${inspectionResult.tools.length}`);
console.log(`  Memory: ${inspectionResult.memory.type} (${inspectionResult.memory.maxTokens} tokens)`);
console.log(`  Guardrails: ${inspectionResult.guardrails.length}`);
console.log(`  Warnings: ${inspectionResult.warnings.length}`);

const report = formatReport(inspectionResult);
console.log('\nFormatted report:');
console.log(report);

/* ── 4. DevTools — Validation ─────────────────────────── */

header('4. DevTools — Configuration Validation');

const validator = createValidator();

const validConfig = {
  name: 'My Agent',
  model: 'gpt-4o',
  tools: ['search'],
  systemPrompt: 'You are helpful.',
  maxSteps: 5,
};

const invalidConfig = {
  name: '',
  model: '',
  tools: [],
  systemPrompt: '',
  maxSteps: -1,
};

for (const [label, config] of [['Valid', validConfig], ['Invalid', invalidConfig]] as const) {
  const result = validator.validate(config);
  console.log(`${label} config: ${result.valid ? '✅ Valid' : '❌ Invalid'}`);
  if (!result.valid) {
    for (const err of result.errors) {
      console.log(`  ⚠️  ${err.field}: ${err.message}`);
    }
  }
}

/* ── 5. DevTools — Mock Runtime ───────────────────────── */

header('5. DevTools — Mock Runtime');

const mockModel = createMockModel({
  responses: [
    'Hello! How can I help you today?',
    'I\'d be happy to look that up for you.',
  ],
});

const mockEventBus = createMockEventBus();
const mockRuntime = createMockRuntime({ model: mockModel, eventBus: mockEventBus });

// Simulate interactions
const response1 = await mockRuntime.chat('Hi there!');
const response2 = await mockRuntime.chat('What\'s the weather?');

console.log('Mock runtime interactions:');
console.log(`  User: "Hi there!" → Agent: "${response1}"`);
console.log(`  User: "What\'s the weather?" → Agent: "${response2}"`);
console.log(`  Events captured: ${mockEventBus.events.length}`);
for (const event of mockEventBus.events) {
  console.log(`    📡 ${event.type}: ${JSON.stringify(event.data).slice(0, 60)}...`);
}

/* ── 6. UI Primitives — Streaming Events ──────────────── */

header('6. UI Primitives — Streaming Events');

// Build a stream of events
const stream = createStreamBuilder();

stream.push(statusEvent({ status: 'thinking', message: 'Analyzing your request...' }));
stream.push(textEvent({ text: 'Based on your question about pricing, ' }));
stream.push(toolCallEvent({
  toolName: 'search_pricing',
  arguments: { product: 'Enterprise', region: 'US' },
  status: 'executing',
}));
stream.push(toolCallEvent({
  toolName: 'search_pricing',
  arguments: { product: 'Enterprise', region: 'US' },
  status: 'completed',
  result: { price: '$499/mo', features: ['unlimited seats', 'priority support'] },
}));
stream.push(textEvent({ text: 'the Enterprise plan is $499/month with unlimited seats.' }));
stream.push(stepUpdateEvent({ step: 1, total: 3, label: 'Research complete' }));

console.log('Stream events:');
for (const event of stream.events()) {
  const wrapped = envelope(event);
  console.log(`  ${wrapped.type}: ${JSON.stringify(wrapped.data).slice(0, 80)}`);
}

/* ── 7. UI Primitives — Tool Approval ─────────────────── */

header('7. UI Primitives — Tool Approval Widget');

const approval = toolApproval({
  toolName: 'delete_records',
  arguments: { userId: 'user-42', scope: 'all_conversations' },
  risk: 'high',
  message: 'This will permanently delete all conversations for user-42.',
});

console.log('Approval widget:');
console.log(`  Tool: ${approval.toolName}`);
console.log(`  Risk: ${approval.risk}`);
console.log(`  Message: ${approval.message}`);
console.log(`  Args: ${JSON.stringify(approval.arguments)}`);

/* ── 8. UI Primitives — Citations ─────────────────────── */

header('8. UI Primitives — Citations');

const citations = [
  documentCitation({
    title: 'API Rate Limits',
    source: 'docs/api/rate-limits.md',
    snippet: 'Enterprise customers: 100,000 requests/minute...',
    relevance: 0.95,
  }),
  webCitation({
    url: 'https://docs.example.com/pricing',
    title: 'Pricing Page',
    snippet: 'Enterprise: $499/mo with unlimited seats...',
    fetchedAt: new Date().toISOString(),
    relevance: 0.88,
  }),
  documentCitation({
    title: 'API Rate Limits',
    source: 'docs/api/rate-limits.md',
    snippet: 'Burst allowance: 150% for 30 seconds...',
    relevance: 0.82,
  }),
];

const deduplicated = deduplicateCitations(citations);
console.log(`Citations: ${citations.length} total, ${deduplicated.length} after dedup`);
for (const c of deduplicated) {
  const icon = c.type === 'document' ? '📄' : '🌐';
  console.log(`  ${icon} ${c.title} (relevance: ${c.relevance})`);
  console.log(`     "${c.snippet}"`);
}

/* ── 9. UI Primitives — Artifacts ─────────────────────── */

header('9. UI Primitives — Artifacts');

const artifacts = [
  jsonArtifact({
    name: 'search-results.json',
    data: { results: [{ id: 1, title: 'Rate Limits' }, { id: 2, title: 'Pricing' }] },
  }),
  codeArtifact({
    name: 'api-client.ts',
    language: 'typescript',
    code: `import { WeaveClient } from '@weaveintel/core';\n\nconst client = new WeaveClient({ apiKey: process.env.API_KEY });\nconst result = await client.chat('Hello!');`,
  }),
  csvArtifact({
    name: 'usage-report.csv',
    headers: ['Date', 'Requests', 'Tokens', 'Cost'],
    rows: [
      ['2025-01-01', '45000', '2.1M', '$12.50'],
      ['2025-01-02', '52000', '2.8M', '$15.20'],
      ['2025-01-03', '38000', '1.9M', '$10.80'],
    ],
  }),
  markdownArtifact({
    name: 'summary.md',
    content: '# Weekly Summary\n\nTotal requests: 135,000\nAvg daily cost: $12.83\nUptime: 99.97%',
  }),
];

console.log(`Generated ${artifacts.length} artifacts:`);
for (const a of artifacts) {
  console.log(`  📎 ${a.name} (${a.type})`);
}

/* ── 10. UI Primitives — Widgets ──────────────────────── */

header('10. UI Primitives — Widgets');

const table = tableWidget({
  title: 'Model Performance',
  columns: ['Model', 'Latency', 'Cost/1K', 'Quality'],
  rows: [
    ['gpt-4o', '320ms', '$0.015', '95%'],
    ['gpt-4o-mini', '180ms', '$0.003', '88%'],
    ['claude-3.5-sonnet', '410ms', '$0.018', '94%'],
  ],
});

console.log(`Table: ${table.title}`);
console.log(`  Columns: ${table.columns.join(' | ')}`);
for (const row of table.rows) {
  console.log(`  ${row.join(' | ')}`);
}

const chart = chartWidget({
  title: 'Daily Request Volume',
  type: 'bar',
  labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
  datasets: [
    { label: 'Requests', data: [45000, 52000, 38000, 61000, 48000] },
  ],
});

console.log(`\nChart: ${chart.title} (${chart.type})`);
console.log(`  Labels: ${chart.labels.join(', ')}`);
console.log(`  Data: ${chart.datasets[0].data.join(', ')}`);

/* ── 11. UI Primitives — Progress Tracking ────────────── */

header('11. Progress Tracking');

const progress = createProgressTracker({
  total: 5,
  label: 'Processing documents',
});

const steps = [
  'Loading documents...',
  'Extracting entities...',
  'Building graph...',
  'Computing embeddings...',
  'Indexing for search...',
];

for (let i = 0; i < steps.length; i++) {
  progress.update(i + 1, steps[i]);
  const state = progress.state();
  const bar = '█'.repeat(Math.floor(state.percent / 5)) + '░'.repeat(20 - Math.floor(state.percent / 5));
  console.log(`  [${bar}] ${state.percent}% — ${state.currentLabel}`);
}

console.log(`\n  ✅ Complete! ${progress.state().elapsed}ms elapsed`);

/* ── Summary ──────────────────────────────────────────── */

header('Summary');
console.log('✅ Recipe factories (governed, approval, workflow, eval-routed, safe)');
console.log('✅ DevTools scaffolding with templates');
console.log('✅ Agent inspection and formatted reports');
console.log('✅ Configuration validation');
console.log('✅ Mock runtime for testing');
console.log('✅ Streaming events (text, tool call, status, step update)');
console.log('✅ Tool approval widgets');
console.log('✅ Citations (document + web) with deduplication');
console.log('✅ Artifacts (JSON, code, CSV, markdown)');
console.log('✅ Widgets (table, chart)');
console.log('✅ Progress tracking');
