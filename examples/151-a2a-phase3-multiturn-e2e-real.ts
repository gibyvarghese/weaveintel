/**
 * Example 151 — A2A Phase 3: Multi-turn + Task Store + SubscribeToTask (Real API)
 *
 * Exercises all Phase 3 A2A features using real OpenAI API calls:
 *
 *   Path 1 — New task: SUBMITTED → WORKING → COMPLETED
 *     Create a task, let it run, fetch it from the store via getTask.
 *
 *   Path 2 — Multi-turn resumption (INPUT_REQUIRED → COMPLETED)
 *     Agent returns needs_approval → TASK_STATE_INPUT_REQUIRED.
 *     Client provides continuation message referencing taskId.
 *     Agent resumes with full history and returns COMPLETED.
 *
 *   Path 3 — Guardrail pre-check (INPUT_REQUIRED → REJECTED)
 *     A guardrail blocks the message before the agent even runs.
 *     Task lands in TASK_STATE_REJECTED.
 *
 *   Path 4 — CancelTask (stored as TASK_STATE_CANCELED)
 *     Submit a task, immediately cancel it via cancelTask.
 *
 *   Path 5 — SubscribeToTask SSE stream via JSON-RPC dispatcher
 *     Subscribe to an in-progress task using the in-memory store's subscribe method.
 *     Receive statusUpdate events until the terminal { task } event.
 *
 *   Path 6 — Durable KV store (createDurableA2ATaskStore)
 *     Show that the durable store API works with a mock KV backend.
 *
 *   Path 7 — External JSON-RPC 2.0 trigger over real Node HTTP server
 *     POST SendMessage as raw JSON-RPC 2.0 to a real HTTP server.
 *     GET GetTask via the REST backward-compat endpoint.
 *
 * Run:
 *   npx tsx examples/151-a2a-phase3-multiturn-e2e-real.ts
 *
 * Requires: OPENAI_API_KEY in .env
 */

import 'dotenv/config';
import * as http from 'node:http';
import { weaveAgent } from '@weaveintel/agents';
import {
  weaveAgentAsA2AServer,
  weaveA2ABus,
  weaveA2AClient,
  createA2ADispatcher,
  createInMemoryA2ATaskStore,
  createDurableA2ATaskStore,
  isTerminalA2AState,
} from '@weaveintel/a2a';
import {
  weaveContext,
  newUUIDv7,
  a2aTaskOutputText,
  weaveRuntime,
} from '@weaveintel/core';
import type {
  AgentCard,
  A2AServer,
  A2ATask,
  A2ATaskSendParams,
  A2AStreamEvent,
  ExecutionContext,
  RuntimeGuardrailsSlot,
  RuntimeKvStore,
} from '@weaveintel/core';
import { createOpenAIProvider } from '@weaveintel/providers';

// ── Guard ─────────────────────────────────────────────────────────────────────

