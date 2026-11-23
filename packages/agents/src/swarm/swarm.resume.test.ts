// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { RUN_EVENT_KINDS } from '@weaveintel/core';
import { SwarmResumeError, weaveSwarm } from './engine.js';
import { createInMemorySwarmRunStore, markSwarmInterrupted } from './store.js';
import type { SwarmApprovalAnswer, SwarmDefinition, SwarmFixedTask, SwarmRunStore } from './types.js';
import {
  LIMITS, WHO, fake, fanOut, found, happyModels, makeHost, recorder, role, sleep, taskKeyIn, tool,
} from './swarm.test.kit.js';

const fixedTasks = (n: number): SwarmFixedTask[] =>
  Array.from({ length: n }, (_v, i) => ({ key: `f${i + 1}`, title: `Fixed ${i + 1}`, role: 'researcher' }));

const fixed = (n: number, over: Partial<SwarmDefinition> = {}): SwarmDefinition =>
  fanOut({ taskSource: { kind: 'fixed', tasks: fixedTasks(n) }, checker: undefined, onFailure: { worker: 'continue', maxRetriesPerTask: 0 }, ...over });

const until = async (ok: () => boolean | Promise<boolean>, ms = 2_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(5);
  }
};

describe('approval points', () => {
  const run = (answers: SwarmApprovalAnswer[], def = fanOut({ approvalPoints: ['after_plan'] })) => {
    const models = happyModels(2);
    const store = createInMemorySwarmRunStore();
    const host = makeHost({ models, approval: () => answers.shift() ?? 'pending' });
    const engine = weaveSwarm({ host, store });
    return { models, store, host, engine, def };
  };

  it('a pending answer parks the run before any worker starts; a yes carries it on without planning again', async () => {
    const { models, store, host, engine, def } = run(['pending', 'approved']);
    const rec = recorder();
    const first = await engine.start(def, { principal: WHO, inputs: { subject: 'x' }, onEvent: rec.onEvent }).result;
    expect(first.status).toBe('waiting_approval');
    expect(first.stopReason).toBe('approval_pending');
    expect(first.plan).toHaveLength(2);
    expect(first.plan.every((t) => t.status === 'pending')).toBe(true);
    expect(models.researcher.calls).toBe(0);
    expect(host.approvals[0]).toMatchObject({ point: 'after_plan', principal: WHO });
    expect(host.approvals[0]!.tasks).toHaveLength(2);
    expect((await store.load(first.runId))!.run).toMatchObject({ status: 'waiting_approval', waitingAt: 'after_plan' });
    // parked, not over: no terminal event yet
    expect(rec.kinds().some((k) => k === 'run.completed' || k === 'run.failed' || k === 'run.cancelled')).toBe(false);

    const rec2 = recorder();
    const second = await (await engine.resume(first.runId, def, { onEvent: rec2.onEvent })).result;
    expect(second.status).toBe('completed');
    expect(models.planner.calls).toBe(1); // the plan a person approved is the plan that ran
    expect(models.researcher.calls).toBe(2);
    expect(second.plan.map((t) => t.key)).toEqual(['t1', 't2']);
    // one event stream across both stretches
    expect(rec2.events[0]!.sequence).toBe(rec.events[rec.events.length - 1]!.sequence + 1);
    expect(rec2.events[0]).toMatchObject({ kind: 'run.started', payload: { resumed: true } });
    expect(second.usage.agentsStarted).toBe(5);
    expect(second.usage.modelCalls).toBe(5);
  });

  it('a no ends the run', async () => {
    const { models, engine, def } = run(['denied']);
    const r = await engine.start(def, { principal: WHO, inputs: { subject: 'x' } }).result;
    expect(r.status).toBe('cancelled');
    expect(r.stopReason).toBe('approval_denied');
    expect(models.researcher.calls).toBe(0);
  });

  it('before the result is released', async () => {
    const { host, engine } = run(['approved']);
    const r = await engine.start(fanOut({ approvalPoints: ['before_finish'] }), { principal: WHO, inputs: { subject: 'x' } }).result;
    expect(r.status).toBe('completed');
    expect(host.approvals.map((a) => a.point)).toEqual(['before_finish']);

    const again = run(['pending', 'approved']);
    const def = fanOut({ approvalPoints: ['before_finish'] });
    const parked = await again.engine.start(def, { principal: WHO, inputs: { subject: 'x' } }).result;
    expect(parked.status).toBe('waiting_approval');
    expect(parked.joined).toBeDefined();
    const calls = Object.values(again.models as Record<string, { calls: number }>).reduce((n, m) => n + m.calls, 0);
    const done = await (await again.engine.resume(parked.runId, def)).result;
    expect(done.status).toBe('completed');
    expect(done.joined!.summary).toBe('The joined answer.');
    expect(Object.values(again.models as Record<string, { calls: number }>).reduce((n, m) => n + m.calls, 0)).toBe(calls); // nothing was run twice
  });
});

