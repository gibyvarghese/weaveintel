/**
 * Phase K5 — Bootstrap a Kaggle live-agents mesh into a StateStore.
 *
 * Provisions:
 *   - Mesh (with dual-control on submit + kernel.push)
 *   - Six role-bound Agents + AgentContracts
 *   - DelegationEdges that wire the discoverer → strategist → implementer →
 *     validator → submitter pipeline (and observer ↔ strategist feedback)
 *   - One Account (Kaggle credentials) + six AccountBindings (one per agent)
 *   - CrossMeshBridge to the user's main mesh (when `userMeshId` provided)
 *
 * Caller is responsible for running the heartbeat. This function is pure
 * provisioning — no ticks scheduled.
 */

import type {
  Account,
  AccountBinding,
  AgentContract,
  CrossMeshBridge,
  DelegationEdge,
  LiveAgent,
  Mesh,
  StateStore,
} from '@weaveintel/live-agents';
import { buildKaggleMeshTemplate, type KaggleMeshTemplate } from './mesh-template.js';
import {
  KAGGLE_CAPABILITY_MATRIX,
  bindingConstraintsFor,
  type KaggleAgentRole,
} from './account-bindings.js';
import { buildKaggleBridge } from './bridge.js';

export interface BootKaggleMeshOptions {
  store: StateStore;
  tenantId: string;
  /** Human who owns the credentials and authorises bindings/bridges. */
  humanOwnerId: string;
  /** Kaggle username (used for accountIdentifier). */
  kaggleUsername: string;
  /** MCP HTTP URL exposing `@weaveintel/tools-kaggle`. */
  mcpUrl: string;
  /** Vault ref for the credential (e.g. `env:KAGGLE_KEY` for local dev). */
  credentialVaultRef?: string;
  /** When set, a CrossMeshBridge is wired to this user mesh. */
  userMeshId?: string | null;
  /** Override mesh id. */
  meshId?: string;
  /** ISO timestamp. */
  nowIso?: string;
}

export interface KaggleMeshBootResult {
  template: KaggleMeshTemplate;
  account: Account;
  bindings: Record<KaggleAgentRole, AccountBinding>;
  delegationEdges: DelegationEdge[];
  bridge: CrossMeshBridge | null;
}

const PIPELINE_EDGES: ReadonlyArray<{ from: KaggleAgentRole; to: KaggleAgentRole; rel: DelegationEdge['relationship']; prose: string }> = [
  { from: 'discoverer', to: 'strategist', rel: 'DIRECTS', prose: 'Discoverer hands picked competitions to the strategist.' },
  { from: 'strategist', to: 'implementer', rel: 'DIRECTS', prose: 'Strategist hands approved approaches to the implementer.' },
  { from: 'implementer', to: 'validator', rel: 'DIRECTS', prose: 'Implementer hands kernel outputs to the validator.' },
  { from: 'validator', to: 'submitter', rel: 'DIRECTS', prose: 'Validator hands passing submissions to the submitter.' },
  { from: 'observer', to: 'strategist', rel: 'COLLABORATES_WITH', prose: 'Observer surfaces leaderboard signal to the strategist.' },
];

export async function bootKaggleMesh(opts: BootKaggleMeshOptions): Promise<KaggleMeshBootResult> {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const template = buildKaggleMeshTemplate({
    tenantId: opts.tenantId,
    ...(opts.meshId !== undefined ? { meshId: opts.meshId } : {}),
    nowIso,
  });
  const { mesh, agents, contracts } = template;

  await opts.store.saveMesh(mesh);
  for (const agent of Object.values(agents) as LiveAgent[]) {
    await opts.store.saveAgent(agent);
  }
  for (const contract of Object.values(contracts) as AgentContract[]) {
    await opts.store.saveContract(contract);
  }

  // Delegation edges
  const delegationEdges: DelegationEdge[] = [];
  for (const edge of PIPELINE_EDGES) {
    const id = `edge-${mesh.id}-${edge.from}-${edge.to}`;
    const row: DelegationEdge = {
      id,
      meshId: mesh.id,
      fromAgentId: agents[edge.from].id,
      toAgentId: agents[edge.to].id,
      relationship: edge.rel,
      relationshipProse: edge.prose,
      effectiveFrom: nowIso,
      effectiveTo: null,
    };
    await opts.store.saveDelegationEdge(row);
    delegationEdges.push(row);
  }

  // Single Kaggle credentials Account for the mesh.
  const account: Account = {
    id: `account-kaggle-${mesh.id}`,
    meshId: mesh.id,
    provider: 'kaggle.com',
    accountIdentifier: opts.kaggleUsername,
    description: `Kaggle credentials for ${opts.kaggleUsername}`,
    mcpServerRef: {
      url: opts.mcpUrl,
      serverType: 'HTTP',
      discoveryHint: '@weaveintel/tools-kaggle MCP server',
    },
    credentialVaultRef: opts.credentialVaultRef ?? 'env:KAGGLE_KEY',
    upstreamScopesDescription:
      'Kaggle REST API: list competitions/datasets/kernels, push kernels, submit to competitions. Counts against per-account 4/day submit cap.',
    ownerHumanId: opts.humanOwnerId,
    status: 'ACTIVE',
    createdAt: nowIso,
    revokedAt: null,
  };
  await opts.store.saveAccount(account);

  // One AccountBinding per role, encoding capabilities in `constraints`.
  const bindings = {} as Record<KaggleAgentRole, AccountBinding>;
  const roles = Object.keys(KAGGLE_CAPABILITY_MATRIX) as KaggleAgentRole[];
  for (const role of roles) {
    const id = `binding-${mesh.id}-${role}`;
    const binding: AccountBinding = {
      id,
      agentId: agents[role].id,
      accountId: account.id,
      purpose: `Kaggle role: ${role}`,
      constraints: bindingConstraintsFor(role),
      grantedByHumanId: opts.humanOwnerId,
      grantedAt: nowIso,
      expiresAt: null,
      revokedAt: null,
      revokedByHumanId: null,
      revocationReason: null,
    };
    await opts.store.saveAccountBinding(binding);
    bindings[role] = binding;
  }

  // Optional cross-mesh bridge to the user's main mesh.
  let bridge: CrossMeshBridge | null = null;
  if (opts.userMeshId) {
    bridge = buildKaggleBridge({
      fromMeshId: mesh.id,
      toMeshId: opts.userMeshId,
      authorisedByHumanId: opts.humanOwnerId,
      nowIso,
    });
    await opts.store.saveCrossMeshBridge(bridge);
  }

  return { template, account, bindings, delegationEdges, bridge };
}

/** Helper: revoke a single agent's binding (immediate effect on next tick). */
export async function revokeKaggleBinding(
  store: StateStore,
  bindingId: string,
  revokedByHumanId: string,
  reason: string,
): Promise<AccountBinding | null> {
  return store.revokeAccountBinding(bindingId, revokedByHumanId, reason, new Date().toISOString());
}
