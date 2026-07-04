/**
 * Example 152 — Knowledge graph memory tools (P4-3)
 *
 * Demonstrates `createGraphMemoryToolSet(store)` from @weaveintel/agents:
 *
 *   graph_entity_add         — add or upsert entity nodes
 *   graph_entity_search      — full-text search across nodes
 *   graph_relate             — create directed relationship edges
 *   graph_recall_neighbours  — traverse neighbours up to N hops
 *
 * Scenarios:
 *   1. Build a knowledge graph of people and organisations
 *   2. Search and recall relationship chains
 *   3. Missing entity error handling
 *   4. Deep neighbour traversal
 *
 * Usage:
 *   npx ts-node examples/152-graph-memory.ts
 */

import { weaveContext, weaveRuntime } from '@weaveintel/core';
import type { Tool } from '@weaveintel/core';
import { weaveAgent, createGraphMemoryToolSet, createGraphMemoryToolRegistry } from '@weaveintel/agents';
import { createGraphMemoryStore } from '@weaveintel/memory';
import { createMockModel } from '@weaveintel/devtools';

// Helper: call a tool's invoke method directly (for direct use outside agents)
async function invokeTool(tool: Tool, args: Record<string, unknown>) {
  const ctx = makeCtx();
  return tool.invoke(ctx, { name: tool.schema.name, arguments: args });
}
async function invokeToolJson(tool: Tool, args: Record<string, unknown>) {
  const out = await invokeTool(tool, args);
  return JSON.parse(out.content);
}

const runtime = weaveRuntime({});

function makeCtx() {
  return weaveContext({ executionId: `ex-${Date.now()}`, runtime });
}

// ─── Scenario 1: Build a knowledge graph ─────────────────────

async function scenario1BuildKnowledgeGraph() {
  console.log('\n── Scenario 1: Build and traverse knowledge graph ──');

  const store = createGraphMemoryStore();
  const registry = createGraphMemoryToolRegistry(store);

  const model = createMockModel([
    // Add Alice
    { toolCalls: [{ id: 'tc1', name: 'graph_entity_add', arguments: JSON.stringify({ id: 'person:alice', type: 'person', name: 'Alice Chen', properties: { role: 'engineer', team: 'backend' } }) }] },
    // Add ACME Corp
    { toolCalls: [{ id: 'tc2', name: 'graph_entity_add', arguments: JSON.stringify({ id: 'org:acme', type: 'organisation', name: 'ACME Corp', properties: { industry: 'technology', size: 'startup' } }) }] },
    // Relate Alice → ACME
    { toolCalls: [{ id: 'tc3', name: 'graph_relate', arguments: JSON.stringify({ sourceId: 'person:alice', targetId: 'org:acme', type: 'works_at', weight: 1.0 }) }] },
    // Recall Alice's neighbours
    { toolCalls: [{ id: 'tc4', name: 'graph_recall_neighbours', arguments: JSON.stringify({ entityId: 'person:alice', depth: 1 }) }] },
    { content: 'Knowledge graph built: Alice Chen works at ACME Corp.' },
  ]);

  const agent = weaveAgent({
    model,
    tools: registry,
    name: 'graph-builder',
    maxSteps: 10,
  });

  const result = await agent.run(makeCtx(), {
    goal: 'Build and explore knowledge graph',
    messages: [{ role: 'user', content: 'Add Alice Chen who works at ACME Corp. Then show her connections.' }],
  });

  console.log('Status:', result.status);
  console.log('Output:', result.output);
  console.log('Nodes in store:', store.nodeCount());
  console.log('Edges in store:', store.edgeCount());
  console.log('Alice node:', store.getNode('person:alice'));
}

// ─── Scenario 2: Search and upsert ───────────────────────────

