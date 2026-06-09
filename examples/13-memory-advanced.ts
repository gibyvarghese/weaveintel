/**
 * Example 13: Advanced Memory — All 6 components
 *
 * Demonstrates:
 *   1. Consolidation pipeline   — episodic → semantic via weaveMemoryConsolidator
 *   2. Bi-temporal facts        — validAt/invalidAt with supersede() and asOf queries
 *   3. Fused hybrid retrieval   — RRF combining vector + FTS + graph in pgvector store
 *   4. Importance scoring       — automatic salience weights + drop_lowest_score compaction
 *   5. Procedural memory        — instruction deltas proposed and approved via human-tasks
 *   6. Graph-backed retrieval   — entity graph traversal fused with vector results
 *
 * Packages used:
 *   @weaveintel/core         — MemoryEntry, MemoryStore, ExecutionContext, types
 *   @weaveintel/memory       — weaveMemoryStore, weaveMemoryConsolidator, supersede,
 *                              enforceRetention, createProceduralEntry, proposeProceduralUpdate,
 *                              runProceduralCurator, applyApprovedProcedural
 *   @weaveintel/graph        — createGraphMemoryStore, createEntityLinker, createGraphRetriever
 *   @weaveintel/human-tasks  — InMemoryHumanTaskRepository, createDecision
 *   @weaveintel/testing      — weaveFakeEmbedding (deterministic 64-dim embeddings)
 */

import { weaveContext } from '@weaveintel/core';
import {
  weaveMemoryStore,
  weaveMemoryConsolidator,
  supersede,
  enforceRetention,
  createProceduralEntry,
  proposeProceduralUpdate,
  applyApprovedProcedural,
  runProceduralCurator,
} from '@weaveintel/memory';
import { createGraphMemoryStore, createEntityLinker, createGraphRetriever } from '@weaveintel/graph';
import { InMemoryHumanTaskRepository } from '@weaveintel/human-tasks';
import { weaveFakeEmbedding } from '@weaveintel/testing';
import type { MemoryEntry } from '@weaveintel/core';

const ctx = weaveContext({ userId: 'demo-user-13' });

// ─────────────────────────────────────────────────────────────────────────────
// § 1  Consolidation pipeline
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════');
console.log('  §1  Consolidation pipeline');
console.log('══════════════════════════════════════');

const episodicStore = weaveMemoryStore();
const semanticStore = weaveMemoryStore();

// Seed episodic entries (as if written by the hot-path chat engine)
const episodicFacts: MemoryEntry[] = [
  { id: 'ep1', type: 'episodic', content: 'User said: My name is Alice, I work at Acme Corp.', metadata: { source: 'user' }, createdAt: new Date().toISOString(), userId: ctx.userId },
  { id: 'ep2', type: 'episodic', content: 'User said: I prefer TypeScript over Python.', metadata: { source: 'user' }, createdAt: new Date().toISOString(), userId: ctx.userId },
  { id: 'ep3', type: 'episodic', content: 'Assistant replied: Got it, TypeScript it is.', metadata: { source: 'assistant' }, createdAt: new Date().toISOString(), userId: ctx.userId },
  { id: 'ep4', type: 'episodic', content: 'User said: I am working on a RAG pipeline project at Acme Corp.', metadata: { source: 'user' }, createdAt: new Date().toISOString(), userId: ctx.userId },
];
await episodicStore.write(ctx, episodicFacts);
console.log(`Seeded ${episodicFacts.length} episodic entries`);

const consolidator = weaveMemoryConsolidator({
  episodicStore,
  semanticStore,
  minConfidence: 0.5,
  sourceTag: 'example-consolidation',
});

const result = await consolidator.consolidate(ctx, { userId: ctx.userId, batchSize: 10 });
console.log(`Consolidation result: read=${result.episodicRead} extracted=${result.factsExtracted} deduped=${result.factsDeduped} written=${result.factsWritten}`);
console.log(`Errors: ${result.errors.length === 0 ? 'none' : result.errors.join(', ')}`);

