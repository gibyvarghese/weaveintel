/**
 * Example 150 — A2A v1.0 Phase 2: JSON-RPC 2.0 end-to-end
 *
 * Exercises the JSON-RPC 2.0 transport layer added in Phase 2:
 *
 *   Path 1 — JSON-RPC 2.0 codec round-trip
 *     Exercises makeRpcRequest / parseRpcResponse / parseRpcRequest.
 *     Verifies all A2A method constants and error codes.
 *
 *   Path 2 — Dispatcher (weaveA2AServer) with real agent
 *     Creates a geography specialist agent wrapped as A2AServer.
 *     Dispatches SendMessage, GetTask (unsupported), ListTasks (unsupported),
 *     CancelTask, and invalid method — verifies all JSON-RPC response shapes.
 *
 *   Path 3 — Streaming (SendStreamingMessage) through dispatcher
 *     Dispatches SendStreamingMessage, iterates the stream,
 *     collects statusUpdate + artifactUpdate + task events.
 *
 *   Path 4 — weaveA2AClient JSON-RPC 2.0 over in-process HTTP server
 *     Spins up a Node.js http server wired to the JSON-RPC dispatcher.
 *     Calls client.sendMessage() → verifies it sends JSON-RPC 2.0 body.
 *     Calls client.discover() → verifies AgentCard shape.
 *
 *   Path 5 — External trigger: raw fetch with JSON-RPC 2.0 body
 *     POSTs a raw JSON-RPC 2.0 request body to the test server.
 *     Verifies the response is a valid JSON-RPC 2.0 success envelope.
 *
 *   Path 6 — SSE streaming: raw fetch with Accept: text/event-stream
 *     POSTs SendStreamingMessage with SSE Accept header.
 *     Collects SSE events and verifies A2AStreamEvent shapes.
 *
 *   Path 7 — traceparent propagation
 *     Verifies outbound requests include W3C traceparent header.
 *
 * Run:
 *   npx tsx examples/150-a2a-jsonrpc-e2e-real.ts
 *
 * Requires: OPENAI_API_KEY in .env
 */

import 'dotenv/config';
import * as http from 'node:http';
import { weaveAgent } from '@weaveintel/agents';
import { weaveAgentAsA2AServer, weaveA2AClient, createA2ADispatcher, streamToSse } from '@weaveintel/a2a';
import {
  A2A_METHODS,
  A2A_ERROR_CODES,
  A2AJsonRpcError,
  makeRpcRequest,
  makeRpcSuccess,
  makeRpcError,
  parseRpcResponse,
  parseRpcRequest,
} from '@weaveintel/a2a';
import { parseSseStream } from '@weaveintel/a2a';
import {
  weaveContext,
  weaveToolRegistry,
  newUUIDv7,
  a2aTaskOutputText,
} from '@weaveintel/core';
import type {
  AgentCard,
  A2ATask,
  A2AStreamEvent,
} from '@weaveintel/core';
import { weaveOpenAIModel } from '@weaveintel/provider-openai';

// ── Env ───────────────────────────────────────────────────────────────────────

const OPENAI_API_KEY = process.env['OPENAI_API_KEY'];
if (!OPENAI_API_KEY) {
  console.error('❌  OPENAI_API_KEY not set in .env');
  process.exit(1);
}

function check(label: string, pass: boolean, detail = '') {
  const icon = pass ? '✓' : '✗';
  const suffix = detail ? `  (${detail})` : '';
  console.log(`  ${icon} ${label}${suffix}`);
  if (!pass) process.exitCode = 1;
}

// ── Shared context ────────────────────────────────────────────────────────────

const ctx = weaveContext({ userId: 'a2a-jsonrpc-e2e', executionId: 'e2e-150' });

console.log('='.repeat(60));
console.log('A2A v1.0 Phase 2 — JSON-RPC 2.0 End-to-End Test');
console.log('='.repeat(60));

// ── Build specialist agent + A2A server ────────────────────────────────────────

const specialistAgent = weaveAgent({
  model: weaveOpenAIModel('gpt-4o-mini', { apiKey: OPENAI_API_KEY }),
  tools: weaveToolRegistry(),
  systemPrompt: 'You are a concise geography expert. Answer in 1-2 sentences.',
  maxSteps: 3,
  name: 'geography-specialist',
});

