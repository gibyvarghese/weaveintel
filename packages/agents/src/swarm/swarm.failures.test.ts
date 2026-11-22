// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { weaveSwarm } from './engine.js';
import type { SwarmDefinition, SwarmFixedTask } from './types.js';
import {
  LIMITS, WHO, fake, fanOut, found, happyModels, joined, makeHost, plan, recorder, role, taskKeyIn, verdicts,
} from './swarm.test.kit.js';

const fixedTasks = (n: number): SwarmFixedTask[] =>
  Array.from({ length: n }, (_v, i) => ({ key: `f${i + 1}`, title: `Fixed ${i + 1}`, role: 'researcher' }));

const fixed = (n: number, over: Partial<SwarmDefinition> = {}): SwarmDefinition =>
  fanOut({ taskSource: { kind: 'fixed', tasks: fixedTasks(n) }, checker: undefined, ...over });

describe('a failing worker', () => {
  it('does not sink the run: bounded retry, then the failure is reported and the rest is joined', async () => {
    const models = happyModels();
    models.researcher = fake('m-researcher', (t) => (taskKeyIn(t.user) === 'f2' ? new Error('upstream 500') : found(`Ok ${taskKeyIn(t.user)}`)));
    const rec = recorder();
    const r = await weaveSwarm({ host: makeHost({ models }) }).start(fixed(3), { principal: WHO, onEvent: rec.onEvent }).result;

    expect(r.status).toBe('partial');
    expect(r.stopReason).toBe('worker_failed');
    expect(r.stopDetail).toMatch(/1 of 3 tasks did not finish/);
    expect(r.failures.map((f) => [f.taskKey, f.attempt, f.reason, f.retried])).toEqual([['f2', 1, 'error', true], ['f2', 2, 'error', false]]);
    expect(r.failures[0]!.message).toContain('upstream 500');
    expect(models.researcher.turnsSeen.filter((t) => taskKeyIn(t.user) === 'f2')).toHaveLength(2); // one retry, no more
    expect(r.plan.find((t) => t.key === 'f2')).toMatchObject({ status: 'failed', attempts: 2 });
    expect(r.results.find((x) => x.taskKey === 'f2')).toMatchObject({ status: 'failed', attempt: 2, failure: { reason: 'error' } });
    // the reducer still ran, on the two that finished, and the gap is stated
    expect(models.reducer.calls).toBe(1);
    expect(r.joined).toMatchObject({ by: 'reducer', partial: true });
    expect(r.joined!.notDone.join('\n')).toMatch(/Fixed 2.*was not done/);
    // a retry is an agent run and is counted as one
    expect(r.usage.agentsStarted).toBe(5);
    expect(rec.steps('swarm.worker.finished').filter((s) => s['status'] === 'failed')).toHaveLength(2);
  });

  it('sinks the run when the definition says so', async () => {
    const models = happyModels();
    models.researcher = fake('m-researcher', (t) => (taskKeyIn(t.user) === 'f1' ? new Error('boom') : found('Ok')), { delayMs: 5 });
    const def = fixed(3, { limits: { ...LIMITS, maxConcurrency: 1 }, onFailure: { worker: 'fail_run', maxRetriesPerTask: 0 } });
    const r = await weaveSwarm({ host: makeHost({ models }) }).start(def, { principal: WHO }).result;
    expect(r.status).toBe('failed');
    expect(r.stopReason).toBe('worker_failed');
    expect(r.stopDetail).toMatch(/Fixed 1/);
    expect(models.researcher.calls).toBe(1); // nothing else started
    expect(models.reducer.calls).toBe(0);
  });

  it('a retry that works leaves a completed run and a record of the failure', async () => {
    const models = happyModels();
    let f1 = 0;
    models.researcher = fake('m-researcher', (t) => (taskKeyIn(t.user) === 'f1' && ++f1 === 1 ? new Error('blip') : found('Ok')));
    const r = await weaveSwarm({ host: makeHost({ models }) }).start(fixed(2), { principal: WHO }).result;
    expect(r.status).toBe('completed');
    expect(r.failures.map((f) => [f.taskKey, f.reason, f.retried])).toEqual([['f1', 'error', true]]);
    expect(r.plan.find((t) => t.key === 'f1')).toMatchObject({ status: 'ok', attempts: 2 });
    expect(r.results.find((x) => x.taskKey === 'f1')).toMatchObject({ status: 'ok', attempt: 2 });
  });

  it('a reply that is not the agreed structure is retried, then kept as plain text and marked', async () => {
    const models = happyModels();
    models.researcher = fake('m-researcher', (t) => (taskKeyIn(t.user) === 'f1' ? 'It was probably DNS.' : found('Ok')));
    const r = await weaveSwarm({ host: makeHost({ models }) }).start(fixed(2), { principal: WHO }).result;
    expect(models.researcher.turnsSeen.filter((t) => taskKeyIn(t.user) === 'f1')).toHaveLength(2);
    expect(r.failures.map((f) => [f.reason, f.retried])).toEqual([['malformed_result', true], ['malformed_result', false]]);
    const kept = r.results.find((x) => x.taskKey === 'f1')!;
    expect(kept).toMatchObject({ status: 'ok', structured: false, confidence: 'low', finding: 'It was probably DNS.', evidence: [] });
    expect(kept.notDone[0]).toMatch(/did not answer in the agreed structure/);
  });

  it('too few workers finishing fails the run', async () => {
    const models = happyModels();
    models.researcher = fake('m-researcher', (t) => (taskKeyIn(t.user) === 'f1' ? found('Ok') : new Error('down')));
    const def = fixed(3, { onFailure: { worker: 'continue', maxRetriesPerTask: 0, minWorkersOk: 2 } });
    const r = await weaveSwarm({ host: makeHost({ models }) }).start(def, { principal: WHO }).result;
    expect(r.status).toBe('failed');
    expect(r.stopReason).toBe('too_few_workers');
    expect(r.stopDetail).toMatch(/1 worker finished.*at least 2/);
    expect(models.reducer.calls).toBe(0);
  });

  it('a failed stage stops the stages after it', async () => {
    const def: SwarmDefinition = {
      key: 'staged',
      goalTemplate: 'Explain the outage.',
      pattern: 'pipeline',
      roles: [role('draft', 'worker'), role('review', 'worker'), role('final', 'worker')],
      limits: LIMITS,
      stages: ['draft', 'review', 'final'],
      join: { kind: 'last_stage' },
      onFailure: { worker: 'continue', maxRetriesPerTask: 0 },
      approvalPoints: [],
    };
    const draft = fake('m-d', () => found('Draft.'));
    const review = fake('m-r', () => new Error('review is down'));
    const final = fake('m-f', () => found('Final.'));
    const r = await weaveSwarm({ host: makeHost({ models: { draft, review, final } }) }).start(def, { principal: WHO }).result;
    expect(final.calls).toBe(0);
    expect(r.plan.map((t) => t.status)).toEqual(['ok', 'failed', 'skipped']);
    expect(r.failures.map((f) => f.reason)).toEqual(['error', 'upstream_failed']);
    expect(r.status).toBe('partial');
    expect(r.joined).toMatchObject({ by: 'last_stage', partial: true, summary: 'Draft.' });
  });
});

