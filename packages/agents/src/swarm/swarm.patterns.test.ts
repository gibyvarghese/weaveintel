// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import { RUN_EVENT_KINDS } from '@weaveintel/core';
import { weaveSwarm } from './engine.js';
import { SwarmDefinitionError, estimateSwarm, validateSwarmDefinition } from './validate.js';
import type { SwarmDefinition } from './types.js';
import {
  LIMITS, WHO, fake, fanOut, fenceIn, found, happyModels, joined, makeHost, outsideFence, recorder, role, taskKeyIn, tool, verdicts,
} from './swarm.test.kit.js';

describe('swarm definition', () => {
  it('reports every problem at once', () => {
    const bad: SwarmDefinition = {
      key: 'bad key!',
      goalTemplate: ' ',
      pattern: 'plan_fan_out_join',
      roles: [
        role('planner', 'planner', ['incident.read']),
        role('lead', 'lead', ['incident_read']),
        role('researcher', 'worker', ['incident.read']),
      ],
      limits: { maxAgents: 0, maxConcurrency: 0, maxStepsPerAgent: 0, maxWallClockMs: 0 },
      taskSource: { kind: 'fixed', tasks: [{ key: 'swarm_x', title: 'A', role: 'nobody' }] },
      join: { kind: 'last_stage' },
      onFailure: { worker: 'continue', maxRetriesPerTask: 9 },
      approvalPoints: [],
    };
    const v = validateSwarmDefinition(bad);
    expect(v.ok).toBe(false);
    const all = v.errors.join('\n');
    expect(all).toMatch(/swarm key/);
    expect(all).toMatch(/goal is empty/);
    expect(all).toMatch(/incident\.read/);
    expect(all).toMatch(/lead role.*holds tools/);
    expect(all).toMatch(/planner role.*holds tools/);
    expect(all).toMatch(/maxAgents/);
    expect(all).toMatch(/maxWallClockMs/);
    expect(all).toMatch(/swarm_x/);
    expect(all).toMatch(/nobody/);
    expect(v.errors.length).toBeGreaterThanOrEqual(9);
  });

  it('accepts the standard definition and estimates it without calling a model', () => {
    expect(validateSwarmDefinition(fanOut())).toEqual({ ok: true, errors: [] });
    const fixed = fanOut({
      taskSource: { kind: 'fixed', tasks: [{ key: 'timeline', title: 'Timeline', role: 'researcher' }, { key: 'changes', title: 'Changes', role: 'researcher' }] },
      limits: { ...LIMITS, maxCostUsd: 0.5 },
    });
    const e = estimateSwarm(fixed);
    expect(e).toMatchObject({ pattern: 'plan_fan_out_join', agentsMin: 4, agentsMax: 4, maxConcurrency: 3, costCapUsd: 0.5, readsOnly: true, wallClockCapMs: 20_000 });
    expect(e.roles.map((r) => r.key)).toEqual(['researcher', 'reducer', 'checker']);
  });

  it('refuses to start what it cannot run safely', () => {
    const models = happyModels();
    const start = (def: SwarmDefinition, host = makeHost({ models }), who = WHO) => () => weaveSwarm({ host }).start(def, { principal: who });

    expect(start({ ...fanOut(), pattern: 'pipeline' })).toThrow(SwarmDefinitionError);
    // a tool the host does not have
    expect(start(fanOut({ roles: [role('planner', 'planner'), role('researcher', 'worker', ['incident_read']), role('reducer', 'reducer'), role('checker', 'checker')] }))).toThrow(/incident_read/);
    // a write tool the definition does not name
    const writer = tool('incident_update', () => 'done', { riskLevel: 'write' });
    const withWriter = fanOut({ roles: [role('planner', 'planner'), role('researcher', 'worker', ['incident_update']), role('reducer', 'reducer'), role('checker', 'checker')] });
    expect(start(withWriter, makeHost({ models, tools: { incident_update: writer } }))).toThrow(/incident_update/);
    // named, but the host has no approval port
    expect(start({ ...withWriter, writeTools: ['incident_update'] }, makeHost({ models, tools: { incident_update: writer } }))).toThrow(/approval/);
    // approval points without an approval port
    expect(start(fanOut({ approvalPoints: ['after_plan'] }))).toThrow(/approval/);
    // a cost cap without prices
    expect(start(fanOut({ limits: { ...LIMITS, maxCostUsd: 1 } }))).toThrow(/pric/);
    // a prompt reference without a prompt port
    const refRoles = [role('planner', 'planner'), { ...role('researcher', 'worker'), prompt: undefined, promptRef: 'swarm.researcher' }, role('reducer', 'reducer'), role('checker', 'checker')];
    expect(start(fanOut({ roles: refRoles }))).toThrow(/prompt/);
    // nobody to act as
    expect(start(fanOut(), makeHost({ models }), { userId: '' })).toThrow(/person|principal|userId/i);
    expect(Object.values(models).every((m) => m.calls === 0)).toBe(true);
  });
});

