/**
 * Example 18 — Knowledge Graph & Entity Extraction
 *
 * Demonstrates:
 *  • Entity node creation and relationship edges
 *  • Graph memory store for agent knowledge
 *  • Entity linking across documents
 *  • Timeline graphs for event ordering
 *  • Graph-based retrieval for agent queries
 *  • Document extraction pipeline (entity + timeline stages)
 *  • Agent using graph context for multi-hop reasoning
 *
 * No API keys needed — uses in-memory graph and fake model.
 *
 * Run: npx tsx examples/18-knowledge-graph.ts
 */

import {
  createEntityNode,
  createRelationshipEdge,
  createGraphMemoryStore,
  createEntityLinker,
  createTimelineGraph,
  createGraphRetriever,
} from '@weaveintel/graph';

import {
  createDocumentTransformPipeline,
  createEntityStage,
  createTimelineStage,
  createMetadataStage,
} from '@weaveintel/extraction';

import { weaveContext } from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';
import { weaveFakeModel } from '@weaveintel/testing';

/* ── Helpers ──────────────────────────────────────────── */

function header(title: string) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

/* ── 1. Entity Nodes ──────────────────────────────────── */

header('1. Building a Knowledge Graph');

const store = createGraphMemoryStore();

// People
const alice = createEntityNode({
  id: 'person-alice',
  type: 'person',
  label: 'Alice Chen',
  properties: { role: 'CEO', company: 'TechCorp', email: 'alice@techcorp.io' },
});
const bob = createEntityNode({
  id: 'person-bob',
  type: 'person',
  label: 'Bob Kumar',
  properties: { role: 'CTO', company: 'TechCorp', email: 'bob@techcorp.io' },
});
const carol = createEntityNode({
  id: 'person-carol',
  type: 'person',
  label: 'Carol Davis',
  properties: { role: 'VP Engineering', company: 'DataFlow Inc', email: 'carol@dataflow.io' },
});

// Companies
const techcorp = createEntityNode({
  id: 'company-techcorp',
  type: 'organization',
  label: 'TechCorp',
  properties: { industry: 'AI/ML', founded: 2019, hq: 'San Francisco' },
});
const dataflow = createEntityNode({
  id: 'company-dataflow',
  type: 'organization',
  label: 'DataFlow Inc',
  properties: { industry: 'Data Infrastructure', founded: 2017, hq: 'Seattle' },
});

// Products
const nexus = createEntityNode({
  id: 'product-nexus',
  type: 'product',
  label: 'Nexus AI Platform',
  properties: { category: 'MLOps', version: '3.0', pricing: 'enterprise' },
});
const pipeline = createEntityNode({
  id: 'product-pipeline',
  type: 'product',
  label: 'DataFlow Pipeline',
  properties: { category: 'ETL', version: '5.2', pricing: 'usage-based' },
});

// Add all nodes
const entities = [alice, bob, carol, techcorp, dataflow, nexus, pipeline];
for (const entity of entities) {
  store.addNode(entity);
}
console.log(`Added ${entities.length} entity nodes to graph`);

/* ── 2. Relationships ─────────────────────────────────── */

header('2. Creating Relationships');

const relationships = [
  createRelationshipEdge({ source: 'person-alice', target: 'company-techcorp', type: 'leads', properties: { since: '2019' } }),
  createRelationshipEdge({ source: 'person-bob', target: 'company-techcorp', type: 'works_at', properties: { since: '2020' } }),
  createRelationshipEdge({ source: 'person-carol', target: 'company-dataflow', type: 'works_at', properties: { since: '2018' } }),
  createRelationshipEdge({ source: 'company-techcorp', target: 'product-nexus', type: 'develops', properties: {} }),
  createRelationshipEdge({ source: 'company-dataflow', target: 'product-pipeline', type: 'develops', properties: {} }),
  createRelationshipEdge({ source: 'company-techcorp', target: 'company-dataflow', type: 'partner', properties: { since: '2023', deal: 'Integration partnership' } }),
  createRelationshipEdge({ source: 'person-alice', target: 'person-carol', type: 'knows', properties: { context: 'Met at AI Summit 2022' } }),
  createRelationshipEdge({ source: 'product-nexus', target: 'product-pipeline', type: 'integrates_with', properties: { api: 'REST', since: '2023' } }),
];

for (const rel of relationships) {
  store.addEdge(rel);
}

console.log(`Added ${relationships.length} relationships:`);
for (const rel of relationships) {
  const src = store.getNode(rel.source);
  const tgt = store.getNode(rel.target);
  console.log(`  ${src?.label || rel.source} ──[${rel.type}]──> ${tgt?.label || rel.target}`);
}

