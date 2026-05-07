import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  createTriggerDispatcher,
  InMemoryTriggerStore,
  ManualSourceAdapter,
  SignalBusSourceAdapter,
  MeshContractSourceAdapter,
  WebhookOutTargetAdapter,
  CallbackTargetAdapter,
  evaluateFilter,
  projectInput,
  readCronIntervalMs,
  readDotted,
  type Trigger,
  type TargetDispatchResult,
} from './dispatcher.js';

function makeTrigger(overrides: Partial<Trigger> = {}): Trigger {
  return {
    id: overrides.id ?? 'trg-1',
    key: overrides.key ?? 'demo',
    enabled: overrides.enabled ?? true,
    source: overrides.source ?? { kind: 'manual', config: {} },
    target: overrides.target ?? { kind: 'webhook_out', config: { url: 'http://example.test/hook' } },
    ...(overrides.filter ? { filter: overrides.filter } : {}),
    ...(overrides.inputMap ? { inputMap: overrides.inputMap } : {}),
    ...(overrides.rateLimit ? { rateLimit: overrides.rateLimit } : {}),
    ...(overrides.metadata ? { metadata: overrides.metadata } : {}),
  };
}

describe('evaluateFilter', () => {
  it('reads var paths', () => {
    expect(evaluateFilter({ '==': [{ var: 'payload.status' }, 'open'] }, { payload: { status: 'open' } })).toBe(true);
    expect(evaluateFilter({ '==': [{ var: 'payload.status' }, 'open'] }, { payload: { status: 'closed' } })).toBe(false);
  });
  it('supports comparison operators', () => {
    expect(evaluateFilter({ '>': [{ var: 'payload.n' }, 5] }, { payload: { n: 10 } })).toBe(true);
    expect(evaluateFilter({ '<=': [{ var: 'payload.n' }, 5] }, { payload: { n: 10 } })).toBe(false);
  });
  it('supports and/or/not', () => {
    expect(evaluateFilter({ and: [true, true] }, {})).toBe(true);
    expect(evaluateFilter({ or: [false, true] }, {})).toBe(true);
    expect(evaluateFilter({ '!': true }, {})).toBe(false);
  });
  it('supports in', () => {
    expect(evaluateFilter({ in: [{ var: 'payload.tag' }, ['a', 'b']] }, { payload: { tag: 'b' } })).toBe(true);
    expect(evaluateFilter({ in: ['foo', 'foobar'] }, {})).toBe(true);
  });
  it('fails closed on unknown operators', () => {
    expect(evaluateFilter({ banana: [1, 2] }, {})).toBe(false);
  });
});

describe('projectInput', () => {
  it('returns payload when no map', () => {
    const out = projectInput(undefined, { payload: { a: 1 } });
    expect(out).toEqual({ a: 1 });
  });
  it('projects dotted paths', () => {
    const out = projectInput(
      { 'request.id': 'payload.id', 'meta.source': 'meta.sourceId' },
      { payload: { id: 'p1' }, meta: { sourceId: 'webhookA' } },
    );
    expect(out).toEqual({ request: { id: 'p1' }, meta: { source: 'webhookA' } });
  });
});

describe('readDotted', () => {
  it('returns undefined on missing path', () => {
    expect(readDotted({ a: { b: 1 } }, 'a.c')).toBe(undefined);
  });
});

describe('readCronIntervalMs', () => {
  it('prefers intervalMs', () => {
    expect(readCronIntervalMs({ intervalMs: 250 })).toBe(250);
  });
  it('parses */5 minute shorthand', () => {
    expect(readCronIntervalMs({ expression: '*/5 * * * *' })).toBe(5 * 60_000);
  });
  it('returns null for unparseable', () => {
    expect(readCronIntervalMs({ expression: 'banana' })).toBe(60_000); // legacy fallback
    expect(readCronIntervalMs({})).toBe(null);
  });
});

