/**
 * Example 51 - live-agents Phase 13 observability + replay
 *
 * Run: npx tsx examples/51-live-agents-phase13.ts
 */

import { weaveContext } from '@weaveintel/core';
import { weaveInMemoryTracer } from '@weaveintel/observability';
import {
  createActionExecutor,
  createExternalEventHandler,
  createHeartbeat,
  createLiveAgentsRunLogger,
  replayLiveAgentsRun,
  weaveInMemoryStateStore,
} from '@weaveintel/live-agents';

async function main() {
  const tracer = weaveInMemoryTracer();
  const runLogger = createLiveAgentsRunLogger();
  const store = weaveInMemoryStateStore();
  const now = new Date().toISOString();
  const ctx = weaveContext({ userId: 'human:ops-admin-1' });

  await store.saveAgent({
    id: 'agent-phase13-example-1',
    meshId: 'mesh-phase13-example-1',
    name: 'Phase13 Example Agent',
    role: 'Coordinator',
    contractVersionId: 'contract-phase13-example-1',
    status: 'ACTIVE',
    createdAt: now,
    archivedAt: null,
  });
  await store.saveContract({
    id: 'contract-phase13-example-1',
    agentId: 'agent-phase13-example-1',
    version: 1,
    persona: 'Coordinator',
    objectives: 'Emit spans and replayable run logs',
    successIndicators: 'Deterministic telemetry',
    budget: {
      monthlyUsdCap: 100,
      perActionUsdCap: 10,
    },
    workingHoursSchedule: {
      timezone: 'UTC',
      cronActive: '* * * * *',
    },
    grantAuthority: {
      mayIssueKinds: ['AUTHORITY_EXTENSION'],
      scopePredicate: 'same mesh',
      maxBudgetIncreaseUsd: null,
      requiresEvidence: false,
      dualControl: false,
    },
    contractAuthority: {
      canIssueContracts: true,
      canIssuePromotions: true,
      scopePredicate: 'same mesh',
      requiresEvidence: false,
    },
    breakGlass: null,
    accountBindingRefs: [],
    attentionPolicyRef: 'phase13-example',
    reviewCadence: 'P1D',
    contextPolicy: {
      compressors: [],
      weighting: [],
      budgets: {
        attentionTokensMax: 1000,
        actionTokensMax: 1000,
        handoffTokensMax: 500,
        reportTokensMax: 500,
        monthlyCompressionUsdCap: 10,
      },
      defaultsProfile: 'standard',
    },
    createdAt: now,
  });
  await store.saveAgent({
    id: 'agent-phase13-example-2',
    meshId: 'mesh-phase13-example-1',
    name: 'Phase13 Recipient',
    role: 'Operator',
    contractVersionId: 'contract-phase13-example-2',
    status: 'ACTIVE',
    createdAt: now,
    archivedAt: null,
  });
  await store.saveContract({
    id: 'contract-phase13-example-2',
    agentId: 'agent-phase13-example-2',
    version: 1,
    persona: 'Operator',
    objectives: 'Receive promotions',
    successIndicators: 'Can adopt new contract versions',
    budget: {
      monthlyUsdCap: 100,
      perActionUsdCap: 10,
    },
    workingHoursSchedule: {
      timezone: 'UTC',
      cronActive: '* * * * *',
    },
    grantAuthority: null,
    contractAuthority: null,
    breakGlass: null,
    accountBindingRefs: [],
    attentionPolicyRef: 'phase13-example',
    reviewCadence: 'P1D',
    contextPolicy: {
      compressors: [],
      weighting: [],
      budgets: {
        attentionTokensMax: 1000,
        actionTokensMax: 1000,
        handoffTokensMax: 500,
        reportTokensMax: 500,
        monthlyCompressionUsdCap: 10,
      },
      defaultsProfile: 'standard',
    },
    createdAt: now,
  });
  await store.saveHeartbeatTick({
    id: 'tick-phase13-example-1',
    agentId: 'agent-phase13-example-1',
    scheduledFor: now,
    pickedUpAt: null,
    completedAt: null,
    workerId: 'scheduler',
    leaseExpiresAt: null,
    actionChosen: null,
    actionOutcomeProse: null,
    actionOutcomeStatus: null,
    status: 'SCHEDULED',
  });

  const actionExecutor = createActionExecutor({
    observability: { tracer, runLogger },
  });
  const heartbeat = createHeartbeat({
    stateStore: store,
    workerId: 'worker-phase13-example',
    concurrency: 1,
    now: () => now,
    attentionPolicy: {
      key: 'phase13-example',
      async decide() {
        return {
          type: 'IssuePromotion',
          recipientAgentId: 'agent-phase13-example-2',
          newContractDraft: {
            role: 'Senior Operator',
            objectives: 'Lead operations',
            successIndicators: 'Stable operations metrics',
          },
          reasonProse: 'Strong delivery consistency',
        } as const;
      },
    },
    actionExecutor,
    runOptions: {
      observability: { tracer, runLogger },
    },
  });

  await heartbeat.tick(ctx);

  await store.saveEventRoute({
    id: 'route-phase13-example-1',
    meshId: 'mesh-phase13-example-1',
    accountId: 'account-phase13-example-1',
    matchDescriptionProse: 'Route all status updates',
    matchExpr: '*',
    targetType: 'AGENT',
    targetId: 'agent-phase13-example-1',
    targetTopic: 'status-updates',
    priorityOverride: 'NORMAL',
    enabled: true,
    createdAt: now,
  });

  const handler = createExternalEventHandler({
    stateStore: store,
    observability: { tracer, runLogger },
  });

  await handler.process(
    {
      id: 'evt-phase13-example-1',
      accountId: 'account-phase13-example-1',
      sourceType: 'status.updated',
      sourceRef: 'status-1',
      receivedAt: now,
      payloadSummary: 'Order moved to fulfilled',
      payloadContextRef: 'mcp://status/1',
      processedAt: null,
      producedMessageIds: [],
      processingStatus: 'RECEIVED',
      error: null,
    },
    ctx,
  );

  const runLog = runLogger.listRunLogs()[0];
  if (!runLog) {
    throw new Error('No run log was captured.');
  }

  const replay = await replayLiveAgentsRun(weaveContext({ userId: 'human:ops-admin-1' }), runLog);

  console.log('Live-agents Phase 13 observability + replay are wired.');
  console.log(`Captured spans: ${tracer.spans.length}`);
  console.log(`Replay status: ${replay.status}`);
  console.log(`Replay match rate: ${replay.matchRate}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