/* ── 3. Entity Linking ────────────────────────────────── */

header('3. Entity Linking');

const linker = createEntityLinker(store);

// Simulate linking mentions from text to existing entities
const mentions = [
  { text: 'Alice Chen', hint: 'person' },
  { text: 'TechCorp', hint: 'organization' },
  { text: 'Nexus AI Platform', hint: 'product' },
  { text: 'DataFlow', hint: 'organization' },
];

for (const mention of mentions) {
  const linked = linker.link(mention.text, mention.hint);
  if (linked) {
    console.log(`  "${mention.text}" → ${linked.label} (${linked.id}) [${linked.type}]`);
  } else {
    console.log(`  "${mention.text}" → ❌ No match`);
  }
}

/* ── 4. Graph Retrieval ───────────────────────────────── */

header('4. Graph-Based Retrieval');

const retriever = createGraphRetriever(store);

// Query: find everything related to TechCorp
console.log('Query: "What is related to TechCorp?"');
const techcorpContext = retriever.retrieve('company-techcorp', { depth: 2 });
console.log(`  Found ${techcorpContext.nodes.length} nodes, ${techcorpContext.edges.length} edges (depth=2)`);
for (const node of techcorpContext.nodes) {
  console.log(`  📍 ${node.label} (${node.type})`);
}
for (const edge of techcorpContext.edges) {
  const src = store.getNode(edge.source);
  const tgt = store.getNode(edge.target);
  console.log(`  🔗 ${src?.label} ──[${edge.type}]──> ${tgt?.label}`);
}

// Query: path between Alice and DataFlow Pipeline
console.log('\nQuery: "How is Alice connected to DataFlow Pipeline?"');
const path = retriever.findPath('person-alice', 'product-pipeline');
if (path) {
  console.log('  Path found:');
  for (const step of path) {
    if (step.type === 'node') {
      console.log(`    📍 ${step.label}`);
    } else {
      console.log(`    ──[${step.type}]──>`);
    }
  }
} else {
  console.log('  No path found');
}

/* ── 5. Timeline Graph ────────────────────────────────── */

header('5. Timeline Graph');

const timeline = createTimelineGraph();

const events = [
  { id: 'ev1', timestamp: '2019-03-15', label: 'TechCorp founded', entity: 'company-techcorp', type: 'founding' },
  { id: 'ev2', timestamp: '2020-06-01', label: 'Bob Kumar joins as CTO', entity: 'person-bob', type: 'hire' },
  { id: 'ev3', timestamp: '2021-09-10', label: 'Nexus AI Platform v1.0 launched', entity: 'product-nexus', type: 'launch' },
  { id: 'ev4', timestamp: '2022-11-05', label: 'Alice meets Carol at AI Summit', entity: 'person-alice', type: 'meeting' },
  { id: 'ev5', timestamp: '2023-02-20', label: 'TechCorp–DataFlow partnership announced', entity: 'company-techcorp', type: 'partnership' },
  { id: 'ev6', timestamp: '2023-06-15', label: 'Nexus–Pipeline integration shipped', entity: 'product-nexus', type: 'integration' },
  { id: 'ev7', timestamp: '2024-01-10', label: 'Nexus AI Platform v3.0 released', entity: 'product-nexus', type: 'release' },
];

for (const ev of events) {
  timeline.addEvent(ev);
}

console.log('Full timeline:');
for (const ev of timeline.getEvents()) {
  console.log(`  📅 ${ev.timestamp} — ${ev.label}`);
}

// Query timeline range
console.log('\nEvents in 2023:');
const year2023 = timeline.getRange('2023-01-01', '2023-12-31');
for (const ev of year2023) {
  console.log(`  📅 ${ev.timestamp} — ${ev.label}`);
}

// Events for a specific entity
console.log('\nNexus AI Platform timeline:');
const nexusTimeline = timeline.getByEntity('product-nexus');
for (const ev of nexusTimeline) {
  console.log(`  📅 ${ev.timestamp} — ${ev.label}`);
}

/* ── 6. Document Extraction Pipeline ──────────────────── */

header('6. Document Extraction Pipeline');

const extractionPipeline = createDocumentTransformPipeline([
  createMetadataStage(),
  createEntityStage(),
  createTimelineStage(),
]);

