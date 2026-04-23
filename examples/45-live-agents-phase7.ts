/**
 * Example 45 - live-agents Phase 7 grants + break-glass workflow
 *
 * Run: npx tsx examples/45-live-agents-phase7.ts
 */

import { weaveContext } from '@weaveintel/core';
import {
  createActionExecutor,
  type AgentContract,
  type LiveAgent,
  type Mesh,
  weaveInMemoryStateStore,
} from '@weaveintel/live-agents';

async function main() {
  const store = weaveInMemoryStateStore();
  const executor = createActionExecutor();
  const meshNow = '2025-01-01T00:00:00.000Z';

  const mesh: Mesh = {
    id: 'mesh-phase7',
    tenantId: 'tenant-phase7',
    name: 'Phase 7 Authority Mesh',
    charter: 'Demonstrate grant requests, delegated grants, and break-glass review.',
    status: 'ACTIVE',
    dualControlRequiredFor: ['MESH_BRIDGE'],
    createdAt: meshNow,
  };

  const manager: LiveAgent = {
    id: 'agent-phase7-manager',
    meshId: mesh.id,
    name: 'Manager',
    role: 'Coordinator',
    contractVersionId: 'contract-phase7-manager-v1',
    status: 'ACTIVE',
    createdAt: meshNow,
    archivedAt: null,
  };

  const worker: LiveAgent = {
    id: 'agent-phase7-worker',
    meshId: mesh.id,
    name: 'Worker',
    role: 'Operator',
    contractVersionId: 'contract-phase7-worker-v1',
    status: 'ACTIVE',
    createdAt: meshNow,
    archivedAt: null,
  };

  const managerContract: AgentContract = {
    id: 'contract-phase7-manager-v1',
    agentId: manager.id,
    version: 1,
    persona: 'A manager who delegates carefully.',
    objectives: 'Issue grants only within contract authority.',
    successIndicators: 'Grants are auditable and policy-compliant.',
    budget: {
      monthlyUsdCap: 100,
      perActionUsdCap: 5,
    },
    workingHoursSchedule: {
      timezone: 'UTC',
      cronActive: '* * * * *',
    },
    grantAuthority: {
      mayIssueKinds: ['AUTHORITY_EXTENSION', 'COLLEAGUE_INTRODUCTION'],
      scopePredicate: 'Agents in this mesh only',
      maxBudgetIncreaseUsd: null,
      requiresEvidence: false,
      dualControl: false,
    },
    breakGlass: null,
    accountBindingRefs: [],
    attentionPolicyRef: 'phase7-example-manager',
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
    createdAt: meshNow,
  };

  const workerContract: AgentContract = {
    id: 'contract-phase7-worker-v1',
    agentId: worker.id,
    version: 1,
    persona: 'An incident responder.',
    objectives: 'Request capabilities when blocked and invoke break-glass only during real emergencies.',
    successIndicators: 'Proper request and post-review traceability.',
    budget: {
      monthlyUsdCap: 100,
      perActionUsdCap: 5,
    },
    workingHoursSchedule: {
      timezone: 'UTC',
      cronActive: '* * * * *',
    },
    grantAuthority: null,
    breakGlass: {
      allowedCapabilityKinds: ['AUTHORITY_EXTENSION'],
      maxDurationMinutes: 30,
      requiredEmergencyConditionsDescription: 'emergency outage',
    },
    accountBindingRefs: [],
    attentionPolicyRef: 'phase7-example-worker',
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
    createdAt: meshNow,
  };

  await store.saveMesh(mesh);
  await store.saveAgent(manager);
  await store.saveAgent(worker);
  await store.saveContract(managerContract);
  await store.saveContract(workerContract);

  const phaseContext = weaveContext({ userId: 'human:ops-admin-1' });

  await executor.execute(
    {
      type: 'RequestCapability',
      capability: {
        kindHint: 'AUTHORITY_EXTENSION',
        descriptionProse: 'Need temporary authority to coordinate mitigation steps.',
        reasonProse: 'Blocked on incident actions without authority extension.',
        evidenceMessageIds: ['msg-phase7-incident-1'],
      },
    },
    {
      tickId: 'tick-phase7-1',
      nowIso: '2025-01-01T00:05:00.000Z',
      stateStore: store,
      agent: worker,
      activeBindings: [],
    },
    phaseContext,
  );

  await executor.execute(
    {
      type: 'IssueGrant',
      recipientAgentId: worker.id,
      capability: {
        kindHint: 'AUTHORITY_EXTENSION',
        descriptionProse: 'You may coordinate emergency mitigations for this incident window.',
        scopeProse: 'Incident channel and mitigation tasks only.',
        durationHint: 'PT30M',
        reasonProse: 'Approved based on on-call manager review.',
      },
    },
    {
      tickId: 'tick-phase7-2',
      nowIso: '2025-01-01T00:10:00.000Z',
      stateStore: store,
      agent: manager,
      activeBindings: [],
    },
    phaseContext,
  );

  await executor.execute(
    {
      type: 'InvokeBreakGlass',
      capability: {
        kindHint: 'AUTHORITY_EXTENSION',
        descriptionProse: 'Emergency authority expansion for immediate customer-impact mitigation.',
        reasonProse: 'Escalating impact requires emergency action now.',
        evidenceMessageIds: ['msg-phase7-incident-2'],
      },
      emergencyReasonProse: 'Sev1 emergency outage impacting customers globally',
    },
    {
      tickId: 'tick-phase7-3',
      nowIso: '2025-01-01T00:12:00.000Z',
      stateStore: store,
      agent: worker,
      activeBindings: [],
    },
    phaseContext,
  );

  const grantRequests = await store.listGrantRequests(mesh.id);
  const grants = await store.listCapabilityGrantsForRecipient('AGENT', worker.id);
  const breakGlass = await store.listBreakGlassInvocations(worker.id);

  const invocation = breakGlass[0] ?? null;
  if (invocation) {
    await store.reviewBreakGlassInvocation(invocation.id, 'REJECTED', '2025-01-01T00:20:00.000Z');
  }

  const workerAfterReview = await store.loadAgent(worker.id);

  console.log('Live-agents Phase 7 grants + break-glass workflow is wired and running.');
  console.log(`Grant requests: ${grantRequests.length}`);
  console.log(`Capability grants for worker: ${grants.length}`);
  console.log(`Break-glass invocations: ${breakGlass.length}`);
  console.log(`Worker status after rejected review: ${workerAfterReview?.status}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
