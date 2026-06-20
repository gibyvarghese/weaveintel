/**
 * Example 135 — A2A-out: wrapping an agent as an A2A v1.0 server (Phase 3)
 *
 * Demonstrates `weaveAgentAsA2AServer` with Phase 3 features:
 *   - `handleMessage(ctx, params: A2ATaskSendParams)` → `Promise<A2ATask>`
 *   - `handleStreamMessage(ctx, params)` → `AsyncIterable<A2AStreamEvent>`
 *   - Task store: `getTask`, `listTasks`, `cancelTask`
 *   - Full state machine: SUBMITTED → WORKING → terminal state
 *   - Multi-turn resumption via `params.message.taskId`
 *
 * Key concepts:
 *   • `createInMemoryA2ATaskStore` — in-process store for development/tests
 *   • `weaveAgentAsA2AServer`     — wraps Agent as A2AServer
 *   • `weaveA2ABus`               — in-process bus: register/discover/send
 *   • `getTask`                   — fetch stored task by ID
 *   • `listTasks`                 — paginated task listing
 *
 * No API key needed — uses createMockModel from @weaveintel/devtools.
 *
 * Run: npx tsx examples/135-a2a-out.ts
 */

import { weaveAgent } from '@weaveintel/agents';
import { weaveAgentAsA2AServer, weaveA2ABus, createInMemoryA2ATaskStore } from '@weaveintel/a2a';
import { weaveContext, newUUIDv7 } from '@weaveintel/core';
import { a2aTaskOutputText } from '@weaveintel/core';
import { createMockModel } from '@weaveintel/devtools';