describe('swarm patterns', () => {
  it('plan, fan out, join, check: the default pattern', async () => {
    const models = happyModels(3);
    const host = makeHost({ models });
    const rec = recorder();
    const handle = weaveSwarm({ host }).start(fanOut(), { principal: WHO, inputs: { subject: 'the payments gateway' }, onEvent: rec.onEvent });
    const r = await handle.result;

    expect(r.status).toBe('completed');
    expect(r.stopReason).toBeUndefined();
    expect(r.goal).toBe('Find out why the payments gateway failed.');
    expect(r.plan.map((t) => t.key)).toEqual(['t1', 't2', 't3']);
    expect(r.plan.every((t) => t.status === 'ok')).toBe(true);
    expect(r.results.map((x) => x.finding).sort()).toEqual(['Finding for t1', 'Finding for t2', 'Finding for t3']);
    expect(r.results.every((x) => x.structured && x.status === 'ok' && x.evidence.length === 1)).toBe(true);
    expect(r.joined).toMatchObject({ summary: 'The joined answer.', by: 'reducer', partial: false });
    expect(r.joined!.findings.map((f) => f.verdict)).toEqual(['supported', 'supported']);
    expect(r.check).toMatchObject({ outcome: 'supported' });
    expect(r.coordination.map((c) => c.kind)).toEqual(['planner', 'reducer', 'checker']);
    expect(r.failures).toEqual([]);

    // six agents: planner, three workers, reducer, checker; the workers overlapped
    expect(r.usage.agentsStarted).toBe(6);
    expect(r.usage.modelCalls).toBe(6);
    expect(r.usage.totalTokens).toBe(6 * 15);
    expect(r.usage.peakConcurrency).toBe(3);
    expect(models.researcher.peak).toBe(3);

    // the model was asked for by purpose, once per role
    expect(host.modelAsks).toEqual([
      { purpose: 'reasoning', role: 'planner' },
      { purpose: 'fast', role: 'researcher' },
      { purpose: 'reasoning', role: 'reducer' },
      { purpose: 'reasoning', role: 'checker' },
    ]);

    // events: known kinds, no gaps, in the order a watcher expects
    expect(rec.events.every((e) => (RUN_EVENT_KINDS as readonly string[]).includes(e.kind))).toBe(true);
    expect(rec.events.map((e) => e.sequence)).toEqual(rec.events.map((_e, i) => i + 1));
    expect(rec.events[0]!.kind).toBe('run.started');
    expect(rec.events[rec.events.length - 1]!.kind).toBe('run.completed');
    const order = rec.events.filter((e) => e.kind === 'step.update').map((e) => (e.payload as { type: string }).type);
    const first = (t: string): number => order.indexOf(t);
    expect(first('swarm.planned')).toBeGreaterThan(0);
    expect(first('swarm.planned')).toBeLessThan(order.indexOf('swarm.worker.started', first('swarm.planned')));
    expect(first('swarm.joined')).toBeGreaterThan(order.lastIndexOf('swarm.planned'));
    expect(first('swarm.checked')).toBeGreaterThan(first('swarm.joined'));
    expect(rec.steps('swarm.worker.started')).toHaveLength(6);
    expect(rec.steps('swarm.worker.finished')).toHaveLength(6);
    expect(rec.steps('swarm.planned')[0]).toMatchObject({ source: 'planner' });

    // every worker got a fresh context: its own task and nobody else's
    for (const t of models.researcher.turnsSeen) {
      const key = taskKeyIn(t.user);
      expect(t.req.messages.filter((m) => m.role !== 'system')).toHaveLength(1);
      for (const other of ['t1', 't2', 't3'].filter((k) => k !== key)) expect(t.user).not.toContain(`Your task, ${other}`);
    }
    // a subscriber added right after start misses nothing
    expect(handle.runId).toBe(r.runId);
  });

  it('a fixed task list needs no planner', async () => {
    const models = happyModels();
    const def = fanOut({
      taskSource: { kind: 'fixed', tasks: [
        { key: 'timeline', title: 'Build the timeline', focus: 'When did it start?', role: 'researcher' },
        { key: 'changes', title: 'Recent changes', role: 'researcher' },
      ] },
      checker: undefined,
    });
    const r = await weaveSwarm({ host: makeHost({ models }) }).start(def, { principal: WHO, inputs: { subject: 'x' } }).result;
    expect(r.status).toBe('completed');
    expect(r.plan.map((t) => t.key)).toEqual(['timeline', 'changes']);
    expect(r.plan[0]!.brief).toBe('When did it start?');
    expect(models.planner.calls).toBe(0);
    expect(models.checker.calls).toBe(0);
    expect(r.check).toBeUndefined();
    expect(r.usage.agentsStarted).toBe(3);
  });

  it('map over a list, then reduce', async () => {
    const worker = fake('m-w', (t) => found(`Looked at ${/item: (.+)/.exec(t.user)?.[1]}`), { delayMs: 15 });
    const reducer = fake('m-r', () => joined('Five items reviewed.'));
    const def: SwarmDefinition = {
      key: 'gap_audit',
      goalTemplate: 'Audit each article.',
      pattern: 'map_reduce',
      roles: [role('auditor', 'worker'), role('reducer', 'reducer')],
      limits: { ...LIMITS, maxConcurrency: 2 },
      taskSource: { kind: 'per_item', role: 'auditor' },
      join: { kind: 'reducer', role: 'reducer' },
      onFailure: { worker: 'continue', maxRetriesPerTask: 0 },
      approvalPoints: [],
    };
    const items = Array.from({ length: 5 }, (_v, i) => ({ key: `KB-${i + 1}`, title: `Article ${i + 1}`, detail: `Body ${i + 1}` }));
    const r = await weaveSwarm({ host: makeHost({ models: { auditor: worker, reducer } }) }).start(def, { principal: WHO, items }).result;
    expect(r.status).toBe('completed');
    expect(r.plan.map((t) => t.key)).toEqual(['i1', 'i2', 'i3', 'i4', 'i5']);
    expect(r.results).toHaveLength(5);
    expect(worker.peak).toBe(2);
    expect(r.usage.peakConcurrency).toBe(2);
    // each worker sees only its own item
    for (const t of worker.turnsSeen) {
      const mine = /item: (Article \d)/.exec(t.user)![1]!;
      for (const it of items.filter((i) => i.title !== mine)) expect(t.user).not.toContain(it.title);
    }
    expect(r.joined).toMatchObject({ by: 'reducer', summary: 'Five items reviewed.' });
  });

  it('a pipeline: each stage reviews the one before', async () => {
    const draft = fake('m-draft', () => found('Draft: the disk filled up.'));
    const review = fake('m-review', () => found('Reviewed: the log volume filled up.'));
    const final = fake('m-final', () => found('Final: log rotation was off, so the log volume filled.'));
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
    const r = await weaveSwarm({ host: makeHost({ models: { draft, review, final } }) }).start(def, { principal: WHO }).result;
    expect(r.status).toBe('completed');
    expect(r.plan.map((t) => [t.key, t.dependsOn])).toEqual([['s1', []], ['s2', ['s1']], ['s3', ['s2']]]);
    expect(r.usage.peakConcurrency).toBe(1);
    expect(r.joined).toMatchObject({ by: 'last_stage', partial: false, summary: 'Final: log rotation was off, so the log volume filled.' });
    // stage 2 was handed stage 1's result, as fenced data
    const t2 = review.turnsSeen[0]!;
    const fence = fenceIn(t2.system);
    expect(fence).not.toBe('');
    expect(t2.user).toContain('Draft: the disk filled up.');
    expect(outsideFence(t2.user, fence)).not.toContain('Draft: the disk filled up.');
    // stage 3 sees stage 2, not stage 1
    expect(final.turnsSeen[0]!.user).toContain('Reviewed:');
    expect(final.turnsSeen[0]!.user).not.toContain('Draft:');
  });

  it('several attempts and a judge that picks', async () => {
    let n = 0;
    const solver = fake('m-solver', () => found(`Cause ${++n}`), { delayMs: 10 });
    const judge = fake('m-judge', () => JSON.stringify({ winner: 2, rationale: 'Best backed by evidence.' }));
    const def: SwarmDefinition = {
      key: 'root_cause',
      goalTemplate: 'Find the root cause.',
      pattern: 'attempts_judge',
      roles: [role('solver', 'worker'), role('judge', 'judge')],
      limits: LIMITS,
      taskSource: { kind: 'fixed', tasks: [{ key: 'cause', title: 'Root cause', role: 'solver' }] },
      attempts: 3,
      join: { kind: 'judge_pick', role: 'judge' },
      onFailure: { worker: 'continue', maxRetriesPerTask: 0 },
      approvalPoints: [],
    };
    const r = await weaveSwarm({ host: makeHost({ models: { solver, judge } }) }).start(def, { principal: WHO }).result;
    expect(r.status).toBe('completed');
    expect(r.plan.map((t) => t.key)).toEqual(['a1', 'a2', 'a3']);
    expect(solver.peak).toBe(3);
    expect(r.joined).toMatchObject({ by: 'judge', winner: 'a2', rationale: 'Best backed by evidence.' });
    expect(r.joined!.summary).toBe(r.results.find((x) => x.taskKey === 'a2')!.finding);
    expect(judge.turnsSeen[0]!.user).toContain('There are 3 attempts (data):');
    // independent: no attempt sees another's finding
    for (const t of solver.turnsSeen) expect(t.user).not.toMatch(/Cause \d/);
  });

  it('several attempts and a judge that merges', async () => {
    const solver = fake('m-solver', (t) => found(`Cause from ${taskKeyIn(t.user)}`));
    const judge = fake('m-judge', () => JSON.stringify({
      summary: 'Merged cause.',
      findings: [{ claim: 'Both agree on the cause', evidence: [], confidence: 'medium', from: ['a1', 'a2', 'zz'] }],
      notDone: [],
      rationale: 'They agree.',
    }));
    const def: SwarmDefinition = {
      key: 'root_cause_merge',
      goalTemplate: 'Find the root cause.',
      pattern: 'attempts_judge',
      roles: [role('solver', 'worker'), role('judge', 'judge')],
      limits: LIMITS,
      taskSource: { kind: 'fixed', tasks: [{ key: 'cause', title: 'Root cause', role: 'solver' }] },
      attempts: 2,
      join: { kind: 'judge_merge', role: 'judge' },
      onFailure: { worker: 'continue', maxRetriesPerTask: 0 },
      approvalPoints: [],
    };
    const r = await weaveSwarm({ host: makeHost({ models: { solver, judge } }) }).start(def, { principal: WHO }).result;
    expect(r.status).toBe('completed');
    expect(r.joined).toMatchObject({ by: 'judge', summary: 'Merged cause.', rationale: 'They agree.' });
    expect(r.joined!.findings[0]!.from).toEqual(['a1', 'a2']); // a task key that does not exist is dropped
  });

  const leadDef = (over: Partial<SwarmDefinition> = {}): SwarmDefinition => ({
    key: 'lead_team',
    goalTemplate: 'Investigate the outage.',
    pattern: 'lead_helpers',
    roles: [role('lead', 'lead'), role('helper', 'worker', ['incident_read'])],
    limits: LIMITS,
    join: { kind: 'lead' },
    onFailure: { worker: 'continue', maxRetriesPerTask: 0 },
    approvalPoints: [],
    ...over,
  });

  it('a lead with helpers delegates, and the delegations are tool calls in the trace', async () => {
    const lead = fake('m-lead', (t) => {
      if (t.turns === 0) return { call: 'delegate_to_worker', args: { worker: 'helper', goal: 'Read the incident record\nand report.' } };
      if (t.turns === 1) return { call: 'delegate_to_worker', args: { worker: 'helper', goal: 'Check recent changes' } };
      return joined('The lead joined two helper results.', [{ claim: 'It was the deploy', from: ['h1', 'h2'] }]);
    });
    const helper = fake('m-helper', (t) => (t.turns === 0 ? { call: 'incident_read', args: { q: 'INC-1' } } : found(`Helper saw: ${/record INC-\d/.exec(t.lastTool ?? '')?.[0]}`)));
    const read = tool('incident_read', () => 'record INC-1');
    const host = makeHost({ models: { lead, helper }, tools: { incident_read: read } });
    const rec = recorder();
    const r = await weaveSwarm({ host }).start(leadDef(), { principal: WHO, onEvent: rec.onEvent }).result;

    expect(r.status).toBe('completed');
    expect(r.joined).toMatchObject({ by: 'lead', summary: 'The lead joined two helper results.' });
    expect(r.plan.map((t) => [t.key, t.title, t.status])).toEqual([['h1', 'Read the incident record', 'ok'], ['h2', 'Check recent changes', 'ok']]);
    expect(r.results.map((x) => x.finding)).toEqual(['Helper saw: record INC-1', 'Helper saw: record INC-1']);
    // the trap: a delegation is a tool_call step named delegate_to_worker
    const leadTrace = r.coordination.find((c) => c.kind === 'lead')!.trace;
    expect(leadTrace.filter((s) => s.type === 'tool_call' && s.tool === 'delegate_to_worker')).toHaveLength(2);
    expect(leadTrace.some((s) => s.type === 'delegation')).toBe(false);
    // the other trap: the lead holds no work tool, so it has to delegate
    const leadTools = (lead.requests[0]!.tools ?? []).map((t) => t.name);
    expect(leadTools).toContain('delegate_to_worker');
    expect(leadTools).not.toContain('incident_read');
    // helpers count as agents and their tool calls went through the gate as the starter
    expect(r.usage.agentsStarted).toBe(3);
    expect(host.checks.map((c) => [c.tool, c.principal.userId, c.taskKey])).toEqual([['incident_read', 'u-kahu', 'h1'], ['incident_read', 'u-kahu', 'h2']]);
    expect(rec.steps('swarm.planned')[0]).toMatchObject({ source: 'lead', delegations: 2 });
    expect(r.results.every((x) => x.trace.some((s) => s.type === 'tool_call' && s.tool === 'incident_read'))).toBe(true);
  });

  it('a lead that answers by itself is a reported failure, never a quiet single-agent answer', async () => {
    const lead = fake('m-lead', () => joined('I already know the answer.', [{ claim: 'Trust me' }]));
    const helper = fake('m-helper', () => found('unused'));
    const host = makeHost({ models: { lead, helper }, tools: { incident_read: tool('incident_read') } });
    const r = await weaveSwarm({ host }).start(leadDef(), { principal: WHO }).result;
    expect(r.status).toBe('failed');
    expect(r.stopReason).toBe('lead_did_not_delegate');
    expect(r.joined).toBeUndefined();
    expect(helper.calls).toBe(0);
  });

  it('checker verdicts are written onto the joined findings', async () => {
    const models = happyModels(2);
    models.checker = fake('m-checker', () => verdicts('supported', 'refuted'));
    const r = await weaveSwarm({ host: makeHost({ models }) }).start(fanOut(), { principal: WHO, inputs: { subject: 'x' } }).result;
    expect(r.status).toBe('completed');
    expect(r.check!.outcome).toBe('refuted');
    expect(r.joined!.findings.map((f) => f.verdict)).toEqual(['supported', 'refuted']);
    // the checker has a different brief from the workers and is told to refute
    expect(models.checker.turnsSeen[0]!.system).toContain('prove each numbered claim WRONG');
    expect(models.checker.turnsSeen[0]!.system).toContain('You are the checker.');
    expect(models.checker.turnsSeen[0]!.user).toContain('The claims to try to refute (data):');
  });
});
