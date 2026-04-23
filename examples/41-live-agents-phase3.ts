/**
 * Example 41 — live-agents Phase 3 accounts and bindings
 *
 * Run: npx tsx examples/41-live-agents-phase3.ts
 */

import {
  type Account,
  type AccountBindingRequest,
  type LiveAgent,
  type Mesh,
  InvalidAccountBindingError,
  weaveInMemoryStateStore,
} from '@weaveintel/live-agents';

function nowIso(): string {
  return new Date().toISOString();
}

async function main() {
  const store = weaveInMemoryStateStore();
  const now = nowIso();

  const mesh: Mesh = {
    id: 'mesh-phase3',
    tenantId: 'tenant-phase3',
    name: 'Phase 3 Account Mesh',
    charter: 'Demonstrate account and binding lifecycle invariants.',
    status: 'ACTIVE',
    dualControlRequiredFor: ['MESH_BRIDGE'],
    createdAt: now,
  };

  const agent: LiveAgent = {
    id: 'agent-phase3-alice',
    meshId: mesh.id,
    name: 'Alice',
    role: 'Support Specialist',
    contractVersionId: 'contract-phase3-alice-v1',
    status: 'ACTIVE',
    createdAt: now,
    archivedAt: null,
  };

  const account: Account = {
    id: 'account-phase3-gmail',
    meshId: mesh.id,
    provider: 'gmail',
    accountIdentifier: 'alice-support@example.com',
    description: 'Support mailbox account for Alice.',
    mcpServerRef: {
      url: 'https://mcp.example.com/gmail',
      serverType: 'HTTP',
      discoveryHint: 'Gmail list/read/send operations',
    },
    credentialVaultRef: 'vault://credentials/alice-support-gmail',
    upstreamScopesDescription: 'Read and send only',
    ownerHumanId: 'human:ops-admin-1',
    status: 'ACTIVE',
    createdAt: now,
    revokedAt: null,
  };

  await store.saveMesh(mesh);
  await store.saveAgent(agent);
  await store.saveAccount(account);

  // Invalid: account does not exist.
  try {
    await store.saveAccountBinding({
      id: 'binding-invalid',
      agentId: agent.id,
      accountId: 'account-missing',
      purpose: 'Should fail for missing account',
      constraints: 'N/A',
      grantedByHumanId: 'human:ops-admin-1',
      grantedAt: now,
      expiresAt: null,
      revokedAt: null,
      revokedByHumanId: null,
      revocationReason: null,
    });
  } catch (error) {
    if (error instanceof InvalidAccountBindingError) {
      console.log(`Expected invalid binding rejection: ${error.message}`);
    } else {
      throw error;
    }
  }

  await store.saveAccountBinding({
    id: 'binding-phase3-1',
    agentId: agent.id,
    accountId: account.id,
    purpose: 'Handle inbound support email triage',
    constraints: 'Escalate refund requests',
    grantedByHumanId: 'human:ops-admin-1',
    grantedAt: now,
    expiresAt: null,
    revokedAt: null,
    revokedByHumanId: null,
    revocationReason: null,
  });

  const request: AccountBindingRequest = {
    id: 'abr-phase3-1',
    meshId: mesh.id,
    agentId: agent.id,
    accountId: account.id,
    requestedByType: 'AGENT',
    requestedById: agent.id,
    status: 'OPEN',
    resolvedByHumanId: null,
    resolvedAccountBindingId: null,
    createdAt: now,
    resolvedAt: null,
    expiresAt: null,
    purposeProse: 'Need ongoing access for support inbox continuity.',
    reasonProse: 'Current binding is expiring and must be renewed.',
    resolutionReasonProse: null,
    evidenceRefs: ['msg-support-123'],
  };

  await store.saveAccountBindingRequest(request);
  await store.resolveAccountBindingRequest(
    request.id,
    'APPROVED',
    'human:ops-admin-2',
    nowIso(),
    'Renewed after review of support workflow logs.',
    'binding-phase3-1',
  );

  const activeBeforeRevoke = await store.listActiveAccountBindingsForAgent(agent.id, nowIso());

  await store.revokeAccountBinding('binding-phase3-1', 'human:ops-admin-2', 'Offboarding mailbox rotation', nowIso());
  const activeAfterBindingRevoke = await store.listActiveAccountBindingsForAgent(agent.id, nowIso());

  await store.saveAccountBinding({
    id: 'binding-phase3-2',
    agentId: agent.id,
    accountId: account.id,
    purpose: 'Temporary restored access for migration checks',
    constraints: 'Read-only',
    grantedByHumanId: 'human:ops-admin-1',
    grantedAt: nowIso(),
    expiresAt: null,
    revokedAt: null,
    revokedByHumanId: null,
    revocationReason: null,
  });

  await store.transitionAccountStatus(account.id, 'REVOKED', nowIso());
  const activeAfterAccountRevoke = await store.listActiveAccountBindingsForAgent(agent.id, nowIso());

  const requests = await store.listAccountBindingRequests(mesh.id);

  console.log('Live-agents Phase 3 account lifecycle is wired and running.');
  console.log(`Mesh: ${mesh.name}`);
  console.log(`Agent: ${agent.name}`);
  console.log(`Active bindings before revocation: ${activeBeforeRevoke.length}`);
  console.log(`Active bindings after binding revocation: ${activeAfterBindingRevoke.length}`);
  console.log(`Active bindings after account revocation: ${activeAfterAccountRevoke.length}`);
  console.log(`Binding requests in mesh: ${requests.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
