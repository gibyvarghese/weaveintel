/**
 * Example 18 — Knowledge Graph
 *
 * Demonstrates:
 *  • Entity nodes and relationship edges
 *  • In-memory graph store with search, neighbors, and traversal
 *  • Document-to-entity linking with pattern extraction
 *  • Graph-assisted retrieval (search and entity-based)
 *  • Timeline graph for event ordering
 *
 * WeaveIntel packages used:
 *   @weaveintel/graph — Knowledge graph primitives for structured memory:
 *     • createEntityNode()       — Typed graph node (person, project, technology, etc.)
 *     • createRelationshipEdge() — Weighted directed edge between two nodes
 *     • createGraphMemoryStore() — In-memory graph with addNode/addEdge, search, neighbors,
 *                                  traversal (multi-hop), and cascade delete
 *     • createEntityLinker()     — Extracts named entities from text (persons, dates, emails)
 *                                  and creates nodes + "mentioned-in" relationships
 *     • createGraphRetriever()   — Graph-assisted RAG: text search + entity-based retrieval
 *                                  with scored results and traversal paths
 *     • createTimelineGraph()    — Temporal graph for ordering events with causal links
 *
 * No API keys needed — uses in-memory graph primitives.
 *
 * Run: npx tsx examples/18-knowledge-graph.ts
 */

import {
  createEntityNode,
  createRelationshipEdge,
  createGraphMemoryStore,
  createEntityLinker,
  createGraphRetriever,
  createTimelineGraph,
} from '@weaveintel/graph';

/* ── Helpers ──────────────────────────────────────────── */

function header(title: string) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