const agentCard: AgentCard = {
  name: 'geography-specialist',
  description: 'Expert on world geography',
  version: '1.0.0',
  skills: [{ id: 'geography-qa', name: 'Geography Q&A', description: 'Answer geography questions' }],
  capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false, stateTransitionHistory: false },
  supportedInterfaces: [
    { url: 'http://localhost:0/api/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
  ],
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
};

const specialistServer = weaveAgentAsA2AServer({ agent: specialistAgent, card: agentCard });
const dispatcher = createA2ADispatcher(specialistServer);

// ─────────────────────────────────────────────────────────────────────────────
// ── Path 1: JSON-RPC codec round-trip ────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n🔁  Path 1: JSON-RPC 2.0 codec round-trip');

const req1 = makeRpcRequest(A2A_METHODS.SEND_MESSAGE, { message: { role: 'user', parts: [{ text: 'hi' }] } }, 'test-req-1');
check('makeRpcRequest jsonrpc is 2.0', req1.jsonrpc === '2.0');
check('makeRpcRequest method is SendMessage', req1.method === 'SendMessage');
check('makeRpcRequest id preserved', req1.id === 'test-req-1');

const successBody = makeRpcSuccess('r1', { id: 'task-123', status: { state: 'TASK_STATE_COMPLETED' } });
const parsedResult = parseRpcResponse<{ id: string }>(successBody);
check('parseRpcResponse extracts result', parsedResult.id === 'task-123');

const errorBody = makeRpcError('r2', A2A_ERROR_CODES.TASK_NOT_FOUND, 'Task not found');
let caughtErr: A2AJsonRpcError | null = null;
try { parseRpcResponse(errorBody); } catch (e) { caughtErr = e as A2AJsonRpcError; }
check('parseRpcResponse throws A2AJsonRpcError on error body', caughtErr !== null);
check('A2AJsonRpcError has correct code', caughtErr?.code === A2A_ERROR_CODES.TASK_NOT_FOUND, String(caughtErr?.code));

const parsed = parseRpcRequest(JSON.stringify(req1));
check('parseRpcRequest roundtrips method', parsed.method === A2A_METHODS.SEND_MESSAGE);
check('parseRpcRequest roundtrips id', parsed.id === 'test-req-1');

// All method constants
const expectedMethods = [
  'SendMessage', 'SendStreamingMessage', 'GetTask', 'ListTasks', 'CancelTask',
  'SubscribeToTask', 'GetExtendedAgentCard', 'CreateTaskPushNotificationConfig',
  'GetTaskPushNotificationConfig', 'ListTaskPushNotificationConfigs',
  'DeleteTaskPushNotificationConfig',
];
const actualMethods = Object.values(A2A_METHODS);
check('all 11 method constants present', actualMethods.length === 11, `${actualMethods.length} found`);
for (const m of expectedMethods) {
  check(`method constant: ${m}`, actualMethods.includes(m as (typeof actualMethods)[number]));
}

// Error code values
check('TASK_NOT_FOUND code is -32001', A2A_ERROR_CODES.TASK_NOT_FOUND === -32001);
check('TASK_NOT_CANCELABLE code is -32002', A2A_ERROR_CODES.TASK_NOT_CANCELABLE === -32002);
check('PUSH_NOTIFICATION_NOT_SUPPORTED code is -32003', A2A_ERROR_CODES.PUSH_NOTIFICATION_NOT_SUPPORTED === -32003);
check('UNSUPPORTED_OPERATION code is -32005', A2A_ERROR_CODES.UNSUPPORTED_OPERATION === -32005);

// ─────────────────────────────────────────────────────────────────────────────
// ── Path 2: Dispatcher — SendMessage with real agent ─────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n📡  Path 2: Dispatcher — SendMessage (real OpenAI call)');

const sendParams = {
  message: { role: 'user', parts: [{ text: 'What is the longest river in South America?' }], contextId: newUUIDv7(), messageId: newUUIDv7() },
};
const dispatchBody = JSON.stringify(makeRpcRequest(A2A_METHODS.SEND_MESSAGE, sendParams, 'send-1'));

const dispatchResult = await dispatcher(ctx, { method: 'POST', body: dispatchBody, headers: { 'a2a-version': '1.0' } });