const document = {
  id: 'doc-press-release',
  content: `FOR IMMEDIATE RELEASE — February 20, 2023

TechCorp and DataFlow Inc today announced a strategic partnership to integrate 
the Nexus AI Platform with DataFlow Pipeline. The integration, led by CTO Bob Kumar 
and VP Engineering Carol Davis, will enable enterprise customers to build end-to-end 
ML pipelines with automated data transformation and model deployment.

"This partnership represents the convergence of AI and data infrastructure," said 
Alice Chen, CEO of TechCorp. "Our customers have been asking for native DataFlow 
integration, and Carol's team has built exactly what the market needs."

The initial integration shipped on June 15, 2023, with full GA expected in Q1 2024.`,
  metadata: { source: 'press-release', date: '2023-02-20' },
};

const extracted = extractionPipeline.process(document);
console.log('Extraction results:');
console.log(`  Metadata: ${JSON.stringify(extracted.metadata)}`);
console.log(`  Entities found: ${extracted.entities?.length || 0}`);
if (extracted.entities) {
  for (const e of extracted.entities) {
    console.log(`    🏷️  ${e.text} (${e.type})`);
  }
}
console.log(`  Timeline events: ${extracted.timeline?.length || 0}`);
if (extracted.timeline) {
  for (const t of extracted.timeline) {
    console.log(`    📅 ${t.date} — ${t.description}`);
  }
}

/* ── 7. Agent with Graph Context ──────────────────────── */

header('7. Agent with Graph-Augmented Reasoning');

const ctx = weaveContext({ userId: 'graph-demo', timeout: 30_000 });

// Build context from graph for the agent
const graphContext = retriever.retrieve('company-techcorp', { depth: 2 });
const contextSummary = [
  'Knowledge Graph Context:',
  '',
  'Entities:',
  ...graphContext.nodes.map(n => `- ${n.label} (${n.type}): ${JSON.stringify(n.properties)}`),
  '',
  'Relationships:',
  ...graphContext.edges.map(e => {
    const src = store.getNode(e.source);
    const tgt = store.getNode(e.target);
    return `- ${src?.label} --[${e.type}]--> ${tgt?.label}`;
  }),
  '',
  'Timeline:',
  ...timeline.getEvents().map(e => `- ${e.timestamp}: ${e.label}`),
].join('\n');

const model = weaveFakeModel({
  responses: [
    `Based on the knowledge graph, here's the complete picture of TechCorp's ecosystem:

**Company Overview:**
TechCorp is an AI/ML company founded in 2019 in San Francisco. They develop the **Nexus AI Platform** (currently v3.0, enterprise pricing).

**Key People:**
- **Alice Chen** (CEO) — Leads the company, connected to Carol Davis from DataFlow Inc (met at AI Summit 2022)
- **Bob Kumar** (CTO) — Joined in June 2020, led the DataFlow integration

**Strategic Partnerships:**
TechCorp partnered with **DataFlow Inc** (Seattle-based data infrastructure company) in February 2023. DataFlow develops the **DataFlow Pipeline** (ETL, v5.2, usage-based pricing).

**Product Integration:**
The Nexus AI Platform integrates with DataFlow Pipeline via REST API since 2023. This enables end-to-end ML pipelines combining TechCorp's AI capabilities with DataFlow's data transformation.

**Timeline of Key Events:**
1. 2019 — TechCorp founded
2. 2020 — Bob Kumar joins as CTO
3. 2021 — Nexus v1.0 launched
4. 2022 — Alice meets Carol at AI Summit
5. 2023 — Partnership announced → Integration shipped
6. 2024 — Nexus v3.0 released

**Connection Path (Alice → DataFlow Pipeline):**
Alice Chen → leads TechCorp → partners with DataFlow Inc → develops DataFlow Pipeline`,
  ],
});

const agent = weaveAgent({
  model,
  systemPrompt: `You are a research analyst. Use the knowledge graph context to answer questions with specific details, relationships, and timelines.\n\n${contextSummary}`,
  maxSteps: 2,
});

const result = await agent.run(
  { messages: [{ role: 'user', content: 'Give me a complete overview of TechCorp — their people, products, partnerships, and timeline.' }] },
  ctx,
);

console.log('Agent response (graph-augmented):');
console.log(result.content);

/* ── Summary ──────────────────────────────────────────── */

header('Summary');
console.log('✅ Entity nodes (person, organization, product)');
console.log('✅ Relationship edges (leads, works_at, develops, partner, integrates_with)');
console.log('✅ Graph memory store with add/get/query');
console.log('✅ Entity linking from text mentions to graph nodes');
console.log('✅ Graph retrieval with depth traversal');
console.log('✅ Path finding between entities');
console.log('✅ Timeline graph with range and entity queries');
console.log('✅ Document extraction pipeline (metadata, entity, timeline stages)');
console.log('✅ Agent using graph context for multi-hop reasoning');