describe('a run survives a restart', () => {
  it('interrupted, then carried on: finished work is not redone and the run keeps its person', async () => {
    const store = createInMemorySwarmRunStore();
    const def = fixed(3, { roles: [role('planner', 'planner'), role('researcher', 'worker', ['incident_read']), role('reducer', 'reducer'), role('checker', 'checker')] });
    // before the "crash": f1 finishes, f2 and f3 never come back
    const before = fake('m-researcher', (t) => (taskKeyIn(t.user) === 'f1' ? found('Found before the restart.') : new Promise<string>(() => {})));
    const host1 = makeHost({ models: { ...happyModels(), researcher: before }, tools: { incident_read: tool('incident_read') } });
    const first = weaveSwarm({ host: host1, store }).start(def, { principal: WHO, runId: 'run-1' });
    await until(async () => ((await store.load('run-1'))?.results.length ?? 0) === 1 && before.calls === 3);
    expect((await store.load('run-1'))!.run.status).toBe('running');

    // the process "restarts": the host marks what was running
    expect(await markSwarmInterrupted(store, 'run-1')).toBe(true);
    expect((await store.load('run-1'))!.run).toMatchObject({ status: 'interrupted', stopReason: 'interrupted' });
    expect(await markSwarmInterrupted(store, 'run-1')).toBe(false);

    const seenBy: (string | undefined)[] = [];
    const read = tool('incident_read', (_a, ctx) => { seenBy.push(ctx.userId); return 'a record'; });
    const after = fake('m-researcher', (t) => (t.turns === 0 ? { call: 'incident_read' } : found(`Found after the restart: ${taskKeyIn(t.user)}`)));
    const models2 = { ...happyModels(), researcher: after };
    const host2 = makeHost({ models: models2, tools: { incident_read: read } });
    const rec = recorder();
    const second = await (await weaveSwarm({ host: host2, store }).resume('run-1', def, { onEvent: rec.onEvent })).result;

    expect(second.status).toBe('completed');
    expect(second.results.map((x) => [x.taskKey, x.finding])).toEqual([
      ['f1', 'Found before the restart.'],
      ['f2', 'Found after the restart: f2'],
      ['f3', 'Found after the restart: f3'],
    ]);
    expect(after.turnsSeen.some((t) => taskKeyIn(t.user) === 'f1')).toBe(false);
    // resume takes no person: the stored one is used
    expect(seenBy).toEqual(['u-kahu', 'u-kahu']);
    expect(host2.checks.every((c) => c.principal.userId === 'u-kahu')).toBe(true);
    // totals carry over: 3 calls before + 4 worker calls + 1 reducer call after
    expect(second.usage.modelCalls).toBe(3 + 4 + 1);
    expect(second.usage.agentsStarted).toBe(3 + 2 + 1);
    expect((await store.load('run-1'))!.run.status).toBe('completed');
    expect(rec.events[0]).toMatchObject({ kind: 'run.started', payload: { resumed: true } });
    void first;
  });

  it('limits span the restart', async () => {
    const store = createInMemorySwarmRunStore();
    const def = fixed(3, { limits: { ...LIMITS, maxModelCalls: 4 } });
    const before = fake('m-researcher', (t) => (taskKeyIn(t.user) === 'f1' ? found('One.') : new Promise<string>(() => {})));
    weaveSwarm({ host: makeHost({ models: { ...happyModels(), researcher: before } }), store }).start(def, { principal: WHO, runId: 'run-2' });
    await until(async () => ((await store.load('run-2'))?.results.length ?? 0) === 1 && before.calls === 3);
    await markSwarmInterrupted(store, 'run-2');
    // 3 calls were reserved before the restart; 1 of them returned and is in the stored totals
    const carried = (await store.load('run-2'))!.run.usage.modelCalls;
    expect(carried).toBeGreaterThanOrEqual(1);

    const models2 = happyModels();
    const second = await (await weaveSwarm({ host: makeHost({ models: models2 }), store }).resume('run-2', def)).result;
    expect(second.usage.modelCalls).toBe(4);
    expect(models2.researcher.calls + models2.reducer.calls).toBe(4 - carried);
    expect(second.stopReason).toBe('limit_model_calls');
    expect(second.status).toBe('partial');
  });

  it('refuses to carry on a run that is over, unknown, or another swarm\'s', async () => {
    const store = createInMemorySwarmRunStore();
    const engine = weaveSwarm({ host: makeHost({ models: happyModels() }), store });
    const done = await engine.start(fixed(1), { principal: WHO }).result;
    expect(done.status).toBe('completed');
    await expect(engine.resume(done.runId, fixed(1))).rejects.toBeInstanceOf(SwarmResumeError);
    await expect(engine.resume('no-such-run', fixed(1))).rejects.toThrow(/no swarm run/);

    const parked = weaveSwarm({ host: makeHost({ models: happyModels(), approval: () => 'pending' }), store });
    const def = fixed(1, { approvalPoints: ['after_plan'] });
    const waiting = await parked.start(def, { principal: WHO }).result;
    await expect(parked.resume(waiting.runId, { ...def, key: 'another_swarm' })).rejects.toThrow(/belongs to the swarm/);
  });

  it('a store that fails stops the run and says so; it does not carry on unrecorded', async () => {
    const inner = createInMemorySwarmRunStore();
    const store: SwarmRunStore = { ...inner, putResult: async () => { throw new Error('disk full'); } };
    const models = happyModels();
    const r = await weaveSwarm({ host: makeHost({ models }), store }).start(fixed(4, { limits: { ...LIMITS, maxConcurrency: 1 } }), { principal: WHO }).result;
    expect(r.status).toBe('failed');
    expect(r.stopReason).toBe('engine_error');
    expect(r.stopDetail).toMatch(/disk full/);
    expect(models.researcher.calls).toBeLessThan(4);
    expect(models.reducer.calls).toBe(0);
  });
});

