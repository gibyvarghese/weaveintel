import type { ExecutionContext } from '@weaveintel/core';
import type {
  ActionExecutionContext,
  ActionExecutor,
  AgentContract,
  AttentionPolicy,
  CompressionMaintainer,
  ExternalEvent,
  ExternalEventHandler,
  Heartbeat,
  HeartbeatRunOptions,
  LiveAgentsRuntime,
  LiveAgent,
  StateStore,
} from './types.js';
import { NotImplementedLiveAgentsError } from './errors.js';
import { asStateStore } from './state-store.js';
import { createStandardAttentionPolicy } from './attention.js';
import { createActionExecutor } from './action-executor.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function evaluateCronField(expr: string, value: number): boolean | null {
  const token = expr.trim();
  if (token === '*') return true;
  const step = /^\*\/(\d+)$/.exec(token);
  if (step) {
    const every = parseInt(step[1] ?? '0', 10);
    if (!Number.isFinite(every) || every <= 0) return null;
    return value % every === 0;
  }
  const exact = /^\d+$/.exec(token);
  if (exact) {
    return value === parseInt(token, 10);
  }
  return null;
}

function isContractActiveNow(contract: AgentContract | null, nowIso: string): boolean {
  const cron = contract?.workingHoursSchedule?.cronActive?.trim();
  if (!cron || cron === '* * * * *') return true;
  if (cron.toLowerCase() === 'never') return false;

  const parts = cron.split(/\s+/);
  if (parts.length !== 5) return true;

  const date = new Date(nowIso);
  const values = [
    date.getUTCMinutes(),
    date.getUTCHours(),
    date.getUTCDate(),
    date.getUTCMonth() + 1,
    date.getUTCDay(),
  ];

  const checks = parts.map((part, index) => evaluateCronField(part, values[index] ?? 0));
  if (checks.some((v) => v === null)) {
    return true;
  }
  return checks.every((v) => v === true);
}

function defaultPauseEvaluator(args: {
  ctx: ExecutionContext;
  contract: AgentContract | null;
  agent: LiveAgent;
}): { shouldPause: boolean; reason: string } {
  const contract = args.contract;
  if (!contract) {
    return { shouldPause: false, reason: '' };
  }

  if (contract.budget.monthlyUsdCap <= 0) {
    return { shouldPause: true, reason: 'Monthly budget cap is exhausted.' };
  }
  if (contract.budget.perActionUsdCap <= 0) {
    return { shouldPause: true, reason: 'Per-action budget cap is exhausted.' };
  }
  if (typeof args.ctx.budget?.maxSteps === 'number' && args.ctx.budget.maxSteps <= 0) {
    return { shouldPause: true, reason: 'Execution budget maxSteps is exhausted.' };
  }

  return { shouldPause: false, reason: '' };
}

export function createLiveAgentsRuntime(opts?: {
  stateStore?: StateStore;
}): LiveAgentsRuntime {
  return {
    stateStore: asStateStore(opts?.stateStore),
    compressors: new Map(),
  };
}

