/**
 * Example 150 — Portable memory tool set (P4-1)
 *
 * Demonstrates `createMemoryToolSet(opts)` from @weaveintel/agents:
 * - 10 memory tools backed by in-memory callbacks
 * - Graceful degradation when callbacks are omitted
 * - Agent round-trip: remember → recall → forget
 *
 * Usage:
 *   npx ts-node examples/150-memory-tools.ts
 */

import { weaveContext, weaveRuntime } from '@weaveintel/core';
import { weaveAgent, createMemoryToolSet, createMemoryToolRegistry } from '@weaveintel/agents';
import { createMockModel } from '@weaveintel/devtools';

const runtime = weaveRuntime({});

function makeCtx() {
  return weaveContext({ executionId: `ex-${Date.now()}`, runtime });
}

// ─── In-memory backing store ──────────────────────────────────

type SemanticEntry = { id: string; content: string; memoryType: string };
type EntityEntry = { entityType: string; entityName: string; facts: Record<string, unknown> };

function createInMemoryStore() {
  const semantic: SemanticEntry[] = [];
  const entities = new Map<string, EntityEntry>();
  let snapshotState: Record<string, unknown> | null = null;

  return {
    recall: async (query: string, limit = 5) => ({
      semantic: semantic.filter((m) => m.content.toLowerCase().includes(query.toLowerCase())).slice(0, limit).map((m) => ({ content: m.content, source: 'in-memory', memoryType: m.memoryType })),
      entities: [...entities.values()].filter((e) => e.entityName.toLowerCase().includes(query.toLowerCase()) || JSON.stringify(e.facts).toLowerCase().includes(query.toLowerCase())).slice(0, limit),
    }),
    search: async (query: string, limit = 5) => ({
      semantic: semantic.filter((m) => m.content.toLowerCase().includes(query.toLowerCase())).slice(0, limit).map((m) => ({ content: m.content, source: 'in-memory', memoryType: m.memoryType })),
      entities: [...entities.values()].slice(0, limit),
    }),
    remember: async (content: string, memoryType = 'user_fact') => {
      const id = `mem-${Date.now()}`;
      semantic.push({ id, content, memoryType });
      return { id };
    },
    forget: async (entityName: string) => {
      const before = entities.size;
      entities.delete(entityName);
      const semanticBefore = semantic.length;
      const removed = semantic.filter((m) => m.content.includes(entityName));
      removed.forEach((m) => semantic.splice(semantic.indexOf(m), 1));
      return { ok: true, deletedEntities: before - entities.size, deletedSemantic: semanticBefore - semantic.length };
    },
    listEntities: async () => ({ entities: [...entities.values()] }),
    listEpisodes: async (limit = 10) => ({
      episodes: semantic.slice(-limit).map((m, i) => ({
        id: m.id,
        messageRole: 'user',
        content: m.content,
        importance: 0.5,
        createdAt: new Date().toISOString(),
      })),
    }),
    getProfile: async () => ({
      entities: [...entities.values()],
      semantic: semantic.map((m) => ({ content: m.content, source: 'in-memory', memoryType: m.memoryType })),
      episodic: [],
      procedural: [],
    }),
    saveSnapshot: async (state: Record<string, unknown>) => {
      snapshotState = state;
      return { id: 'snap-001' };
    },
    loadSnapshot: async () => ({
      snapshot: snapshotState,
      id: snapshotState ? 'snap-001' : null,
      savedAt: snapshotState ? new Date().toISOString() : null,
    }),
    proposeInstruction: async (instruction: string) => {
      console.log('  [proposed instruction]:', instruction);
      return { id: `prop-${Date.now()}` };
    },
  };
}

// ─── Scenario 1: Full tool set round-trip ─────────────────────