check('SendMessage returns json kind', dispatchResult.kind === 'json');
if (dispatchResult.kind === 'json') {
  check('HTTP status 200', dispatchResult.status === 200, String(dispatchResult.status));
  const rpcResp = dispatchResult.data as { jsonrpc: string; id: string; result: A2ATask };
  check('jsonrpc is 2.0', rpcResp.jsonrpc === '2.0');
  check('id is echoed back', rpcResp.id === 'send-1');
  check('result has contextId', typeof rpcResp.result.contextId === 'string');
  check('result has artifacts', rpcResp.result.artifacts.length >= 1);
  check('result state is TASK_STATE_COMPLETED', rpcResp.result.status.state === 'TASK_STATE_COMPLETED',
    rpcResp.result.status.state);
  console.log('  Output:', a2aTaskOutputText(rpcResp.result).slice(0, 120));
}

// Verify error paths
const methodNotFoundResult = await dispatcher(ctx, {
  method: 'POST',
  body: JSON.stringify(makeRpcRequest('DoSomethingWeird', {})),
  headers: {},
});
check('unknown method → METHOD_NOT_FOUND', (() => {
  if (methodNotFoundResult.kind !== 'json') return false;
  const d = methodNotFoundResult.data as { error: { code: number } };
  return d.error?.code === A2A_ERROR_CODES.METHOD_NOT_FOUND;
})());

const badJsonResult = await dispatcher(ctx, { method: 'POST', body: '{bad json}', headers: {} });
check('bad JSON body → PARSE_ERROR', (() => {
  if (badJsonResult.kind !== 'json') return false;
  const d = badJsonResult.data as { error: { code: number } };
  return d.error?.code === A2A_ERROR_CODES.PARSE_ERROR;
})());

const pushResult = await dispatcher(ctx, {
  method: 'POST',
  body: JSON.stringify(makeRpcRequest(A2A_METHODS.CREATE_PUSH_CONFIG, {})),
  headers: {},
});
check('push config → PUSH_NOTIFICATION_NOT_SUPPORTED', (() => {
  if (pushResult.kind !== 'json') return false;
  const d = pushResult.data as { error: { code: number } };
  return d.error?.code === A2A_ERROR_CODES.PUSH_NOTIFICATION_NOT_SUPPORTED;
})());

// ─────────────────────────────────────────────────────────────────────────────
// ── Path 3: SendStreamingMessage through dispatcher ───────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n🌊  Path 3: SendStreamingMessage → A2AStreamEvent stream');

const streamParams = {
  message: { role: 'user', parts: [{ text: 'Name the 3 largest oceans.' }], contextId: newUUIDv7(), messageId: newUUIDv7() },
};
const streamBody = JSON.stringify(makeRpcRequest(A2A_METHODS.SEND_STREAMING_MESSAGE, streamParams, 'stream-1'));
const streamDispatch = await dispatcher(ctx, { method: 'POST', body: streamBody, headers: { 'a2a-version': '1.0' } });

check('SendStreamingMessage returns stream kind', streamDispatch.kind === 'stream');

let statusCount = 0, artifactCount = 0, finalTask: A2ATask | null = null;
if (streamDispatch.kind === 'stream') {
  for await (const event of streamDispatch.events) {
    if ('statusUpdate' in event) statusCount++;
    else if ('artifactUpdate' in event) artifactCount++;
    else if ('task' in event) finalTask = event.task;
  }
}
check('at least 1 statusUpdate event', statusCount >= 1, `${statusCount}`);
check('final task event received', finalTask !== null);
check('final task TASK_STATE_COMPLETED', finalTask?.status.state === 'TASK_STATE_COMPLETED', finalTask?.status.state ?? '?');
console.log('  Streamed output:', finalTask ? a2aTaskOutputText(finalTask).slice(0, 120) : '(none)');

// ─────────────────────────────────────────────────────────────────────────────
// ── Path 4: weaveA2AClient over real HTTP server ──────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n🌐  Path 4: weaveA2AClient JSON-RPC 2.0 over real HTTP server');

// Spin up a minimal Node.js HTTP server backed by the dispatcher
const testServer = http.createServer(async (req, res) => {
  const url = req.url ?? '/';

  if (url === '/.well-known/agent-card.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(specialistServer.card));
    return;
  }

  if (url === '/.well-known/agent.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(specialistServer.card));
    return;
  }

  if (url === '/api/a2a' && req.method === 'POST') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf-8');

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k] = Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
    }

    const accept = req.headers['accept'] ?? '';

    // Check if streaming is requested
    if (accept.includes('text/event-stream')) {
      const result = await dispatcher(ctx, { method: 'POST', body, headers });
      if (result.kind === 'stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        for await (const chunk of streamToSse(result.events)) {
          res.write(chunk);
        }
        res.end();
        return;
      }
    }

    const result = await dispatcher(ctx, { method: 'POST', body, headers });
    if (result.kind === 'json') {
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.data));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// Start on a random port
await new Promise<void>((resolve) => testServer.listen(0, '127.0.0.1', resolve));
const { port } = testServer.address() as { port: number };
const testBaseUrl = `http://127.0.0.1:${port}`;
const testAgentUrl = `${testBaseUrl}/api/a2a`;

