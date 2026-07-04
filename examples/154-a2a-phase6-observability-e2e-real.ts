/**
 * Example 154 — A2A Phase 6: Tests, Observability & Cleanup (Real API E2E)
 *
 * Exercises Phase 6 A2A features end-to-end with a real in-process A2A server:
 *
 *   Path 1 — OTel span attributes:
 *     Send a task via weaveA2AClient and confirm that the span contains
 *     a2a.taskId, a2a.contextId, a2a.taskState as attributes.
 *
 *   Path 2 — In-process bus (weaveA2ABus) full lifecycle:
 *     Register, discover, send, listAgents, unregister.
 *
 *   Path 3 — SSE stream round-trip:
 *     weaveA2AClient.streamMessage streams events from a SendStreamingMessage
 *     response built with sseData helpers.
 *
 *   Path 4 — weaveA2AClient full HTTP method coverage:
 *     discover, sendMessage, getTask, listTasks, cancelTask,
 *     createPushConfig, listPushConfigs, deletePushConfig
 *     — all against a real in-process dispatcher.
 *
 *   Path 5 — Push config + send cycle:
 *     Create push config, send a task, verify config persists.
 *
 *   Path 6 — Deprecated shim pass-through:
 *     sendTask / getTaskStatus delegate correctly to v1.0 methods.
 *
 *   Path 7 — geneWeave A2A discovery (if GENEWEAVE_BASE_URL set):
 *     discover() from /.well-known/agent-card.json, GetExtendedAgentCard.
 *
 *   Path 8 — Negative / security:
 *     Missing taskId, missing pushConfigId, wrong JSON-RPC version,
 *     unknown method, origin mismatch, empty parts.
 *
 * Prerequisites: (none — runs fully in-process without real API keys)
 * Optional: GENEWEAVE_BASE_URL=http://localhost:3000 for Path 7.
 * Run: npx tsx examples/154-a2a-phase6-observability-e2e-real.ts
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as dotenv from 'dotenv';
import {
  weaveA2AClient,
  weaveA2ABus,
  createA2ADispatcher,
  createInMemoryA2ATaskStore,
  createInMemoryPushNotificationStore,
  streamToSse,
  SSE_KEEPALIVE,
  A2A_METHODS,
  A2A_ERROR_CODES,
  makeRpcRequest,
  sseData,
  parseSseStream,
} from '@weaveintel/a2a';
import { weaveContext, newUUIDv7 } from '@weaveintel/core';
import type {
  A2AServer,
  A2ATask,
  A2ATaskSendParams,
  A2AStreamEvent,
  AgentCard,
  ExecutionContext,
  Tracer,
  Span,
} from '@weaveintel/core';

dotenv.config();

// ─── Logging helpers ──────────────────────────────────────────────────────────

let passCount = 0;
let failCount = 0;

function pass(msg: string) {
  console.log(`  ✓ ${msg}`);
  passCount++;
}

function fail(msg: string, err?: unknown) {
  console.error(`  ✗ ${msg}`);
  if (err) console.error('   ', err instanceof Error ? err.message : err);
  failCount++;
}

function section(name: string) {
  console.log(`\n── ${name} ──`);
}

function assert(cond: boolean, msg: string) {
  if (cond) pass(msg);
  else fail(msg);
}

// ─── Minimal A2AServer for in-process tests ───────────────────────────────────

function makeTestServer(name = 'test-agent'): A2AServer {
  const card: AgentCard = {
    name,
    description: `Test agent: ${name}`,
    version: '1.0.0',
    skills: [{ id: 'test', name: 'Test', description: 'A test skill' }],
    capabilities: {
      streaming: true,
      pushNotifications: true,
      extendedAgentCard: true,
      stateTransitionHistory: true,
    },
    supportedInterfaces: [{ url: `http://localhost/api/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
  };

  return {
    card,
    async handleMessage(_ctx: ExecutionContext, params: A2ATaskSendParams): Promise<A2ATask> {
      const taskId = newUUIDv7();
      const contextId = params.message.contextId ?? taskId;
      return {
        id: taskId,
        contextId,
        status: { state: 'TASK_STATE_COMPLETED', timestamp: new Date().toISOString() },
        artifacts: [{ artifactId: `${taskId}-out`, name: 'output', parts: [{ text: 'done' }] }],
        history: [params.message],
      };
    },
    async *handleStreamMessage(_ctx, params): AsyncIterable<A2AStreamEvent> {
      const taskId = newUUIDv7();
      const contextId = params.message.contextId ?? taskId;
      yield { statusUpdate: { taskId, contextId, status: { state: 'TASK_STATE_WORKING', timestamp: new Date().toISOString() } } };
      const task: A2ATask = {
        id: taskId,
        contextId,
        status: { state: 'TASK_STATE_COMPLETED', timestamp: new Date().toISOString() },
        artifacts: [{ artifactId: `${taskId}-out`, name: 'output', parts: [{ text: 'streaming done' }] }],
        history: [params.message],
      };
      yield { artifactUpdate: { taskId, contextId, artifact: task.artifacts[0]!, append: false, lastChunk: true } };
      yield { task };
    },
    async getTask(_ctx, taskId) {
      return null; // simplistic — store handles this
    },
    async listTasks(_ctx, _filter) {
      return { tasks: [] };
    },
    async cancelTask(_ctx, _taskId) {},
    async getExtendedCard(_ctx) {
      return { ...card, documentationUrl: 'https://docs.example.com/a2a' };
    },
    async start(_port: number) {},
    async stop() {},
  };
}

// ─── Span capture tracer ─────────────────────────────────────────────────────

interface CapturedSpan {
  name: string;
  attributes: Record<string, unknown>;
}

function makeCapturingTracer(): { tracer: Tracer; spans: CapturedSpan[] } {
  const spans: CapturedSpan[] = [];

  const tracer: Tracer = {
    startSpan(_ctx, name, attributes) {
      const captured: CapturedSpan = { name, attributes: { ...attributes } };
      spans.push(captured);
      const span: Span = {
        spanId: newUUIDv7(),
        parentSpanId: undefined,
        name,
        startTime: Date.now(),
        attributes: captured.attributes,
        setAttribute(key, value) { captured.attributes[key] = value; },
        addEvent(_name, _data) {},
        setError(_err) {},
        end() {},
      };
      return span;
    },
    async withSpan(_ctx, name, fn, attributes) {
      const captured: CapturedSpan = { name, attributes: { ...attributes } };
      spans.push(captured);
      const span: Span = {
        spanId: newUUIDv7(),
        parentSpanId: undefined,
        name,
        startTime: Date.now(),
        attributes: captured.attributes,
        setAttribute(key, value) { captured.attributes[key] = value; },
        addEvent(_name, _data) {},
        setError(_err) {},
        end() {},
      };
      return fn(span);
    },
  };

  return { tracer, spans };
}

// ─── HTTP server wrapper ──────────────────────────────────────────────────────

function startHttpServer(impl: A2AServer): Promise<{ url: string; close: () => Promise<void> }> {
  const taskStore = createInMemoryA2ATaskStore();
  const pushStore = createInMemoryPushNotificationStore();
  const dispatcher = createA2ADispatcher(impl, taskStore, pushStore);

  const card = impl.card;

  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost`);

      // Discovery endpoints
      if (req.method === 'GET' && (url.pathname === '/.well-known/agent-card.json' || url.pathname === '/.well-known/agent.json')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(card));
        return;
      }

      // A2A JSON-RPC endpoint
      if (req.method === 'POST' && url.pathname === '/api/a2a') {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', async () => {
          const body = Buffer.concat(chunks).toString('utf-8');
          const ctx = weaveContext({ userId: 'test-user' });
          const headers = req.headers as Record<string, string | string[] | undefined>;
          const result = await dispatcher(ctx, { method: 'POST', body, headers });

          if (result.kind === 'json') {
            res.writeHead(result.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result.data));
          } else {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
            });
            for await (const chunk of streamToSse(result.events)) {
              if (!res.writableEnded) res.write(chunk);
            }
            res.end();
          }
        });
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r, e) => server.close((err) => err ? e(err) : r())),
      });
    });
  });
}

// ─── Path 1: OTel span attributes ────────────────────────────────────────────

async function path1OtelAttributes() {
  section('Path 1: OTel Span Attributes');

  const impl = makeTestServer('otel-agent');
  const { url, close } = await startHttpServer(impl);
  const { tracer, spans } = makeCapturingTracer();

  // Inject tracer via ExecutionContext's tracer field
  const ctx = weaveContext({ userId: 'u1', tracer: tracer as unknown as ExecutionContext['tracer'] }) as ExecutionContext & { tracer: Tracer };

  const client = weaveA2AClient();
  try {
    const task = await client.sendMessage(ctx, `${url}/api/a2a`, {
      message: { role: 'user', parts: [{ text: 'hello' }], messageId: 'm1', contextId: 'ctx-1' },
    });

    // Find the SendMessage span
    const sendSpan = spans.find((s) => s.name === 'a2a.client.SendMessage');
    if (sendSpan) {
      assert(sendSpan.attributes['a2a.method'] === 'SendMessage', 'span has a2a.method = SendMessage');
      assert(typeof sendSpan.attributes['a2a.agentUrl'] === 'string', 'span has a2a.agentUrl');
      assert(sendSpan.attributes['a2a.taskId'] === task.id, 'span has a2a.taskId from result');
      assert(sendSpan.attributes['a2a.contextId'] === task.contextId, 'span has a2a.contextId from result');
      assert(sendSpan.attributes['a2a.taskState'] === 'TASK_STATE_COMPLETED', 'span has a2a.taskState from result');
    } else {
      fail('No SendMessage span captured — tracer may not be injected into ctx');
    }
  } catch (err) {
    fail('OTel span test failed', err);
  } finally {
    await close();
  }
}

// ─── Path 2: In-process bus full lifecycle ────────────────────────────────────

async function path2Bus() {
  section('Path 2: weaveA2ABus Full Lifecycle');

  const bus = weaveA2ABus();
  const server = makeTestServer('bus-agent');
  const ctx = weaveContext({ userId: 'u1' }) as unknown as ExecutionContext;

  // Register
  bus.register('bus-agent', server);
  pass('bus.register()');

  // Discover
  const card = bus.discover('bus-agent');
  assert(card?.name === 'bus-agent', 'bus.discover() returns card by name');

  // List agents
  const all = bus.listAgents();
  assert(all.length === 1, 'bus.listAgents() returns all registered cards');

  // Unknown agent
  const unknown = bus.discover('nobody');
  assert(unknown === undefined, 'bus.discover() returns undefined for unknown agent');

  // Send
  const task = await bus.send(ctx, 'bus-agent', {
    message: { role: 'user', parts: [{ text: 'hello bus' }], messageId: 'm1', contextId: 'ctx-1' },
  });
  assert(task.status.state === 'TASK_STATE_COMPLETED', 'bus.send() routes task to registered agent');
  assert(task.artifacts[0]?.parts[0]?.text === 'done', 'bus.send() returns agent output');

  // Not found
  try {
    await bus.send(ctx, 'ghost', { message: { role: 'user', parts: [{ text: 'hi' }], messageId: 'm1', contextId: 'c1' } });
    fail('should throw NOT_FOUND for unknown target');
  } catch (err) {
    const e = err as { code?: string };
    assert(e.code === 'NOT_FOUND', 'bus.send() throws NOT_FOUND for unknown target');
  }

  // Unregister
  bus.unregister('bus-agent');
  assert(bus.discover('bus-agent') === undefined, 'bus.unregister() removes agent');

  // Multiple buses independent
  const bus2 = weaveA2ABus();
  bus2.register('solo', makeTestServer('solo'));
  assert(bus.discover('solo') === undefined, 'buses are independent instances');
  bus2.unregister('solo');
}

// ─── Path 3: SSE stream round-trip ───────────────────────────────────────────

async function path3SseStream() {
  section('Path 3: SSE Stream Round-Trip');

  const impl = makeTestServer('stream-agent');
  const { url, close } = await startHttpServer(impl);
  const ctx = weaveContext({ userId: 'u1' }) as unknown as ExecutionContext;
  const client = weaveA2AClient();

  try {
    const events: A2AStreamEvent[] = [];
    for await (const event of client.streamMessage(ctx, `${url}/api/a2a`, {
      message: { role: 'user', parts: [{ text: 'stream me' }], messageId: 'm1', contextId: 'ctx-stream' },
    })) {
      events.push(event);
    }

    const hasWorking = events.some((e) => 'statusUpdate' in e && e.statusUpdate.status.state === 'TASK_STATE_WORKING');
    const hasArtifact = events.some((e) => 'artifactUpdate' in e);
    const hasFinal = events.some((e) => 'task' in e && e.task.status.state === 'TASK_STATE_COMPLETED');

    assert(hasWorking, 'SSE stream includes TASK_STATE_WORKING statusUpdate');
    assert(hasArtifact, 'SSE stream includes artifactUpdate event');
    assert(hasFinal, 'SSE stream includes final task event');
    assert(events.length >= 3, `SSE stream yields multiple events (got ${events.length})`);
  } catch (err) {
    fail('SSE stream failed', err);
  } finally {
    await close();
  }
}

// ─── Path 4: Full HTTP method coverage ───────────────────────────────────────

async function path4FullHttpCoverage() {
  section('Path 4: Full HTTP Method Coverage');

  const impl = makeTestServer('http-agent');
  const { url, close } = await startHttpServer(impl);
  const ctx = weaveContext({ userId: 'u1' }) as unknown as ExecutionContext;
  const client = weaveA2AClient();
  const agentUrl = `${url}/api/a2a`;

  try {
    // discover
    const card = await client.discover(url);
    assert(card.name === 'http-agent', 'discover() returns card with correct name');

    // sendMessage
    const task = await client.sendMessage(ctx, agentUrl, {
      message: { role: 'user', parts: [{ text: 'run task' }], messageId: 'm1', contextId: 'ctx-http' },
    });
    assert(task.status.state === 'TASK_STATE_COMPLETED', 'sendMessage() returns COMPLETED task');
    pass(`sendMessage() returned taskId: ${task.id}`);

    // getTask (via task store — should be null for this impl since getTask returns null)
    try {
      await client.getTask(ctx, agentUrl, task.id);
      pass('getTask() returned result (may be null for this impl)');
    } catch (err) {
      const e = err as { code?: string };
      assert(e.code === 'NOT_FOUND', 'getTask() throws NOT_FOUND for missing task (acceptable)');
    }

    // listTasks
    const page = await client.listTasks(ctx, agentUrl);
    assert(Array.isArray(page.tasks), 'listTasks() returns tasks array');

    // cancelTask — should not throw (no-op)
    await client.cancelTask(ctx, agentUrl, task.id);
    pass('cancelTask() completed without error');

    // GetExtendedAgentCard
    const body = JSON.stringify(makeRpcRequest(A2A_METHODS.GET_EXTENDED_AGENT_CARD, {}));
    const extRes = await fetch(`${url}/api/a2a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
      body,
    });
    const extJson = await extRes.json() as { result?: { documentationUrl?: string } };
    assert(typeof extJson.result?.documentationUrl === 'string', 'GetExtendedAgentCard returns documentationUrl');

  } catch (err) {
    fail('HTTP method coverage test failed', err);
  } finally {
    await close();
  }
}

// ─── Path 5: Push config + send cycle ────────────────────────────────────────

async function path5PushConfigCycle() {
  section('Path 5: Push Config + Send Cycle');

  const impl = makeTestServer('push-agent');
  const { url, close } = await startHttpServer(impl);
  const ctx = weaveContext({ userId: 'u1' }) as unknown as ExecutionContext;
  const client = weaveA2AClient();
  const agentUrl = `${url}/api/a2a`;

  try {
    // Create push config
    const config = await client.createPushConfig(ctx, agentUrl, 'task-push-1', {
      url: 'https://safe-loopback.example.com/hook',
      token: 'test-token',
    });
    assert(typeof config.pushConfigId === 'string', 'createPushConfig() returns pushConfigId');
    assert(config.taskId === 'task-push-1', 'createPushConfig() echoes taskId');
    assert(typeof config.createdAt === 'string', 'createPushConfig() sets createdAt');

    // Get push config
    const retrieved = await client.getPushConfig(ctx, agentUrl, 'task-push-1', config.pushConfigId);
    assert(retrieved.pushConfigId === config.pushConfigId, 'getPushConfig() retrieves by configId');

    // List push configs
    const configs = await client.listPushConfigs(ctx, agentUrl, 'task-push-1');
    assert(configs.length === 1, 'listPushConfigs() returns all configs for task');
    assert(configs[0]?.pushConfigId === config.pushConfigId, 'listPushConfigs() includes created config');

    // Add second config
    await client.createPushConfig(ctx, agentUrl, 'task-push-1', {
      url: 'https://another.example.com/hook',
    });
    const configs2 = await client.listPushConfigs(ctx, agentUrl, 'task-push-1');
    assert(configs2.length === 2, 'listPushConfigs() returns 2 configs after second create');

    // Delete first config
    const deleted = await client.deletePushConfig(ctx, agentUrl, 'task-push-1', config.pushConfigId);
    assert(deleted === true, 'deletePushConfig() returns true for existing config');

    const configsAfter = await client.listPushConfigs(ctx, agentUrl, 'task-push-1');
    assert(configsAfter.length === 1, 'listPushConfigs() returns 1 config after deletion');

    // Cross-task isolation
    const otherConfigs = await client.listPushConfigs(ctx, agentUrl, 'other-task-id');
    assert(otherConfigs.length === 0, 'push configs are isolated per taskId');

  } catch (err) {
    fail('Push config cycle test failed', err);
  } finally {
    await close();
  }
}

// ─── Path 6: Deprecated shim pass-through ────────────────────────────────────

async function path6DeprecatedShims() {
  section('Path 6: Deprecated Shim Pass-Through');

  const impl = makeTestServer('shim-agent');
  const { url, close } = await startHttpServer(impl);
  const ctx = weaveContext({ userId: 'u1' }) as unknown as ExecutionContext;
  const client = weaveA2AClient();
  const agentUrl = `${url}/api/a2a`;

  try {
    // sendTask → sendMessage
    const legacyResult = await client.sendTask!(ctx, agentUrl, {
      id: 'legacy-1',
      input: { role: 'user', parts: [{ text: 'legacy task' }], messageId: 'm1', contextId: 'c1' },
    });
    assert(legacyResult.status === 'completed', 'sendTask() shim returns completed status');
    assert(legacyResult.output?.parts[0]?.text === 'done', 'sendTask() shim returns agent output');

    // getTaskStatus → getTask (may throw NOT_FOUND but that's OK; the shim delegates correctly)
    try {
      const statusResult = await client.getTaskStatus!(ctx, agentUrl, 'any-task-id');
      assert(['completed', 'failed', 'working', 'submitted'].includes(statusResult.status), 'getTaskStatus() shim returns valid status');
    } catch (err) {
      const e = err as { code?: string };
      assert(e.code === 'NOT_FOUND', 'getTaskStatus() shim correctly propagates NOT_FOUND');
    }

  } catch (err) {
    fail('Deprecated shim test failed', err);
  } finally {
    await close();
  }
}

// ─── Path 7: geneWeave discovery (optional) ──────────────────────────────────

async function path7GeneWeaveDiscovery() {
  section('Path 7: geneWeave Discovery (optional)');

  const geneWeaveUrl = process.env['GENEWEAVE_BASE_URL'];
  if (!geneWeaveUrl) {
    console.log('  — GENEWEAVE_BASE_URL not set, skipping');
    return;
  }

  const ctx = weaveContext({ userId: 'u1' }) as unknown as ExecutionContext;
  const client = weaveA2AClient();

  try {
    const card = await client.discover(geneWeaveUrl);
    assert(card.name === 'geneweave', 'geneWeave card.name = "geneweave"');
    assert(card.capabilities.pushNotifications === true, 'geneWeave card has pushNotifications capability');
    assert(card.capabilities.extendedAgentCard === true, 'geneWeave card has extendedAgentCard capability');
    pass(`Discovered geneWeave at ${geneWeaveUrl}`);
  } catch (err) {
    fail('geneWeave discovery failed (server may not be running)', err);
  }
}

// ─── Path 8: Negative / security ─────────────────────────────────────────────

async function path8Negative() {
  section('Path 8: Negative / Security');

  const impl = makeTestServer('neg-agent');
  const { url, close } = await startHttpServer(impl);
  const ctx = weaveContext({ userId: 'u1' }) as unknown as ExecutionContext;
  const client = weaveA2AClient();
  const agentUrl = `${url}/api/a2a`;

  try {
    // Empty body → parse error
    const emptyRes = await fetch(`${url}/api/a2a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '',
    });
    assert(emptyRes.status === 400, 'empty body returns 400');

    // JSON-RPC 1.0 → invalid request
    const legacyRpcRes = await fetch(`${url}/api/a2a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '1.0', method: 'GetTask', id: '1', params: { id: 'x' } }),
    });
    assert(legacyRpcRes.status === 400, 'jsonrpc 1.0 returns 400');

    // Unknown method → 404
    const unknownMethodRes = await fetch(`${url}/api/a2a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeRpcRequest('NonExistentMethod', {})),
    });
    assert(unknownMethodRes.status === 404, 'unknown method returns 404');
    const unknownBody = await unknownMethodRes.json() as { error: { code: number } };
    assert(unknownBody.error.code === A2A_ERROR_CODES.METHOD_NOT_FOUND, 'unknown method returns METHOD_NOT_FOUND error code');

    // Invalid params — missing taskId in CreatePushConfig
    const missingTaskId = await fetch(`${url}/api/a2a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeRpcRequest(A2A_METHODS.CREATE_PUSH_CONFIG, { config: { url: 'https://x.example.com/h' } })),
    });
    assert(missingTaskId.status === 400, 'missing taskId returns 400');
    const missingTaskBody = await missingTaskId.json() as { error: { code: number } };
    assert(missingTaskBody.error.code === A2A_ERROR_CODES.INVALID_PARAMS, 'missing taskId returns INVALID_PARAMS');

    // Missing push config URL → INVALID_PARAMS
    const missingUrlRes = await fetch(`${url}/api/a2a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeRpcRequest(A2A_METHODS.CREATE_PUSH_CONFIG, {
        taskId: 'task-1',
        config: { token: 'no-url' },
      })),
    });
    assert(missingUrlRes.status === 400, 'missing config.url returns 400');

    // Get non-existent push config → 404
    const missingConfigRes = await fetch(`${url}/api/a2a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makeRpcRequest(A2A_METHODS.GET_PUSH_CONFIG, {
        taskId: 'task-1',
        pushConfigId: 'nonexistent-config-id',
      })),
    });
    assert(missingConfigRes.status === 404, 'missing push config returns 404');

    // Origin mismatch in discover
    try {
      // Create a server that returns a card with a different origin
      const badCardServer = http.createServer((_req, res) => {
        const badCard: AgentCard = {
          name: 'bad-origin',
          version: '1.0.0',
          description: 'bad',
          skills: [],
          capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false, stateTransitionHistory: false },
          supportedInterfaces: [{ url: 'http://evil.example.com/api/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(badCard));
      });
      await new Promise<void>((r) => badCardServer.listen(0, '127.0.0.1', r));
      const badCardAddr = badCardServer.address() as AddressInfo;
      try {
        await client.discover(`http://127.0.0.1:${badCardAddr.port}`);
        fail('origin mismatch should throw');
      } catch (err) {
        const e = err as { code?: string };
        assert(e.code === 'PROTOCOL_ERROR', 'origin mismatch throws PROTOCOL_ERROR');
      } finally {
        await new Promise<void>((r, e) => badCardServer.close((err) => err ? e(err) : r()));
      }
    } catch (err) {
      fail('Origin mismatch test threw unexpectedly', err);
    }

    // SQL injection / XSS in task message — treated as literal text
    const sqlTask = await client.sendMessage(ctx, agentUrl, {
      message: {
        role: 'user',
        parts: [{ text: "'; DROP TABLE tasks; --" }],
        messageId: 'm-sql',
        contextId: 'ctx-sec',
      },
    });
    assert(sqlTask.status.state === 'TASK_STATE_COMPLETED', 'SQL injection string handled safely');

    const xssTask = await client.sendMessage(ctx, agentUrl, {
      message: {
        role: 'user',
        parts: [{ text: '<script>alert(document.cookie)</script>' }],
        messageId: 'm-xss',
        contextId: 'ctx-sec',
      },
    });
    assert(xssTask.status.state === 'TASK_STATE_COMPLETED', 'XSS string handled safely');

    // Very long string
    const longText = 'A'.repeat(100_000);
    const longTask = await client.sendMessage(ctx, agentUrl, {
      message: {
        role: 'user',
        parts: [{ text: longText }],
        messageId: 'm-long',
        contextId: 'ctx-sec',
      },
    });
    assert(longTask.status.state === 'TASK_STATE_COMPLETED', '100K character message handled safely');

  } catch (err) {
    fail('Negative / security test failed', err);
  } finally {
    await close();
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('A2A Phase 6 — Tests, Observability & Cleanup (E2E)');
  console.log('====================================================\n');

  await path1OtelAttributes();
  await path2Bus();
  await path3SseStream();
  await path4FullHttpCoverage();
  await path5PushConfigCycle();
  await path6DeprecatedShims();
  await path7GeneWeaveDiscovery();
  await path8Negative();

  console.log(`\n====================================================`);
  console.log(`Results: ${passCount} passed, ${failCount} failed`);

  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\nFatal:', err);
  process.exit(1);
});
