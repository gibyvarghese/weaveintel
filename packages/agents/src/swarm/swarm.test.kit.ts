// SPDX-License-Identifier: MIT
/**
 * Test support for the swarm suites: scripted fake models, a host, and
 * definition builders. Imported by `*.test.ts` only; the `.test.` in the file
 * name keeps it out of the published package.
 */

import type { ExecutionContext, Model, ModelRequest, ModelResponse, RunEventEnvelope, Tool } from '@weaveintel/core';
import { Capabilities } from '@weaveintel/core';
import type { PricingResolver } from '@weaveintel/cost-governor';
import type {
  SwarmApprovalAnswer,
  SwarmApprovalRequest,
  SwarmDefinition,
  SwarmHost,
  SwarmLimits,
  SwarmPrincipal,
  SwarmRole,
  SwarmRoleKind,
  SwarmToolCall,
} from './types.js';

// ─── Scripted models ─────────────────────────────────────────

export interface Turn {
  /** 1-based number of this call on this model. */
  readonly n: number;
  readonly req: ModelRequest;
  readonly ctx: ExecutionContext;
  readonly system: string;
  /** The first user message: the agent's brief. */
  readonly user: string;
  /** How many turns this agent session has already taken. */
  readonly turns: number;
  /** The newest tool result in the conversation, if any. */
  readonly lastTool: string | undefined;
}

export type Reply =
  | string
  | Error
  | { readonly call: string; readonly args?: Record<string, unknown> }
  | { readonly calls: readonly { readonly call: string; readonly args?: Record<string, unknown> }[] };

