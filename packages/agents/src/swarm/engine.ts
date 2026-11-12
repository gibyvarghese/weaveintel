// SPDX-License-Identifier: MIT
/**
 * @weaveintel/agents — swarm: the engine.
 *
 * One engine runs every pattern. A definition (plain data) picks the strategy;
 * the engine plans, fans out under a concurrency limit, joins, and checks.
 *
 * What the engine never does:
 *   - run a second agent loop: every role is one `weaveAgent` run, and a lead
 *     with helpers is the existing supervisor;
 *   - trust a model for a limit, a permission or a structure: limits live in
 *     `guard.ts`, every tool call goes through the host's permission port as
 *     the person who started the run, and every reply is parsed and checked;
 *   - hide a failure: a failed worker, a rejected plan, a join done in code and
 *     a lead that did not delegate are all reported in the result.
 */

import {
  weaveContext,
  weaveToolRegistry,
  type AgentResult,
  type AgentStep,
  type ExecutionContext,
  type Model,
  type ModelResponse,
  type RunEventEnvelope,
  type Tool,
  type ToolRegistry,
} from '@weaveintel/core';
import { weaveAgent } from '../agent.js';
import type { WorkerDefinition } from '../supervisor-runtime.js';
import {
  createSwarmBudget,
  guardModel,
  newAgentMeter,
  SwarmAgentStepLimit,
  SwarmStopSignal,
  type SwarmAgentMeter,
  type SwarmBudget,
} from './guard.js';
import {
  checkerMessage,
  goalForAgent,
  goalForDisplay,
  joinMessage,
  judgeMessage,
  leadMessage,
  newSwarmFence,
  parseJoin,
  parsePick,
  parsePlan,
  parseVerdicts,
  parseWorkerReply,
  plannerMessage,
  SWARM_TEXT_LIMITS,
  systemPromptFor,
  workerMessage,
  type ParsedJoin,
} from './prompts.js';
import { createInMemorySwarmRunStore } from './store.js';
import {
  SWARM_COORDINATION_KEYS,
  SWARM_TOOL_NAME_RULE,
  type SwarmAgentUsage,
  type SwarmApprovalAnswer,
  type SwarmApprovalPoint,
  type SwarmCheck,
  type SwarmDefinition,
  type SwarmEstimate,
  type SwarmFailure,
  type SwarmHost,
  type SwarmJoined,
  type SwarmJoinedFinding,
  type SwarmPrincipal,
  type SwarmRole,
  type SwarmRunHandle,
  type SwarmRunRecord,
  type SwarmRunResult,
  type SwarmRunStatus,
  type SwarmRunStore,
  type SwarmStartInput,
  type SwarmStopReason,
  type SwarmTask,
  type SwarmToolCall,
  type SwarmTraceStep,
  type SwarmWorkerResult,
} from './types.js';
import { estimateSwarm, roleOf, SwarmDefinitionError, validateSwarmDefinition, type SwarmValidation } from './validate.js';

export interface SwarmEngineOptions {
  readonly host: SwarmHost;
  /** Where run state goes. In memory when not given. */
  readonly store?: SwarmRunStore;
  readonly now?: () => number;
  readonly newId?: () => string;
}

export interface SwarmResumeOptions {
  readonly ctx?: ExecutionContext;
  readonly onEvent?: (event: RunEventEnvelope) => void;
}

export interface SwarmEngine {
  readonly store: SwarmRunStore;
  /** Every problem with a definition, without running it. */
  validate(def: SwarmDefinition): SwarmValidation;
  /** What a person is shown before a start. Calls no model. */
  estimate(def: SwarmDefinition, input?: Pick<SwarmStartInput, 'items'>): SwarmEstimate;
  /**
   * Start a run. Throws `SwarmDefinitionError` at once when the definition is
   * not valid or asks for something this host cannot give; after that the
   * handle's `result` never rejects.
   */
  start(def: SwarmDefinition, input: SwarmStartInput): SwarmRunHandle;
  /**
   * Carry on a run that was interrupted or is waiting for an approval. The run
   * keeps the person it was started as, the work already done and the limits
   * already used. Rejects when the run is unknown or already over.
   */
  resume(runId: string, def: SwarmDefinition, opts?: SwarmResumeOptions): Promise<SwarmRunHandle>;
}

/** Thrown by `resume` when a run cannot be carried on. */
export class SwarmResumeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SwarmResumeError';
  }
}

/** Ends the flow early with a status the engine decided (not a crash). */
class SwarmHalt extends Error {
  constructor(
    readonly status: SwarmRunStatus,
    readonly reason: SwarmStopReason,
    detail: string,
    readonly waitingAt?: SwarmApprovalPoint,
  ) {
    super(detail);
  }
}

const RESUMABLE: readonly SwarmRunStatus[] = ['pending', 'running', 'interrupted', 'waiting_approval'];
const JOIN_RETRIES = 1;
const PLAN_RETRIES = 1;
const CHECK_RETRIES = 1;
const MAX_TIMER_MS = 2 ** 31 - 1;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Whether a tool changes something. The host's word wins; else the tool's own declaration. */
function toolWrites(host: SwarmHost, name: string, tool: Tool): boolean {
  const said = host.tools.isWrite?.(name);
  if (said !== undefined) return said;
  const risk = tool.schema.riskLevel;
  if (risk !== undefined && risk !== 'read-only') return true;
  return (tool.schema.tags ?? []).includes('write');
}

/** What a definition asks of a host that this host cannot give. */
function hostProblems(def: SwarmDefinition, host: SwarmHost, principal: SwarmPrincipal): string[] {
  const errors: string[] = [];
  const writes = new Set(def.writeTools ?? []);
  if ((def.approvalPoints.length > 0 || writes.size > 0) && !host.approval) {
    errors.push('the definition has approval points or write tools, but the host has no approval port');
  }
  if (def.roles.some((r) => r.promptRef !== undefined && r.prompt === undefined) && !host.prompt) {
    errors.push('a role names its brief by reference, but the host has no prompt port');
  }
  if (def.limits.maxCostUsd !== undefined && !host.pricing) {
    errors.push('the definition has a cost limit, but the host has no prices to count the cost with');
  }
  if (typeof principal?.userId !== 'string' || principal.userId.trim() === '') {
    errors.push('a run must be started as a person: the principal has no userId');
  }
  const seen = new Set<string>();
  for (const role of def.roles) {
    for (const name of role.tools) {
      if (seen.has(name)) continue;
      seen.add(name);
      let tool: Tool | undefined;
      try {
        tool = host.tools.get(name, principal);
      } catch (err) {
        errors.push(`the host could not give the tool "${name}": ${errText(err)}`);
        continue;
      }
      if (!tool) { errors.push(`the host has no tool named "${name}"`); continue; }
      if (tool.schema.name !== name) errors.push(`the host's tool for "${name}" calls itself "${tool.schema.name}"`);
      if (!SWARM_TOOL_NAME_RULE.test(tool.schema.name)) errors.push(`the tool name "${tool.schema.name}" does not match ${String(SWARM_TOOL_NAME_RULE)}`);
      if (toolWrites(host, name, tool) && !writes.has(name)) {
        errors.push(`the tool "${name}" writes, but the definition does not name it as a write tool`);
      }
    }
  }
  return errors;
}

