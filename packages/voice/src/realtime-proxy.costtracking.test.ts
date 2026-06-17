/**
 * VoiceRealtimeProxy — Phase 5 unit tests: Cost tracking
 *
 * Tests:
 *   computeRealtimeCostUsd()
 *     - correct formula per token type
 *     - cached tokens billed at $0.40/M not $32/M
 *     - zero usage → zero cost
 *     - partial usage (only some fields present)
 *
 *   response.done → turn_complete and cost_update events
 *     - turn_complete.costUsd populated from real usage
 *     - cost_update sent only when costUsd > 0
 *     - cost_update carries per-turn and cumulative totalCostUsd
 *     - cumulative cost accumulates across multiple turns
 *     - function_call response.done does NOT emit cost_update
 *     - no usage in response.done → turn_complete.costUsd: 0, no cost_update
 *     - turn index in turn_complete / cost_update increments per turn
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { computeRealtimeCostUsd, REALTIME_PRICING } from './realtime-proxy.js';
import type { RealtimeUsage, RealtimeProxyCallbacks } from './realtime-proxy.js';

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
    close(code = 1000, reason = ''): void {
      this.readyState = 3;
      this.emit('close', code, Buffer.from(String(reason)));
    }
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

function oai(index = 0): MockWsInstance { return mockState.instances[index]!; }

function startProxy(
  clientWs: ClientWsStub,
  callbacks: RealtimeProxyCallbacks = {},
): VoiceRealtimeProxy {
  const proxy = new VoiceRealtimeProxy();
  proxy.start({
    clientWs: clientWs as unknown as import('ws').WebSocket,
    apiKey:   'test-key',
    model:    'gpt-realtime-2',
    voice:    'alloy',
    rotateAfterTurns: 0, // disable rotation so it doesn't interfere
    callbacks,
  });
  oai().emitOpen();
  return proxy;
}

function fireResponseDone(usage?: RealtimeUsage): void {
  oai().receive({
    type: 'response.done',
    response: {
      id: 'resp_001',
      output: [{ type: 'audio', id: 'item_001' }],
      ...(usage ? { usage } : {}),
    },
  });
}

beforeEach(() => { mockState.reset(); });
afterEach(() => { vi.restoreAllMocks(); });

// ═══════════════════════════════════════════════════════════════════════════════
// computeRealtimeCostUsd — pure function unit tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('computeRealtimeCostUsd()', () => {

  it('zero usage → zero cost', () => {
    const usage: RealtimeUsage = { input_tokens: 0, output_tokens: 0 };
    expect(computeRealtimeCostUsd(usage)).toBe(0);
  });

  it('audio input tokens billed at $32/M (uncached)', () => {
    const usage: RealtimeUsage = {
      input_tokens: 1000,
      output_tokens: 0,
      input_token_details: { audio_tokens: 1000 },
    };
    const expected = 1000 * (REALTIME_PRICING.audioInputPerM / 1_000_000);
    expect(computeRealtimeCostUsd(usage)).toBeCloseTo(expected, 10);
  });

  it('cached tokens billed at $0.40/M not $32/M', () => {
    // 500 audio tokens total, all cached — should be billed at cached rate
    const usage: RealtimeUsage = {
      input_tokens: 500,
      output_tokens: 0,
      input_token_details: { audio_tokens: 500, cached_tokens: 500 },
    };
    const expected = 500 * (REALTIME_PRICING.cachedInputPerM / 1_000_000);
    expect(computeRealtimeCostUsd(usage)).toBeCloseTo(expected, 10);
  });

  it('mixed cached/uncached: each billed at its own rate', () => {
    // 1000 audio tokens, 400 cached, 600 uncached
    const usage: RealtimeUsage = {
      input_tokens: 1000,
      output_tokens: 0,
      input_token_details: { audio_tokens: 1000, cached_tokens: 400 },
    };
    const expected =
      600 * (REALTIME_PRICING.audioInputPerM  / 1_000_000) +
      400 * (REALTIME_PRICING.cachedInputPerM / 1_000_000);
    expect(computeRealtimeCostUsd(usage)).toBeCloseTo(expected, 10);
  });

  it('text input tokens billed at $2.5/M', () => {
    const usage: RealtimeUsage = {
      input_tokens: 2000,
      output_tokens: 0,
      input_token_details: { text_tokens: 2000 },
    };
    const expected = 2000 * (REALTIME_PRICING.textInputPerM / 1_000_000);
    expect(computeRealtimeCostUsd(usage)).toBeCloseTo(expected, 10);
  });

  it('audio output tokens billed at $64/M', () => {
    const usage: RealtimeUsage = {
      input_tokens: 0,
      output_tokens: 500,
      output_token_details: { audio_tokens: 500 },
    };
    const expected = 500 * (REALTIME_PRICING.audioOutputPerM / 1_000_000);
    expect(computeRealtimeCostUsd(usage)).toBeCloseTo(expected, 10);
  });

  it('text output tokens billed at $13/M', () => {
    const usage: RealtimeUsage = {
      input_tokens: 0,
      output_tokens: 100,
      output_token_details: { text_tokens: 100 },
    };
    const expected = 100 * (REALTIME_PRICING.textOutputPerM / 1_000_000);
    expect(computeRealtimeCostUsd(usage)).toBeCloseTo(expected, 10);
  });

  it('full realistic turn: audio in, cached system prompt, audio out, some text', () => {
    const usage: RealtimeUsage = {
      input_tokens: 1500,
      output_tokens: 300,
      input_token_details: {
        audio_tokens:  1000,
        cached_tokens: 400,   // 400 of the 1000 audio tokens were cached
        text_tokens:   500,   // system prompt text portion
      },
      output_token_details: {
        audio_tokens: 280,
        text_tokens:  20,   // function call JSON in response
      },
    };
    const expected =
      (1000 - 400) * (REALTIME_PRICING.audioInputPerM  / 1_000_000) +
      400          * (REALTIME_PRICING.cachedInputPerM  / 1_000_000) +
      500          * (REALTIME_PRICING.textInputPerM    / 1_000_000) +
      280          * (REALTIME_PRICING.audioOutputPerM  / 1_000_000) +
      20           * (REALTIME_PRICING.textOutputPerM   / 1_000_000);
    expect(computeRealtimeCostUsd(usage)).toBeCloseTo(expected, 10);
  });

  it('cached_tokens > audio_tokens: clamped to zero uncached (no negative cost)', () => {
    // Defensive: OpenAI shouldn't send this but guard against it
    const usage: RealtimeUsage = {
      input_tokens: 100,
      output_tokens: 0,
      input_token_details: { audio_tokens: 100, cached_tokens: 200 },
    };
    expect(computeRealtimeCostUsd(usage)).toBeGreaterThanOrEqual(0);
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// response.done → client events
// ═══════════════════════════════════════════════════════════════════════════════

describe('Phase 5 — response.done cost events', () => {

  const SAMPLE_USAGE: RealtimeUsage = {
    input_tokens: 500,
    output_tokens: 200,
    input_token_details: { audio_tokens: 400, text_tokens: 100 },
    output_token_details: { audio_tokens: 200 },
  };

  it('turn_complete.costUsd is computed from usage (not hardcoded 0)', () => {
    const client = new ClientWsStub();
    startProxy(client);
    fireResponseDone(SAMPLE_USAGE);

    const tc = client.ofType('turn_complete') as Record<string, unknown>[];
    expect(tc).toHaveLength(1);
    expect(tc[0]!['costUsd']).toBeGreaterThan(0);
  });

  it('turn_complete.costUsd matches computeRealtimeCostUsd formula', () => {
    const client = new ClientWsStub();
    startProxy(client);
    fireResponseDone(SAMPLE_USAGE);

    const tc = client.ofType('turn_complete') as Record<string, unknown>[];
    const expected = computeRealtimeCostUsd(SAMPLE_USAGE);
    expect(tc[0]!['costUsd']).toBeCloseTo(expected, 12);
  });

  it('cost_update sent when usage is non-zero', () => {
    const client = new ClientWsStub();
    startProxy(client);
    fireResponseDone(SAMPLE_USAGE);

    const cu = client.ofType('cost_update') as Record<string, unknown>[];
    expect(cu).toHaveLength(1);
    expect(cu[0]!['costUsd']).toBeGreaterThan(0);
  });

  it('cost_update.totalCostUsd equals costUsd for first turn', () => {
    const client = new ClientWsStub();
    startProxy(client);
    fireResponseDone(SAMPLE_USAGE);

    const cu = client.ofType('cost_update') as Record<string, unknown>[];
    expect(cu[0]!['totalCostUsd']).toBeCloseTo(cu[0]!['costUsd'] as number, 12);
  });

  it('cost_update.totalCostUsd accumulates across turns', () => {
    const client = new ClientWsStub();
    startProxy(client);

    fireResponseDone(SAMPLE_USAGE);
    fireResponseDone(SAMPLE_USAGE);

    const cu = client.ofType('cost_update') as Record<string, unknown>[];
    expect(cu).toHaveLength(2);

    const turn1Cost = cu[0]!['costUsd'] as number;
    const turn2Cost = cu[1]!['costUsd'] as number;

    // Both turns used same usage → same per-turn cost
    expect(turn1Cost).toBeCloseTo(turn2Cost, 12);
    // Cumulative after turn 2 = turn1 + turn2
    expect(cu[1]!['totalCostUsd']).toBeCloseTo(turn1Cost + turn2Cost, 12);
  });

  it('no usage in response.done → turn_complete.costUsd is 0', () => {
    const client = new ClientWsStub();
    startProxy(client);
    fireResponseDone(undefined); // no usage field

    const tc = client.ofType('turn_complete') as Record<string, unknown>[];
    expect(tc[0]!['costUsd']).toBe(0);
  });

  it('no usage → cost_update NOT sent (avoids noise for $0 events)', () => {
    const client = new ClientWsStub();
    startProxy(client);
    fireResponseDone(undefined);

    expect(client.ofType('cost_update')).toHaveLength(0);
  });

  it('function_call response.done does not emit cost_update (intermediate turn)', () => {
    const client = new ClientWsStub();
    // onToolCall returns quickly so the intermediate response is handled
    startProxy(client, {
      onToolCall: async () => '{"result":"ok"}',
    });

    // response.done with function_call item — should NOT emit cost_update
    oai().receive({
      type: 'response.done',
      response: {
        id: 'resp_fn',
        output: [{
          type: 'function_call',
          id: 'item_fn',
          call_id: 'call_001',
          name: 'get_time',
          arguments: '{}',
        }],
        usage: SAMPLE_USAGE,
      },
    });

    // The proxy passes this to executeToolCalls and does NOT emit cost_update
    expect(client.ofType('cost_update')).toHaveLength(0);
    expect(client.ofType('turn_complete')).toHaveLength(0);
  });

  it('turn index in turn_complete increments per turn (0-based)', () => {
    const client = new ClientWsStub();
    startProxy(client);

    fireResponseDone(SAMPLE_USAGE);
    fireResponseDone(SAMPLE_USAGE);

    const tc = client.ofType('turn_complete') as Record<string, unknown>[];
    expect(tc[0]!['turnIndex']).toBe(0);
    expect(tc[1]!['turnIndex']).toBe(1);
  });

  it('turn index in cost_update matches turn_complete', () => {
    const client = new ClientWsStub();
    startProxy(client);

    fireResponseDone(SAMPLE_USAGE);
    fireResponseDone(SAMPLE_USAGE);

    const tc = client.ofType('turn_complete') as Record<string, unknown>[];
    const cu = client.ofType('cost_update')   as Record<string, unknown>[];

    expect(cu[0]!['turnIndex']).toBe(tc[0]!['turnIndex']);
    expect(cu[1]!['turnIndex']).toBe(tc[1]!['turnIndex']);
  });

  it('onTurnComplete callback still receives raw usage (backward compat)', () => {
    const client = new ClientWsStub();
    let receivedUsage: RealtimeUsage | undefined;
    startProxy(client, {
      onTurnComplete: (_durationMs, usage) => { receivedUsage = usage; },
    });

    fireResponseDone(SAMPLE_USAGE);

    expect(receivedUsage).toBeDefined();
    expect(receivedUsage!.input_tokens).toBe(SAMPLE_USAGE.input_tokens);
    expect(receivedUsage!.output_tokens).toBe(SAMPLE_USAGE.output_tokens);
  });

});
