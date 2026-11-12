// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { weaveSwarm } from './engine.js';
import type { SwarmDefinition, SwarmFixedTask, SwarmLimits } from './types.js';
import { makeCtx } from '../test-helpers.js';
import {
  LIMITS, WHO, fake, fanOut, found, hanging, happyModels, joined, makeHost, recorder, role, taskKeyIn, tool,
} from './swarm.test.kit.js';

const fixedTasks = (n: number): SwarmFixedTask[] =>
  Array.from({ length: n }, (_v, i) => ({ key: `f${i + 1}`, title: `Fixed ${i + 1}`, role: 'researcher' }));

/** n fixed tasks → researchers → reducer. No planner, no checker. */
const fixed = (n: number, limits: Partial<SwarmLimits> = {}, over: Partial<SwarmDefinition> = {}): SwarmDefinition =>
  fanOut({
    taskSource: { kind: 'fixed', tasks: fixedTasks(n) },
    checker: undefined,
    limits: { ...LIMITS, ...limits },
    onFailure: { worker: 'continue', maxRetriesPerTask: 0 },
    ...over,
  });

describe('swarm limits are enforced in code', () => {
  it('most agents: stops cleanly and hands back what it has, with the reason', async () => {
    const models = happyModels();
    const rec = recorder();
    const r = await weaveSwarm({ host: makeHost({ models }) }).start(fixed(5, { maxAgents: 3 }), { principal: WHO, onEvent: rec.onEvent }).result;
    expect(r.status).toBe('partial');
    expect(r.stopReason).toBe('limit_agents');
    expect(r.stopDetail).toMatch(/limit of 3 agents/);
    expect(r.usage.agentsStarted).toBe(3);
    expect(models.researcher.calls).toBe(3);
    expect(models.reducer.calls).toBe(0); // no agent left for the reducer: the join is done in code
    expect(r.joined).toMatchObject({ by: 'code', partial: true });
    expect(r.joined!.findings).toHaveLength(3);
    expect(r.joined!.notDone.join('\n')).toMatch(/Fixed 4/);
    expect(r.joined!.notDone.join('\n')).toMatch(/Fixed 5/);
    expect(r.plan.filter((t) => t.status === 'ok')).toHaveLength(3);
    expect(r.plan.filter((t) => t.status !== 'ok').map((t) => t.status).sort()).toEqual(['failed', 'skipped']);
    expect(rec.events[rec.events.length - 1]!.kind).toBe('run.completed');
    expect((rec.events[rec.events.length - 1]!.payload as { status: string }).status).toBe('partial');
  });

  it('most at once: never more workers in flight than the limit', async () => {
    const models = happyModels();
    const r = await weaveSwarm({ host: makeHost({ models }) }).start(fixed(6, { maxConcurrency: 1 }), { principal: WHO }).result;
    expect(r.status).toBe('completed');
    expect(models.researcher.peak).toBe(1);
    expect(r.usage.peakConcurrency).toBe(1);

    const models4 = happyModels();
    const r4 = await weaveSwarm({ host: makeHost({ models: models4 }) }).start(fixed(8, { maxConcurrency: 4 }), { principal: WHO }).result;
    expect(r4.status).toBe('completed');
    expect(models4.researcher.peak).toBe(4);
    expect(r4.usage.peakConcurrency).toBe(4);
  });

  it('steps per agent: an agent that only calls tools is stopped at its step limit', async () => {
    const looper = fake('m-researcher', (t) => (taskKeyIn(t.user) === 'f1' ? { call: 'incident_read', args: { q: 'again' } } : found('Fine.')));
    const read = tool('incident_read');
    const def = fixed(2, { maxStepsPerAgent: 3 }, {
      roles: [role('planner', 'planner'), role('researcher', 'worker', ['incident_read']), role('reducer', 'reducer'), role('checker', 'checker')],
    });
    const models = { ...happyModels(), researcher: looper };
    const r = await weaveSwarm({ host: makeHost({ models, tools: { incident_read: read } }) }).start(def, { principal: WHO }).result;
    expect(looper.turnsSeen.filter((t) => taskKeyIn(t.user) === 'f1')).toHaveLength(3);
    expect(read.seen.length).toBeLessThanOrEqual(3);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatchObject({ taskKey: 'f1', reason: 'limit_steps', retried: false });
    expect(r.status).toBe('partial');
    expect(r.stopReason).toBe('worker_failed');
    expect(r.results.find((x) => x.taskKey === 'f1')).toMatchObject({ status: 'failed' });
    expect(models.reducer.calls).toBe(1); // the run went on with the worker that finished

    // a role's own smaller limit wins
    const looper2 = fake('m-researcher', (t) => (taskKeyIn(t.user) === 'f1' ? { call: 'incident_read' } : found('Fine.')));
    const def2 = { ...def, limits: { ...LIMITS, maxStepsPerAgent: 4 }, roles: def.roles.map((x) => (x.key === 'researcher' ? { ...x, maxSteps: 2 } : x)) };
    await weaveSwarm({ host: makeHost({ models: { ...happyModels(), researcher: looper2 }, tools: { incident_read: tool('incident_read') } }) }).start(def2, { principal: WHO }).result;
    expect(looper2.turnsSeen.filter((t) => taskKeyIn(t.user) === 'f1')).toHaveLength(2);
  });

  it('tokens: no call is made once the token limit is reached', async () => {
    const models = happyModels(); // 15 tokens a call
    const r = await weaveSwarm({ host: makeHost({ models }) }).start(fixed(5, { maxConcurrency: 1, maxTotalTokens: 40 }), { principal: WHO }).result;
    expect(r.status).toBe('partial');
    expect(r.stopReason).toBe('limit_tokens');
    expect(r.usage.modelCalls).toBe(3);
    expect(r.usage.totalTokens).toBe(45);
    expect(models.researcher.calls).toBe(3);
    expect(models.reducer.calls).toBe(0);
    expect(r.joined).toMatchObject({ by: 'code', partial: true });
  });

  it('cost: no call is made once the money is spent', async () => {
    const models = happyModels();
    const pricing = { resolve: async () => ({ inputPerMillion: 100_000, outputPerMillion: 200_000 }) }; // 2.00 USD a call
    const rec = recorder();
    const r = await weaveSwarm({ host: makeHost({ models, pricing }) })
      .start(fixed(5, { maxConcurrency: 1, maxCostUsd: 5 }), { principal: WHO, onEvent: rec.onEvent }).result;
    expect(r.status).toBe('partial');
    expect(r.stopReason).toBe('limit_cost');
    expect(r.usage.modelCalls).toBe(3);
    expect(r.usage.costUsd).toBeCloseTo(6, 6);
    expect(models.researcher.calls).toBe(3);
    const usage = rec.events.filter((e) => e.kind === 'usage.update');
    expect(usage).toHaveLength(3);
    expect(usage[2]!.payload).toMatchObject({ priced: true, run: { modelCalls: 3 }, caps: { maxCostUsd: 5 } });
  });

  it('cost with no price for the model: the call is refused, not made for free', async () => {
    const models = happyModels();
    const pricing = { resolve: async () => null };
    const r = await weaveSwarm({ host: makeHost({ models, pricing }) }).start(fanOut({ limits: { ...LIMITS, maxCostUsd: 5 } }), { principal: WHO }).result;
    expect(r.status).toBe('failed');
    expect(r.stopReason).toBe('cost_unknown');
    expect(Object.values(models).reduce((n, m) => n + m.calls, 0)).toBe(0);
    expect(r.usage.modelCalls).toBe(0);
    expect(r.joined).toBeUndefined();
  });

  it('model calls: an exact cap across every agent', async () => {
    const models = happyModels(3);
    const r = await weaveSwarm({ host: makeHost({ models }) }).start(fanOut({ limits: { ...LIMITS, maxModelCalls: 4 } }), { principal: WHO, inputs: { subject: 'x' } }).result;
    expect(r.status).toBe('partial');
    expect(r.stopReason).toBe('limit_model_calls');
    expect(r.usage.modelCalls).toBe(4);
    expect(Object.values(models).reduce((n, m) => n + m.calls, 0)).toBe(4);
    expect(models.reducer.calls).toBe(0);
    expect(models.checker.calls).toBe(0);
    expect(r.joined).toMatchObject({ by: 'code' });
    expect(r.check).toBeUndefined();
  });

  it('time: no new work after the time limit, and a call in flight is told to stop', async () => {
    const slow = fake('m-researcher', () => found('Slow answer.'), { delayMs: 120 });
    const models = { ...happyModels(), researcher: slow };
    const r = await weaveSwarm({ host: makeHost({ models }) }).start(fixed(5, { maxConcurrency: 1, maxWallClockMs: 180 }), { principal: WHO }).result;
    expect(r.stopReason).toBe('limit_time');
    expect(r.status).toBe('partial');
    expect(slow.calls).toBeGreaterThanOrEqual(1);
    expect(slow.calls).toBeLessThanOrEqual(2);
    expect(models.reducer.calls).toBe(0);
    expect(r.plan.filter((t) => t.status === 'skipped').length).toBeGreaterThanOrEqual(3);
    expect(r.usage.wallClockMs).toBeLessThan(2_000);

    // a provider that honours the signal is cut off mid-call
    const stuck = hanging('m-researcher', { honourSignal: true });
    const started = Date.now();
    const r2 = await weaveSwarm({ host: makeHost({ models: { ...happyModels(), researcher: stuck } }) })
      .start(fixed(2, { maxWallClockMs: 100 }), { principal: WHO }).result;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(r2.status).toBe('failed'); // nothing was found, so there is nothing partial to hand back
    expect(r2.stopReason).toBe('limit_time');
    expect(r2.results.every((x) => x.status === 'failed')).toBe(true);
    expect(r2.joined).toBeUndefined();
  });
});

