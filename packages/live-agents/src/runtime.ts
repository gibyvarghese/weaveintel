import { weaveResolveTracer, type ExecutionContext, type MemoryEntry, type WorkingMemory } from '@weaveintel/core';
import {
  createCompressorRegistry,
  createContextAssembler,
  createDefaultContextCompressors,
  weaveWorkingMemory,
  type CompressionProfile,
} from '@weaveintel/memory';
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
  Message,
  StateStore,
} from './types.js';
import { asStateStore } from './state-store.js';
import { createStandardAttentionPolicy } from './attention.js';
import { createActionExecutor } from './action-executor.js';
import { createLiveAgentsRunLogger } from './replay.js';

function makeId(prefix: string, nowIso: string, suffix: string): string {
  return `${prefix}_${Date.parse(nowIso)}_${suffix}`;
}

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
  const compressors = createDefaultContextCompressors();
  return {
    stateStore: asStateStore(opts?.stateStore),
    compressors: new Map(compressors.map((compressor) => [compressor.id, compressor])),
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
  const resolvedRunLogger = opts.runOptions?.observability?.runLogger ?? createLiveAgentsRunLogger();
  const resolvedObservability = {
    ...opts.runOptions?.observability,
    runLogger: resolvedRunLogger,
  };
  const attentionPolicy = opts.attentionPolicy ?? createStandardAttentionPolicy();
  const actionExecutor = opts.actionExecutor ?? createActionExecutor({ observability: resolvedObservability });
  const now = opts.now ?? (() => new Date().toISOString());
  const leaseDurationMs = Math.max(1, opts.runOptions?.leaseDurationMs ?? 30_000);
  const runPollIntervalMs = Math.max(1, opts.runOptions?.runPollIntervalMs ?? 100);
  const shouldPauseAgent = opts.runOptions?.shouldPauseAgent ?? defaultPauseEvaluator;
  const observability = resolvedObservability;
  let running = false;

  const withObservedSpan = <T>(
    ctx: ExecutionContext,
    spanName: string,
    attributes: Record<string, unknown>,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const tracer = weaveResolveTracer(ctx, observability?.tracer);
    if (!tracer) {
      return fn();
    }
    return tracer.withSpan(ctx, spanName, () => fn(), attributes);
  };
  const runLogger = observability?.runLogger;

  const processClaimedTick = async (tickId: string, ctx: ExecutionContext): Promise<void> => {
    const stepStart = Date.now();
    return withObservedSpan(
      ctx,
      'live_agents.heartbeat.process_tick',
      { tickId },
      async () => {
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
          runLogger?.recordStep(ctx.executionId, {
            type: 'tick',
            name: 'missing-agent',
            startTime: stepStart,
            endTime: Date.now(),
            input: { tickId, agentId: tick.agentId },
            output: { status: 'FAILED' },
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
          runLogger?.recordStep(ctx.executionId, {
            type: 'tick',
            name: 'working-hours-skip',
            startTime: stepStart,
            endTime: Date.now(),
            input: { tickId, agentId: agent.id },
            output: { status: 'SKIPPED' },
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
          runLogger?.recordStep(ctx.executionId, {
            type: 'tick',
            name: 'budget-skip',
            startTime: stepStart,
            endTime: Date.now(),
            input: { tickId, agentId: agent.id },
            output: { status: 'SKIPPED', reason: pauseDecision.reason },
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
        runLogger?.recordStep(ctx.executionId, {
          type: 'tick',
          name: 'completed-tick',
          startTime: stepStart,
          endTime: Date.now(),
          input: { tickId, agentId: agent.id, actionType: action.type },
          output: { status: result.status, summary: result.summaryProse },
        });
      },
    );
  };

  return {
    async tick(ctx: ExecutionContext) {
      runLogger?.startRun(ctx.executionId);
      const tickStart = Date.now();
      return withObservedSpan(
        ctx,
        'live_agents.heartbeat.tick',
        { workerId: opts.workerId },
        async () => {
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
              runLogger?.recordStep(ctx.executionId, {
                type: 'tick',
                name: 'failed-tick',
                startTime: tickStart,
                endTime: Date.now(),
                input: { tickId: tick.id },
                output: { status: 'FAILED', error: error instanceof Error ? error.message : String(error) },
              });
            }
          }
          runLogger?.recordStep(ctx.executionId, {
            type: 'tick-loop',
            name: 'claim-and-process',
            startTime: tickStart,
            endTime: Date.now(),
            input: { workerId: opts.workerId, concurrency: opts.concurrency },
            output: { claimedCount: claimed.length },
          });
          runLogger?.completeRun(ctx.executionId, 'completed');
          return { processed: claimed.length };
        },
      );
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

function mapMessageToMemoryEntry(message: {
  id: string;
  body: string;
  subject: string;
  createdAt: string;
}): MemoryEntry {
  return {
    id: message.id,
    type: 'conversation',
    content: `${message.subject}: ${message.body}`,
    metadata: {},
    createdAt: message.createdAt,
  };
}

export function createCompressionMaintainer(opts: {
  stateStore: StateStore;
  runIntervalMs?: number;
  now?: () => string;
  workingMemory?: WorkingMemory;
  agentIds?: string[];
  meshIds?: string[];
  tenantId?: string;
  runOnce?: boolean;
  onCompressed?: (payload: {
    agentId: string;
    profile: CompressionProfile;
    rendered: string;
    artefactCount: number;
  }, ctx: ExecutionContext) => Promise<void> | void;
}): CompressionMaintainer {
  const runIntervalMs = Math.max(1, opts.runIntervalMs ?? 30_000);
  const now = opts.now ?? (() => new Date().toISOString());
  const workingMemory = opts.workingMemory ?? weaveWorkingMemory();
  const registry = createCompressorRegistry(createDefaultContextCompressors());
  const assembler = createContextAssembler(registry);
  let running = false;

  const resolveAgentIds = async (ctx: ExecutionContext): Promise<string[]> => {
    if (opts.agentIds && opts.agentIds.length > 0) {
      return opts.agentIds;
    }

    const meshIds = opts.meshIds && opts.meshIds.length > 0
      ? opts.meshIds
      : (await opts.stateStore.listMeshes(opts.tenantId ?? ctx.tenantId ?? '')).map((mesh) => mesh.id);

    const allAgents = await Promise.all(meshIds.map((meshId) => opts.stateStore.listAgents(meshId)));
    return allAgents.flat().map((agent) => agent.id);
  };

  const maintainAgent = async (agentId: string, ctx: ExecutionContext): Promise<void> => {
    const agent = await opts.stateStore.loadAgent(agentId);
    if (!agent || agent.status !== 'ACTIVE') {
      return;
    }

    const [contract, messages, current] = await Promise.all([
      opts.stateStore.loadLatestContractForAgent(agent.id),
      opts.stateStore.listMessagesForRecipient('AGENT', agent.id),
      workingMemory.getCurrent(ctx, agent.id),
    ]);
    if (!contract) {
      return;
    }

    const memoryEntries = messages.map(mapMessageToMemoryEntry);
    const episodicEntries = messages
      .filter((message) => message.kind === 'REPORT' || message.kind === 'ESCALATION')
      .slice(-10)
      .map((message) => ({
        id: `${message.id}:episodic`,
        type: 'episodic' as const,
        content: `${message.subject}: ${message.body}`,
        metadata: { kind: message.kind },
        createdAt: message.createdAt,
      }));

    const assembled = await assembler.assemble({
      agentId: agent.id,
      messages: memoryEntries,
      episodicEvents: episodicEntries,
      workingState: current?.content,
      metadata: {
        role: agent.role,
        objectives: contract.objectives,
      },
    }, {
      profile: contract.contextPolicy.defaultsProfile ?? 'standard',
      tokenBudget: contract.contextPolicy.budgets.attentionTokensMax,
      weighting: contract.contextPolicy.weighting,
    }, ctx);

    await workingMemory.patch(ctx, agent.id, [
      { op: 'set', key: 'compressionProfile', value: contract.contextPolicy.defaultsProfile ?? 'standard' },
      { op: 'set', key: 'compressedAt', value: now() },
      { op: 'set', key: 'compressedContext', value: assembled.rendered },
      {
        op: 'set',
        key: 'compressionArtefacts',
        value: assembled.artefacts.map((artefact) => ({
          id: artefact.id,
          compressorId: artefact.compressorId,
          summary: artefact.summary,
          tokensEstimated: artefact.tokensEstimated,
        })),
      },
    ]);

    await opts.onCompressed?.({
      agentId: agent.id,
      profile: contract.contextPolicy.defaultsProfile ?? 'standard',
      rendered: assembled.rendered,
      artefactCount: assembled.artefacts.length,
    }, ctx);
  };

  return {
    async run(ctx: ExecutionContext) {
      running = true;
      while (running) {
        const agentIds = await resolveAgentIds(ctx);
        for (const agentId of agentIds) {
          await maintainAgent(agentId, ctx);
        }
        if (opts.runOnce) {
          running = false;
          break;
        }
        await sleep(runIntervalMs);
      }
    },
    async stop() {
      running = false;
    },
  };
}

export function createExternalEventHandler(opts: {
  stateStore: StateStore;
  observability?: HeartbeatRunOptions['observability'];
}): ExternalEventHandler {
  const resolvedObservability = {
    ...opts.observability,
    runLogger: opts.observability?.runLogger ?? createLiveAgentsRunLogger(),
  };
  const withObservedSpan = <T>(
    ctx: ExecutionContext,
    spanName: string,
    attributes: Record<string, unknown>,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const tracer = weaveResolveTracer(ctx, resolvedObservability?.tracer);
    if (!tracer) {
      return fn();
    }
    return tracer.withSpan(ctx, spanName, () => fn(), attributes);
  };

  const matchesRoute = (event: ExternalEvent, matchExpr: string): boolean => {
    const expr = matchExpr.trim();
    if (!expr || expr === '*') {
      return true;
    }

    if (expr.startsWith('sourceType:')) {
      return event.sourceType === expr.slice('sourceType:'.length).trim();
    }
    if (expr.startsWith('sourceRef:')) {
      return event.sourceRef === expr.slice('sourceRef:'.length).trim();
    }
    if (expr.startsWith('summaryContains:')) {
      const needle = expr.slice('summaryContains:'.length).trim().toLowerCase();
      return event.payloadSummary.toLowerCase().includes(needle);
    }

    try {
      const parsed = JSON.parse(expr) as {
        sourceType?: string;
        sourceRef?: string;
        summaryIncludes?: string;
      };
      if (parsed.sourceType && parsed.sourceType !== event.sourceType) {
        return false;
      }
      if (parsed.sourceRef && parsed.sourceRef !== event.sourceRef) {
        return false;
      }
      if (parsed.summaryIncludes && !event.payloadSummary.toLowerCase().includes(parsed.summaryIncludes.toLowerCase())) {
        return false;
      }
      return true;
    } catch {
      return event.payloadSummary.toLowerCase().includes(expr.toLowerCase());
    }
  };

  const mapTargetTypeToMessageRecipient = (targetType: 'AGENT' | 'TEAM' | 'BROADCAST'): Message['toType'] => {
    if (targetType === 'TEAM') return 'TEAM';
    if (targetType === 'BROADCAST') return 'BROADCAST';
    return 'AGENT';
  };

  return {
    async process(event: ExternalEvent, ctx: ExecutionContext) {
      resolvedObservability?.runLogger?.startRun(ctx.executionId);
      const eventStart = Date.now();
      return withObservedSpan(
        ctx,
        'live_agents.external_event.process',
        {
          eventId: event.id,
          sourceType: event.sourceType,
          accountId: event.accountId,
        },
        async () => {
          const existing = await opts.stateStore.findExternalEvent(event.accountId, event.sourceType, event.sourceRef);
          if (existing) {
            return { routedMessageCount: existing.producedMessageIds.length };
          }

          const nowIso = new Date().toISOString();
          const baseEvent: ExternalEvent = {
            ...event,
            processedAt: null,
            producedMessageIds: [],
            processingStatus: 'RECEIVED',
            error: null,
          };
          await withObservedSpan(
            ctx,
            'live_agents.external_event.save',
            { eventId: event.id, status: 'RECEIVED' },
            () => opts.stateStore.saveExternalEvent(baseEvent),
          );

          try {
            const routes = await opts.stateStore.listEventRoutes(event.accountId);
            const matchingRoutes = routes.filter((route) => matchesRoute(event, route.matchExpr));

            const producedMessageIds: string[] = [];
            for (const route of matchingRoutes) {
              if (route.targetType !== 'BROADCAST' && !route.targetId) {
                throw new Error(`Route ${route.id} has targetType ${route.targetType} but no targetId.`);
              }

              const messageId = makeId('msg', nowIso, Math.random().toString(36).slice(2, 10));
              const toType = mapTargetTypeToMessageRecipient(route.targetType);
              const toId = toType === 'BROADCAST' ? null : route.targetId;

              await withObservedSpan(
                ctx,
                'live_agents.message.save',
                {
                  sourceType: event.sourceType,
                  routeId: route.id,
                  toType,
                },
                () => opts.stateStore.saveMessage({
                  id: messageId,
                  meshId: route.meshId,
                  fromType: 'INGRESS',
                  fromId: event.accountId,
                  fromMeshId: null,
                  toType,
                  toId,
                  topic: route.targetTopic ?? event.sourceType,
                  kind: 'TELL',
                  replyToMessageId: null,
                  threadId: messageId,
                  contextRefs: [event.id, event.payloadContextRef],
                  contextPacketRef: event.payloadContextRef,
                  expiresAt: null,
                  priority: route.priorityOverride ?? 'NORMAL',
                  status: 'PENDING',
                  deliveredAt: null,
                  readAt: null,
                  processedAt: null,
                  createdAt: nowIso,
                  subject: `External event: ${event.sourceType}`,
                  body: `${event.payloadSummary}\n\nEvent reference: ${event.sourceRef}`,
                }),
              );
              producedMessageIds.push(messageId);
            }

            await withObservedSpan(
              ctx,
              'live_agents.external_event.save',
              { eventId: event.id, status: producedMessageIds.length > 0 ? 'ROUTED' : 'NO_MATCH' },
              () => opts.stateStore.saveExternalEvent({
                ...baseEvent,
                processedAt: nowIso,
                producedMessageIds,
                processingStatus: producedMessageIds.length > 0 ? 'ROUTED' : 'NO_MATCH',
                error: null,
              }),
            );
            resolvedObservability?.runLogger?.recordStep(ctx.executionId, {
              type: 'external-event',
              name: event.sourceType,
              startTime: eventStart,
              endTime: Date.now(),
              input: { eventId: event.id, sourceRef: event.sourceRef },
              output: { routedMessageCount: producedMessageIds.length },
            });
            resolvedObservability?.runLogger?.completeRun(ctx.executionId, 'completed');
            return { routedMessageCount: producedMessageIds.length };
          } catch (error) {
            await withObservedSpan(
              ctx,
              'live_agents.external_event.save',
              { eventId: event.id, status: 'FAILED' },
              () => opts.stateStore.saveExternalEvent({
                ...baseEvent,
                processedAt: nowIso,
                producedMessageIds: [],
                processingStatus: 'FAILED',
                error: error instanceof Error ? error.message : String(error),
              }),
            );
            opts.observability?.runLogger?.recordStep(ctx.executionId, {
              type: 'external-event',
              name: `${event.sourceType}:failed`,
              startTime: eventStart,
              endTime: Date.now(),
              input: { eventId: event.id, sourceRef: event.sourceRef },
              output: { routedMessageCount: 0, error: error instanceof Error ? error.message : String(error) },
            });
            opts.observability?.runLogger?.completeRun(ctx.executionId, 'failed');
            return { routedMessageCount: 0 };
          }
        },
      );
    },
  };
}
