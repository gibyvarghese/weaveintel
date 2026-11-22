/**
 * Example 170: a swarm of agents on one task
 *
 * A swarm is a group of agents set to work on one goal: a planner splits the
 * goal into tasks, workers take one task each side by side, a reducer joins
 * what they found and a checker tries to refute it. The whole thing is driven
 * by a definition that is plain data, and every limit is enforced in code.
 *
 * Run it without a key and it rehearses with scripted models (no network):
 *
 *   npx tsx examples/170-agent-swarm.ts
 *
 * Run it for real against Claude (about ten model calls, capped at twelve in
 * the definition, on the smallest model):
 *
 *   SWARM_LIVE=1 ANTHROPIC_API_KEY=... npx tsx examples/170-agent-swarm.ts
 *
 * Either way it asserts on the trace: more than one worker ran, two were at
 * work at the same moment, each called a tool as the person who started the
 * run, and the checker ran.
 *
 * WeaveIntel packages used:
 *   @weaveintel/agents             — weaveSwarm, the swarm engine
 *   @weaveintel/provider-anthropic — the Claude model (live mode only)
 *   @weaveintel/core               — the Model and Tool contracts, Capabilities
 */

import { strict as assert } from 'node:assert';
import { weaveSwarm } from '@weaveintel/agents';
import type { SwarmDefinition, SwarmHost, SwarmToolCall } from '@weaveintel/agents';
import { Capabilities } from '@weaveintel/core';
import type { Model, ModelRequest, ModelResponse, RunEventEnvelope, Tool } from '@weaveintel/core';
import { weaveAnthropicModel } from '@weaveintel/provider-anthropic';

const LIVE = process.env['SWARM_LIVE'] === '1';
const MODEL_ID = process.env['SWARM_MODEL'] ?? 'claude-haiku-4-5-20251001';
/** US dollars per million tokens for the model above; used for the cost cap. */
const PRICE = { inputPerMillion: 1, outputPerMillion: 5 };

// ─── The definition: plain data ──────────────────────────────

const definition: SwarmDefinition = {
  key: 'outage_review',
  label: 'Review an outage',
  goalTemplate: 'Work out the most likely cause of incident {{incident}} and name the evidence for it.',
  pattern: 'plan_fan_out_join',
  roles: [
    {
      key: 'planner',
      kind: 'planner',
      modelPurpose: 'fast',
      tools: [],
      prompt: 'Split the goal into exactly two tasks for two researchers working apart: one reads the incident record itself, the other looks at the changes made shortly before it.',
    },
    {
      key: 'researcher',
      kind: 'worker',
      description: 'Reads incident records and the change log.',
      modelPurpose: 'fast',
      tools: ['incident_read', 'change_search'],
      prompt: 'You are a careful incident researcher. Use one tool call to get the facts you need, then answer. Say only what the records support.',
    },
    {
      key: 'reducer',
      kind: 'reducer',
      modelPurpose: 'fast',
      tools: [],
      prompt: 'Join the researchers\' findings into one short answer. Keep at most two claims, each tied to the task it came from.',
    },
    {
      key: 'checker',
      kind: 'checker',
      modelPurpose: 'fast',
      tools: [],
      prompt: 'You are a sceptical reviewer. Try to refute each claim from the evidence given. A claim the evidence does not carry is not supported.',
    },
  ],
  limits: {
    maxAgents: 6,
    maxConcurrency: 2,
    maxStepsPerAgent: 3,
    maxWallClockMs: 120_000,
    maxModelCalls: 12,
    maxTotalTokens: 60_000,
    maxCostUsd: 0.15,
  },
  taskSource: { kind: 'planner', role: 'planner', maxTasks: 2 },
  join: { kind: 'reducer', role: 'reducer' },
  checker: { role: 'checker', maxClaims: 2 },
  onFailure: { worker: 'continue', maxRetriesPerTask: 0 },
  approvalPoints: [],
};

// ─── The host: models, tools, and who may do what ────────────

const RECORDS: Record<string, string> = {
  'INC-4471': 'INC-4471, 2 March 09:14. Checkout returned errors for 38 minutes. Payment service logs show "connection pool exhausted" from 09:12. Resolved 09:52 by rolling back a release. Reported by the service desk.',
};
const CHANGES = [
  'CHG-2210, 2 March 09:05: payment service release 8.3 lowered the database connection pool from 50 to 5. Rolled back 09:52.',
  'CHG-2198, 1 March 16:30: marketing banner text changed on the home page.',
];