describe('a planner that returns rubbish', () => {
  const run = async (script: (n: number, user: string) => string, over: Partial<SwarmDefinition> = {}) => {
    const models = happyModels();
    models.planner = fake('m-planner', (t) => script(t.n, t.user));
    const r = await weaveSwarm({ host: makeHost({ models }) }).start(fanOut(over), { principal: WHO, inputs: { subject: 'x' } }).result;
    return { r, models };
  };

  it('fails the run with the reason; it never falls back to one agent', async () => {
    const { r, models } = await run(() => 'Sure! Here are some ideas: 1) look at logs 2) ...');
    expect(r.status).toBe('failed');
    expect(r.stopReason).toBe('planner_invalid');
    expect(models.planner.calls).toBe(2); // asked once more, then stopped
    expect(models.researcher.calls).toBe(0);
    expect(models.reducer.calls).toBe(0);
    expect(r.plan).toEqual([]);
    expect(r.joined).toBeUndefined();
    expect(r.failures.map((f) => [f.role, f.reason, f.retried])).toEqual([['planner', 'malformed_result', true], ['planner', 'malformed_result', false]]);
  });

  it('is told what was wrong and may correct it once', async () => {
    const { r, models } = await run((n) => (n === 1 ? plan({ title: 'A', role: 'nobody' }) : plan({ title: 'A' }, { title: 'B' })));
    expect(r.status).toBe('completed');
    expect(r.plan.map((t) => t.title)).toEqual(['A', 'B']);
    const retry = models.planner.turnsSeen[1]!.user;
    expect(retry).toContain('Your last task list was not accepted.');
    expect(retry).toMatch(/nobody/);
  });

  it.each([
    ['no tasks', JSON.stringify({ tasks: [] })],
    ['too many tasks', plan({ title: 'A' }, { title: 'B' }, { title: 'C' })],
    ['a role that is not a worker', plan({ title: 'A', role: 'reducer' })],
    ['a field nobody asked for', JSON.stringify({ tasks: [{ title: 'A', brief: 'b', role: 'researcher', tools: ['incident_update'] }] })],
    ['a brief that is too long', plan({ title: 'A', brief: 'x'.repeat(5000) })],
    ['the same task twice', plan({ title: 'A', brief: 'same' }, { title: 'A', brief: 'same' })],
  ])('rejects a task list with %s', async (_name, text) => {
    const { r, models } = await run(() => text, { taskSource: { kind: 'planner', role: 'planner', maxTasks: 2 } });
    expect(r.status).toBe('failed');
    expect(r.stopReason).toBe('planner_invalid');
    expect(models.researcher.calls).toBe(0);
  });

  it('cannot plan more tasks than the agent limit leaves room for', async () => {
    // 5 agents: planner, reducer and checker take three, so two tasks at most
    const { r, models } = await run(() => plan({ title: 'A' }, { title: 'B' }, { title: 'C' }), { limits: { ...LIMITS, maxAgents: 5 } });
    expect(models.planner.turnsSeen[0]!.user).toContain('Write at most 2 tasks.');
    expect(r.stopReason).toBe('planner_invalid');
  });
});