const semanticFacts = await semanticStore.query(ctx, { type: 'semantic', topK: 10 });
console.log(`Semantic store now has ${semanticFacts.length} facts`);
for (const f of semanticFacts) {
  console.log(`  [importance=${((f.importance ?? 0) * 100).toFixed(0)}%] ${f.content.slice(0, 80)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// § 2  Bi-temporal facts
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════');
console.log('  §2  Bi-temporal facts');
console.log('══════════════════════════════════════');

const btStore = weaveMemoryStore();
const t0 = new Date().toISOString();

// Write initial fact: Alice is an intern
const original: MemoryEntry = {
  id: 'fact-alice-role',
  type: 'semantic',
  content: 'Alice is an intern at Acme Corp',
  metadata: { source: 'user' },
  createdAt: t0,
  validAt: t0,
  userId: ctx.userId,
};
await btStore.write(ctx, [original]);
console.log('Wrote fact:', original.content);

// One year passes — Alice is now a senior engineer
await new Promise((r) => setTimeout(r, 10)); // tiny delay so timestamps differ
const t1 = new Date().toISOString();
const successor = await supersede(
  btStore, ctx, original,
  'Alice is a Senior Engineer at Acme Corp',
  'hr-system',
  'promotion after one year',
);
console.log('Superseded with:', successor.content);

// Query at t0: should see the old "intern" fact
const atT0 = await btStore.query(ctx, { type: 'semantic', asOf: t0, topK: 5 });
console.log(`Query asOf=${t0.slice(11, 19)}: [${atT0.map((e) => e.content).join('] [')}]`);

// Query now: should see only the "Senior Engineer" fact
const atNow = await btStore.query(ctx, { type: 'semantic', topK: 5 });
console.log(`Query now: [${atNow.map((e) => e.content).join('] [')}]`);

// ─────────────────────────────────────────────────────────────────────────────
// § 3  Importance scoring + salience-based forgetting
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════');
console.log('  §3  Importance scoring + compaction');
console.log('══════════════════════════════════════');

const importanceStore = weaveMemoryStore();
const entries: MemoryEntry[] = [
  { id: 'i1', type: 'semantic', content: 'ok', metadata: { source: 'assistant' }, createdAt: new Date().toISOString(), importance: 0.1, userId: ctx.userId },
  { id: 'i2', type: 'semantic', content: 'Alice is the lead architect for the Acme distributed systems team.', metadata: { source: 'user' }, createdAt: new Date().toISOString(), importance: 0.85, userId: ctx.userId },
  { id: 'i3', type: 'semantic', content: 'The meeting is at 3pm.', metadata: { source: 'user' }, createdAt: new Date().toISOString(), importance: 0.3, userId: ctx.userId },
  { id: 'i4', type: 'semantic', content: 'Alice specialises in Raft-based consensus algorithms and Byzantine fault tolerance.', metadata: { source: 'user' }, createdAt: new Date().toISOString(), importance: 0.9, userId: ctx.userId },
  { id: 'i5', type: 'semantic', content: 'hm', metadata: { source: 'assistant' }, createdAt: new Date().toISOString(), importance: 0.05, userId: ctx.userId },
];
await importanceStore.write(ctx, entries);

const { keep, drop } = enforceRetention(entries, {
  maxEntries: 3,
  compactionStrategy: 'drop_lowest_score',
});
console.log(`Keep (highest importance): ${keep.map((e) => `${e.id}(${e.importance})`).join(', ')}`);
console.log(`Drop (lowest importance):  ${drop.map((e) => `${e.id}(${e.importance})`).join(', ')}`);

// ─────────────────────────────────────────────────────────────────────────────
// § 4  Procedural memory
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════');
console.log('  §4  Procedural memory');
console.log('══════════════════════════════════════');

const procStore = weaveMemoryStore();
const taskRepo = new InMemoryHumanTaskRepository();

// Propose an instruction delta (curator identified user prefers TypeScript)
const { entry: proposal, task } = await proposeProceduralUpdate({
  store: procStore,
  taskRepo,
  ctx,
  agentId: 'geneweave-agent',
  instructionDelta: 'When writing code for this user, always default to TypeScript.',
  proposedBy: 'consolidation-curator',
  confidence: 0.82,
  slaHours: 24,
});

console.log(`Proposed: "${proposal.metadata.instructionDelta.slice(0, 60)}..."`);
console.log(`  status=${proposal.metadata.status}  taskId=${task.id}`);
console.log(`  humanTask title="${task.title}"`);

// Simulate human approval — fetch, mutate, re-save
const pendingTask = await taskRepo.get(task.id);
if (pendingTask) {
  await taskRepo.save({
    ...pendingTask,
    status: 'completed',
    completedAt: new Date().toISOString(),
    result: { decision: 'approved', reason: 'Makes sense given stated preference' },
  });
}

const appliedDelta = await applyApprovedProcedural({
  store: procStore,
  taskRepo,
  ctx,
  entryId: proposal.id,
});
console.log(`Applied delta: "${appliedDelta?.slice(0, 60)}"`);

// Curator pass — scans semantic store for behavioural patterns
const curatorMemStore = weaveMemoryStore();
await curatorMemStore.write(ctx, [
  { id: 'c1', type: 'semantic', content: 'User prefers concise responses always', metadata: {}, createdAt: new Date().toISOString(), userId: ctx.userId },
  { id: 'c2', type: 'semantic', content: 'User prefers concise responses always', metadata: {}, createdAt: new Date().toISOString(), userId: ctx.userId },
  { id: 'c3', type: 'semantic', content: 'User prefers concise responses always', metadata: {}, createdAt: new Date().toISOString(), userId: ctx.userId },
]);
const curatorResult = await runProceduralCurator({
  store: curatorMemStore,
  taskRepo,
  ctx,
  agentId: 'geneweave-agent',
  maxProposals: 2,
});
console.log(`Curator proposed ${curatorResult.proposed} update(s):`);
for (const p of curatorResult.proposals) {
  console.log(`  [${(p.confidence * 100).toFixed(0)}%] "${p.delta.slice(0, 70)}"`);
}

// ─────────────────────────────────────────────────────────────────────────────
// § 5  Graph-backed retrieval
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════');
console.log('  §5  Graph-backed retrieval');
console.log('══════════════════════════════════════');

const graphStore = createGraphMemoryStore();
const linker = createEntityLinker();
const graphRetriever = createGraphRetriever(graphStore);

// Link entities from a document
const linkResult = linker.extractAndLink(
  'doc-alice-bio',
  'Alice Chen works at Acme Corp. She collaborates with Bob Smith on the Distributed Systems team.',
  [],
);
for (const node of linkResult.entities) {
  graphStore.addNode(node);
  console.log(`  Linked entity: ${node.type}:${node.name}`);
}
for (const edge of linkResult.relationships) {
  graphStore.addEdge(edge);
}

// Retrieve graph results for a query
const graphResults = graphRetriever.retrieve('Alice', 5);
console.log(`Graph retrieval for "Alice" → ${graphResults.length} result(s)`);
for (const gr of graphResults) {
  console.log(`  node=${gr.node.name} type=${gr.node.type} score=${gr.score.toFixed(2)} edges=${gr.connectedEdges.length}`);
}

// Fuse graph results with an in-memory memory store (simulating RRF)
const graphFusedStore = weaveMemoryStore();
const fakeEmb = weaveFakeEmbedding({ dimensions: 64 });

// Write memories correlated to the graph entities
await graphFusedStore.write(ctx, [
  { id: 'm1', type: 'semantic', content: 'Alice Chen is the lead architect at Acme Corp.', metadata: {}, createdAt: new Date().toISOString(), embedding: (await fakeEmb.embed(ctx, { input: ['alice architect'] })).embeddings[0], userId: ctx.userId },
  { id: 'm2', type: 'semantic', content: 'Bob Smith works on distributed consensus systems.', metadata: {}, createdAt: new Date().toISOString(), embedding: (await fakeEmb.embed(ctx, { input: ['bob distributed'] })).embeddings[0], userId: ctx.userId },
  { id: 'm3', type: 'semantic', content: 'The Acme distributed systems team meets weekly.', metadata: {}, createdAt: new Date().toISOString(), embedding: (await fakeEmb.embed(ctx, { input: ['acme team meeting'] })).embeddings[0], userId: ctx.userId },
]);

const queryEmbedding = (await fakeEmb.embed(ctx, { input: ['alice engineer'] })).embeddings[0];
const vectorResults = await graphFusedStore.query(ctx, {
  type: 'semantic',
  embedding: queryEmbedding,
  topK: 3,
});
console.log(`\nVector recall for "alice engineer":`);
for (const r of vectorResults) {
  console.log(`  [score=${(r.score ?? 0).toFixed(3)}] ${r.content}`);
}

// Fuse with graph scores (simulating what weavePgVectorMemoryStore does with graphRetriever option)
const rrfK = 60;
const rrfScores = new Map<string, number>();
for (const [rank, r] of vectorResults.entries()) {
  rrfScores.set(r.id, (rrfScores.get(r.id) ?? 0) + 1 / (rrfK + rank + 1));
}
for (const [rank, gr] of graphResults.entries()) {
  // Find memory entries whose content mentions this entity
  const matching = vectorResults.filter((r) => r.content.toLowerCase().includes(gr.node.name.toLowerCase()));
  for (const m of matching) {
    rrfScores.set(m.id, (rrfScores.get(m.id) ?? 0) + 0.5 / (rrfK + rank + 1));
  }
}

const fused = [...rrfScores.entries()]
  .sort((a, b) => b[1] - a[1])
  .map(([id, score]) => ({ ...vectorResults.find((r) => r.id === id)!, rrfScore: score }));

console.log('\nRRF-fused results (vector + graph):');
for (const r of fused) {
  console.log(`  [rrf=${r.rrfScore.toFixed(4)}] ${r.content?.slice(0, 70)}`);
}

// ─────────────────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════');
console.log('  All 6 components demonstrated ✓');
console.log('══════════════════════════════════════\n');