export interface FakeModel extends Model {
  readonly requests: ModelRequest[];
  readonly turnsSeen: Turn[];
  /** Calls made so far. */
  readonly calls: number;
  /** Most calls in flight at the same moment. */
  readonly peak: number;
}

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : JSON.stringify(content);

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function fake(
  id: string,
  script: (turn: Turn) => Reply | Promise<Reply>,
  opts: { delayMs?: number; tokens?: readonly [number, number] } = {},
): FakeModel {
  const caps = new Set([Capabilities.Chat, Capabilities.ToolCalling]);
  const requests: ModelRequest[] = [];
  const turnsSeen: Turn[] = [];
  let calls = 0;
  let active = 0;
  let peak = 0;
  let callId = 0;
  const [promptTokens, completionTokens] = opts.tokens ?? [10, 5];
  return {
    info: { provider: 'fake', modelId: id, capabilities: caps },
    capabilities: caps,
    hasCapability: (c) => caps.has(c),
    requests,
    turnsSeen,
    get calls() { return calls; },
    get peak() { return peak; },
    async generate(ctx: ExecutionContext, req: ModelRequest): Promise<ModelResponse> {
      calls += 1;
      const n = calls;
      requests.push(req);
      active += 1;
      if (active > peak) peak = active;
      try {
        if (opts.delayMs) await sleep(opts.delayMs);
        const tools = req.messages.filter((m) => m.role === 'tool');
        const turn: Turn = {
          n,
          req,
          ctx,
          system: textOf(req.messages.find((m) => m.role === 'system')?.content ?? ''),
          user: textOf(req.messages.find((m) => m.role === 'user')?.content ?? ''),
          turns: req.messages.filter((m) => m.role === 'assistant').length,
          lastTool: tools.length > 0 ? textOf(tools[tools.length - 1]!.content) : undefined,
        };
        turnsSeen.push(turn);
        const reply = await script(turn);
        if (reply instanceof Error) throw reply;
        const usage = { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
        if (typeof reply === 'string') {
          return { id: `${id}-${n}`, model: id, content: reply, toolCalls: [], finishReason: 'stop', usage };
        }
        const list = 'calls' in reply ? reply.calls : [reply];
        return {
          id: `${id}-${n}`,
          model: id,
          content: '',
          toolCalls: list.map((c) => ({ id: `${id}-call-${++callId}`, name: c.call, arguments: JSON.stringify(c.args ?? {}) })),
          finishReason: 'tool_calls',
          usage,
        };
      } finally {
        active -= 1;
      }
    },
  };
}

/**
 * A model whose call never returns. With `honourSignal` it rejects when its
 * context's signal aborts, as a real provider call does.
 */
export function hanging(id: string, opts: { honourSignal?: boolean } = {}): FakeModel {
  return fake(id, (t) => new Promise<Reply>((_resolve, reject) => {
    if (!opts.honourSignal) return;
    const signal = t.ctx.signal;
    if (!signal) return;
    if (signal.aborted) { reject(new Error('aborted')); return; }
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
}

// ─── Reply builders ──────────────────────────────────────────

export const plan = (...tasks: { title: string; brief?: string; role?: string }[]): string =>
  JSON.stringify({ tasks: tasks.map((t) => ({ title: t.title, brief: t.brief ?? `Look into ${t.title}.`, role: t.role ?? 'researcher' })) });

export const found = (finding: string, more: { evidence?: { ref: string; note?: string }[]; confidence?: string; notDone?: string[] } = {}): string =>
  JSON.stringify({
    finding,
    evidence: more.evidence ?? [{ ref: 'INC-1', note: 'seen' }],
    confidence: more.confidence ?? 'high',
    notDone: more.notDone ?? [],
  });

export const joined = (summary: string, findings: { claim: string; from?: string[]; confidence?: string }[] = [], notDone: string[] = []): string =>
  JSON.stringify({
    summary,
    findings: findings.map((f) => ({ claim: f.claim, evidence: [{ ref: 'INC-1', note: 'seen' }], confidence: f.confidence ?? 'high', from: f.from ?? [] })),
    notDone,
  });

export const verdicts = (...v: ('supported' | 'refuted' | 'unverified')[]): string =>
  JSON.stringify({ verdicts: v.map((verdict, i) => ({ claim: i + 1, verdict, reason: `checked claim ${i + 1}` })) });

/** The task key a worker was given, read from its brief. */
export const taskKeyIn = (user: string): string => /Your task, (\S+) \(data\)/.exec(user)?.[1] ?? '?';

/** The run's fence marker, read from a system prompt. */
export const fenceIn = (system: string): string => /<<UNTRUSTED:[a-z0-9]+>>/.exec(system)?.[0] ?? '';

/** The parts of a text that sit outside every fenced block. */
export function outsideFence(text: string, fence: string): string {
  const parts = text.split(fence);
  return parts.filter((_p, i) => i % 2 === 0).join('\n');
}

// ─── Tools ───────────────────────────────────────────────────

export interface FakeTool extends Tool {
  readonly seen: { ctx: ExecutionContext; args: Record<string, unknown> }[];
}

export function tool(
  name: string,
  run: (args: Record<string, unknown>, ctx: ExecutionContext) => string | Promise<string> = () => 'ok',
  more: { riskLevel?: Tool['schema']['riskLevel']; tags?: string[] } = {},
): FakeTool {
  const seen: FakeTool['seen'] = [];
  return {
    seen,
    schema: {
      name,
      description: `The ${name} tool.`,
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
      ...(more.riskLevel ? { riskLevel: more.riskLevel } : {}),
      ...(more.tags ? { tags: more.tags } : {}),
    },
    async invoke(ctx, input) {
      seen.push({ ctx, args: input.arguments });
      return { content: await run(input.arguments, ctx) };
    },
  };
}

// ─── Host ────────────────────────────────────────────────────

export interface TestHost extends SwarmHost {
  readonly checks: SwarmToolCall[];
  readonly approvals: SwarmApprovalRequest[];
  readonly modelAsks: { purpose: string; role: string }[];
}

export interface HostOptions {
  /** Models by role key; `*` is the fallback. */
  models: { readonly [role: string]: Model };
  tools?: Record<string, Tool> | ((name: string, principal: SwarmPrincipal) => Tool | undefined);
  allow?: (call: SwarmToolCall) => boolean | { allow: boolean; reason?: string } | Promise<boolean>;
  approval?: (req: SwarmApprovalRequest) => SwarmApprovalAnswer | Promise<SwarmApprovalAnswer>;
  pricing?: PricingResolver;
  prompts?: Record<string, string>;
  isWrite?: (name: string) => boolean;
}

export function makeHost(o: HostOptions): TestHost {
  const checks: SwarmToolCall[] = [];
  const approvals: SwarmApprovalRequest[] = [];
  const modelAsks: { purpose: string; role: string }[] = [];
  const toolsOpt = o.tools;
  const h: TestHost = {
    checks,
    approvals,
    modelAsks,
    modelFor(purpose, role) {
      modelAsks.push({ purpose, role: role.key });
      const m = o.models[role.key] ?? o.models['*'];
      if (!m) throw new Error(`no model for role ${role.key}`);
      return m;
    },
    tools: {
      get: (name, principal) => (typeof toolsOpt === 'function' ? toolsOpt(name, principal) : toolsOpt?.[name]),
      ...(o.isWrite ? { isWrite: o.isWrite } : {}),
    },
    permission: {
      async check(call) {
        checks.push(call);
        const r = o.allow ? await o.allow(call) : true;
        return typeof r === 'boolean' ? { allow: r, ...(r ? {} : { reason: 'the gate said no' }) } : r;
      },
    },
    ...(o.approval
      ? { approval: { async request(req: SwarmApprovalRequest) { approvals.push(req); return o.approval!(req); } } }
      : {}),
    ...(o.pricing ? { pricing: o.pricing } : {}),
    ...(o.prompts ? { prompt: { resolve: (ref: string) => o.prompts![ref] ?? '' } } : {}),
  };
  return h;
}

// ─── Definitions ─────────────────────────────────────────────

export const LIMITS: SwarmLimits = { maxAgents: 12, maxConcurrency: 3, maxStepsPerAgent: 4, maxWallClockMs: 20_000 };

export const role = (key: string, kind: SwarmRoleKind, tools: string[] = [], more: Partial<SwarmRole> = {}): SwarmRole => ({
  key,
  kind,
  description: `the ${key}`,
  prompt: `You are the ${key}.`,
  modelPurpose: kind === 'worker' ? 'fast' : 'reasoning',
  tools,
  ...more,
});

/** planner → researchers → reducer → checker. */
export function fanOut(over: Partial<SwarmDefinition> = {}): SwarmDefinition {
  return {
    key: 'incident_review',
    goalTemplate: 'Find out why {{subject}} failed.',
    pattern: 'plan_fan_out_join',
    roles: [role('planner', 'planner'), role('researcher', 'worker'), role('reducer', 'reducer'), role('checker', 'checker')],
    limits: LIMITS,
    taskSource: { kind: 'planner', role: 'planner' },
    join: { kind: 'reducer', role: 'reducer' },
    checker: { role: 'checker' },
    onFailure: { worker: 'continue', maxRetriesPerTask: 1 },
    approvalPoints: [],
    ...over,
  };
}

export const WHO: SwarmPrincipal = { userId: 'u-kahu', tenantId: 't-kauri', roles: ['service_desk_lead'] };

/** Collect a run's events. */
export function recorder(): { events: RunEventEnvelope[]; onEvent: (e: RunEventEnvelope) => void; steps: (type: string) => Record<string, unknown>[]; kinds: () => string[] } {
  const events: RunEventEnvelope[] = [];
  return {
    events,
    onEvent: (e) => { events.push(e); },
    steps: (type) => events
      .filter((e) => e.kind === 'step.update' && (e.payload as { type?: string }).type === type)
      .map((e) => e.payload as Record<string, unknown>),
    kinds: () => events.map((e) => e.kind),
  };
}

/** The standard happy scripts for the fan-out definition. */
// A type alias, not an interface, so it can be handed to a host that takes models by role key.
export type HappyModels = { planner: FakeModel; researcher: FakeModel; reducer: FakeModel; checker: FakeModel };
export function happyModels(tasks = 3): HappyModels {
  return {
    planner: fake('m-planner', () => plan(...Array.from({ length: tasks }, (_v, i) => ({ title: `Part ${i + 1}` })))),
    researcher: fake('m-researcher', (t) => found(`Finding for ${taskKeyIn(t.user)}`), { delayMs: 15 }),
    reducer: fake('m-reducer', () => joined('The joined answer.', [{ claim: 'Claim one', from: ['t1'] }, { claim: 'Claim two', from: ['t2'] }])),
    checker: fake('m-checker', () => verdicts('supported', 'supported')),
  };
}