describe('a reducer or checker that fails', () => {
  it('a reducer that will not answer in structure: the join is done in code and the run says so', async () => {
    const models = happyModels(2);
    models.reducer = fake('m-reducer', () => 'All good, nothing to see.');
    const r = await weaveSwarm({ host: makeHost({ models }) }).start(fanOut({ checker: undefined }), { principal: WHO, inputs: { subject: 'x' } }).result;
    expect(models.reducer.calls).toBe(2);
    expect(r.status).toBe('partial');
    expect(r.stopReason).toBe('join_failed');
    expect(r.joined).toMatchObject({ by: 'code' });
    expect(r.joined!.findings.map((f) => f.claim).sort()).toEqual(['Finding for t1', 'Finding for t2']);
  });

  it('a checker that refutes is reported on the claim', async () => {
    const models = happyModels(2);
    models.checker = fake('m-checker', () => verdicts('refuted'));
    const r = await weaveSwarm({ host: makeHost({ models }) }).start(fanOut(), { principal: WHO, inputs: { subject: 'x' } }).result;
    expect(r.check!.outcome).toBe('refuted');
    expect(r.joined!.findings.map((f) => f.verdict)).toEqual(['refuted', 'unverified']); // a claim the checker skipped is not passed as checked
  });

  it('a checker that fails leaves the answer marked unchecked', async () => {
    const models = happyModels(2);
    models.checker = fake('m-checker', () => new Error('checker down'));
    const r = await weaveSwarm({ host: makeHost({ models }) }).start(fanOut(), { principal: WHO, inputs: { subject: 'x' } }).result;
    expect(r.status).toBe('partial');
    expect(r.stopReason).toBe('check_failed');
    expect(r.check).toBeUndefined();
    expect(r.joined!.summary).toBe('The joined answer.');
    expect(r.joined!.notDone.join('\n')).toMatch(/check/i);
    void joined;
  });
});