async function scenario2SearchAndUpsert() {
  console.log('\n── Scenario 2: Search entities and upsert ──');

  const store = createGraphMemoryStore();
  const registry = createGraphMemoryToolRegistry(store);

  // Pre-populate the store with some entities
  const tools = createGraphMemoryToolSet(store);
  const addTool = tools.find((t) => t.schema.name === 'graph_entity_add')!;
  await invokeTool(addTool, { type: 'person', name: 'Bob Smith', properties: { role: 'designer' } });
  await invokeTool(addTool, { type: 'person', name: 'Bob Jones', properties: { role: 'marketing' } });
  await invokeTool(addTool, { type: 'product', name: 'WeaveChat', properties: { status: 'GA' } });

  const model = createMockModel([
    // Search for "Bob"
    { toolCalls: [{ id: 'tc1', name: 'graph_entity_search', arguments: JSON.stringify({ query: 'Bob', limit: 5 }) }] },
    // Upsert Bob Smith with additional properties
    { toolCalls: [{ id: 'tc2', name: 'graph_entity_add', arguments: JSON.stringify({ id: 'person:bob-smith', type: 'person', name: 'Bob Smith', properties: { role: 'senior designer', team: 'product' } }) }] },
    { content: 'Found 2 Bobs. Updated Bob Smith to senior designer on the product team.' },
  ]);

  const agent = weaveAgent({
    model,
    tools: registry,
    name: 'search-agent',
    maxSteps: 5,
  });

  const result = await agent.run(makeCtx(), {
    goal: 'Search and update entities',
    messages: [{ role: 'user', content: 'Find all people named Bob and update Bob Smith to senior designer.' }],
  });

  console.log('Status:', result.status);
  console.log('Output:', result.output);
  const bobSmith = store.searchNodes('Bob Smith');
  console.log('Bob Smith updated properties:', bobSmith[0]?.properties);
}

// ─── Scenario 3: Error handling — missing entities ────────────

async function scenario3MissingEntityError() {
  console.log('\n── Scenario 3: Relate to non-existent entity ──');

  const store = createGraphMemoryStore();
  const tools = createGraphMemoryToolSet(store);

  const relateTool = tools.find((t) => t.schema.name === 'graph_relate')!;

  // Attempt to relate two entities that don't exist
  const parsed = await invokeToolJson(relateTool, {
    sourceId: 'person:ghost',
    targetId: 'org:phantom',
    type: 'member_of',
  });
  console.log('Relate result (should be error):', parsed);
  console.log('ok:', parsed.ok);
  console.log('error:', parsed.error);
}

// ─── Scenario 4: Deep neighbour traversal ────────────────────

async function scenario4DeepTraversal() {
  console.log('\n── Scenario 4: Deep neighbour traversal (depth 2) ──');

  const store = createGraphMemoryStore();
  const tools = createGraphMemoryToolSet(store);

  const add = tools.find((t) => t.schema.name === 'graph_entity_add')!;
  const relate = tools.find((t) => t.schema.name === 'graph_relate')!;
  const recall = tools.find((t) => t.schema.name === 'graph_recall_neighbours')!;

  // Alice → knows → Bob → knows → Carol
  await invokeTool(add, { id: 'person:alice2', type: 'person', name: 'Alice', properties: {} });
  await invokeTool(add, { id: 'person:bob2', type: 'person', name: 'Bob', properties: {} });
  await invokeTool(add, { id: 'person:carol', type: 'person', name: 'Carol', properties: {} });

  await invokeTool(relate, { sourceId: 'person:alice2', targetId: 'person:bob2', type: 'knows', weight: 0.9 });
  await invokeTool(relate, { sourceId: 'person:bob2', targetId: 'person:carol', type: 'knows', weight: 0.8 });

  // Depth 1: should return Bob only
  const depth1 = await invokeToolJson(recall, { entityId: 'person:alice2', depth: 1 });
  console.log('Depth 1 neighbours of Alice:', depth1.neighbours.map((n: { name: string }) => n.name));

  // Depth 2: should return Bob + Carol
  const depth2 = await invokeToolJson(recall, { entityId: 'person:alice2', depth: 2 });
  console.log('Depth 2 neighbours of Alice:', depth2.neighbours.map((n: { name: string }) => n.name));
}

// ─── Run all scenarios ─────────────────────────────────────────

(async () => {
  await scenario1BuildKnowledgeGraph();
  await scenario2SearchAndUpsert();
  await scenario3MissingEntityError();
  await scenario4DeepTraversal();
  console.log('\n✓ All graph memory scenarios complete.');
})().catch(console.error);