describe('TriggerDispatcher', () => {
  it('dispatches manual events to webhook_out via callback target', async () => {
    const store = new InMemoryTriggerStore();
    const calls: Array<{ input: unknown; ref: string }> = [];
    const target = new CallbackTargetAdapter('webhook_out', async (_t, input): Promise<TargetDispatchResult> => {
      calls.push({ input, ref: 'r1' });
      return { ref: 'r1' };
    });
    const manual = new ManualSourceAdapter();
    const dispatcher = createTriggerDispatcher({
      store,
      sourceAdapters: [manual],
      targetAdapters: [target],
    });
    await store.save(makeTrigger({ inputMap: { value: 'payload.x' } }));
    await dispatcher.start();
    await manual.emit({ x: 42 });
    await dispatcher.stop();
    expect(calls).toEqual([{ input: { value: 42 }, ref: 'r1' }]);
    const invs = await store.listInvocations();
    expect(invs.length).toBe(1);
    expect(invs[0]!.status).toBe('dispatched');
    expect(invs[0]!.targetRef).toBe('r1');
  });

  it('records filtered events without dispatching', async () => {
    const store = new InMemoryTriggerStore();
    const target = new CallbackTargetAdapter('webhook_out', vi.fn(async () => ({ ref: 'x' })));
    await store.save(makeTrigger({ filter: { expression: { '==': [{ var: 'payload.kind' }, 'wanted'] } } }));
    const manual = new ManualSourceAdapter();
    const d = createTriggerDispatcher({ store, sourceAdapters: [manual], targetAdapters: [target] });
    await d.start();
    await manual.emit({ kind: 'unwanted' });
    await d.stop();
    const invs = await store.listInvocations();
    expect(invs[0]!.status).toBe('filtered');
  });

  it('rate-limits within a 1-minute window', async () => {
    const store = new InMemoryTriggerStore();
    const target = new CallbackTargetAdapter('webhook_out', async () => ({ ref: 'ok' }));
    await store.save(makeTrigger({ rateLimit: { perMinute: 2 } }));
    const manual = new ManualSourceAdapter();
    const d = createTriggerDispatcher({ store, sourceAdapters: [manual], targetAdapters: [target] });
    await d.start();
    await manual.emit({});
    await manual.emit({});
    await manual.emit({});
    await d.stop();
    const invs = await store.listInvocations();
    const counts = invs.reduce<Record<string, number>>((acc, i) => { acc[i.status] = (acc[i.status] ?? 0) + 1; return acc; }, {});
    expect(counts['dispatched']).toBe(2);
    expect(counts['rate_limited']).toBe(1);
  });

  it('records disabled triggers', async () => {
    const store = new InMemoryTriggerStore();
    const target = new CallbackTargetAdapter('webhook_out', async () => ({ ref: 'ok' }));
    await store.save(makeTrigger({ enabled: false }));
    const manual = new ManualSourceAdapter();
    const d = createTriggerDispatcher({ store, sourceAdapters: [manual], targetAdapters: [target] });
    await d.start();
    await manual.emit({});
    await d.stop();
    const invs = await store.listInvocations();
    expect(invs[0]!.status).toBe('disabled');
  });

  it('records error when target throws', async () => {
    const store = new InMemoryTriggerStore();
    const target = new CallbackTargetAdapter('webhook_out', async () => { throw new Error('boom'); });
    await store.save(makeTrigger());
    const manual = new ManualSourceAdapter();
    const d = createTriggerDispatcher({
      store,
      sourceAdapters: [manual],
      targetAdapters: [target],
      logger: { warn: () => undefined },
    });
    await d.start();
    await manual.emit({});
    await d.stop();
    const invs = await store.listInvocations();
    expect(invs[0]!.status).toBe('error');
    expect(invs[0]!.errorMessage).toContain('boom');
  });

  it('records no_target_adapter when target kind is missing', async () => {
    const store = new InMemoryTriggerStore();
    await store.save(makeTrigger({ target: { kind: 'agent_tick', config: {} } }));
    const manual = new ManualSourceAdapter();
    const d = createTriggerDispatcher({ store, sourceAdapters: [manual], targetAdapters: [] });
    await d.start();
    await manual.emit({});
    await d.stop();
    const invs = await store.listInvocations();
    expect(invs[0]!.status).toBe('no_target_adapter');
  });

  it('routes signal_bus events to dispatch', async () => {
    const store = new InMemoryTriggerStore();
    const bus = new EventEmitter();
    const recv: unknown[] = [];
    const target = new CallbackTargetAdapter('webhook_out', async (_t, input) => { recv.push(input); return { ref: 'ok' }; });
    await store.save(makeTrigger({ source: { kind: 'signal_bus', config: { event: 'demo' } } }));
    const d = createTriggerDispatcher({
      store,
      sourceAdapters: [new SignalBusSourceAdapter(bus, 'demo')],
      targetAdapters: [target],
    });
    await d.start();
    bus.emit('demo', { hello: 'world' });
    // give the dispatcher a microtask to process
    await new Promise((r) => setImmediate(r));
    await d.stop();
    expect(recv).toEqual([{ hello: 'world' }]);
  });

  it('routes mesh contract emissions via MeshContractSourceAdapter', async () => {
    const store = new InMemoryTriggerStore();
    const bus = new EventEmitter();
    const recv: unknown[] = [];
    const target = new CallbackTargetAdapter('webhook_out', async (_t, input) => { recv.push(input); return { ref: 'ok' }; });
    await store.save(makeTrigger({
      source: { kind: 'contract_emitted', config: {} },
      filter: { expression: { '==': [{ var: 'payload.kind' }, 'demo.completed' ] } },
    }));
    const d = createTriggerDispatcher({
      store,
      sourceAdapters: [new MeshContractSourceAdapter(bus)],
      targetAdapters: [target],
    });
    await d.start();
    bus.emit('contract_emitted', { id: 'c-1', kind: 'demo.completed', body: { x: 1 }, meta: { workflowDefinitionId: 'wf', workflowRunId: 'r', emittedAt: 'now' } });
    bus.emit('contract_emitted', { id: 'c-2', kind: 'other.kind', body: {}, meta: { workflowDefinitionId: 'wf', workflowRunId: 'r2', emittedAt: 'now' } });
    await new Promise((r) => setImmediate(r));
    await d.stop();
    expect(recv).toHaveLength(1);
    expect((recv[0] as { kind: string }).kind).toBe('demo.completed');
  });
});

describe('WebhookOutTargetAdapter', () => {
  it('POSTs JSON payload to configured url', async () => {
    const calls: Array<{ url: unknown; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response('', { status: 202 });
    }) as typeof fetch;
    const adapter = new WebhookOutTargetAdapter({ fetchImpl });
    const r = await adapter.dispatch(
      { kind: 'webhook_out', config: { url: 'http://example.test/hook' } },
      { hello: 'world' },
      { triggerId: 't', triggerKey: 'k', firedAt: Date.now() },
    );
    expect(r.ref).toBe('http:202');
    expect(calls.length).toBe(1);
    const init = calls[0]!.init;
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ hello: 'world' }));
  });

  it('throws without url', async () => {
    const adapter = new WebhookOutTargetAdapter({ fetchImpl: vi.fn() });
    await expect(adapter.dispatch({ kind: 'webhook_out', config: {} }, {}, { triggerId: 't', triggerKey: 'k', firedAt: 0 })).rejects.toThrow(/url/);
  });
});