async function scenario1FullRoundTrip() {
  console.log('\n── Scenario 1: Remember → Recall → Forget ──');

  const store = createInMemoryStore();

  const tools = createMemoryToolSet({
    userId: 'user-alice',
    ...store,
  });

  console.log('  Registered tools:', tools.map((t) => t.schema.name).join(', '));

  // Agent that remembers a fact, then recalls it
  const model = createMockModel([
    { toolCalls: [{ id: 'tc1', name: 'memory_remember', arguments: JSON.stringify({ content: 'Alice loves hiking and photography', memoryType: 'user_fact' }) }] },
    { toolCalls: [{ id: 'tc2', name: 'memory_recall', arguments: JSON.stringify({ query: 'hobbies', limit: 5 }) }] },
    { content: 'I remember that Alice loves hiking and photography!' },
  ]);

  const agent = weaveAgent({
    model,
    tools: createMemoryToolRegistry({ userId: 'user-alice', ...store }),
    name: 'memory-agent',
    maxSteps: 5,
  });

  const result = await agent.run(makeCtx(), {
    goal: 'Remember and recall user preferences',
    messages: [{ role: 'user', content: 'Remember that I love hiking and photography, then tell me what you know about my hobbies.' }],
  });

  console.log('Status:', result.status);
  console.log('Output:', result.output);
  console.log('Steps:', result.steps.length);
}

// ─── Scenario 2: Graceful degradation (missing callbacks) ─────

async function scenario2GracefulDegradation() {
  console.log('\n── Scenario 2: Graceful degradation (no recall callback) ──');

  const tools = createMemoryToolSet({
    userId: 'user-bob',
    // Only `remember` is wired — recall/search/etc. will return isError: true
    remember: async (content) => {
      console.log('  [remember]:', content);
      return { id: 'mem-bob-001' };
    },
  });

  const model = createMockModel([
    { toolCalls: [{ id: 'tc1', name: 'memory_recall', arguments: JSON.stringify({ query: 'preferences' }) }] },
    { toolCalls: [{ id: 'tc2', name: 'memory_remember', arguments: JSON.stringify({ content: 'Bob prefers dark mode' }) }] },
    { content: 'I could not recall past memories but I have noted your dark mode preference.' },
  ]);

  const registry = createMemoryToolRegistry({ userId: 'user-bob', remember: async (content) => { console.log('  [remember]:', content); return { id: 'mem-bob-001' }; } });

  const agent = weaveAgent({
    model,
    tools: registry,
    name: 'partial-memory-agent',
    maxSteps: 5,
  });

  const result = await agent.run(makeCtx(), {
    goal: 'Test graceful degradation',
    messages: [{ role: 'user', content: 'What do you know about my preferences? Also note that I prefer dark mode.' }],
  });

  console.log('Status:', result.status);
  console.log('Output:', result.output);
}

// ─── Scenario 3: Snapshot round-trip ─────────────────────────

async function scenario3SnapshotRoundTrip() {
  console.log('\n── Scenario 3: Save and restore working state snapshot ──');

  const store = createInMemoryStore();
  const registry = createMemoryToolRegistry({ userId: 'user-charlie', ...store });

  // Step 1: Save a snapshot
  const saveModel = createMockModel([
    { toolCalls: [{ id: 'tc1', name: 'memory_snapshot', arguments: JSON.stringify({ state: { step: 3, todoList: ['write tests', 'run CI'], progress: 0.4 }, label: 'mid-task checkpoint' }) }] },
    { content: 'Working state saved.' },
  ]);

  const saveAgent = weaveAgent({ model: saveModel, tools: registry, name: 'save-agent', maxSteps: 3 });
  await saveAgent.run(makeCtx(), { goal: 'Save checkpoint', messages: [{ role: 'user', content: 'Save my progress.' }] });

  // Step 2: Reload the snapshot
  const loadModel = createMockModel([
    { toolCalls: [{ id: 'tc2', name: 'memory_load_state', arguments: '{}' }] },
    { content: 'Restored previous state: step 3, 40% complete, todo: write tests, run CI.' },
  ]);

  const loadAgent = weaveAgent({ model: loadModel, tools: registry, name: 'load-agent', maxSteps: 3 });
  const result = await loadAgent.run(makeCtx(), { goal: 'Load checkpoint', messages: [{ role: 'user', content: 'What was my previous progress?' }] });

  console.log('Status:', result.status);
  console.log('Output:', result.output);
}

// ─── Run all scenarios ─────────────────────────────────────────

(async () => {
  await scenario1FullRoundTrip();
  await scenario2GracefulDegradation();
  await scenario3SnapshotRoundTrip();
  console.log('\n✓ All memory tools scenarios complete.');
})().catch(console.error);