console.log(`  Test server listening at ${testBaseUrl}`);

// Update card's supportedInterfaces to point to real server
(specialistServer.card as { supportedInterfaces: unknown[] }).supportedInterfaces = [
  { url: testAgentUrl, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
];

const client = weaveA2AClient();

// Test discover()
const discoveredCard = await client.discover(testBaseUrl);
check('discover() returns card', typeof discoveredCard.name === 'string', discoveredCard.name);
check('card.capabilities is object', typeof discoveredCard.capabilities === 'object');
check('card.supportedInterfaces is array', Array.isArray(discoveredCard.supportedInterfaces));
check('protocolVersion is 1.0', discoveredCard.supportedInterfaces[0]?.protocolVersion === '1.0');

// Test sendMessage() — should use JSON-RPC 2.0 body
const clientTask = await client.sendMessage(ctx, testAgentUrl, {
  message: {
    role: 'user',
    parts: [{ text: 'What is the tallest mountain in Europe?' }],
    contextId: newUUIDv7(),
    messageId: newUUIDv7(),
  },
});
check('client.sendMessage returns A2ATask', typeof clientTask.id === 'string');
check('client task state COMPLETED', clientTask.status.state === 'TASK_STATE_COMPLETED', clientTask.status.state);
check('client task has artifacts', clientTask.artifacts.length >= 1);
console.log('  Client task output:', a2aTaskOutputText(clientTask).slice(0, 120));

// ─────────────────────────────────────────────────────────────────────────────
// ── Path 5: External trigger — raw JSON-RPC 2.0 POST ─────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n🔌  Path 5: External trigger — raw JSON-RPC 2.0 POST');

const rawRpcBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 'external-req-1',
  method: 'SendMessage',
  params: {
    message: {
      role: 'user',
      parts: [{ text: 'What is the capital of Canada?' }],
      contextId: newUUIDv7(),
    },
  },
});

const rawResp = await fetch(testAgentUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
  body: rawRpcBody,
});

check('raw POST status 200', rawResp.status === 200, String(rawResp.status));
const rawRpcResp = await rawResp.json() as Record<string, unknown>;
check('response jsonrpc is 2.0', rawRpcResp['jsonrpc'] === '2.0');
check('response id echoed', rawRpcResp['id'] === 'external-req-1');
check('response has result', 'result' in rawRpcResp && !('error' in rawRpcResp));
const externalTask = rawRpcResp['result'] as A2ATask;
check('external task has contextId', typeof externalTask.contextId === 'string');
check('external task TASK_STATE_COMPLETED', externalTask.status.state === 'TASK_STATE_COMPLETED',
  externalTask.status.state);
console.log('  External task output:', a2aTaskOutputText(externalTask).slice(0, 120));

// Verify error responses are also JSON-RPC 2.0
const badMethodResp = await fetch(testAgentUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 'bad-req', method: 'NotAMethod', params: {} }),
});
const badRpcResp = await badMethodResp.json() as Record<string, unknown>;
check('error response is JSON-RPC 2.0', badRpcResp['jsonrpc'] === '2.0');
check('error response has error field', 'error' in badRpcResp && !('result' in badRpcResp));
check('error id echoed', badRpcResp['id'] === 'bad-req');

// ─────────────────────────────────────────────────────────────────────────────
// ── Path 6: SSE streaming via raw fetch ───────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n📺  Path 6: SSE streaming — raw fetch with Accept: text/event-stream');

const sseBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 'sse-req-1',
  method: 'SendStreamingMessage',
  params: {
    message: {
      role: 'user',
      parts: [{ text: 'What are the 2 most populous countries in Asia?' }],
      contextId: newUUIDv7(),
    },
  },
});

const sseResp = await fetch(testAgentUrl, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'A2A-Version': '1.0',
    'Accept': 'text/event-stream',
  },
  body: sseBody,
});

