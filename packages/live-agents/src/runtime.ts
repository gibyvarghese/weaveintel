import type { ExecutionContext } from '@weaveintel/core';
import type {
  ActionExecutionContext,
  ActionExecutor,
  AttentionPolicy,
  CompressionMaintainer,
  ExternalEvent,
  ExternalEventHandler,
  Heartbeat,
  LiveAgentsRuntime,
  StateStore,
} from './types.js';
import { NotImplementedLiveAgentsError } from './errors.js';
import { asStateStore } from './state-store.js';
import { createStandardAttentionPolicy } from './attention.js';
import { createActionExecutor } from './action-executor.js';

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
}): Heartbeat {
  const attentionPolicy = opts.attentionPolicy ?? createStandardAttentionPolicy();
  const actionExecutor = opts.actionExecutor ?? createActionExecutor();
  const now = opts.now ?? (() => new Date().toISOString());
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
      actionChosen: action,
      actionOutcomeStatus: result.status,
      actionOutcomeProse: result.summaryProse,
    });
  };

  return {
    async tick(ctx: ExecutionContext) {
      const nowIso = now();
      const claimed = await opts.stateStore.claimNextTicks(opts.workerId, nowIso, opts.concurrency);
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
          running = false;
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