export function createHeartbeat(opts: {
  stateStore: StateStore;
  workerId: string;
  concurrency: number;
  attentionPolicy?: AttentionPolicy;
  actionExecutor?: ActionExecutor;
  now?: () => string;
  runOptions?: HeartbeatRunOptions;
}): Heartbeat {
  const attentionPolicy = opts.attentionPolicy ?? createStandardAttentionPolicy();
  const actionExecutor = opts.actionExecutor ?? createActionExecutor();
  const now = opts.now ?? (() => new Date().toISOString());
  const leaseDurationMs = Math.max(1, opts.runOptions?.leaseDurationMs ?? 30_000);
  const runPollIntervalMs = Math.max(1, opts.runOptions?.runPollIntervalMs ?? 100);
  const shouldPauseAgent = opts.runOptions?.shouldPauseAgent ?? defaultPauseEvaluator;
  let running = false;

  const processClaimedTick = async (tickId: string, ctx: ExecutionContext): Promise<void> => {
    const tick = await opts.stateStore.loadHeartbeatTick(tickId);
    if (!tick) {
      return;
    }

    const agent = await opts.stateStore.loadAgent(tick.agentId);
    const nowIso = now();
    if (!agent) {
      await opts.stateStore.saveHeartbeatTick({
        ...tick,
        status: 'FAILED',
        completedAt: nowIso,
        actionOutcomeStatus: 'FAILED',
        actionOutcomeProse: `Missing agent ${tick.agentId}`,
      });
      return;
    }

    const [contract, inbox, backlog, activeBindings] = await Promise.all([
      opts.stateStore.loadLatestContractForAgent(agent.id),
      opts.stateStore.listMessagesForRecipient('AGENT', agent.id),
      opts.stateStore.listBacklogForAgent(agent.id),
      opts.stateStore.listActiveAccountBindingsForAgent(agent.id, nowIso),
    ]);

    if (!isContractActiveNow(contract, nowIso)) {
      await opts.stateStore.saveHeartbeatTick({
        ...tick,
        status: 'SKIPPED',
        completedAt: nowIso,
        leaseExpiresAt: null,
        actionOutcomeStatus: 'SKIPPED',
        actionOutcomeProse: 'Skipped because contract working-hours schedule is not active.',
      });
      return;
    }

    const pauseDecision = shouldPauseAgent({ ctx, contract, agent });
    if (pauseDecision.shouldPause) {
      await opts.stateStore.transitionAgentStatus(agent.id, 'PAUSED', nowIso);
      await opts.stateStore.saveHeartbeatTick({
        ...tick,
        status: 'SKIPPED',
        completedAt: nowIso,
        leaseExpiresAt: null,
        actionOutcomeStatus: 'SKIPPED',
        actionOutcomeProse: `Skipped because agent is paused by budget guardrail: ${pauseDecision.reason}`,
      });
      return;
    }

    const action = await attentionPolicy.decide(
      {
        nowIso,
        agent,
        contract,
        inbox,
        backlog,
        activeBindings,
      },
      ctx,
    );

    const executionContext: ActionExecutionContext = {
      tickId: tick.id,
      nowIso,
      stateStore: opts.stateStore,
      agent,
      activeBindings,
    };
    const result = await actionExecutor.execute(action, executionContext, ctx);

    await opts.stateStore.saveHeartbeatTick({
      ...tick,
      status: 'COMPLETED',
      completedAt: now(),
      leaseExpiresAt: null,
      actionChosen: action,
      actionOutcomeStatus: result.status,
      actionOutcomeProse: result.summaryProse,
    });
  };

  return {
    async tick(ctx: ExecutionContext) {
      const nowIso = now();
      const claimed = await opts.stateStore.claimNextTicks(opts.workerId, nowIso, opts.concurrency, leaseDurationMs);
      for (const tick of claimed) {
        try {
          await processClaimedTick(tick.id, ctx);
        } catch (error) {
          const latest = await opts.stateStore.loadHeartbeatTick(tick.id);
          if (!latest) {
            continue;
          }
          await opts.stateStore.saveHeartbeatTick({
            ...latest,
            status: 'FAILED',
            completedAt: now(),
            leaseExpiresAt: null,
            actionOutcomeStatus: 'FAILED',
            actionOutcomeProse: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { processed: claimed.length };
    },
    async run(ctx: ExecutionContext) {
      running = true;
      while (running) {
        const { processed } = await this.tick(ctx);
        if (processed === 0) {
          await sleep(runPollIntervalMs);
        }
      }
    },
    async stop() {
      running = false;
    },
  };
}

export function createCompressionMaintainer(_opts: {
  stateStore: StateStore;
}): CompressionMaintainer {
  return {
    async run(_ctx: ExecutionContext) {
      throw new NotImplementedLiveAgentsError('CompressionMaintainer.run');
    },
    async stop() {
      throw new NotImplementedLiveAgentsError('CompressionMaintainer.stop');
    },
  };
}

export function createExternalEventHandler(opts: {
  stateStore: StateStore;
}): ExternalEventHandler {
  return {
    async process(event: ExternalEvent, _ctx: ExecutionContext) {
      const existing = await opts.stateStore.findExternalEvent(event.accountId, event.sourceType, event.sourceRef);
      if (existing) {
        return { routedMessageCount: existing.producedMessageIds.length };
      }
      await opts.stateStore.saveExternalEvent(event);
      return { routedMessageCount: 0 };
    },
  };
}
