// SPDX-License-Identifier: MIT
/**
 * @weaveintel/agents — swarm: the limits, enforced in code.
 *
 * Every model call any agent in a swarm makes goes through `guardModel`. The
 * guard is the one place that says no: it counts calls, tokens and money
 * against the run's limits before the call is made, refuses a call it cannot
 * price when a money cap is set, and stops an agent that has used its steps.
 * No limit is ever enforced by asking a model to behave.
 *
 * What the guard cannot know before a call is what that call will cost, so a
 * token or money cap can be passed by at most the calls already in flight when
 * it is reached (never more than `maxConcurrency` calls). The call-count,
 * agent-count, step and concurrency limits are exact.
 */

import type { ExecutionContext, Model, ModelRequest, ModelResponse } from '@weaveintel/core';
import { computeUsd, type CostLedger, type PricingResolver } from '@weaveintel/cost-governor';
import type { SwarmCostEntry, SwarmLimits, SwarmStopReason, SwarmUsage } from './types.js';

/** Thrown inside an agent's model call when the RUN must stop. */
export class SwarmStopSignal extends Error {
  readonly reason: SwarmStopReason;
  constructor(reason: SwarmStopReason, detail: string) {
    super(detail);
    this.name = 'SwarmStopSignal';
    this.reason = reason;
  }
}

/** Thrown inside an agent's model call when that ONE agent has used its steps. */
export class SwarmAgentStepLimit extends Error {
  constructor(role: string, maxSteps: number) {
    super(`The ${role} agent used all ${maxSteps} of its steps without finishing.`);
    this.name = 'SwarmAgentStepLimit';
  }
}

export function emptySwarmUsage(): SwarmUsage {
  return {
    agentsStarted: 0,
    modelCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    toolCalls: 0,
    peakConcurrency: 0,
    wallClockMs: 0,
  };
}

/** The run's running totals and its one stop decision. */
export interface SwarmBudget {
  readonly limits: SwarmLimits;
  readonly usage: SwarmUsage;
  /** Wall-clock moment this run (or this resumed stretch of it) must stop by. */
  readonly deadline: number;
  readonly signal: AbortSignal;
  /** Agents working right now. */
  readonly running: number;
  /** The first reason the run was told to stop, if it was. */
  readonly stop: { readonly reason: SwarmStopReason; readonly detail: string } | undefined;
  /** Record the decision to stop. The first reason wins; later ones are ignored. */
  requestStop(reason: SwarmStopReason, detail: string): void;
  /** Stop the run if its time is up. Returns true when the run is stopped (for any reason). */
  checkTime(): boolean;
  /** A stop reason when no further model call may be made, else undefined. Sets the stop. */
  refuseCall(): SwarmStopSignal | undefined;
  /**
   * Count one more agent run. Returns false, and stops the run, when that
   * would pass `maxAgents`. Retries and a lead's helpers count.
   */
  startAgent(): boolean;
  /** Mark an agent as working / done, for the concurrency peak. */
  enter(): void;
  leave(): void;
  /** Bring `usage.wallClockMs` up to now. */
  touchClock(): void;
}

export function createSwarmBudget(limits: SwarmLimits, carried: SwarmUsage | undefined, now: () => number): SwarmBudget {
  const usage: SwarmUsage = carried ? { ...carried } : emptySwarmUsage();
  const abort = new AbortController();
  const segmentStart = now();
  const carriedMs = usage.wallClockMs;
  const deadline = segmentStart + Math.max(0, limits.maxWallClockMs - carriedMs);
  let running = 0;
  let stop: { reason: SwarmStopReason; detail: string } | undefined;

  const budget: SwarmBudget = {
    limits,
    usage,
    deadline,
    signal: abort.signal,
    get running() { return running; },
    get stop() { return stop; },
    requestStop(reason, detail) {
      if (stop) return;
      stop = { reason, detail };
      // A cancel or the time limit reaches a model call in flight where the
      // provider honours the signal; every agent loop sees it at its next step
      // either way. The other limits let a call in flight finish and be counted.
      if (reason === 'cancelled' || reason === 'limit_time') abort.abort();
    },
    checkTime() {
      if (!stop && now() >= deadline) {
        budget.requestStop('limit_time', `The run reached its time limit of ${Math.round(limits.maxWallClockMs / 1000)} seconds.`);
      }
      return stop !== undefined;
    },
    refuseCall() {
      if (!budget.checkTime()) {
        if (limits.maxModelCalls !== undefined && usage.modelCalls >= limits.maxModelCalls) {
          budget.requestStop('limit_model_calls', `The run reached its limit of ${limits.maxModelCalls} model calls.`);
        } else if (limits.maxTotalTokens !== undefined && usage.totalTokens >= limits.maxTotalTokens) {
          budget.requestStop('limit_tokens', `The run reached its limit of ${limits.maxTotalTokens} tokens.`);
        } else if (limits.maxCostUsd !== undefined && usage.costUsd >= limits.maxCostUsd) {
          budget.requestStop('limit_cost', `The run reached its cost limit of ${limits.maxCostUsd.toFixed(2)} US dollars.`);
        }
      }
      return stop ? new SwarmStopSignal(stop.reason, stop.detail) : undefined;
    },
    startAgent() {
      if (stop) return false;
      if (usage.agentsStarted >= limits.maxAgents) {
        budget.requestStop('limit_agents', `The run reached its limit of ${limits.maxAgents} agents.`);
        return false;
      }
      usage.agentsStarted += 1;
      return true;
    },
    enter() {
      running += 1;
      if (running > usage.peakConcurrency) usage.peakConcurrency = running;
    },
    leave() { running = Math.max(0, running - 1); },
    touchClock() { usage.wallClockMs = carriedMs + Math.max(0, now() - segmentStart); },
  };
  return budget;
}