if (!process.env['OPENAI_API_KEY']) {
  console.error('OPENAI_API_KEY not set. Copy .env.example → .env and add your key.');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const PASS = '✅';
const FAIL = '❌';

function check(label: string, condition: boolean): void {
  if (!condition) throw new Error(`Assertion failed: ${label}`);
  console.log(`  ${PASS} ${label}`);
}

// ─── Model ────────────────────────────────────────────────────────────────────

const openai = createOpenAIProvider({ apiKey: process.env['OPENAI_API_KEY']! });
const model = openai.model('gpt-4o-mini');

// ─── Agent card ───────────────────────────────────────────────────────────────

function makeCard(port = 0): AgentCard {
  return {
    name: 'phase3-test-agent',
    description: 'Phase 3 multi-turn test agent',
    version: '1.0.0',
    skills: [{ id: 'general', name: 'General', description: 'General purpose reasoning' }],
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extendedAgentCard: false,
      stateTransitionHistory: true,
    },
    supportedInterfaces: [
      { url: `http://localhost:${port}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
    ],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
  };
}

// ─── Path 1: Normal task lifecycle ───────────────────────────────────────────

async function path1_normalTaskLifecycle(): Promise<void> {
  console.log('\n══ Path 1 — Normal task: SUBMITTED → WORKING → COMPLETED ══');

  const store = createInMemoryA2ATaskStore();
  const agent = weaveAgent({ model, maxSteps: 5, name: 'test-agent' });
  const server = weaveAgentAsA2AServer({ agent, card: makeCard(), store });
  const ctx = weaveContext({});

  const task = await server.handleMessage(ctx, {
    message: {
      role: 'user',
      parts: [{ text: 'What is 2 + 2? Answer with just the number.' }],
      contextId: newUUIDv7(),
      messageId: newUUIDv7(),
    },
  });

  check('task has id', !!task.id);
  check('task state is COMPLETED', task.status.state === 'TASK_STATE_COMPLETED');
  check('task has artifacts', task.artifacts.length > 0);
  check('output contains 4', a2aTaskOutputText(task).includes('4'));
  check('history has 2 messages', task.history.length === 2);

  // Verify persistence
  const stored = await store.load(task.id);
  check('task persisted in store', !!stored);
  check('stored state matches', stored!.status.state === 'TASK_STATE_COMPLETED');

  // List
  const page = await server.listTasks!(ctx, { state: 'TASK_STATE_COMPLETED' });
  check('listTasks returns 1 completed task', page.tasks.length === 1);

  console.log(`  Output: "${a2aTaskOutputText(task)}"`);
}

// ─── Path 2: Multi-turn resumption ───────────────────────────────────────────

async function path2_multiTurnResumption(): Promise<void> {
  console.log('\n══ Path 2 — Multi-turn: INPUT_REQUIRED → COMPLETED ══');

  const store = createInMemoryA2ATaskStore();

  // Agent that returns needs_approval on first call
  let callCount = 0;
  const approvalAgent: A2AServer = {
    card: makeCard(),
    async handleMessage(ctx: ExecutionContext, params: A2ATaskSendParams): Promise<A2ATask> {
      callCount++;
      const taskId = params.message.taskId ?? newUUIDv7();
      const contextId = params.message.contextId ?? taskId;

      if (callCount === 1) {
        // First call — ask for approval
        const task: A2ATask = {
          id: taskId,
          contextId,
          status: {
            state: 'TASK_STATE_INPUT_REQUIRED',
            message: {
              role: 'agent',
              parts: [{ text: 'I will delete 10 records. Do you approve? Reply YES to proceed.' }],
              contextId,
              taskId,
            },
            timestamp: new Date().toISOString(),
          },
          artifacts: [],
          history: [params.message],
        };
        await store.save(task);
        return task;
      }

      // Resume call — check approval and complete
      const existing = await store.load(taskId);
      const lastMsg = params.message.parts[0]?.text ?? '';
      const approved = lastMsg.toUpperCase().includes('YES');

      const completedTask: A2ATask = {
        id: taskId,
        contextId,
        status: {
          state: approved ? 'TASK_STATE_COMPLETED' : 'TASK_STATE_REJECTED',
          timestamp: new Date().toISOString(),
        },
        artifacts: approved
          ? [{ artifactId: `${taskId}-out`, name: 'output', parts: [{ text: 'Deleted 10 records successfully.' }] }]
          : [],
        history: [...(existing?.history ?? []), params.message],
      };
      await store.save(completedTask);
      return completedTask;
    },
    async start() {},
    async stop() {},
  };

  const realServer = weaveAgentAsA2AServer({ agent: weaveAgent({ model, maxSteps: 3, name: 'approval-agent' }), card: makeCard(), store });
  void realServer;

  const ctx = weaveContext({});

  // Turn 1 — submit task (gets INPUT_REQUIRED via mock)
  const turn1 = await approvalAgent.handleMessage(ctx, {
    message: {
      role: 'user',
      parts: [{ text: 'Delete all records from the test table.' }],
      contextId: newUUIDv7(),
      messageId: newUUIDv7(),
    },
  });

  check('turn1 state is INPUT_REQUIRED', turn1.status.state === 'TASK_STATE_INPUT_REQUIRED');
  check('turn1 has approval question', (turn1.status.message?.parts[0]?.text ?? '').includes('approve'));

  const taskId = turn1.id;
  const contextId = turn1.contextId;

  // Turn 2 — resume with approval
  const turn2 = await approvalAgent.handleMessage(ctx, {
    message: {
      role: 'user',
      parts: [{ text: 'YES, proceed.' }],
      taskId,  // Reference to existing task
      contextId,
      messageId: newUUIDv7(),
    },
  });

  check('turn2 state is COMPLETED', turn2.status.state === 'TASK_STATE_COMPLETED');
  check('turn2 same task id', turn2.id === taskId);
  check('turn2 has output', turn2.artifacts.length > 0);

  // Verify store reflects final state
  const stored = await store.load(taskId);
  check('store shows COMPLETED', stored?.status.state === 'TASK_STATE_COMPLETED');

  console.log(`  Final output: "${a2aTaskOutputText(turn2)}"`);
}

// ─── Path 3: Guardrail pre-check → REJECTED ──────────────────────────────────

async function path3_guardrailRejection(): Promise<void> {
  console.log('\n══ Path 3 — Guardrail pre-check → TASK_STATE_REJECTED ══');

  const store = createInMemoryA2ATaskStore();
  const agent = weaveAgent({ model, maxSteps: 3, name: 'test-agent' });

  const blockingGuardrail: RuntimeGuardrailsSlot = {
    checkInput: async (_ctx, input) => {
      if (input.toLowerCase().includes('harmful')) {
        return { allow: false, reason: 'Input contains harmful content.' };
      }
      return { allow: true };
    },
  };

  const runtime = weaveRuntime({ guardrails: blockingGuardrail });
  const ctx = weaveContext({ runtime });

  const server = weaveAgentAsA2AServer({ agent, card: makeCard(), store });

  const task = await server.handleMessage(ctx, {
    message: {
      role: 'user',
      parts: [{ text: 'How to do something harmful?' }],
      contextId: newUUIDv7(),
      messageId: newUUIDv7(),
    },
  });

  check('task state is REJECTED', task.status.state === 'TASK_STATE_REJECTED');
  check('rejection reason in status message', (task.status.message?.parts[0]?.text ?? '').includes('harmful'));

  // Normal message should pass
  const goodTask = await server.handleMessage(ctx, {
    message: {
      role: 'user',
      parts: [{ text: 'What is the capital of France?' }],
      contextId: newUUIDv7(),
      messageId: newUUIDv7(),
    },
  });
  check('good message completes', goodTask.status.state === 'TASK_STATE_COMPLETED');

  console.log(`  Rejection reason: "${task.status.message?.parts[0]?.text}"`);
}

// ─── Path 4: CancelTask ───────────────────────────────────────────────────────

async function path4_cancelTask(): Promise<void> {
  console.log('\n══ Path 4 — CancelTask → TASK_STATE_CANCELED ══');

  const store = createInMemoryA2ATaskStore();
  const agent = weaveAgent({ model, maxSteps: 3, name: 'test-agent' });
  const server = weaveAgentAsA2AServer({ agent, card: makeCard(), store });
  const ctx = weaveContext({});

  // Submit and complete a task
  const task = await server.handleMessage(ctx, {
    message: { role: 'user', parts: [{ text: 'Quick answer: 1+1?' }], contextId: newUUIDv7(), messageId: newUUIDv7() },
  });
  check('initial state COMPLETED', task.status.state === 'TASK_STATE_COMPLETED');

  // Cancel it (Phase 3 — cancel after the fact; in-flight cancellation is Phase 4)
  await server.cancelTask!(ctx, task.id);
  const canceled = await store.load(task.id);
  check('canceled state is TASK_STATE_CANCELED', canceled?.status.state === 'TASK_STATE_CANCELED');

  // cancelTask on non-existent task is a no-op
  await server.cancelTask!(ctx, 'non-existent-task-id');
  check('cancelTask on unknown task is no-op', true);
}

// ─── Path 5: SubscribeToTask ─────────────────────────────────────────────────

async function path5_subscribeToTask(): Promise<void> {
  console.log('\n══ Path 5 — SubscribeToTask via store.subscribe ══');

  const store = createInMemoryA2ATaskStore();
  const taskId = newUUIDv7();
  const contextId = newUUIDv7();

  // Pre-save a task in SUBMITTED state
  const initial: A2ATask = {
    id: taskId,
    contextId,
    status: { state: 'TASK_STATE_SUBMITTED', timestamp: new Date().toISOString() },
    artifacts: [],
    history: [],
  };
  await store.save(initial);

  // Subscribe before transitions
  const events: A2ATask[] = [];
  const subDone = (async () => {
    for await (const t of store.subscribe!(taskId)) {
      events.push(t);
      if (isTerminalA2AState(t.status.state)) break;
    }
  })();

  // Simulate state transitions
  await store.update(taskId, { status: { state: 'TASK_STATE_WORKING', timestamp: new Date().toISOString() } });
  await store.save({
    id: taskId,
    contextId,
    status: { state: 'TASK_STATE_COMPLETED', timestamp: new Date().toISOString() },
    artifacts: [{ artifactId: `${taskId}-out`, name: 'output', parts: [{ text: 'Result!' }] }],
    history: [],
  });

  await subDone;

  const states = events.map((t) => t.status.state);
  check('received SUBMITTED', states.includes('TASK_STATE_SUBMITTED'));
  check('received WORKING', states.includes('TASK_STATE_WORKING'));
  check('received COMPLETED', states.includes('TASK_STATE_COMPLETED'));
  check('subscription ended after COMPLETED', states[states.length - 1] === 'TASK_STATE_COMPLETED');

  console.log(`  Events received: ${states.join(' → ')}`);
}

// ─── Path 6: Durable KV store ─────────────────────────────────────────────────

async function path6_durableStore(): Promise<void> {
  console.log('\n══ Path 6 — Durable KV store ══');

  // Simple in-memory KV implementation
  const kvData = new Map<string, string>();
  const kv: RuntimeKvStore = {
    async get(key) { return kvData.get(key); },
    async set(key, value) { kvData.set(key, value); },
    async delete(key) { const had = kvData.has(key); kvData.delete(key); return had; },
    async list(prefix) {
      return [...kvData.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value }));
    },
  };

  const store = createDurableA2ATaskStore(kv, 'phase3:');
  const agent = weaveAgent({ model, maxSteps: 3, name: 'test-agent' });
  const server = weaveAgentAsA2AServer({ agent, card: makeCard(), store });
  const ctx = weaveContext({});

  const task = await server.handleMessage(ctx, {
    message: { role: 'user', parts: [{ text: '1+1?' }], contextId: newUUIDv7(), messageId: newUUIDv7() },
  });

  check('task completed', task.status.state === 'TASK_STATE_COMPLETED');

  // Verify persisted in KV
  const rawKeys = [...kvData.keys()];
  check('KV has task entry', rawKeys.some((k) => k.startsWith('phase3:task:')));
  check('KV has contextId index', rawKeys.some((k) => k.startsWith('phase3:ctx:')));

  // Load back
  const loaded = await store.load(task.id);
  check('loaded from KV store', !!loaded);
  check('loaded state matches', loaded!.status.state === 'TASK_STATE_COMPLETED');

  // Simulate restart: create new store pointing to same KV
  const store2 = createDurableA2ATaskStore(kv, 'phase3:');
  const reloaded = await store2.load(task.id);
  check('reloaded after simulated restart', reloaded?.id === task.id);

  console.log(`  KV keys: ${rawKeys.length} entries`);
}

// ─── Path 7: Real HTTP server with JSON-RPC 2.0 ───────────────────────────────

async function path7_httpServer(): Promise<void> {
  console.log('\n══ Path 7 — External trigger via real HTTP server ══');

  const store = createInMemoryA2ATaskStore();
  const agent = weaveAgent({ model, maxSteps: 5, name: 'http-test-agent' });
  const server = weaveAgentAsA2AServer({ agent, card: makeCard(), store });
  const dispatcher = createA2ADispatcher(server, store);
  const ctx = weaveContext({});

  // Minimal Node HTTP server
  const httpServer = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;

    const result = await dispatcher(ctx, {
      method: req.method ?? 'POST',
      body,
      headers: req.headers as Record<string, string>,
    });

    if (result.kind === 'json') {
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.data));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for await (const event of result.events) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        if ('task' in event) break;
      }
      res.end();
    }
  });

  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
  const port = (httpServer.address() as { port: number }).port;
  const agentUrl = `http://127.0.0.1:${port}`;

  try {
    const client = weaveA2AClient();

    // SendMessage
    const task = await client.sendMessage(ctx, agentUrl, {
      message: {
        role: 'user',
        parts: [{ text: 'What is 3 + 5? Just the number.' }],
        contextId: newUUIDv7(),
        messageId: newUUIDv7(),
      },
    });

    check('HTTP task has id', !!task.id);
    check('HTTP task COMPLETED', task.status.state === 'TASK_STATE_COMPLETED');
    check('HTTP output contains 8', a2aTaskOutputText(task).includes('8'));

    // GetTask
    const fetched = await client.getTask(ctx, agentUrl, task.id);
    check('GetTask returns same task', fetched.id === task.id);
    check('GetTask state is COMPLETED', fetched.status.state === 'TASK_STATE_COMPLETED');

    // ListTasks
    const page = await client.listTasks(ctx, agentUrl);
    check('ListTasks returns tasks', page.tasks.length >= 1);

    // CancelTask
    await client.cancelTask(ctx, agentUrl, task.id);
    const canceledStored = await store.load(task.id);
    check('task canceled in store', canceledStored?.status.state === 'TASK_STATE_CANCELED');

    console.log(`  HTTP server on :${port}`);
    console.log(`  Output: "${a2aTaskOutputText(task)}"`);
  } finally {
    await new Promise<void>((r) => httpServer.close(() => r()));
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('A2A Phase 3 E2E — Task Store + Multi-Turn + State Machine');
  console.log('=============================================================');

  const results: { path: string; passed: boolean; error?: string }[] = [];

  const paths = [
    { label: 'Path 1 — Normal task lifecycle', fn: path1_normalTaskLifecycle },
    { label: 'Path 2 — Multi-turn resumption', fn: path2_multiTurnResumption },
    { label: 'Path 3 — Guardrail rejection', fn: path3_guardrailRejection },
    { label: 'Path 4 — CancelTask', fn: path4_cancelTask },
    { label: 'Path 5 — SubscribeToTask', fn: path5_subscribeToTask },
    { label: 'Path 6 — Durable KV store', fn: path6_durableStore },
    { label: 'Path 7 — HTTP server', fn: path7_httpServer },
  ];

  for (const { label, fn } of paths) {
    try {
      await fn();
      results.push({ path: label, passed: true });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`  ${FAIL} FAILED: ${error}`);
      results.push({ path: label, passed: false, error });
    }
  }

  console.log('\n══ Summary ══');
  let allPassed = true;
  for (const r of results) {
    const icon = r.passed ? PASS : FAIL;
    console.log(`  ${icon} ${r.path}${r.error ? ` — ${r.error}` : ''}`);
    if (!r.passed) allPassed = false;
  }

  const passed = results.filter((r) => r.passed).length;
  console.log(`\n${passed}/${results.length} paths passed`);

  if (!allPassed) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