async function main() {
  // ── Build agent ──────────────────────────────────────────────────────────
  const agent = weaveAgent({
    model: createMockModel({
      name: 'mock-a2a-agent',
      responses: [
        'The capital of France is Paris.',
        'The largest country by area is Russia.',
        'Three European capitals: Berlin, Paris, Madrid.',
        'Approved! Proceeding with the workflow.',
      ],
    }),
    maxSteps: 3,
    name: 'geography-expert',
  });

  // ── Phase 3: Task store ──────────────────────────────────────────────────
  const store = createInMemoryA2ATaskStore();

  // ── Wrap agent as A2A v1.0 server with store ─────────────────────────────
  const server = weaveAgentAsA2AServer({
    agent,
    store,
    card: {
      name: 'geography-expert',
      description: 'Expert agent for geography questions',
      version: '1.0.0',
      skills: [
        {
          id: 'geography-qa',
          name: 'Geography Q&A',
          description: 'Answer geography questions',
          tags: ['geography', 'facts'],
          examples: ['What is the capital of France?', 'How large is Canada?'],
          inputModes: ['text/plain'],
          outputModes: ['text/plain'],
        },
      ],
      capabilities: {
        streaming: true,
        pushNotifications: false,
        extendedAgentCard: false,
        stateTransitionHistory: true,
      },
      supportedInterfaces: [
        { url: 'http://localhost:3001/api/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      ],
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
    },
  });

  console.log('Agent card:');
  console.log('  name:', server.card.name);
  console.log('  stateTransitionHistory:', server.card.capabilities.stateTransitionHistory);
  console.log('  endpoint:', server.card.supportedInterfaces[0]?.url);

  // ── Register on in-process bus ───────────────────────────────────────────
  const bus = weaveA2ABus();
  bus.register(server.card.name, server);

  const ctx = weaveContext({});
  const contextId = newUUIDv7();

  // ── 1. Direct handleMessage call (SUBMITTED → WORKING → COMPLETED) ───────
  console.log('\n--- 1. Direct handleMessage (full state machine) ---');
  const task = await server.handleMessage(ctx, {
    message: {
      role: 'user',
      parts: [{ text: 'What is the capital of France?' }],
      contextId,
      messageId: newUUIDv7(),
    },
  });

  console.log('Task ID:', task.id);
  console.log('State:', task.status.state);         // TASK_STATE_COMPLETED
  console.log('Output:', a2aTaskOutputText(task));
  console.log('History msgs:', task.history.length);

  // ── 2. Load stored task ──────────────────────────────────────────────────
  console.log('\n--- 2. Load stored task via getTask ---');
  const storedTask = await server.getTask!(ctx, task.id);
  console.log('Stored state:', storedTask?.status.state);
  console.log('Stored output:', a2aTaskOutputText(storedTask!));

  // ── 3. List tasks ────────────────────────────────────────────────────────
  console.log('\n--- 3. List all tasks ---');
  await server.handleMessage(ctx, {
    message: { role: 'user', parts: [{ text: 'What is the largest country by area?' }], contextId, messageId: newUUIDv7() },
  });
  const page = await server.listTasks!(ctx, { contextId });
  console.log('Tasks in context:', page.tasks.length);
  console.log('States:', page.tasks.map((t) => t.status.state).join(', '));

  // ── 4. Cancel a task ─────────────────────────────────────────────────────
  console.log('\n--- 4. Cancel a task ---');
  const cancelTarget = await server.handleMessage(ctx, {
    message: { role: 'user', parts: [{ text: 'Name three European capitals.' }], contextId, messageId: newUUIDv7() },
  });
  console.log('Before cancel:', cancelTarget.status.state);
  await server.cancelTask!(ctx, cancelTarget.id);
  const afterCancel = await store.load(cancelTarget.id);
  console.log('After cancel:', afterCancel?.status.state);  // TASK_STATE_CANCELED

  // ── 5. Via bus.send() ────────────────────────────────────────────────────
  console.log('\n--- 5. Via bus.send() ---');
  const busResult = await bus.send(ctx, 'geography-expert', {
    message: { role: 'user', parts: [{ text: 'What is the largest country by area?' }], contextId, messageId: newUUIDv7() },
  });
  console.log('Bus result state:', busResult.status.state);
  console.log('Bus result output:', a2aTaskOutputText(busResult));

  // ── 6. Streaming via handleStreamMessage ─────────────────────────────────
  if (server.handleStreamMessage) {
    console.log('\n--- 6. Streaming handleStreamMessage ---');
    let artifactChunks = 0;
    let statusUpdates = 0;
    let finalTask = null;

    for await (const event of server.handleStreamMessage(ctx, {
      message: { role: 'user', parts: [{ text: 'Name three European capitals.' }], contextId, messageId: newUUIDv7() },
    })) {
      if ('statusUpdate' in event) {
        statusUpdates++;
        process.stdout.write(`[status: ${event.statusUpdate.status.state}] `);
      } else if ('artifactUpdate' in event) {
        artifactChunks++;
      } else if ('task' in event) {
        finalTask = event.task;
        process.stdout.write(`\n[final: ${event.task.status.state}]\n`);
      }
    }

    console.log(`Status updates: ${statusUpdates}, artifact chunks: ${artifactChunks}`);
    if (finalTask) {
      const stored = await store.load(finalTask.id);
      console.log('Stream task stored:', stored?.status.state);
    }
  }

  // ── 7. Deprecated handleTask shim (still works) ──────────────────────────
  console.log('\n--- 7. Deprecated handleTask shim ---');
  if (server.handleTask) {
    const legacyResult = await server.handleTask(ctx, {
      id: newUUIDv7(),
      input: { role: 'user', parts: [{ text: 'What is the capital of Japan?' }] },
    });
    console.log('Legacy status:', legacyResult.status);
    console.log('Legacy output:', legacyResult.output?.parts[0]?.text?.slice(0, 60));
  }

  // ── 8. Final list — all tasks ────────────────────────────────────────────
  console.log('\n--- 8. Final task inventory ---');
  const allTasks = await server.listTasks!(ctx);
  console.log('Total tasks stored:', allTasks.totalSize ?? allTasks.tasks.length);
  const stateCounts: Record<string, number> = {};
  for (const t of allTasks.tasks) {
    stateCounts[t.status.state] = (stateCounts[t.status.state] ?? 0) + 1;
  }
  for (const [state, count] of Object.entries(stateCounts)) {
    console.log(`  ${state}: ${count}`);
  }
}

main().catch(console.error);