/** One agent's own totals, filled in by the guard as it works. */
export interface SwarmAgentMeter {
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export const newAgentMeter = (): SwarmAgentMeter => ({ modelCalls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 });

export interface GuardScope {
  readonly runId: string;
  readonly role: string;
  /** The task the agent is on right now. A function, because a lead's helper serves several in turn. */
  readonly taskKey: () => string;
  /** Most model turns one session of this agent may take. */
  readonly maxSteps: number;
  /** Where this agent's own totals are kept right now. */
  readonly meter: () => SwarmAgentMeter;
  readonly pricing?: PricingResolver;
  readonly ledger?: CostLedger;
  readonly now: () => number;
  readonly newId: () => string;
  /**
   * Called before a call is made, after the run's limits allowed it.
   * `turnsSoFar` is 0 when the request opens a new agent session. A lead's
   * helpers are started by the supervisor, so the engine counts and announces
   * them here. Throwing refuses the call.
   */
  readonly beforeCall?: (request: ModelRequest, turnsSoFar: number) => void;
  /** Called with each reply. Must not throw. */
  readonly afterCall?: (response: ModelResponse) => void;
  /** Where each call's cost goes (the store, the event stream). Must not throw. */
  readonly onCost: (entry: SwarmCostEntry) => void;
  /** Told when the host's ledger refused a record. Must not throw. */
  readonly onLedgerError: (message: string) => void;
}

/**
 * Wrap a model so every call is checked against the run's limits first and
 * measured after. The returned model has no `stream`: a swarm agent always
 * goes through `generate`, so no call can slip past the guard.
 */
export function guardModel(inner: Model, budget: SwarmBudget, scope: GuardScope): Model {
  const modelId = inner.info.modelId;
  return {
    info: inner.info,
    capabilities: inner.capabilities,
    hasCapability: (id) => inner.hasCapability(id),
    async generate(ctx: ExecutionContext, request: ModelRequest): Promise<ModelResponse> {
      const refused = budget.refuseCall();
      if (refused) throw refused;

      // A money cap with no price is not a cap. Fail closed.
      let rate: Awaited<ReturnType<PricingResolver['resolve']>> = null;
      if (scope.pricing) rate = await scope.pricing.resolve(modelId);
      if (budget.limits.maxCostUsd !== undefined && !rate) {
        budget.requestStop('cost_unknown', `There is a cost limit but no price is known for the model "${modelId}", so the call was refused.`);
        throw new SwarmStopSignal('cost_unknown', budget.stop!.detail);
      }

      const turnsSoFar = request.messages.filter((m) => m.role === 'assistant').length;
      if (turnsSoFar >= scope.maxSteps) throw new SwarmAgentStepLimit(scope.role, scope.maxSteps);
      scope.beforeCall?.(request, turnsSoFar);
      const meter = scope.meter();
      const taskKey = scope.taskKey();

      // Reserve the call before making it, so calls made at the same moment
      // cannot all pass a call cap.
      budget.usage.modelCalls += 1;
      meter.modelCalls += 1;

      const response = await inner.generate(ctx, request);

      const prompt = response.usage?.promptTokens ?? 0;
      const completion = response.usage?.completionTokens ?? 0;
      const costUsd = computeUsd({ modelId, inputTokens: prompt, outputTokens: completion }, rate);
      budget.usage.promptTokens += prompt;
      budget.usage.completionTokens += completion;
      budget.usage.totalTokens += prompt + completion;
      budget.usage.costUsd += costUsd;
      meter.promptTokens += prompt;
      meter.completionTokens += completion;
      meter.costUsd += costUsd;

      const at = scope.now();
      scope.onCost({
        runId: scope.runId,
        taskKey,
        role: scope.role,
        model: modelId,
        promptTokens: prompt,
        completionTokens: completion,
        costUsd,
        priced: Boolean(rate),
        at,
      });
      if (scope.ledger) {
        // The ledger is a second record for the host's own reports. The run's
        // totals above do not depend on it, so a ledger that is down does not
        // lift a limit; the failure is reported, not hidden.
        try {
          await scope.ledger.record({
            id: scope.newId(),
            runId: scope.runId,
            stepId: taskKey,
            agentRole: scope.role,
            source: 'model',
            lever: 'model',
            subject: modelId,
            provider: inner.info.provider,
            inputTokens: prompt,
            outputTokens: completion,
            costUsd,
            observedAt: at,
          });
        } catch (err) {
          scope.onLedgerError(err instanceof Error ? err.message : String(err));
        }
      }
      scope.afterCall?.(response);
      return response;
    },
  };
}