function readTool(name: string, description: string, run: (q: string) => string): Tool {
  return {
    schema: { name, description, parameters: { type: 'object', properties: { q: { type: 'string', description: 'What to look for.' } }, required: ['q'] } },
    async invoke(_ctx, input) {
      return { content: run(String(input.arguments['q'] ?? '')) };
    },
  };
}

const tools: Record<string, Tool> = {
  incident_read: readTool('incident_read', 'Read one incident record by its number, for example INC-4471.', (q) => RECORDS[q.trim().toUpperCase()] ?? `No incident ${q}.`),
  change_search: readTool('change_search', 'List the changes made around a date or to a service.', () => CHANGES.join('\n')),
};

/** Scripted models for the rehearsal: the same shapes a real model is asked for. */
function rehearsalModel(role: string): Model {
  const caps = new Set([Capabilities.Chat, Capabilities.ToolCalling]);
  let n = 0;
  return {
    info: { provider: 'rehearsal', modelId: `rehearsal-${role}`, capabilities: caps },
    capabilities: caps,
    hasCapability: (c) => caps.has(c),
    async generate(_ctx, req: ModelRequest): Promise<ModelResponse> {
      n += 1;
      await new Promise((r) => setTimeout(r, 20));
      const usage = { promptTokens: 200, completionTokens: 60, totalTokens: 260 };
      const base = { id: `${role}-${n}`, model: `rehearsal-${role}`, usage };
      const say = (content: string): ModelResponse => ({ ...base, content, toolCalls: [], finishReason: 'stop' });
      if (role === 'planner') {
        return say(JSON.stringify({ tasks: [
          { title: 'Read the incident record', brief: 'Read INC-4471 and say what failed and when.', role: 'researcher' },
          { title: 'Look at recent changes', brief: 'Find changes made shortly before INC-4471.', role: 'researcher' },
        ] }));
      }
      if (role === 'researcher') {
        const usedTool = req.messages.some((m) => m.role === 'tool');
        if (!usedTool) {
          const text = JSON.stringify(req.messages.find((m) => m.role === 'user')?.content ?? '');
          const name = /changes/i.test(text) ? 'change_search' : 'incident_read';
          return { ...base, content: '', toolCalls: [{ id: `call-${n}`, name, arguments: JSON.stringify({ q: 'INC-4471' }) }], finishReason: 'tool_calls' };
        }
        return say(JSON.stringify({ finding: 'The payment service ran out of database connections after release 8.3.', evidence: [{ ref: 'CHG-2210', note: 'pool lowered from 50 to 5' }], confidence: 'high', notDone: [] }));
      }
      if (role === 'reducer') {
        return say(JSON.stringify({ summary: 'Release 8.3 cut the connection pool and checkout failed.', findings: [{ claim: 'Release 8.3 lowered the pool to 5.', evidence: [{ ref: 'CHG-2210' }], confidence: 'high', from: ['t2'] }], notDone: [] }));
      }
      return say(JSON.stringify({ verdicts: [{ claim: 1, verdict: 'supported', reason: 'CHG-2210 says so.' }] }));
    },
  };
}

const permissionChecks: SwarmToolCall[] = [];
const modelAsks: string[] = [];

const host: SwarmHost = {
  modelFor(purpose, role) {
    modelAsks.push(`${role.key}:${purpose}`);
    return LIVE ? weaveAnthropicModel(MODEL_ID) : rehearsalModel(role.key);
  },
  tools: { get: (name) => tools[name] },
  permission: {
    async check(call) {
      permissionChecks.push(call);
      // A real host asks its policy engine here, as `call.principal`.
      return { allow: call.principal.userId === 'u-demo' };
    },
  },
  pricing: { resolve: () => PRICE },
};

// ─── Run it and assert on the trace ──────────────────────────