describe('the event stream and the store', () => {
  it('uses the core run-event kinds, and the store holds the same stream', async () => {
    const store = createInMemorySwarmRunStore();
    const read = tool('incident_read', () => 'a record');
    const models = { ...happyModels(), researcher: fake('m-researcher', (t) => (t.turns === 0 ? { call: 'incident_read' } : found('Read it.'))) };
    const def = fixed(2, { roles: [role('planner', 'planner'), role('researcher', 'worker', ['incident_read']), role('reducer', 'reducer'), role('checker', 'checker')] });
    const rec = recorder();
    const r = await weaveSwarm({ host: makeHost({ models, tools: { incident_read: read } }), store }).start(def, { principal: WHO, onEvent: rec.onEvent }).result;
    expect(r.status).toBe('completed');

    const kinds = new Set(rec.kinds());
    for (const k of kinds) expect(RUN_EVENT_KINDS as readonly string[]).toContain(k);
    for (const k of ['run.started', 'step.update', 'tool.invoked', 'tool.completed', 'usage.update', 'run.completed']) expect(kinds).toContain(k);
    expect(rec.events.filter((e) => e.kind === 'tool.invoked').map((e) => (e.payload as { toolName: string }).toolName)).toEqual(['incident_read', 'incident_read']);
    expect(rec.events.every((e) => e.runId === r.runId)).toBe(true);

    expect(store.events(r.runId).map((e) => [e.sequence, e.kind])).toEqual(rec.events.map((e) => [e.sequence, e.kind]));
    expect(store.costs(r.runId)).toHaveLength(r.usage.modelCalls);
    const snap = (await store.load(r.runId))!;
    expect(snap.run).toMatchObject({ status: 'completed', definitionKey: 'incident_review', principal: WHO });
    expect(snap.run.finishedAt).toBeDefined();
    expect(snap.tasks.map((t) => [t.key, t.status])).toEqual([['f1', 'ok'], ['f2', 'ok']]);
    expect(snap.results.map((x) => x.kind).sort()).toEqual(['reducer', 'worker', 'worker']);
    expect(snap.lastSequence).toBe(rec.events.length);
    expect(snap.run.usage).toEqual(r.usage);
  });

  it('a listener that throws does not break the run, and the failure is reported', async () => {
    const rec = recorder();
    let thrown = 0;
    const handle = weaveSwarm({ host: makeHost({ models: happyModels() }) }).start(fixed(2), { principal: WHO });
    handle.subscribe((e) => { if (e.kind === 'step.update' && thrown++ === 0) throw new Error('watcher crashed'); });
    handle.subscribe(rec.onEvent);
    const r = await handle.result;
    expect(r.status).toBe('completed');
    const diag = rec.events.filter((e) => e.kind === 'diagnostic').map((e) => (e.payload as { data: { type: string; message?: string } }).data);
    expect(diag).toContainEqual(expect.objectContaining({ type: 'swarm.listener_error', message: 'watcher crashed' }));
  });

  it('an unsubscribed listener hears nothing more', async () => {
    const heard: string[] = [];
    const handle = weaveSwarm({ host: makeHost({ models: happyModels() }) }).start(fixed(1), { principal: WHO });
    const off = handle.subscribe((e) => { heard.push(e.kind); off(); });
    await handle.result;
    expect(heard).toEqual(['run.started']);
  });
});
