/**
 * VoiceRealtimeProxy — Phase 3 unit tests: Tool calling
 *
 * Tests the full function-call flow:
 *   response.done (function_call items) → executeToolCalls →
 *   conversation.item.create (function_call_output) → response.create →
 *   response.done (audio) → onTurnComplete
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { RealtimeToolCall, RealtimeTool } from './realtime-proxy.js';

// ── Hoisted mock state ────────────────────────────────────────────────────────
const mockState = vi.hoisted(() => ({
  instances: [] as MockWsInstance[],
  reset: () => { mockState.instances.length = 0; },
}));

interface MockWsInstance {
  readyState: number;
  sent: string[];
  receive: (event: unknown) => void;
  messages: () => unknown[];
  ofType: (type: string) => unknown[];
  emitOpen: () => void;
}

vi.mock('ws', () => {
  const { EventEmitter: EE } = require('node:events') as typeof import('node:events');

  class MockWs extends EE {
    static OPEN   = 1 as const;
    static CLOSED = 3 as const;
    readyState = 1;
    readonly sent: string[] = [];

    constructor(_url: string, _opts?: unknown) {
      super();
      const self = this;
      const inst: MockWsInstance = {
        get readyState(){ return self.readyState; },
        sent:     self.sent,
        receive:  (ev: unknown) => self.emit('message', Buffer.from(JSON.stringify(ev))),
        messages: () => self.sent.map((s: string) => JSON.parse(s) as unknown),
        ofType:   (t: string) => self.sent
          .map((s: string) => JSON.parse(s) as Record<string, unknown>)
          .filter((m) => m['type'] === t),
        emitOpen: () => self.emit('open'),
      };
      mockState.instances.push(inst);
    }

    send(data: string): void { this.sent.push(data); }
    close(code = 1000, reason = ''): void { this.readyState = 3; this.emit('close', code, Buffer.from(String(reason))); }
  }

  return { default: MockWs };
});

import { VoiceRealtimeProxy } from './realtime-proxy.js';

// ── Client WS stub ────────────────────────────────────────────────────────────

class ClientWsStub extends EventEmitter {
  static OPEN = 1;
  readyState  = 1;
  readonly sent: string[] = [];

  send(data: string): void { this.sent.push(data); }
  close(): void            { this.readyState = 3; }
  messages(): unknown[]   { return this.sent.map((s) => JSON.parse(s) as unknown); }
  ofType(t: string): unknown[] {
    return this.messages().filter((m) => (m as Record<string, unknown>)['type'] === t);
  }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

function oai(index = 0): MockWsInstance { return mockState.instances[index]!; }

// ── Helpers to simulate OpenAI events ────────────────────────────────────────

/** Simulate a response.done event with function_call output items */
function responseDoneWithCalls(calls: Array<{ callId: string; name: string; arguments: string }>): Record<string, unknown> {
  return {
    type: 'response.done',
    response: {
      id: 'resp_tool',
      output: calls.map((c, i) => ({
        type: 'function_call',
        id:        `item_fn_${i}`,
        call_id:   c.callId,
        name:      c.name,
        arguments: c.arguments,
      })),
    },
  };
}

/** Simulate a final (audio) response.done with no function calls */
function responseDoneAudio(id = 'resp_final'): Record<string, unknown> {
  return {
    type: 'response.done',
    response: {
      id,
      output: [{ type: 'audio', id: 'item_audio' }],
      usage: { input_tokens: 50, output_tokens: 30 },
    },
  };
}