async function main(): Promise<void> {
  if (LIVE && !process.env['ANTHROPIC_API_KEY']) throw new Error('SWARM_LIVE=1 needs ANTHROPIC_API_KEY in the environment.');
  const events: RunEventEnvelope[] = [];
  const swarm = weaveSwarm({ host });
  const handle = swarm.start(definition, {
    principal: { userId: 'u-demo', tenantId: 't-demo' },
    inputs: { incident: 'INC-4471' },
    onEvent: (e) => { events.push(e); },
  });
  const r = await handle.result;

  const steps = (type: string): Record<string, unknown>[] => events
    .filter((e) => e.kind === 'step.update' && (e.payload as { type?: string }).type === type)
    .map((e) => e.payload as Record<string, unknown>);
  const order = events.map((e) => (e.kind === 'step.update' ? String((e.payload as { type?: string }).type) : e.kind));
  // The planner, reducer and checker are agents too and report the same two steps; `kind` tells them apart.
  const workerSteps = events
    .filter((e) => e.kind === 'step.update' && (e.payload as { kind?: string }).kind === 'worker')
    .map((e) => String((e.payload as { type?: string }).type));
  const firstFinish = workerSteps.indexOf('swarm.worker.finished');
  const startedBeforeFirstFinish = workerSteps.slice(0, firstFinish).filter((k) => k === 'swarm.worker.started').length;
  const workersOk = r.results.filter((x) => x.status === 'ok');

  const report = {
    mode: LIVE ? `live ${MODEL_ID}` : 'rehearsal (scripted models, no network)',
    status: r.status,
    stopReason: r.stopReason ?? null,
    stopDetail: r.stopDetail ?? null,
    plan: r.plan.map((t) => ({ key: t.key, title: t.title, role: t.role, status: t.status })),
    workers: r.results.map((x) => ({ task: x.taskKey, status: x.status, structured: x.structured, confidence: x.confidence, trace: x.trace.map((s) => (s.tool ? `${s.type}:${s.tool}` : s.type)), finding: x.finding })),
    workersStartedBeforeFirstFinish: startedBeforeFirstFinish,
    joined: r.joined ? { by: r.joined.by, summary: r.joined.summary, findings: r.joined.findings.map((f) => ({ claim: f.claim, from: f.from, verdict: f.verdict ?? null })), notDone: r.joined.notDone } : null,
    check: r.check ?? null,
    failures: r.failures,
    usage: r.usage,
    permissionChecks: permissionChecks.map((c) => `${c.principal.userId} ${c.role}/${c.taskKey} ${c.tool}`),
    modelAsks,
    eventKinds: order,
  };
  console.log(JSON.stringify(report, null, 2));

  // The limits held, whatever the models did.
  assert.ok(r.usage.modelCalls <= 12, `model calls ${r.usage.modelCalls} went over the cap of 12`);
  assert.ok(r.usage.costUsd <= 0.15, `cost ${r.usage.costUsd} went over the cap`);
  // More than one worker really ran...
  assert.ok(r.plan.length >= 2, `the plan has ${r.plan.length} task(s), expected two`);
  assert.ok(workersOk.length >= 2, `${workersOk.length} worker(s) finished, expected two`);
  assert.ok(steps('swarm.worker.started').filter((p) => p['kind'] === 'worker').length >= 2, 'two workers should have started');
  // ...side by side...
  assert.ok(r.usage.peakConcurrency >= 2, `peak concurrency was ${r.usage.peakConcurrency}`);
  assert.ok(startedBeforeFirstFinish >= 2, 'the second worker should start before the first finishes');
  // ...each used a tool, and every call was checked as the person who started the run.
  assert.ok(workersOk.every((x) => x.trace.some((s) => s.type === 'tool_call')), 'each worker should have called a tool');
  assert.ok(permissionChecks.length >= 2 && permissionChecks.every((c) => c.principal.userId === 'u-demo'), 'tool calls must be checked as the starter');
  // The join was done by the reducer and the checker ran.
  assert.equal(r.joined?.by, 'reducer');
  assert.equal(steps('swarm.checked').length, 1, 'the checker should have run once');
  assert.ok(r.check && r.check.verdicts.length >= 1, 'the checker should have given a verdict');
  assert.equal(r.status, 'completed');
  console.log(`\nOK: ${workersOk.length} workers, peak ${r.usage.peakConcurrency} at once, ${r.usage.modelCalls} model calls, ${r.usage.totalTokens} tokens, $${r.usage.costUsd.toFixed(4)}; checker said "${r.check.outcome}".`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