describe('stopping a swarm', () => {
  it('cancel stops new work at once', async () => {
    const models = { ...happyModels(), researcher: fake('m-researcher', (t) => found(`Done ${taskKeyIn(t.user)}`), { delayMs: 60 }) };
    const rec = recorder();
    const handle = weaveSwarm({ host: makeHost({ models }) }).start(fixed(6, { maxConcurrency: 2 }), { principal: WHO });
    let cancelledAt = 0;
    handle.subscribe((e) => {
      rec.onEvent(e);
      if (!cancelledAt && e.kind === 'step.update' && (e.payload as { type: string }).type === 'swarm.worker.started') {
        setTimeout(() => { cancelledAt = rec.events.length; handle.cancel('Stopped from the test.'); }, 10);
      }
    });
    const r = await handle.result;
    expect(r.status).toBe('cancelled');
    expect(r.stopReason).toBe('cancelled');
    expect(r.stopDetail).toBe('Stopped from the test.');
    expect(models.researcher.calls).toBe(2); // the two in flight; nothing new
    expect(models.reducer.calls).toBe(0);
    expect(r.plan.filter((t) => t.status === 'skipped')).toHaveLength(4);
    expect(rec.events[0]!.kind).toBe('run.started'); // subscribe right after start misses nothing
    expect(rec.events[rec.events.length - 1]!.kind).toBe('run.cancelled');
    const after = rec.events.slice(cancelledAt);
    expect(after.some((e) => e.kind === 'step.update' && (e.payload as { type: string }).type === 'swarm.worker.started')).toBe(false);
    // what was already found is handed back
    expect(r.joined).toMatchObject({ by: 'code', partial: true });
    expect(r.results.filter((x) => x.status === 'ok')).toHaveLength(2);
  });

  it('cancel stops an agent in flight at its next step', async () => {
    const worker = fake('m-researcher', () => ({ call: 'incident_read', args: { q: 'more' } }));
    let handle: ReturnType<ReturnType<typeof weaveSwarm>['start']> | undefined;
    const read = tool('incident_read', () => { handle!.cancel(); return 'a record'; });
    const def = fixed(1, { maxStepsPerAgent: 10 }, {
      roles: [role('planner', 'planner'), role('researcher', 'worker', ['incident_read']), role('reducer', 'reducer'), role('checker', 'checker')],
    });
    handle = weaveSwarm({ host: makeHost({ models: { ...happyModels(), researcher: worker }, tools: { incident_read: read } }) }).start(def, { principal: WHO });
    const r = await handle.result;
    expect(r.status).toBe('cancelled');
    expect(worker.calls).toBe(1); // the second model call was never made
    expect(read.seen).toHaveLength(1);
    expect(r.results[0]).toMatchObject({ status: 'failed', failure: { reason: 'cancelled' } });
    expect(r.joined).toBeUndefined();
  });

  it('a cancelled parent context cancels the run', async () => {
    const models = { ...happyModels(), researcher: hanging('m-researcher', { honourSignal: true }) };
    const ac = new AbortController();
    const ctx = { ...makeCtx(), signal: ac.signal };
    const handle = weaveSwarm({ host: makeHost({ models }) }).start(fixed(3), { principal: WHO, ctx });
    setTimeout(() => ac.abort(), 30);
    const r = await handle.result;
    expect(r.status).toBe('cancelled');
    expect(r.stopReason).toBe('cancelled');
    expect(models.reducer.calls).toBe(0);
    void joined;
  });
});