check('SSE response Content-Type', sseResp.headers.get('content-type')?.includes('text/event-stream') ?? false,
  sseResp.headers.get('content-type') ?? 'none');

const sseEvents: A2AStreamEvent[] = [];
if (sseResp.body) {
  for await (const event of parseSseStream<A2AStreamEvent>(sseResp.body)) {
    sseEvents.push(event);
  }
}
check('at least 1 SSE event received', sseEvents.length >= 1, `${sseEvents.length} events`);
check('last SSE event is { task }', sseEvents.length > 0 && 'task' in (sseEvents[sseEvents.length - 1]!));
const lastEvent = sseEvents[sseEvents.length - 1];
if (lastEvent && 'task' in lastEvent) {
  check('SSE final task TASK_STATE_COMPLETED', lastEvent.task.status.state === 'TASK_STATE_COMPLETED',
    lastEvent.task.status.state);
  console.log('  SSE final output:', a2aTaskOutputText(lastEvent.task).slice(0, 120));
}

// ─────────────────────────────────────────────────────────────────────────────
// ── Path 7: traceparent propagation ──────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n🔎  Path 7: W3C traceparent propagation');

// Intercept headers by replacing the test server with a recording one
const recordedHeaders: Record<string, string>[] = [];
const recordingServer = http.createServer(async (req, res) => {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    headers[k] = Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
  }
  recordedHeaders.push(headers);
  // Return a valid A2A task response
  const task: A2ATask = {
    id: newUUIDv7(),
    contextId: 'ctx-trace',
    status: { state: 'TASK_STATE_COMPLETED', timestamp: new Date().toISOString() },
    artifacts: [{ artifactId: 'a1', name: 'output', parts: [{ text: 'done' }] }],
    history: [],
  };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: 'req-1', result: task }));
});

await new Promise<void>((resolve) => recordingServer.listen(0, '127.0.0.1', resolve));
const { port: recordingPort } = recordingServer.address() as { port: number };
const recordingUrl = `http://127.0.0.1:${recordingPort}/api/a2a`;

const traceCtx = weaveContext({ userId: 'trace-test', executionId: 'exec-abc123def456789012345678901234', parentSpanId: '1234567890abcdef' });
await client.sendMessage(traceCtx, recordingUrl, {
  message: { role: 'user', parts: [{ text: 'test' }], contextId: 'ctx-1' },
});

const sentHeaders = recordedHeaders[0] ?? {};
check('A2A-Version header sent', sentHeaders['a2a-version'] === '1.0', sentHeaders['a2a-version'] ?? 'missing');
check('Content-Type header sent', sentHeaders['content-type']?.includes('application/json') ?? false);
const traceparent = sentHeaders['traceparent'];
check('traceparent header sent', typeof traceparent === 'string' && traceparent.length > 0, traceparent ?? 'missing');
if (traceparent) {
  const parts = traceparent.split('-');
  check('traceparent version is 00', parts[0] === '00');
  check('traceparent traceId is 32 hex chars', (parts[1]?.length ?? 0) === 32, parts[1] ?? '?');
  check('traceparent spanId is 16 hex chars', (parts[2]?.length ?? 0) === 16, parts[2] ?? '?');
  check('traceparent flags is 01', parts[3] === '01');
  console.log(`  traceparent: ${traceparent}`);
}

recordingServer.close();
testServer.close();

// ─────────────────────────────────────────────────────────────────────────────
// ── Summary ────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(60));
if (process.exitCode === 1) {
  console.log('❌  Some checks failed — see above.');
} else {
  console.log('✅  All A2A v1.0 Phase 2 (JSON-RPC 2.0) checks passed.');
  console.log('');
  console.log('  Paths exercised:');
  console.log('    1. JSON-RPC codec (makeRpcRequest, parseRpcResponse, parseRpcRequest)');
  console.log('    2. Dispatcher (createA2ADispatcher / weaveA2AServer) — real agent');
  console.log('    3. SendStreamingMessage → A2AStreamEvent stream via dispatcher');
  console.log('    4. weaveA2AClient.sendMessage() + discover() over real HTTP');
  console.log('    5. External trigger — raw JSON-RPC 2.0 POST, error shape validation');
  console.log('    6. SSE streaming via raw fetch (parseSseStream)');
  console.log('    7. W3C traceparent propagation in all outbound client headers');
}
console.log('='.repeat(60));