export function weaveSwarm(options: SwarmEngineOptions): SwarmEngine {
  const host = options.host;
  const store = options.store ?? createInMemorySwarmRunStore();
  const now = options.now ?? Date.now;
  let idCounter = 0;
  const newId = options.newId ?? (() => `sw_${now().toString(36)}_${(++idCounter).toString(36)}_${Math.random().toString(36).slice(2, 8)}`);

  function assertRunnable(def: SwarmDefinition, principal: SwarmPrincipal): void {
    const v = validateSwarmDefinition(def);
    if (!v.ok) throw new SwarmDefinitionError(v.errors);
    const problems = hostProblems(def, host, principal);
    if (problems.length > 0) throw new SwarmDefinitionError(problems);
  }

  interface Launch {
    readonly def: SwarmDefinition;
    readonly record: SwarmRunRecord;
    readonly tasks: SwarmTask[];
    readonly results: Map<string, SwarmWorkerResult>;
    readonly coordination: SwarmWorkerResult[];
    readonly lastSequence: number;
    readonly resumed: boolean;
    readonly ctx?: ExecutionContext;
    readonly onEvent?: (event: RunEventEnvelope) => void;
  }

  function launch(l: Launch): SwarmRunHandle {
    const { def, record, tasks, results, coordination } = l;
    const runId = record.runId;
    const principal: SwarmPrincipal = Object.freeze({ ...record.principal });
    const limits = def.limits;
    const budget: SwarmBudget = createSwarmBudget(limits, l.resumed ? record.usage : undefined, now);
    record.usage = budget.usage;
    const fence = newSwarmFence();
    const goalAgent = goalForAgent(def.goalTemplate, record.inputs, fence);
    const writeNames = new Set(def.writeTools ?? []);
    const baseCtx: ExecutionContext = l.ctx ?? weaveContext({});
    let degraded: { reason: SwarmStopReason; detail: string } | undefined;
    const noteDegraded = (reason: SwarmStopReason, detail: string): void => { degraded ??= { reason, detail }; };

    // ── Events and the store ────────────────────────────────
    const listeners = new Set<(event: RunEventEnvelope) => void>();
    if (l.onEvent) listeners.add(l.onEvent);
    let sequence = l.lastSequence;
    let chain: Promise<void> = Promise.resolve();
    let storeBroken = false;

    const persist = (what: string, write: () => Promise<void>): void => {
      chain = chain.then(write).catch((err: unknown) => {
        if (storeBroken) return;
        storeBroken = true;
        // A run whose records cannot be kept is stopped, and says so.
        budget.requestStop('engine_error', `The run's records could not be saved (${what}): ${errText(err)}`);
      });
    };

    const emit = (kind: string, payload: Record<string, unknown>): void => {
      const event: RunEventEnvelope = { runId, sequence: ++sequence, kind, payload, timestamp: now() };
      persist('event', () => store.appendEvent(event));
      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch (err) {
          if (kind !== 'diagnostic') {
            emit('diagnostic', { channel: 'swarm', data: { type: 'swarm.listener_error', message: errText(err) } });
          }
        }
      }
    };
    const step = (type: string, data: Record<string, unknown>): void => emit('step.update', { type, ...data });
    const diagnostic = (type: string, data: Record<string, unknown>): void => emit('diagnostic', { channel: 'swarm', data: { type, ...data } });

    const saveRun = (): void => {
      let snap: SwarmRunRecord;
      try {
        snap = structuredClone(record);
      } catch (err) {
        persist('run', () => Promise.reject(err));
        return;
      }
      persist('run', () => store.updateRun(runId, snap));
    };
    const saveTask = (task: SwarmTask): void => {
      const snap = { ...task };
      persist('task', () => store.putTask(runId, snap));
    };
    const saveResult = (result: SwarmWorkerResult): void => {
      persist('result', () => store.putResult(runId, result));
    };
    const addFailure = (f: SwarmFailure): void => { record.failures.push(f); };

    // ── Roles: model, brief, tools (each resolved once per run) ──
    const models = new Map<string, Promise<Model>>();
    const modelOf = (role: SwarmRole): Promise<Model> => {
      let m = models.get(role.key);
      if (!m) {
        m = Promise.resolve().then(() => host.modelFor(role.modelPurpose, role));
        models.set(role.key, m);
      }
      return m;
    };
    const briefs = new Map<string, Promise<string>>();
    const briefOf = (role: SwarmRole): Promise<string> => {
      let b = briefs.get(role.key);
      if (!b) {
        b = Promise.resolve().then(async () => {
          const text = role.prompt ?? (role.promptRef !== undefined && host.prompt ? await host.prompt.resolve(role.promptRef, role) : '');
          if (typeof text !== 'string' || text.trim() === '') throw new Error(`The role "${role.key}" has no brief.`);
          return text;
        });
        briefs.set(role.key, b);
      }
      return b;
    };
    const stepsFor = (role: SwarmRole): number => Math.min(role.maxSteps ?? limits.maxStepsPerAgent, limits.maxStepsPerAgent);

    /**
     * Wrap a host tool. The order is fixed: is the run still going, may the
     * person do this, does a write have a person's yes — and only then the tool.
     */
    function wrapTool(inner: Tool, role: SwarmRole, taskKeyOf: () => string, onCall?: (name: string, durationMs: number) => void): Tool {
      const name = inner.schema.name;
      return {
        schema: inner.schema,
        async invoke(ctx, input) {
          const taskKey = taskKeyOf();
          const callId = newId();
          const started = now();
          const args = (input.arguments ?? {}) as Record<string, unknown>;
          budget.usage.toolCalls += 1;
          const base = { toolName: name, taskKey, role: role.key, callId };
          emit('tool.invoked', base);
          const refuse = (code: string, message: string) => {
            emit('tool.errored', { ...base, code, error: clip(message, 400), durationMs: now() - started });
            onCall?.(name, now() - started);
            return { content: message, isError: true };
          };
          if (budget.stop) return refuse('stopped', 'The run has stopped. The tool was not called.');

          const call: SwarmToolCall = { principal, tool: name, args, runId, taskKey, role: role.key };
          let verdict: { allow: boolean; reason?: string };
          try {
            verdict = await host.permission.check(call);
          } catch (err) {
            // A permission check that cannot answer is a no.
            verdict = { allow: false, reason: `the permission check failed (${errText(err)})` };
          }
          if (!verdict || verdict.allow !== true) {
            return refuse('denied', `Not allowed: ${verdict?.reason ?? 'the person this run acts for may not do this'}.`);
          }

          if (toolWrites(host, name, inner)) {
            if (!writeNames.has(name) || !host.approval) {
              return refuse('write_not_named', 'Not allowed: this swarm is not set up to make this change.');
            }
            const taskId = `${runId}:${callId}`;
            const summary = `The ${role.label ?? role.key} agent wants to use "${name}", which makes a change.`;
            emit('approval.request', { taskId, toolName: name, title: 'A change is waiting for a yes', description: summary, riskLevel: inner.schema.riskLevel ?? 'write', taskKey, role: role.key });
            let answer: SwarmApprovalAnswer;
            let why = '';
            try {
              answer = await host.approval.request({ point: 'before_write', runId, principal, summary, toolCall: call });
            } catch (err) {
              answer = 'denied';
              why = ` (the approval could not be asked for: ${errText(err)})`;
            }
            emit('approval.resolved', { taskId, action: answer, taskKey, role: role.key });
            if (answer !== 'approved') {
              return answer === 'pending'
                ? refuse('approval_pending', 'Not done: this change is waiting for a person to approve it. It has NOT been made.')
                : refuse('approval_denied', `Not done: this change was not approved${why}. It has NOT been made.`);
            }
          }

          try {
            // The tool runs as the person who started the run, whatever context the agent handed over.
            const out = await inner.invoke({ ...ctx, userId: principal.userId, tenantId: principal.tenantId }, input);
            const durationMs = now() - started;
            if (out.isError) emit('tool.errored', { ...base, code: 'tool_error', error: clip(String(out.content ?? ''), 400), durationMs });
            else emit('tool.completed', { ...base, durationMs });
            onCall?.(name, durationMs);
            return out;
          } catch (err) {
            emit('tool.errored', { ...base, code: 'tool_threw', error: clip(errText(err), 400), durationMs: now() - started });
            onCall?.(name, now() - started);
            throw err;
          }
        },
      };
    }

    function toolsFor(role: SwarmRole, taskKeyOf: () => string, onCall?: (name: string, durationMs: number) => void): ToolRegistry | undefined {
      if (role.tools.length === 0) return undefined;
      const registry = weaveToolRegistry();
      for (const name of role.tools) {
        const inner = host.tools.get(name, principal);
        if (!inner) throw new Error(`The host has no tool named "${name}".`);
        registry.register(wrapTool(inner, role, taskKeyOf, onCall));
      }
      return registry;
    }

    const costOf = (role: SwarmRole) => ({
      onCost: (entry: Parameters<SwarmRunStore['recordCost']>[0]): void => {
        persist('cost', () => store.recordCost(entry));
        // Keep the stored totals current after every call, so a run carried on
        // after a restart counts what was already spent against the same limits.
        budget.touchClock();
        saveRun();
        emit('usage.update', {
          promptTokens: entry.promptTokens,
          completionTokens: entry.completionTokens,
          totalTokens: entry.promptTokens + entry.completionTokens,
          costUsd: entry.costUsd,
          model: entry.model,
          taskKey: entry.taskKey,
          role: role.key,
          priced: entry.priced,
          run: {
            agentsStarted: budget.usage.agentsStarted,
            modelCalls: budget.usage.modelCalls,
            totalTokens: budget.usage.totalTokens,
            costUsd: budget.usage.costUsd,
          },
          caps: {
            maxAgents: limits.maxAgents,
            ...(limits.maxModelCalls !== undefined ? { maxModelCalls: limits.maxModelCalls } : {}),
            ...(limits.maxTotalTokens !== undefined ? { maxTotalTokens: limits.maxTotalTokens } : {}),
            ...(limits.maxCostUsd !== undefined ? { maxCostUsd: limits.maxCostUsd } : {}),
          },
        });
      },
      onLedgerError: (message: string): void => diagnostic('swarm.ledger_error', { role: role.key, message }),
    });

    // ── One agent run, for every kind of role ───────────────
    interface AgentRun {
      readonly ok: boolean;
      readonly output: string;
      readonly failure?: { readonly reason: SwarmFailure['reason']; readonly message: string };
      readonly usage: SwarmAgentUsage;
      readonly trace: SwarmTraceStep[];
      readonly steps: readonly AgentStep[];
      readonly startedAt: number;
      readonly finishedAt: number;
    }

    const stopFailure = (): { reason: SwarmFailure['reason']; message: string } => {
      const s = budget.stop;
      return { reason: s?.reason === 'cancelled' ? 'cancelled' : 'limit', message: s?.detail ?? 'The run stopped.' };
    };

    interface LeadOptions {
      readonly workers: WorkerDefinition[];
      readonly maxDelegations: number;
      readonly beforeCall: () => void;
    }

    async function runAgent(
      role: SwarmRole,
      taskKey: string,
      attempt: number,
      title: string,
      userMessage: string,
      extra: { judge?: 'pick' | 'merge'; lead?: LeadOptions } = {},
    ): Promise<AgentRun> {
      const startedAt = now();
      const none: SwarmAgentUsage = { steps: 0, toolCalls: 0, modelCalls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, durationMs: 0 };
      if (!budget.startAgent()) {
        return { ok: false, output: '', failure: stopFailure(), usage: none, trace: [], steps: [], startedAt, finishedAt: now() };
      }
      budget.enter();
      step('swarm.worker.started', { taskKey, role: role.key, kind: role.kind, attempt, title: clip(title, SWARM_TEXT_LIMITS.taskTitle) });
      const meter: SwarmAgentMeter = newAgentMeter();
      const maxSteps = stepsFor(role);
      let result: AgentResult | undefined;
      let failure: AgentRun['failure'];
      try {
        const inner = await modelOf(role);
        const brief = await briefOf(role);
        const model = guardModel(inner, budget, {
          runId,
          role: role.key,
          taskKey: () => taskKey,
          maxSteps,
          meter: () => meter,
          ...(host.pricing ? { pricing: host.pricing } : {}),
          ...(host.ledger ? { ledger: host.ledger } : {}),
          now,
          newId,
          ...(extra.lead ? { beforeCall: extra.lead.beforeCall } : {}),
          ...costOf(role),
        });
        const tools = extra.lead ? undefined : toolsFor(role, () => taskKey);
        const agent = weaveAgent({
          name: role.key,
          model,
          systemPrompt: systemPromptFor(role, brief, fence, { maxSteps, ...(extra.judge ? { judge: extra.judge } : {}) }),
          maxSteps,
          // The agent loop asks before every step; a stopped run takes no more steps.
          policy: { shouldContinue: async () => ({ continue: !budget.checkTime() }) },
          ...(tools ? { tools } : {}),
          ...(extra.lead
            ? {
                workers: extra.lead.workers,
                includeUtilityTools: false,
                maxDelegations: extra.lead.maxDelegations,
                // One helper at a time: the supervisor has no concurrency limit of its own.
                parallelDelegation: false,
                parallelToolCalls: false,
              }
            : {}),
          ...(host.workerCheckpoints && !extra.lead
            ? { checkpoint: { store: host.workerCheckpoints, runId: `${runId}:${taskKey}:${attempt}` } }
            : {}),
        });
        const ctx: ExecutionContext = {
          ...baseCtx,
          executionId: `${runId}:${taskKey}:${attempt}`,
          userId: principal.userId,
          tenantId: principal.tenantId,
          signal: budget.signal,
          metadata: { ...baseCtx.metadata, swarmRunId: runId, swarmTaskKey: taskKey, swarmRole: role.key },
        };
        result = await agent.run(ctx, { messages: [{ role: 'user', content: userMessage }] });
        switch (result.status) {
          case 'completed':
            break;
          case 'cancelled':
            if (!budget.stop) {
              budget.requestStop(baseCtx.signal?.aborted ? 'cancelled' : 'limit_time', baseCtx.signal?.aborted ? 'The run was cancelled by its caller.' : 'The run ran out of time.');
            }
            failure = stopFailure();
            break;
          case 'failed':
            failure = result.steps.some((s) => s.type === 'response')
              ? { reason: 'agent_failed', message: 'The agent reported that it failed.' }
              : { reason: 'limit_steps', message: `The ${role.label ?? role.key} agent used all ${maxSteps} of its steps without giving its answer.` };
            break;
          default:
            failure = { reason: 'agent_failed', message: `The agent stopped with the status "${result.status}".` };
        }
      } catch (err) {
        if (err instanceof SwarmStopSignal) failure = { reason: err.reason === 'cancelled' ? 'cancelled' : 'limit', message: err.message };
        else if (err instanceof SwarmAgentStepLimit) failure = { reason: 'limit_steps', message: err.message };
        else if (budget.stop && budget.signal.aborted) failure = stopFailure();
        else failure = { reason: 'error', message: clip(errText(err), 600) };
      } finally {
        budget.leave();
      }
      const finishedAt = now();
      const steps = result?.steps ?? [];
      const toolCalls = steps.filter((s) => s.type === 'tool_call').length;
      return {
        ok: failure === undefined,
        output: result?.output ?? '',
        ...(failure ? { failure } : {}),
        usage: {
          steps: steps.length,
          toolCalls,
          modelCalls: meter.modelCalls,
          promptTokens: meter.promptTokens,
          completionTokens: meter.completionTokens,
          costUsd: meter.costUsd,
          durationMs: Math.max(0, finishedAt - startedAt),
        },
        trace: steps.map((s) => ({ type: s.type, ...(s.toolCall?.name ? { tool: s.toolCall.name } : {}), durationMs: s.durationMs })),
        steps,
        startedAt,
        finishedAt,
      };
    }

    /** Record what an agent handed back: the store, the stream. */
    function finishAgent(result: SwarmWorkerResult): SwarmWorkerResult {
      saveResult(result);
      step('swarm.worker.finished', {
        taskKey: result.taskKey,
        role: result.role,
        kind: result.kind,
        attempt: result.attempt,
        status: result.status,
        structured: result.structured,
        confidence: result.confidence,
        finding: clip(result.finding, 600),
        evidence: result.evidence.length,
        notDone: result.notDone.length,
        ...(result.failure ? { failure: result.failure } : {}),
        usage: result.usage,
      });
      return result;
    }

    function resultOf(
      role: SwarmRole,
      taskKey: string,
      attempt: number,
      run: Pick<AgentRun, 'usage' | 'trace' | 'startedAt' | 'finishedAt'>,
      body: { status: 'ok' | 'failed'; structured: boolean; finding: string; evidence?: SwarmWorkerResult['evidence']; confidence?: SwarmWorkerResult['confidence']; notDone?: readonly string[]; failure?: SwarmWorkerResult['failure'] },
    ): SwarmWorkerResult {
      return {
        taskKey,
        role: role.key,
        kind: role.kind,
        status: body.status,
        structured: body.structured,
        finding: body.finding,
        evidence: body.evidence ?? [],
        confidence: body.confidence ?? 'low',
        notDone: body.notDone ?? [],
        attempt,
        ...(body.failure ? { failure: body.failure } : {}),
        usage: run.usage,
        trace: run.trace,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      };
    }

    /** A planner, reducer, judge, checker or lead: run it, parse its reply, retry a bad reply a bounded number of times. */
    async function runCoordinator<T>(
      role: SwarmRole,
      taskKey: string,
      title: string,
      message: (problems?: readonly string[]) => string,
      parse: (output: string) => { ok: true; value: T } | { ok: false; errors: readonly string[] },
      describe: (value: T) => string,
      retries: number,
      extra: { judge?: 'pick' | 'merge'; lead?: LeadOptions } = {},
    ): Promise<{ value?: T; run: AgentRun; problems: readonly string[] }> {
      let problems: readonly string[] | undefined;
      for (let attempt = 1; ; attempt++) {
        const run = await runAgent(role, taskKey, attempt, title, message(problems), extra);
        const canRetry = attempt <= retries && !budget.stop;
        if (!run.ok) {
          const failure = run.failure!;
          const retried = canRetry && failure.reason === 'error';
          addFailure({ taskKey, role: role.key, attempt, reason: failure.reason, message: failure.message, retried });
          coordination.push(finishAgent(resultOf(role, taskKey, attempt, run, { status: 'failed', structured: false, finding: '', failure })));
          if (retried) continue;
          return { run, problems: [failure.message] };
        }
        const parsed = parse(run.output);
        if (parsed.ok) {
          coordination.push(finishAgent(resultOf(role, taskKey, attempt, run, { status: 'ok', structured: true, finding: describe(parsed.value), confidence: 'medium' })));
          return { value: parsed.value, run, problems: [] };
        }
        problems = parsed.errors;
        const failure = { reason: 'malformed_result' as const, message: clip(parsed.errors.join(' '), 600) };
        addFailure({ taskKey, role: role.key, attempt, reason: failure.reason, message: failure.message, retried: canRetry });
        coordination.push(finishAgent(resultOf(role, taskKey, attempt, run, { status: 'failed', structured: false, finding: clip(run.output, 600), failure })));
        if (!canRetry) return { run, problems: parsed.errors };
      }
    }

    // ── Results, as the rest of the run sees them ───────────
    const okResults = (): SwarmWorkerResult[] =>
      tasks.map((t) => results.get(t.key)).filter((r): r is SwarmWorkerResult => r !== undefined && r.status === 'ok');
    const taskKeys = (): Set<string> => new Set(tasks.map((t) => t.key));

    /** What was planned and did not get done, in plain words. */
    function notDoneTasks(): string[] {
      const out: string[] = [];
      for (const t of tasks) {
        const r = results.get(t.key);
        if (r?.status === 'ok') continue;
        const why = r?.failure?.message ?? (budget.stop ? budget.stop.detail : 'it was not started');
        out.push(clip(`The task "${t.title}" was not done: ${why}`, SWARM_TEXT_LIMITS.notDoneItem));
      }
      return out;
    }

    const findingOf = (r: SwarmWorkerResult): SwarmJoinedFinding => ({ claim: clip(r.finding, SWARM_TEXT_LIMITS.claim), evidence: [...r.evidence], confidence: r.confidence, from: [r.taskKey] });

    function withNotDone(joined: SwarmJoined): SwarmJoined {
      const seen = new Set(joined.notDone);
      for (const line of notDoneTasks()) if (!seen.has(line)) { seen.add(line); joined.notDone.push(line); }
      return joined;
    }

    /** A join done in code, with no model: used when the run cannot pay for a joining agent, or that agent failed. */
    function codeJoin(why: string): SwarmJoined {
      const ok = okResults();
      return withNotDone({
        summary: `${why} What each worker found is listed as it was handed back; nothing was merged or weighed.`,
        findings: ok.map(findingOf),
        notDone: ok.flatMap((r) => [...r.notDone]),
        partial: true,
        by: 'code',
      });
    }

    function fromParsedJoin(parsed: ParsedJoin, by: SwarmJoined['by']): SwarmJoined {
      const ok = okResults();
      const findings: SwarmJoinedFinding[] = parsed.findings.length > 0
        ? parsed.findings.map((f) => ({ ...f }))
        : [{ claim: clip(parsed.summary, SWARM_TEXT_LIMITS.claim), evidence: [], confidence: 'low', from: ok.map((r) => r.taskKey) }];
      return withNotDone({
        summary: parsed.summary,
        findings,
        notDone: [...parsed.notDone],
        partial: ok.length < tasks.length,
        by,
        ...(parsed.rationale ? { rationale: parsed.rationale } : {}),
      });
    }

    // ── Approval points ─────────────────────────────────────
    async function approvalPoint(point: SwarmApprovalPoint, summary: string): Promise<void> {
      if (!def.approvalPoints.includes(point) || record.approved.includes(point)) return;
      const taskId = `${runId}:${point}`;
      emit('approval.request', { taskId, toolName: `swarm_${point}`, title: point === 'after_plan' ? 'The plan is waiting for a yes' : 'The result is waiting for a yes', description: summary, point });
      let answer: SwarmApprovalAnswer;
      try {
        answer = await host.approval!.request({ point, runId, principal, summary, ...(point === 'after_plan' ? { tasks: tasks.map((t) => ({ ...t })) } : {}) });
      } catch (err) {
        emit('approval.resolved', { taskId, action: 'failed', point });
        throw new SwarmHalt('failed', 'engine_error', `The approval could not be asked for: ${errText(err)}`);
      }
      emit('approval.resolved', { taskId, action: answer, point });
      if (answer === 'approved') {
        record.approved.push(point);
        saveRun();
        return;
      }
      if (answer === 'pending') {
        throw new SwarmHalt('waiting_approval', 'approval_pending', 'The run is waiting for a person to approve it.', point);
      }
      throw new SwarmHalt('cancelled', 'approval_denied', 'A person declined, so the run stopped.');
    }

    // ── Phase: the task list ────────────────────────────────
    const overheadAfterPlan = (): number => {
      let n = 0;
      if (def.join.kind === 'reducer' || def.join.kind === 'judge_pick' || def.join.kind === 'judge_merge') n += 1;
      if (def.checker) n += 1;
      return n;
    };

    const newTask = (key: string, title: string, brief: string, role: string, position: number, dependsOn: string[] = [], inputs: Record<string, string> = {}): SwarmTask => ({
      key,
      title: clip(title, SWARM_TEXT_LIMITS.taskTitle),
      brief,
      role,
      position,
      dependsOn,
      inputs,
      status: 'pending',
      attempts: 0,
    });

    async function planPhase(): Promise<void> {
      if (tasks.length > 0) return; // resumed: the plan is kept
      let source: string;
      if (def.pattern === 'pipeline') {
        source = 'stages';
        (def.stages ?? []).forEach((roleKey, i) => {
          const role = roleOf(def, roleKey)!;
          tasks.push(newTask(`s${i + 1}`, role.label ?? role.key, i === 0 ? 'Do the first pass at the goal.' : 'Review the stage before you, correct it, and take the work further.', role.key, i, i === 0 ? [] : [`s${i}`]));
        });
      } else if (def.pattern === 'attempts_judge') {
        source = 'attempts';
        const only = def.taskSource?.kind === 'fixed' ? def.taskSource.tasks[0] : undefined;
        if (!only) throw new SwarmHalt('failed', 'engine_error', 'The definition has no task for the attempts.');
        const n = def.attempts ?? 3;
        for (let i = 0; i < n; i++) tasks.push(newTask(`a${i + 1}`, `${only.title} (attempt ${i + 1} of ${n})`, only.focus ?? only.title, only.role, i));
      } else if (def.taskSource?.kind === 'fixed') {
        source = 'fixed';
        def.taskSource.tasks.forEach((t, i) => tasks.push(newTask(t.key, t.title, t.focus ?? t.title, t.role, i)));
      } else if (def.taskSource?.kind === 'per_item') {
        source = 'per_item';
        const ts = def.taskSource;
        const room = Math.max(0, limits.maxAgents - overheadAfterPlan());
        const cap = Math.min(ts.maxItems ?? Number.POSITIVE_INFINITY, room);
        const items = record.items;
        items.slice(0, cap).forEach((item, i) => {
          tasks.push(newTask(`i${i + 1}`, item.title, 'Do the goal for this one item.', ts.role, i, [], { item: item.title, ...(item.detail !== undefined ? { detail: item.detail } : {}), key: item.key }));
        });
        if (items.length > tasks.length) {
          noteDegraded('limit_agents', `${items.length - tasks.length} of ${items.length} items were left out: the swarm may look at ${tasks.length} at most.`);
          diagnostic('swarm.items_left_out', { given: items.length, taken: tasks.length });
        }
        if (tasks.length === 0) throw new SwarmHalt('failed', 'too_few_workers', 'There were no items to work on.');
      } else if (def.taskSource?.kind === 'planner') {
        source = 'planner';
        const ts = def.taskSource;
        const role = roleOf(def, ts.role)!;
        const maxTasks = Math.max(1, Math.min(ts.maxTasks ?? Number.POSITIVE_INFINITY, limits.maxAgents - 1 - overheadAfterPlan()));
        const maxChars = Math.min(ts.maxTaskChars ?? SWARM_TEXT_LIMITS.taskBrief, SWARM_TEXT_LIMITS.taskBrief);
        const planned = await runCoordinator(
          role,
          SWARM_COORDINATION_KEYS.planner,
          'Plan the work',
          (problems) => plannerMessage(def, goalAgent, maxTasks, fence, problems),
          (out) => parsePlan(out, def, maxTasks, maxChars),
          (value) => `Planned ${value.length} task${value.length === 1 ? '' : 's'}.`,
          PLAN_RETRIES,
        );
        if (!planned.value) {
          if (budget.stop) return;
          // No task list, no swarm. The engine does not quietly fall back to one agent.
          throw new SwarmHalt('failed', 'planner_invalid', clip(`The planner did not give a task list the engine could accept. ${planned.problems.join(' ')}`, 900));
        }
        planned.value.forEach((t, i) => tasks.push(newTask(`t${i + 1}`, t.title, t.brief, t.role, i)));
      } else {
        throw new SwarmHalt('failed', 'engine_error', 'The definition does not say where the tasks come from.');
      }
      for (const t of tasks) saveTask(t);
      step('swarm.planned', { source, tasks: tasks.map((t) => ({ key: t.key, title: t.title, role: t.role, dependsOn: t.dependsOn })) });
    }

    // ── Phase: the workers, under the concurrency limit ─────
    async function runTask(task: SwarmTask): Promise<void> {
      const role = roleOf(def, task.role)!;
      const maxRetries = def.onFailure.maxRetriesPerTask;
      for (let tries = 0; ; tries++) {
        task.attempts += 1;
        const attempt = task.attempts;
        const previous = task.dependsOn.length > 0 ? results.get(task.dependsOn[task.dependsOn.length - 1]!) : undefined;
        const run = await runAgent(role, task.key, attempt, task.title, workerMessage(goalAgent, task, fence, previous));
        const canRetry = tries < maxRetries && !budget.stop;
        let result: SwarmWorkerResult;
        if (run.ok) {
          const parsed = parseWorkerReply(run.output);
          if (parsed.ok) {
            result = resultOf(role, task.key, attempt, run, { status: 'ok', structured: true, ...parsed.value });
          } else {
            const message = clip(parsed.errors.join(' '), 600);
            addFailure({ taskKey: task.key, role: role.key, attempt, reason: 'malformed_result', message, retried: canRetry });
            if (canRetry) {
              finishAgent(resultOf(role, task.key, attempt, run, { status: 'failed', structured: false, finding: clip(run.output, 600), failure: { reason: 'malformed_result', message } }));
              continue;
            }
            const text = run.output.trim();
            result = text === ''
              ? resultOf(role, task.key, attempt, run, { status: 'failed', structured: false, finding: '', failure: { reason: 'malformed_result', message: 'The worker gave no answer.' } })
              // Kept, and marked for what it is: plain text nobody could check.
              : resultOf(role, task.key, attempt, run, {
                  status: 'ok',
                  structured: false,
                  finding: clip(text, SWARM_TEXT_LIMITS.finding),
                  confidence: 'low',
                  notDone: ['This worker did not answer in the agreed structure, so its reply was kept as plain text and its evidence could not be read.'],
                });
          }
        } else {
          const failure = run.failure!;
          const retried = canRetry && failure.reason === 'error';
          addFailure({ taskKey: task.key, role: role.key, attempt, reason: failure.reason, message: failure.message, retried });
          result = resultOf(role, task.key, attempt, run, { status: 'failed', structured: false, finding: '', failure });
          if (retried) { finishAgent(result); continue; }
        }
        results.set(task.key, finishAgent(result));
        task.status = result.status;
        saveTask(task);
        if (result.status === 'failed' && def.onFailure.worker === 'fail_run' && !budget.stop) {
          budget.requestStop('worker_failed', `The task "${task.title}" failed, and this swarm is set to stop when a worker fails: ${result.failure?.message ?? ''}`.trim());
        }
        return;
      }
    }

    async function workPhase(): Promise<void> {
      const inFlight = new Set<Promise<void>>();
      const byKey = new Map(tasks.map((t) => [t.key, t]));
      for (;;) {
        if (!budget.checkTime()) {
          for (const task of tasks) {
            if (task.status !== 'pending') continue;
            const deps = task.dependsOn.map((k) => byKey.get(k));
            if (deps.some((d) => d && (d.status === 'failed' || d.status === 'skipped'))) {
              // A stage cannot review work that is not there.
              task.status = 'skipped';
              saveTask(task);
              const message = 'The stage before it did not finish, so there was nothing to review.';
              addFailure({ taskKey: task.key, role: task.role, attempt: 0, reason: 'upstream_failed', message, retried: false });
              diagnostic('swarm.task_skipped', { taskKey: task.key, message });
              continue;
            }
            if (deps.some((d) => d && d.status !== 'ok')) continue;
            if (inFlight.size >= limits.maxConcurrency) break;
            task.status = 'running';
            saveTask(task);
            const p: Promise<void> = runTask(task).finally(() => { inFlight.delete(p); });
            inFlight.add(p);
          }
        }
        if (inFlight.size === 0) break;
        await Promise.race(inFlight);
      }
      const failed = tasks.filter((t) => t.status === 'failed' || t.status === 'skipped');
      if (failed.length > 0) noteDegraded('worker_failed', `${failed.length} of ${tasks.length} tasks did not finish; the answer covers the rest.`);
    }

    function enoughWorkers(): void {
      const min = def.onFailure.minWorkersOk ?? 1;
      const ok = okResults().length;
      if (ok >= min || budget.stop) return;
      throw new SwarmHalt('failed', 'too_few_workers', `${ok} worker${ok === 1 ? '' : 's'} finished, and this swarm needs at least ${min}.`);
    }

    // ── Phase: the join ─────────────────────────────────────
    async function joinPhase(): Promise<void> {
      if (record.joined) return;
      const ok = okResults();
      if (budget.stop) {
        if (ok.length > 0) record.joined = codeJoin('The run stopped before the results could be joined by an agent.');
        return;
      }
      const all = tasks.map((t) => results.get(t.key)).filter((r): r is SwarmWorkerResult => r !== undefined);
      const fellBack = (what: string, problems: readonly string[]): SwarmJoined => {
        const detail = clip(`${what} ${problems.join(' ')}`.trim(), 600);
        if (!budget.stop) noteDegraded('join_failed', detail);
        return codeJoin(what);
      };
      let joined: SwarmJoined;
      switch (def.join.kind) {
        case 'reducer': {
          const role = roleOf(def, def.join.role)!;
          const out = await runCoordinator(
            role, SWARM_COORDINATION_KEYS.reducer, 'Join the results',
            () => joinMessage(goalAgent, tasks, all, fence),
            (text) => parseJoin(text, taskKeys()),
            (value) => clip(value.summary, 600),
            JOIN_RETRIES,
          );
          joined = out.value ? fromParsedJoin(out.value, 'reducer') : fellBack('The joining agent did not give an answer the engine could accept.', out.problems);
          break;
        }
        case 'judge_pick': {
          if (ok.length === 1) {
            joined = withNotDone({ summary: ok[0]!.finding, findings: [findingOf(ok[0]!)], notDone: [...ok[0]!.notDone], partial: true, by: 'code', winner: ok[0]!.taskKey, rationale: 'Only one attempt finished, so there was nothing to choose between.' });
            break;
          }
          const role = roleOf(def, def.join.role)!;
          const out = await runCoordinator(
            role, SWARM_COORDINATION_KEYS.judge, 'Pick the best attempt',
            () => judgeMessage(goalAgent, ok, fence),
            (text) => parsePick(text, ok.length),
            (value) => `Picked attempt ${value.winner}. ${value.rationale}`.trim(),
            JOIN_RETRIES,
            { judge: 'pick' },
          );
          if (out.value) {
            const winner = ok[out.value.winner - 1]!;
            joined = withNotDone({ summary: winner.finding, findings: [findingOf(winner)], notDone: [...winner.notDone], partial: ok.length < tasks.length, by: 'judge', winner: winner.taskKey, ...(out.value.rationale ? { rationale: out.value.rationale } : {}) });
          } else {
            joined = fellBack('The judge did not pick an attempt.', out.problems);
          }
          break;
        }
        case 'judge_merge': {
          const role = roleOf(def, def.join.role)!;
          const out = await runCoordinator(
            role, SWARM_COORDINATION_KEYS.judge, 'Merge the attempts',
            () => judgeMessage(goalAgent, ok, fence),
            (text) => parseJoin(text, taskKeys()),
            (value) => clip(value.summary, 600),
            JOIN_RETRIES,
            { judge: 'merge' },
          );
          joined = out.value ? fromParsedJoin(out.value, 'judge') : fellBack('The judge did not give a merged answer the engine could accept.', out.problems);
          break;
        }
        case 'last_stage': {
          const last = ok[ok.length - 1];
          if (!last) { joined = codeJoin('No stage finished.'); break; }
          const whole = last.taskKey === tasks[tasks.length - 1]?.key;
          joined = withNotDone({
            summary: last.finding,
            findings: [{ ...findingOf(last), from: ok.map((r) => r.taskKey) }],
            notDone: [...new Set(ok.flatMap((r) => [...r.notDone]))],
            partial: !whole,
            by: 'last_stage',
          });
          break;
        }
        default:
          joined = codeJoin('This swarm has no joining step.');
      }
      record.joined = joined;
      step('swarm.joined', { by: joined.by, partial: joined.partial, findings: joined.findings.length, notDone: joined.notDone.length, summary: clip(joined.summary, 600), ...(joined.winner ? { winner: joined.winner } : {}) });
      saveRun();
    }

    // ── Phase: the checker ──────────────────────────────────
    async function checkPhase(): Promise<void> {
      if (!def.checker || record.check || !record.joined) return;
      if (budget.stop) return;
      const joined = record.joined;
      const role = roleOf(def, def.checker.role)!;
      const claims = joined.findings.slice(0, def.checker.maxClaims ?? 5);
      if (claims.length === 0) return;
      const out = await runCoordinator(
        role, SWARM_COORDINATION_KEYS.checker, 'Try to refute the claims',
        () => checkerMessage(goalAgent, claims, fence),
        (text) => parseVerdicts(text, claims.length),
        (value) => value.map((v) => `Claim ${v.claim}: ${v.verdict}.`).join(' '),
        CHECK_RETRIES,
      );
      if (!out.value) {
        if (!budget.stop) noteDegraded('check_failed', clip(`The checker did not give verdicts the engine could accept, so the claims are unchecked. ${out.problems.join(' ')}`, 600));
        joined.notDone.push('The claims were not checked: the checking agent did not finish.');
        saveRun();
        return;
      }
      const verdicts = out.value;
      for (const v of verdicts) {
        const f = claims[v.claim - 1];
        if (f) { f.verdict = v.verdict; f.verdictReason = v.reason; }
      }
      for (const f of claims) {
        if (!f.verdict) { f.verdict = 'unverified'; f.verdictReason = 'The checker gave no verdict on this claim.'; }
      }
      // The outcome is worked out here, not taken from the checker's own summary.
      const all = claims.map((f) => f.verdict);
      const outcome: SwarmCheck['outcome'] = all.includes('refuted') ? 'refuted' : all.every((v) => v === 'supported') ? 'supported' : 'unverified';
      const check: SwarmCheck = { outcome, verdicts: verdicts.map((v) => ({ claim: v.claim, verdict: v.verdict, reason: v.reason })) };
      record.check = check;
      step('swarm.checked', { outcome, claims: claims.length, verdicts: check.verdicts.map((v) => ({ claim: v.claim, verdict: v.verdict })) });
      saveRun();
    }

    // ── Pattern: a lead with helpers (the existing supervisor) ──
    async function leadPhase(): Promise<void> {
      if (record.joined || budget.stop) return;
      const leadRole = def.roles.find((r) => r.kind === 'lead')!;
      const helpers = def.roles.filter((r) => r.kind === 'worker');
      let position = tasks.length;

      interface Session {
        readonly task: SwarmTask;
        readonly role: SwarmRole;
        readonly meter: SwarmAgentMeter;
        readonly startedAt: number;
        readonly trace: SwarmTraceStep[];
        last?: ModelResponse;
      }
      let session: Session | undefined;
      const idle = newAgentMeter();

      const closeSession = (): void => {
        const s = session;
        if (!s) return;
        session = undefined;
        budget.leave();
        const finishedAt = now();
        const run = {
          usage: {
            steps: s.meter.modelCalls + s.trace.length,
            toolCalls: s.trace.length,
            modelCalls: s.meter.modelCalls,
            promptTokens: s.meter.promptTokens,
            completionTokens: s.meter.completionTokens,
            costUsd: s.meter.costUsd,
            durationMs: Math.max(0, finishedAt - s.startedAt),
          },
          trace: s.trace,
          startedAt: s.startedAt,
          finishedAt,
        };
        const answered = s.last !== undefined && (s.last.toolCalls ?? []).length === 0;
        let result: SwarmWorkerResult;
        if (answered) {
          const text = String(s.last!.content ?? '');
          const parsed = parseWorkerReply(text);
          if (parsed.ok) {
            result = resultOf(s.role, s.task.key, 1, run, { status: 'ok', structured: true, ...parsed.value });
          } else if (text.trim() !== '') {
            addFailure({ taskKey: s.task.key, role: s.role.key, attempt: 1, reason: 'malformed_result', message: clip(parsed.errors.join(' '), 600), retried: false });
            result = resultOf(s.role, s.task.key, 1, run, {
              status: 'ok', structured: false, finding: clip(text.trim(), SWARM_TEXT_LIMITS.finding), confidence: 'low',
              notDone: ['This helper did not answer in the agreed structure, so its reply was kept as plain text and its evidence could not be read.'],
            });
          } else {
            const failure = { reason: 'malformed_result' as const, message: 'The helper gave no answer.' };
            addFailure({ taskKey: s.task.key, role: s.role.key, attempt: 1, ...failure, retried: false });
            result = resultOf(s.role, s.task.key, 1, run, { status: 'failed', structured: false, finding: '', failure });
          }
        } else {
          const failure: { reason: SwarmFailure['reason']; message: string } = budget.stop
            ? stopFailure()
            : s.meter.modelCalls >= stepsFor(s.role)
              ? { reason: 'limit_steps', message: `The ${s.role.label ?? s.role.key} helper used all ${stepsFor(s.role)} of its steps without giving its answer.` }
              : { reason: 'error', message: 'The helper stopped without giving its answer.' };
          addFailure({ taskKey: s.task.key, role: s.role.key, attempt: 1, ...failure, retried: false });
          result = resultOf(s.role, s.task.key, 1, run, { status: 'failed', structured: false, finding: '', failure });
        }
        results.set(s.task.key, finishAgent(result));
        s.task.status = result.status;
        saveTask(s.task);
      };

      const workers: WorkerDefinition[] = [];
      for (const role of helpers) {
        const inner = await modelOf(role);
        const brief = await briefOf(role);
        const maxSteps = stepsFor(role);
        const model = guardModel(inner, budget, {
          runId,
          role: role.key,
          taskKey: () => session?.task.key ?? SWARM_COORDINATION_KEYS.lead,
          maxSteps,
          meter: () => session?.meter ?? idle,
          ...(host.pricing ? { pricing: host.pricing } : {}),
          ...(host.ledger ? { ledger: host.ledger } : {}),
          now,
          newId,
          beforeCall: (request, turnsSoFar) => {
            if (turnsSoFar > 0 && session) return;
            // A new helper session: the supervisor started it, the engine counts it.
            closeSession();
            if (!budget.startAgent()) {
              const stop = budget.stop!;
              throw new SwarmStopSignal(stop.reason, stop.detail);
            }
            budget.enter();
            const asked = request.messages.filter((m) => m.role === 'user').map((m) => (typeof m.content === 'string' ? m.content : '')).pop() ?? '';
            position += 1;
            const task = newTask(`h${position}`, asked.split('\n')[0] ?? role.key, clip(asked, SWARM_TEXT_LIMITS.taskBrief), role.key, position - 1);
            task.status = 'running';
            task.attempts = 1;
            tasks.push(task);
            saveTask(task);
            session = { task, role, meter: newAgentMeter(), startedAt: now(), trace: [] };
            step('swarm.worker.started', { taskKey: task.key, role: role.key, kind: role.kind, attempt: 1, title: task.title, delegatedBy: leadRole.key });
          },
          afterCall: (response) => { if (session) session.last = response; },
          ...costOf(role),
        });
        const tools = toolsFor(role, () => session?.task.key ?? SWARM_COORDINATION_KEYS.lead, (name, durationMs) => {
          session?.trace.push({ type: 'tool_call', tool: name, durationMs });
        });
        workers.push({
          name: role.key,
          description: role.description ?? role.label ?? role.key,
          systemPrompt: systemPromptFor(role, brief, fence, { maxSteps }),
          model,
          ...(tools ? { tools } : {}),
        });
      }

      const maxDelegations = Math.max(1, limits.maxAgents - 1 - (def.checker ? 1 : 0));
      const before = okResults().length;
      const out = await runCoordinator(
        leadRole, SWARM_COORDINATION_KEYS.lead, 'Lead the work',
        () => leadMessage(goalAgent),
        (text) => parseJoin(text, taskKeys()),
        (value) => clip(value.summary, 600),
        0,
        { lead: { workers, maxDelegations, beforeCall: closeSession } },
      );
      closeSession();
      const delegations = out.run.steps.filter((s) => s.type === 'tool_call' && s.toolCall?.name === 'delegate_to_worker').length;
      step('swarm.planned', { source: 'lead', tasks: tasks.map((t) => ({ key: t.key, title: t.title, role: t.role, dependsOn: t.dependsOn })), delegations });
      const ok = okResults().length;
      if (delegations === 0 || ok === before) {
        if (budget.stop) return;
        // The known trap: a lead that answers by itself has done no checked work. That is a failure, not an answer.
        throw new SwarmHalt(
          'failed',
          delegations === 0 ? 'lead_did_not_delegate' : 'too_few_workers',
          delegations === 0
            ? 'The lead answered without giving any work to a helper, so nothing stands behind the answer. It was not used.'
            : 'The lead gave out work, but no helper finished any of it.',
        );
      }
      enoughWorkers();
      if (tasks.some((t) => t.status === 'failed')) noteDegraded('worker_failed', `${tasks.filter((t) => t.status === 'failed').length} of ${tasks.length} helper tasks did not finish; the answer covers the rest.`);
      if (out.value) {
        record.joined = fromParsedJoin(out.value, 'lead');
      } else if (budget.stop) {
        record.joined = codeJoin('The run stopped before the lead could join the results.');
      } else {
        noteDegraded('join_failed', clip(`The lead did not give a joined answer the engine could accept. ${out.problems.join(' ')}`, 600));
        record.joined = codeJoin('The lead did not give a joined answer the engine could accept.');
      }
      const joined = record.joined;
      step('swarm.joined', { by: joined.by, partial: joined.partial, findings: joined.findings.length, notDone: joined.notDone.length, summary: clip(joined.summary, 600) });
      saveRun();
    }

    // ── The whole run ───────────────────────────────────────
    async function flow(): Promise<void> {
      if (def.pattern === 'lead_helpers') {
        await approvalPoint('after_plan', `Start the lead and up to ${limits.maxAgents - 1} helper runs.`);
        await leadPhase();
      } else {
        await planPhase();
        if (budget.stop) return;
        await approvalPoint('after_plan', `The plan has ${tasks.length} task${tasks.length === 1 ? '' : 's'}. Start the workers?`);
        await workPhase();
        enoughWorkers();
        await joinPhase();
      }
      await checkPhase();
      if (budget.stop) return;
      await approvalPoint('before_finish', 'The result is ready. Release it?');
    }

    function settle(halt: SwarmHalt | undefined, crash: unknown): { status: SwarmRunStatus; reason?: SwarmStopReason; detail?: string; waitingAt?: SwarmApprovalPoint } {
      if (crash !== undefined) return { status: 'failed', reason: 'engine_error', detail: `The engine hit an error it did not expect: ${clip(errText(crash), 600)}` };
      const stop = budget.stop;
      if (stop?.reason === 'engine_error') return { status: 'failed', reason: stop.reason, detail: stop.detail };
      if (halt) return { status: halt.status, reason: halt.reason, detail: halt.message, ...(halt.waitingAt ? { waitingAt: halt.waitingAt } : {}) };
      const anyOk = okResults().length > 0;
      if (stop) {
        if (stop.reason === 'cancelled') return { status: 'cancelled', reason: stop.reason, detail: stop.detail };
        if (stop.reason === 'worker_failed') return { status: 'failed', reason: stop.reason, detail: stop.detail };
        return { status: anyOk ? 'partial' : 'failed', reason: stop.reason, detail: stop.detail };
      }
      if (degraded) return { status: 'partial', reason: degraded.reason, detail: degraded.detail };
      return { status: 'completed' };
    }

    async function run(): Promise<SwarmRunResult> {
      await Promise.resolve(); // let a caller subscribe before the first event
      const onParentAbort = (): void => budget.requestStop('cancelled', 'The run was cancelled by its caller.');
      if (baseCtx.signal?.aborted) onParentAbort();
      baseCtx.signal?.addEventListener('abort', onParentAbort, { once: true });
      // The time limit has its own timer, so a model call that never returns is
      // still told to stop. A timer can fire a moment early (and a long limit is
      // capped by the largest delay a timer takes), so it re-arms until the
      // limit has really passed or the run is over.
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timerDone = false;
      const armTimer = (): void => {
        if (timerDone) return;
        timer = setTimeout(() => {
          if (!budget.checkTime()) armTimer();
        }, Math.min(MAX_TIMER_MS, Math.max(1, budget.deadline - now())));
        (timer as { unref?: () => void }).unref?.();
      };
      armTimer();

      let halt: SwarmHalt | undefined;
      let crash: unknown;
      try {
        record.status = 'running';
        delete record.stopReason;
        delete record.stopDetail;
        delete record.waitingAt;
        delete record.finishedAt;
        if (l.resumed) saveRun();
        else {
          const first = structuredClone(record);
          persist('run', () => store.createRun(first));
        }
        emit('run.started', {
          definitionKey: def.key,
          pattern: def.pattern,
          goal: record.goal,
          resumed: l.resumed,
          startedBy: principal.userId,
          limits: { ...limits },
        });
        await flow();
      } catch (err) {
        if (err instanceof SwarmHalt) halt = err;
        else crash = err;
      } finally {
        timerDone = true;
        if (timer !== undefined) clearTimeout(timer);
        baseCtx.signal?.removeEventListener('abort', onParentAbort);
      }

      // Whatever stopped the run, hand back what there is.
      if (!record.joined && okResults().length > 0 && (budget.stop || halt || crash !== undefined)) {
        record.joined = codeJoin('The run stopped before the results could be joined by an agent.');
      }
      const outcome = settle(halt, crash);
      if (outcome.status !== 'waiting_approval') {
        for (const task of tasks) {
          if (task.status === 'pending' || task.status === 'running') { task.status = 'skipped'; saveTask(task); }
        }
        if (record.joined) withNotDone(record.joined);
      }
      budget.touchClock();
      record.status = outcome.status;
      if (outcome.reason) record.stopReason = outcome.reason;
      if (outcome.detail) record.stopDetail = outcome.detail;
      if (outcome.waitingAt) record.waitingAt = outcome.waitingAt;
      if (outcome.status !== 'waiting_approval') record.finishedAt = now();
      saveRun();

      const summary = {
        status: outcome.status,
        ...(outcome.reason ? { stopReason: outcome.reason } : {}),
        ...(outcome.detail ? { stopDetail: outcome.detail } : {}),
        usage: { ...budget.usage },
        tasks: tasks.length,
        tasksOk: okResults().length,
      };
      if (outcome.status === 'waiting_approval') diagnostic('swarm.waiting', { ...summary, waitingAt: outcome.waitingAt });
      else if (outcome.status === 'cancelled') emit('run.cancelled', summary);
      else if (outcome.status === 'failed') emit('run.failed', summary);
      else emit('run.completed', summary);
      await chain;

      return {
        runId,
        definitionKey: def.key,
        status: outcome.status,
        ...(outcome.reason ? { stopReason: outcome.reason } : {}),
        ...(outcome.detail ? { stopDetail: outcome.detail } : {}),
        goal: record.goal,
        plan: tasks.map((t) => ({ ...t })),
        results: tasks.map((t) => results.get(t.key)).filter((r): r is SwarmWorkerResult => r !== undefined),
        coordination: [...coordination],
        ...(record.joined ? { joined: record.joined } : {}),
        ...(record.check ? { check: record.check } : {}),
        failures: [...record.failures],
        usage: { ...budget.usage },
      };
    }

    const result: Promise<SwarmRunResult> = run().catch((err: unknown): SwarmRunResult => ({
      runId,
      definitionKey: def.key,
      status: 'failed',
      stopReason: 'engine_error',
      stopDetail: `The engine hit an error it did not expect: ${clip(errText(err), 600)}`,
      goal: record.goal,
      plan: tasks.map((t) => ({ ...t })),
      results: [...results.values()],
      coordination: [...coordination],
      failures: [...record.failures],
      usage: { ...budget.usage },
    }));

    return {
      runId,
      result,
      cancel(reason?: string) {
        budget.requestStop('cancelled', reason && reason.trim() !== '' ? clip(reason.trim(), 300) : 'The run was stopped by a person.');
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    };
  }

  return {
    store,
    validate: validateSwarmDefinition,
    estimate: estimateSwarm,

    start(def, input) {
      assertRunnable(def, input.principal);
      const inputs = { ...(input.inputs ?? {}) };
      const record: SwarmRunRecord = {
        runId: input.runId ?? newId(),
        definitionKey: def.key,
        pattern: def.pattern,
        goal: goalForDisplay(def.goalTemplate, inputs),
        principal: { ...input.principal },
        inputs,
        items: (input.items ?? []).map((i) => ({ ...i })),
        status: 'pending',
        approved: [],
        usage: { agentsStarted: 0, modelCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0, toolCalls: 0, peakConcurrency: 0, wallClockMs: 0 },
        failures: [],
        startedAt: now(),
      };
      return launch({
        def,
        record,
        tasks: [],
        results: new Map(),
        coordination: [],
        lastSequence: 0,
        resumed: false,
        ...(input.ctx ? { ctx: input.ctx } : {}),
        ...(input.onEvent ? { onEvent: input.onEvent } : {}),
      });
    },

    async resume(runId, def, opts = {}) {
      const snap = await store.load(runId);
      if (!snap) throw new SwarmResumeError(`There is no swarm run "${runId}".`);
      if (snap.run.definitionKey !== def.key) {
        throw new SwarmResumeError(`The run "${runId}" belongs to the swarm "${snap.run.definitionKey}", not "${def.key}".`);
      }
      if (!RESUMABLE.includes(snap.run.status)) {
        throw new SwarmResumeError(`The run "${runId}" is over (${snap.run.status}); it cannot be carried on.`);
      }
      // The run keeps the person it was started as. Nothing passed to resume can change that.
      assertRunnable(def, snap.run.principal);
      const record: SwarmRunRecord = structuredClone(snap.run);
      const results = new Map<string, SwarmWorkerResult>();
      const coordination: SwarmWorkerResult[] = [];
      for (const r of snap.results) {
        if (r.kind !== 'worker') coordination.push(r);
        else if (r.status === 'ok') results.set(r.taskKey, r);
      }
      const tasks: SwarmTask[] = snap.tasks.map((t) => ({
        ...t,
        status: results.has(t.key) ? 'ok' : 'pending',
      }));
      return launch({
        def,
        record,
        tasks,
        results,
        coordination,
        lastSequence: snap.lastSequence,
        resumed: true,
        ...(opts.ctx ? { ctx: opts.ctx } : {}),
        ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
      });
    },
  };
}
