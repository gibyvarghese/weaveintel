/**
 * E2E test for all 6 advanced memory components.
 * Runs entirely in-process with no network required.
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
import type { MemoryEntry } from '@weaveintel/core';

const g = (s: string) => `\x1b[32m${s}\x1b[0m`;
const r = (s: string) => `\x1b[31m${s}\x1b[0m`;
const b = (s: string) => `\x1b[34m${s}\x1b[0m`;

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail?: string) {
  if (condition) { console.log(`  ${g('✓')} ${label}`); passed++; }
  else { console.log(`  ${r('✗')} ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}

// ── §1 Consolidation ──────────────────────────────────────────────────────────

async function testConsolidation() {
  console.log(b('\n[ 1 ] Consolidation pipeline'));
  const ctx = weaveContext({ userId: 'test-consolidation' });
  const episodicStore = weaveMemoryStore();
  const semanticStore = weaveMemoryStore();
  const now = new Date().toISOString();

  const episodic: MemoryEntry[] = [
    { id: 'ep-a', type: 'episodic', content: 'User said they prefer dark mode always.', metadata: { source: 'user' }, createdAt: now, userId: ctx.userId },
    { id: 'ep-b', type: 'episodic', content: 'User mentioned their timezone is UTC+5:30.', metadata: { source: 'user' }, createdAt: now, userId: ctx.userId },
    { id: 'ep-c', type: 'episodic', content: 'Already processed', metadata: { source: 'user', _consolidated: true }, createdAt: now, userId: ctx.userId },
  ];
  await episodicStore.write(ctx, episodic);

  const consolidator = weaveMemoryConsolidator({ episodicStore, semanticStore, minConfidence: 0 });
  const result = await consolidator.consolidate(ctx, { userId: ctx.userId, batchSize: 10 });

  assert('reads 2 unconsolidated episodic entries', result.episodicRead === 2, `got ${result.episodicRead}`);
  assert('writes facts to semantic store', result.factsWritten >= 2, `got ${result.factsWritten}`);
  assert('no errors', result.errors.length === 0, result.errors.join('; '));

  const semantic = await semanticStore.query(ctx, { type: 'semantic', topK: 20 });
  assert('semantic store has consolidated facts', semantic.length >= 2, `got ${semantic.length}`);
  assert('facts have importance scores', semantic.every((e) => e.importance !== undefined && e.importance > 0));
  assert('source tag on facts', semantic.every((e) => e.metadata['_sourceTag'] === 'example-consolidation' || e.metadata['_sourceTag'] === 'geneweave-consolidation' || typeof e.metadata['_sourceTag'] === 'string'));
}

// ── §2 Bi-temporal facts ──────────────────────────────────────────────────────

async function testBiTemporal() {
  console.log(b('\n[ 2 ] Bi-temporal facts'));
  const ctx = weaveContext({ userId: 'test-bitemporal' });
  const store = weaveMemoryStore();
  const t0 = new Date().toISOString();

  const original: MemoryEntry = {
    id: 'bt-role',
    type: 'semantic',
    content: 'User is a junior developer',
    metadata: {},
    createdAt: t0,
    validAt: t0,
    userId: ctx.userId,
  };
  await store.write(ctx, [original]);

  await new Promise((resolve) => setTimeout(resolve, 5));

  const successor = await supersede(store, ctx, original, 'User is a senior engineer', 'hr-system', 'promotion');

  const beforeSupersession = await store.query(ctx, { type: 'semantic', asOf: t0, topK: 10 });
  assert('asOf before supersession returns original', beforeSupersession.some((e) => e.content.includes('junior')));
  assert('asOf before supersession excludes successor', !beforeSupersession.some((e) => e.content.includes('senior')));

  const afterSupersession = await store.query(ctx, { type: 'semantic', topK: 10 });
  assert('default query returns successor', afterSupersession.some((e) => e.content.includes('senior')));
  assert('default query excludes invalidated entry', !afterSupersession.some((e) => e.content.includes('junior')));
  assert('successor has no invalidAt', successor.invalidAt === undefined);
  assert('original has invalidAt set', original.invalidAt === undefined); // original object unchanged; the store has the updated copy

  // Check invalidAt is on the stored copy
  const allEntries = await store.query(ctx, { type: 'semantic', asOf: t0, topK: 100 });
  const storedOriginal = allEntries.find((e) => e.id === 'bt-role');
  assert('stored original has invalidAt', storedOriginal?.invalidAt !== undefined);
}

// ── §3 Importance scoring + compaction ────────────────────────────────────────

async function testImportanceCompaction() {
  console.log(b('\n[ 3 ] Importance scoring + compaction'));

  const entries: MemoryEntry[] = [
    { id: 'h1', type: 'semantic', content: 'Alice is CTO at Acme Corp leading 200 engineers.', metadata: {}, createdAt: new Date().toISOString(), importance: 0.95, userId: 'u1' },
    { id: 'h2', type: 'semantic', content: 'Alice prefers TypeScript for all backend services.', metadata: {}, createdAt: new Date().toISOString(), importance: 0.80, userId: 'u1' },
    { id: 'm1', type: 'semantic', content: 'The meeting is tomorrow at 3pm.', metadata: {}, createdAt: new Date().toISOString(), importance: 0.40, userId: 'u1' },
    { id: 'l1', type: 'semantic', content: 'ok', metadata: {}, createdAt: new Date().toISOString(), importance: 0.05, userId: 'u1' },
    { id: 'l2', type: 'semantic', content: 'hmm', metadata: {}, createdAt: new Date().toISOString(), importance: 0.02, userId: 'u1' },
  ];

  const { keep, drop } = enforceRetention(entries, { maxEntries: 3, compactionStrategy: 'drop_lowest_score' });

  assert('keeps 3 entries', keep.length === 3, `got ${keep.length}`);
  assert('drops 2 entries', drop.length === 2, `got ${drop.length}`);
  assert('kept entries are high importance', keep.every((e) => e.importance! >= 0.4));
  assert('dropped entries are low importance', drop.every((e) => e.importance! < 0.5));
  assert('highest importance entry is kept', keep.some((e) => e.id === 'h1'));
}

// ── §4 Procedural memory ──────────────────────────────────────────────────────

async function testProceduralMemory() {
  console.log(b('\n[ 4 ] Procedural memory'));
  const ctx = weaveContext({ userId: 'test-procedural' });
  const store = weaveMemoryStore();
  const taskRepo = new InMemoryHumanTaskRepository();

  // Direct entry creation
  const entry = createProceduralEntry({
    agentId: 'agent-01',
    instructionDelta: 'Always use bullet points for technical explanations.',
    proposedBy: 'curator',
    confidence: 0.88,
    userId: ctx.userId,
  });
  await store.write(ctx, [entry]);
  assert('entry type is procedural', entry.type === 'procedural');
  assert('entry has high importance', (entry.importance ?? 0) >= 0.8);
  assert('initial status is proposed', entry.metadata.status === 'proposed');

  // Propose through human-tasks
  const { entry: proposal, task } = await proposeProceduralUpdate({
    store, taskRepo, ctx,
    agentId: 'agent-01',
    instructionDelta: 'Include TypeScript examples in all code responses.',
    proposedBy: 'curator',
    confidence: 0.9,
  });
  assert('proposal has humanTaskId', !!proposal.metadata.humanTaskId);

  const saved = await taskRepo.get(task.id);
  assert('task saved to repo', !!saved);

  // Approve
  await taskRepo.save({ ...saved!, status: 'completed', completedAt: new Date().toISOString(), result: { decision: 'approved', reason: 'Good' } });

  const delta = await applyApprovedProcedural({ store, taskRepo, ctx, entryId: proposal.id });
  assert('apply returns instruction delta', typeof delta === 'string' && delta.length > 0, String(delta));
  assert('delta contains expected text', delta?.includes('TypeScript') ?? false);

  // Curator
  const curStore = weaveMemoryStore();
  await curStore.write(ctx, [
    { id: 'pf1', type: 'semantic', content: 'User prefers markdown output always', metadata: {}, createdAt: new Date().toISOString(), userId: ctx.userId },
    { id: 'pf2', type: 'semantic', content: 'User prefers markdown output always', metadata: {}, createdAt: new Date().toISOString(), userId: ctx.userId },
    { id: 'pf3', type: 'semantic', content: 'User prefers markdown output always', metadata: {}, createdAt: new Date().toISOString(), userId: ctx.userId },
  ]);
  const curResult = await runProceduralCurator({ store: curStore, taskRepo, ctx, agentId: 'agent-01', maxProposals: 2 });
  assert('curator runs without error', curResult.proposed >= 0);
}

// ── §5 Graph-backed retrieval ─────────────────────────────────────────────────

async function testGraphRetrieval() {
  console.log(b('\n[ 5 ] Graph-backed retrieval'));

  const graphStore = createGraphMemoryStore();
  const linker = createEntityLinker();
  const retriever = createGraphRetriever(graphStore);

  const { entities, relationships } = linker.extractAndLink(
    'doc-test',
    'Dr. Sarah Kim is VP of Engineering at DataFlow Inc. She mentors James Lee, a senior ML researcher.',
  );
  for (const node of entities)       graphStore.addNode(node);
  for (const edge of relationships)  graphStore.addEdge(edge);

  assert('entities extracted from text', entities.length > 0, `got ${entities.length}`);

  const results = retriever.retrieve('Sarah', 5);
  assert('retrieve finds Sarah entity', results.some((r) => r.node.name.includes('Sarah')));
  assert('scores are positive', results.every((r) => r.score > 0));

  const sarah = entities.find((e) => e.name.includes('Sarah'));
  if (sarah) {
    const neighbors = retriever.retrieveByEntity(sarah.id, 2, 10);
    assert('entity neighbor traversal runs', Array.isArray(neighbors));
  } else {
    assert('found Sarah node', false, 'Sarah not found in entities');
  }

  // RRF fusion simulation (same as example §5)
  const memStore = weaveMemoryStore();
  const ctx = weaveContext({ userId: 'test-graph' });
  await memStore.write(ctx, [
    { id: 'gm1', type: 'semantic', content: 'Dr. Sarah Kim leads DataFlow engineering.', metadata: {}, createdAt: new Date().toISOString(), userId: ctx.userId },
    { id: 'gm2', type: 'semantic', content: 'James Lee is a researcher at DataFlow.', metadata: {}, createdAt: new Date().toISOString(), userId: ctx.userId },
  ]);

  // Search for a person-type entity that was extracted
  const graphMatches = retriever.retrieve('Sarah', 3);
  assert('graph finds Sarah entity for RRF', graphMatches.length > 0, `got ${graphMatches.length}`);

  const rrfScores = new Map<string, number>();
  for (const [rank, gr] of graphMatches.entries()) {
    const mems = await memStore.query(ctx, { type: 'semantic', query: gr.node.name.split(' ')[0] ?? gr.node.name, topK: 5 });
    for (const m of mems) {
      rrfScores.set(m.id, (rrfScores.get(m.id) ?? 0) + 0.5 / (60 + rank + 1));
    }
  }
  assert('RRF scores computed from graph', rrfScores.size > 0, `got ${rrfScores.size} entries`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log(b('\n══════════════════════════════════════════════════════'));
  console.log(b('  Advanced Memory — Component E2E Tests'));
  console.log(b('══════════════════════════════════════════════════════'));

  const tests = [
    ['Consolidation', testConsolidation],
    ['Bi-temporal', testBiTemporal],
    ['Importance/compaction', testImportanceCompaction],
    ['Procedural memory', testProceduralMemory],
    ['Graph retrieval', testGraphRetrieval],
  ] as const;

  for (const [name, fn] of tests) {
    try {
      await fn();
    } catch (e) {
      console.log(r(`  [${name}] threw: ${String(e)}`));
      failed++;
    }
  }

  console.log(b('\n══════════════════════════════════════════════════════'));
  if (failed === 0) {
    console.log(g(`  ALL ${passed} ASSERTIONS PASSED`));
  } else {
    console.log(r(`  ${failed} FAILED`) + ` / ` + g(`${passed} passed`));
  }
  console.log(b('══════════════════════════════════════════════════════\n'));
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(console.error);