const SAMPLE_TOOL: RealtimeTool = {
  name: 'get_time',
  description: 'Returns current UTC time.',
  parameters: { type: 'object', properties: {} },
};

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('VoiceRealtimeProxy — Phase 3 (tool calling)', () => {
  let clientWs: ClientWsStub;
  let proxy: VoiceRealtimeProxy;

  async function startProxy(opts?: {
    tools?: RealtimeTool[];
    onToolCall?: (call: RealtimeToolCall) => Promise<string>;
    toolBudgetMs?: number;
    rotateAfterTurns?: number;
  }): Promise<void> {
    mockState.reset();
    clientWs = new ClientWsStub();
    proxy = new VoiceRealtimeProxy();
    proxy.start({
      clientWs:         clientWs as never,
      apiKey:           'test-key',
      model:            'gpt-realtime-2',
      voice:            'alloy',
      systemPrompt:     'You are a voice assistant.',
      tools:            opts?.tools ?? [SAMPLE_TOOL],
      toolBudgetMs:     opts?.toolBudgetMs ?? 800,
      rotateAfterTurns: opts?.rotateAfterTurns ?? 100,
      callbacks: { onToolCall: opts?.onToolCall },
    });
    oai().emitOpen();
    await sleep(5);
    // Clear setup noise
    oai().sent.length = 0;
    clientWs.sent.length = 0;
  }

  beforeEach(async () => { await startProxy(); });
  afterEach(() => { proxy.close(); });

  // ── 1. session.update includes tools ──────────────────────────────────────

  it('includes tools in session.update with type=function', async () => {
    proxy.close();
    mockState.reset();
    clientWs = new ClientWsStub();
    proxy = new VoiceRealtimeProxy();
    proxy.start({
      clientWs: clientWs as never,
      apiKey:   'key',
      model:    'gpt-realtime-2',
      voice:    'alloy',
      tools:    [SAMPLE_TOOL, { name: 'search_web', description: 'Search', parameters: { type: 'object', properties: {} } }],
    });
    oai().emitOpen();
    await sleep(5);

    const updates = oai().ofType('session.update') as Array<{ session: { tools: unknown[]; tool_choice: string } }>;
    expect(updates).toHaveLength(1);
    const tools = updates[0]?.session.tools ?? [];
    expect(tools).toHaveLength(2);
    expect((tools[0] as Record<string, unknown>)['type']).toBe('function');
    expect((tools[0] as Record<string, unknown>)['name']).toBe('get_time');
    expect(updates[0]?.session.tool_choice).toBe('auto');
  });

  // ── 2. session.update omits tools when none provided ──────────────────────

  it('omits tools and tool_choice from session.update when tools array is empty', async () => {
    proxy.close();
    mockState.reset();
    clientWs = new ClientWsStub();
    proxy = new VoiceRealtimeProxy();
    proxy.start({
      clientWs: clientWs as never,
      apiKey:   'key',
      model:    'gpt-realtime-2',
      voice:    'alloy',
      tools:    [], // explicitly empty
    });
    oai().emitOpen();
    await sleep(5);

    const updates = oai().ofType('session.update') as Array<{ session: Record<string, unknown> }>;
    expect(updates[0]?.session['tools']).toBeUndefined();
    expect(updates[0]?.session['tool_choice']).toBeUndefined();
  });

  // ── 3. response.done with function calls triggers onToolCall ──────────────

  it('calls onToolCall for each function_call item in response.done', async () => {
    const callLog: string[] = [];
    proxy.close();
    await startProxy({
      onToolCall: async (c) => { callLog.push(c.name); return '{"time":"12:00"}'; },
    });

    oai().receive(responseDoneWithCalls([{ callId: 'call_1', name: 'get_time', arguments: '{}' }]));
    await sleep(30);

    expect(callLog).toEqual(['get_time']);
  });

  // ── 4. tool_executing + tool_complete sent to client ─────────────────────

  it('sends tool_executing and tool_complete events to the client', async () => {
    proxy.close();
    await startProxy({
      onToolCall: async () => '{"ok":true}',
    });

    oai().receive(responseDoneWithCalls([{ callId: 'call_x', name: 'get_time', arguments: '{}' }]));
    await sleep(30);

    const executing = clientWs.ofType('tool_executing') as Array<{ callId: string; toolName: string }>;
    const complete  = clientWs.ofType('tool_complete')  as Array<{ callId: string; durationMs: number }>;
    expect(executing).toHaveLength(1);
    expect(executing[0]?.callId).toBe('call_x');
    expect(executing[0]?.toolName).toBe('get_time');
    expect(complete).toHaveLength(1);
    expect(complete[0]?.callId).toBe('call_x');
    expect(typeof complete[0]?.durationMs).toBe('number');
  });

  // ── 5. function_call_output + response.create sent to OpenAI ─────────────

  it('sends conversation.item.create (function_call_output) and response.create to OpenAI', async () => {
    proxy.close();
    await startProxy({
      onToolCall: async () => '{"result":"2026-06-17"}',
    });

    oai().receive(responseDoneWithCalls([{ callId: 'call_y', name: 'get_time', arguments: '{}' }]));
    await sleep(30);

    const outputs = oai().ofType('conversation.item.create') as Array<{
      item: { type: string; call_id: string; output: string };
    }>;
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.item.type).toBe('function_call_output');
    expect(outputs[0]?.item.call_id).toBe('call_y');
    expect(outputs[0]?.item.output).toBe('{"result":"2026-06-17"}');

    const creates = oai().ofType('response.create');
    expect(creates).toHaveLength(1);
  });

  // ── 6. Multiple tool calls in one response.done handled in parallel ────────

  it('handles multiple simultaneous tool calls and submits all outputs before response.create', async () => {
    proxy.close();
    const order: string[] = [];
    await startProxy({
      onToolCall: async (c) => { order.push(c.name); await sleep(10); return `{"from":"${c.name}"}`; },
    });

    oai().receive(responseDoneWithCalls([
      { callId: 'c1', name: 'tool_a', arguments: '{}' },
      { callId: 'c2', name: 'tool_b', arguments: '{}' },
    ]));
    await sleep(100);

    // Both were invoked
    expect(order.sort()).toEqual(['tool_a', 'tool_b']);

    // Both outputs submitted before response.create
    const outputs = oai().ofType('conversation.item.create');
    const creates = oai().ofType('response.create');
    expect(outputs).toHaveLength(2);
    // response.create should appear after both outputs
    const outputIdx  = oai().messages().findIndex((m) => (m as Record<string, unknown>)['type'] === 'conversation.item.create');
    const createIdx  = oai().messages().findIndex((m) => (m as Record<string, unknown>)['type'] === 'response.create');
    expect(createIdx).toBeGreaterThan(outputIdx);
    expect(creates).toHaveLength(1);
  });

  // ── 7. Tool timeout returns error JSON to model ────────────────────────────

  it('returns error JSON to model when tool exceeds toolBudgetMs', async () => {
    proxy.close();
    await startProxy({
      toolBudgetMs: 50,
      onToolCall: async () => { await sleep(200); return '{"ok":true}'; },
    });

    oai().receive(responseDoneWithCalls([{ callId: 'call_slow', name: 'get_time', arguments: '{}' }]));
    await sleep(400);

    const outputs = oai().ofType('conversation.item.create') as Array<{
      item: { output: string };
    }>;
    expect(outputs).toHaveLength(1);
    const output = JSON.parse(outputs[0]?.item.output ?? '{}') as { error?: string };
    expect(output.error).toMatch(/timed out/i);
  });

  // ── 8. Tool error → error JSON sent to model, not thrown ─────────────────

  it('catches thrown errors in onToolCall and returns error JSON to model', async () => {
    proxy.close();
    await startProxy({
      onToolCall: async () => { throw new Error('DB connection failed'); },
    });

    oai().receive(responseDoneWithCalls([{ callId: 'call_err', name: 'get_time', arguments: '{}' }]));
    await sleep(50);

    const outputs = oai().ofType('conversation.item.create') as Array<{
      item: { output: string };
    }>;
    const output = JSON.parse(outputs[0]?.item.output ?? '{}') as { error?: string };
    expect(output.error).toMatch(/DB connection failed/);
    // Still sends response.create so model can recover
    expect(oai().ofType('response.create')).toHaveLength(1);
  });

  // ── 9. Function-call response.done does NOT trigger onTurnComplete ─────────

  it('does not call onTurnComplete when response.done has function_call items', async () => {
    let turnCompletions = 0;
    proxy.close();
    mockState.reset();
    clientWs = new ClientWsStub();
    proxy = new VoiceRealtimeProxy();
    proxy.start({
      clientWs:     clientWs as never,
      apiKey:       'key',
      model:        'gpt-realtime-2',
      voice:        'alloy',
      tools:        [SAMPLE_TOOL],
      toolBudgetMs: 800,
      rotateAfterTurns: 100,
      callbacks: {
        onToolCall: async () => '{"time":"12:00"}',
        onTurnComplete: () => { turnCompletions++; },
      },
    });
    oai().emitOpen();
    await sleep(5);
    oai().sent.length = 0;

    // Tool call response — should NOT fire onTurnComplete
    oai().receive(responseDoneWithCalls([{ callId: 'c1', name: 'get_time', arguments: '{}' }]));
    await sleep(50);
    expect(turnCompletions).toBe(0);

    // Final audio response — SHOULD fire onTurnComplete
    oai().receive(responseDoneAudio());
    await sleep(10);
    expect(turnCompletions).toBe(1);
  });

  // ── 10. After tool round-trip, final response.done counts as a turn ────────

  it('increments turnCount after the final audio response following tool use', async () => {
    let rotationCount = 0;
    proxy.close();
    await startProxy({
      rotateAfterTurns: 1, // rotate after every turn
      onToolCall: async () => '{"ok":true}',
    });

    // Tool call → final response (= 1 turn)
    oai(0).receive(responseDoneWithCalls([{ callId: 'c1', name: 'get_time', arguments: '{}' }]));
    await sleep(50);

    // Wire onRotateSession after startup (easier than passing it in)
    const originalCallbacks = (proxy as unknown as { storedOpts: { callbacks: { onRotateSession?: unknown } } })
      .storedOpts.callbacks;
    originalCallbacks.onRotateSession = async () => { rotationCount++; return { systemPrompt: 'new' }; };

    oai(0).receive(responseDoneAudio());
    await sleep(30);

    // 1 turn completed → rotation fired (rotateAfterTurns = 1)
    expect(rotationCount).toBe(1);
  });

  // ── 11. No onToolCall callback → function_call response treated as normal turn

  it('treats function_call response.done as normal turn when onToolCall is absent', async () => {
    let turnCompletions = 0;
    proxy.close();
    mockState.reset();
    clientWs = new ClientWsStub();
    proxy = new VoiceRealtimeProxy();
    proxy.start({
      clientWs: clientWs as never,
      apiKey:   'key',
      model:    'gpt-realtime-2',
      voice:    'alloy',
      tools:    [SAMPLE_TOOL],
      rotateAfterTurns: 100,
      callbacks: {
        // NOTE: no onToolCall
        onTurnComplete: () => { turnCompletions++; },
      },
    });
    oai().emitOpen();
    await sleep(5);

    oai().receive(responseDoneWithCalls([{ callId: 'c1', name: 'get_time', arguments: '{}' }]));
    await sleep(10);

    // Without onToolCall, the response is treated as a normal turn completion
    expect(turnCompletions).toBe(1);
  });

  // ── 12. callId and itemId correctly forwarded to onToolCall ──────────────

  it('forwards callId and itemId exactly as received from OpenAI', async () => {
    const received: Pick<RealtimeToolCall, 'callId' | 'itemId' | 'name' | 'arguments'>[] = [];
    proxy.close();
    await startProxy({
      onToolCall: async (c) => { received.push({ callId: c.callId, itemId: c.itemId, name: c.name, arguments: c.arguments }); return '{}'; },
    });

    oai().receive({
      type: 'response.done',
      response: {
        output: [{
          type:      'function_call',
          id:        'item_EXACT_123',
          call_id:   'call_EXACT_456',
          name:      'get_time',
          arguments: '{"tz":"UTC"}',
        }],
      },
    });
    await sleep(30);

    expect(received[0]?.callId).toBe('call_EXACT_456');
    expect(received[0]?.itemId).toBe('item_EXACT_123');
    expect(received[0]?.name).toBe('get_time');
    expect(received[0]?.arguments).toBe('{"tz":"UTC"}');
  });
});