async function main() {

/* ── 1. Build a Knowledge Graph ───────────────────────── */

header('1. Entity Nodes & Relationships');

// createGraphMemoryStore() is an in-memory graph database. It stores
// typed entity nodes and weighted relationship edges, and supports:
//   • findNodes(type)       — filter by entity type
//   • getNeighbors(id, depth)— multi-hop traversal
//   • searchNodes(query)    — text search across node names
//   • removeNode() with cascade delete of connected edges
const store = createGraphMemoryStore();

// Create entity nodes
// createEntityNode(id, type, name, properties) creates a typed graph node.
// The type field (person, project, team, technology) enables type-filtered queries.
const alice = createEntityNode('person-alice', 'person', 'Alice Chen', { role: 'CTO', department: 'Engineering' });
const bob = createEntityNode('person-bob', 'person', 'Bob Williams', { role: 'Lead Engineer', department: 'Engineering' });
const carol = createEntityNode('person-carol', 'person', 'Carol Davis', { role: 'Product Manager', department: 'Product' });
const projectX = createEntityNode('project-x', 'project', 'Project X', { status: 'active', budget: 500000 });
const projectY = createEntityNode('project-y', 'project', 'Project Y', { status: 'planning', budget: 200000 });
const teamAlpha = createEntityNode('team-alpha', 'team', 'Alpha Team', { size: 8 });
const techAI = createEntityNode('tech-ai', 'technology', 'Machine Learning', { category: 'AI' });
const techCloud = createEntityNode('tech-cloud', 'technology', 'Kubernetes', { category: 'Infrastructure' });

// Add nodes to store
for (const node of [alice, bob, carol, projectX, projectY, teamAlpha, techAI, techCloud]) {
  store.addNode(node);
}
console.log(`  Added ${store.nodeCount()} nodes`);

// Create relationships
// createRelationshipEdge(sourceId, targetId, type, weight) creates a
// directed weighted edge. Weights (0–1) encode relationship strength,
// which the graph retriever uses for relevance scoring.
const relationships = [
  createRelationshipEdge('person-alice', 'team-alpha', 'leads', 1.0),
  createRelationshipEdge('person-bob', 'team-alpha', 'member-of', 0.8),
  createRelationshipEdge('person-carol', 'project-x', 'manages', 1.0),
  createRelationshipEdge('team-alpha', 'project-x', 'works-on', 0.9),
  createRelationshipEdge('team-alpha', 'project-y', 'works-on', 0.5),
  createRelationshipEdge('project-x', 'tech-ai', 'uses', 1.0),
  createRelationshipEdge('project-x', 'tech-cloud', 'uses', 0.7),
  createRelationshipEdge('project-y', 'tech-cloud', 'uses', 0.9),
  createRelationshipEdge('person-alice', 'person-bob', 'mentors', 0.8),
];

for (const edge of relationships) {
  store.addEdge(edge);
}
console.log(`  Added ${store.edgeCount()} relationships`);

// Query the graph
const persons = store.findNodes('person');
console.log(`\n  Persons: ${persons.map(p => p.name).join(', ')}`);

const projects = store.findNodes('project');
console.log(`  Projects: ${projects.map(p => `${p.name} (${(p.properties as any).status})`).join(', ')}`);

const techs = store.findNodes('technology');
console.log(`  Technologies: ${techs.map(t => t.name).join(', ')}`);

/* ── 2. Graph Traversal ───────────────────────────────── */

header('2. Graph Traversal — Neighbors & Paths');

// Direct neighbors (depth 1)
const aliceNeighbors = store.getNeighbors('person-alice', 1);
console.log(`  Alice's direct connections: ${aliceNeighbors.map(n => n.name).join(', ')}`);

// Extended traversal (depth 2)
const aliceExtended = store.getNeighbors('person-alice', 2);
console.log(`  Alice's 2-hop reach: ${aliceExtended.map(n => n.name).join(', ')}`);

// Edges from/to
const alphaEdges = store.getEdgesFrom('team-alpha');
console.log(`\n  Alpha Team outgoing edges: ${alphaEdges.map(e => `→ ${e.targetId} (${e.type})`).join(', ')}`);

const projectXIncoming = store.getEdgesTo('project-x');
console.log(`  Project X incoming: ${projectXIncoming.map(e => `← ${e.sourceId} (${e.type})`).join(', ')}`);

// Edges between specific nodes
const aliceBobEdges = store.getEdgesBetween('person-alice', 'person-bob');
console.log(`\n  Alice ↔ Bob: ${aliceBobEdges.map(e => e.type).join(', ')}`);

// Search
const searchResults = store.searchNodes('machine');
console.log(`  Search "machine": ${searchResults.map(n => `${n.name} (${n.type})`).join(', ')}`);

/* ── 3. Entity Linking from Documents ─────────────────── */

header('3. Entity Linking — Extracting from Text');

// createEntityLinker() extracts named entities from unstructured text
// using pattern matching (person names, emails, dates, technologies).
// It returns entities + "mentioned-in" relationships suitable for
// directly inserting into the graph store.
const linker = createEntityLinker();

const doc1 = `
Project update from Alice Chen and Bob Williams:
The Machine Learning pipeline is now running on Kubernetes.
Please contact team@example.com for details.
Meeting scheduled for 2025-03-15.
Carol Davis approved the budget increase.
`;

const result1 = linker.extractAndLink('doc-001', doc1);
console.log(`  Document "doc-001" entities found: ${result1.entities.length}`);
for (const entity of result1.entities) {
  console.log(`    - ${entity.name} (${entity.type})`);
}
console.log(`  Relationships created: ${result1.relationships.length}`);

// Link with existing entities for deduplication
const doc2 = `Alice Chen presented findings at the 2025-06-01 meeting.`;
const result2 = linker.extractAndLink('doc-002', doc2, result1.entities);
console.log(`\n  Document "doc-002" — new entities: ${result2.entities.length}, relationships: ${result2.relationships.length}`);

/* ── 4. Graph Retrieval ───────────────────────────────── */

header('4. Graph-Assisted Retrieval');

// createGraphRetriever(store) wraps the graph store with RAG-style
// retrieval methods: .retrieve(query, k) does text search and returns
// scored results with connected edges; .retrieveByEntity(nodeId, depth, k)
// traverses from a node and returns all reachable nodes with paths.
const retriever = createGraphRetriever(store);

// Text search retrieval
const queryResults = retriever.retrieve('Alice', 5);
console.log(`  Query "Alice" — ${queryResults.length} results:`);
for (const r of queryResults) {
  console.log(`    ${r.node.name} (score: ${r.score.toFixed(2)}, edges: ${r.connectedEdges.length})`);
}

// Search for technology
const techResults = retriever.retrieve('Machine Learning', 3);
console.log(`\n  Query "Machine Learning" — ${techResults.length} results:`);
for (const r of techResults) {
  console.log(`    ${r.node.name} (score: ${r.score.toFixed(2)})`);
}

// Entity-based retrieval (find everything connected to Project X)
const entityResults = retriever.retrieveByEntity('project-x', 2, 10);
console.log(`\n  Entity retrieval from "project-x" — ${entityResults.length} connected nodes:`);
for (const r of entityResults) {
  console.log(`    ${r.node.name} (score: ${r.score.toFixed(2)}, path: ${r.path.join(' → ')})`);
}

/* ── 5. Timeline Graph ────────────────────────────────── */

header('5. Timeline Graph — Event Ordering');

// createTimelineGraph() is a temporal graph optimized for event ordering.
// addEvent() stamps each event with a timestamp; linkEvents() records
// causal relationships (led-to, resulted-in, etc.); getEventsBetween()
// returns events within a date range for timeline visualization.
const timeline = createTimelineGraph();

// Add events
const e1 = timeline.addEvent('Project X Kickoff', new Date('2025-01-15').getTime(), { type: 'milestone', participants: 5 });
const e2 = timeline.addEvent('Alpha Team Formed', new Date('2025-02-01').getTime(), { type: 'organizational' });
const e3 = timeline.addEvent('ML Pipeline v1 Deployed', new Date('2025-03-10').getTime(), { type: 'release', version: '1.0' });
const e4 = timeline.addEvent('Budget Review', new Date('2025-04-01').getTime(), { type: 'review', outcome: 'approved' });
const e5 = timeline.addEvent('ML Pipeline v2 Released', new Date('2025-05-20').getTime(), { type: 'release', version: '2.0' });
const e6 = timeline.addEvent('Project X Phase 2', new Date('2025-06-01').getTime(), { type: 'milestone' });

// Link events to show causality
timeline.linkEvents(e1.id, e2.id, 'led-to');
timeline.linkEvents(e2.id, e3.id, 'resulted-in');
timeline.linkEvents(e3.id, e4.id, 'triggered');
timeline.linkEvents(e4.id, e5.id, 'enabled');
timeline.linkEvents(e5.id, e6.id, 'preceded');

// Get all events in order
const allEvents = timeline.getEvents();
console.log(`  Full timeline (${allEvents.length} events):`);
for (const ev of allEvents) {
  const date = new Date(ev.timestamp).toISOString().slice(0, 10);
  console.log(`    ${date}: ${ev.label}`);
}

// Filter by date range
const q1Events = timeline.getEventsBetween(
  new Date('2025-01-01').getTime(),
  new Date('2025-03-31').getTime(),
);
console.log(`\n  Q1 2025 events: ${q1Events.map(e => e.label).join(', ')}`);

const q2Events = timeline.getEventsBetween(
  new Date('2025-04-01').getTime(),
  new Date('2025-06-30').getTime(),
);
console.log(`  Q2 2025 events: ${q2Events.map(e => e.label).join(', ')}`);

/* ── 6. Graph Statistics ──────────────────────────────── */

header('6. Graph Statistics');

console.log(`  Total nodes: ${store.nodeCount()}`);
console.log(`  Total edges: ${store.edgeCount()}`);
console.log(`  Node types: ${[...new Set(store.findNodes('person').concat(store.findNodes('project'), store.findNodes('team'), store.findNodes('technology')).map(n => n.type))].join(', ')}`);

// Remove a node and check cascade
store.removeNode('project-y');
console.log(`\n  After removing "Project Y":`);
console.log(`    Nodes: ${store.nodeCount()}, Edges: ${store.edgeCount()}`);

/* ── Summary ──────────────────────────────────────────── */

header('Summary');
console.log('✅ Entity nodes with typed properties');
console.log('✅ Relationship edges with weights');
console.log('✅ Graph search and multi-hop traversal');
console.log('✅ Document-to-entity linking with pattern extraction');
console.log('✅ Graph-assisted retrieval (text and entity-based)');
console.log('✅ Timeline graph with event ordering and date filtering');
}

main().catch(console.error);
