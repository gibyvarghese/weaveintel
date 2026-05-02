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
import { buildKaggleMeshTemplate, type KaggleMeshTemplate, type KaggleRolePersona } from './mesh-template.js';
import {
  KAGGLE_CAPABILITY_MATRIX,
  bindingConstraintsForCaps,
  resolveCapabilitiesFor,
  type KaggleAgentRole,
} from './account-bindings.js';
import { buildKaggleBridge } from './bridge.js';
import type { KagglePlaybookResolver } from './playbook-resolver.js';
import type { DatabaseAdapter } from '../../db.js';

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
  /** When set, the catch-all (`*`) playbook is resolved once at boot and
   *  its `bridgeTopics` / `bridgeRateLimitPerHour` / `bridgePurposeProse` /
   *  `bridgeConstraintsProse` fields override the historical defaults in
   *  `buildKaggleBridge`. Operators tune these in admin without code edits. */
  playbookResolver?: KagglePlaybookResolver;
  /** When set, the framework-level live mesh definition (`live_mesh_definitions`
   *  + `live_agent_definitions` + `live_mesh_delegation_edges`) is loaded for
   *  `meshKey` and used as the base personas/edges/dual-control snapshot.
   *  Playbook overlay still wins on top. Failure is non-fatal — falls back to
   *  the in-code defaults shipped in `mesh-template.ts`. */
  db?: DatabaseAdapter;
  /** Mesh blueprint key in `live_mesh_definitions`. Defaults to `'kaggle'`. */
  meshKey?: string;
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

  // Resolve the catch-all (`*`) playbook ONCE so every downstream piece
  // (mesh dual-control gate, per-role capabilities, cross-mesh bridge) sees
  // a consistent operator-tunable config. Resolver failure is non-fatal —
  // we fall back to the historical in-code defaults silently.
  let pbConfig: import('./playbook-resolver.js').KagglePlaybookConfig = {};
  if (opts.playbookResolver) {
    try {
      const pb = await opts.playbookResolver('');
      pbConfig = pb?.config ?? {};
    } catch {
      // Non-fatal — pbConfig stays empty and historical defaults apply.
    }
  }

  // Framework-level mesh definition snapshot (DB-driven). Merges UNDER the
  // playbook overlay: DB rows form the base personas + edges + dual-control,
  // and playbook fields override them per competition slug.
  const dbDef = await loadMeshDefinitionSnapshot(opts.db, opts.meshKey ?? 'kaggle');

  const dualControlOverride =
    pbConfig.dualControlRequiredFor ?? dbDef?.dualControlRequiredFor;
  const rolePersonasOverride = mergeRolePersonas(dbDef?.rolePersonas, pbConfig.rolePersonas);

  const template = buildKaggleMeshTemplate({
    tenantId: opts.tenantId,
    ...(opts.meshId !== undefined ? { meshId: opts.meshId } : {}),
    ...(dualControlOverride ? { dualControlRequiredFor: dualControlOverride } : {}),
    ...(rolePersonasOverride ? { rolePersonas: rolePersonasOverride } : {}),
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

  // Delegation edges. Catch-all (`*`) playbook can REPLACE the historical
  // 5-edge pipeline (e.g. drop the observer, add a new collaborator).
  const delegationEdges: DelegationEdge[] = [];
  const edgeSpecs = pbConfig.pipelineEdges && pbConfig.pipelineEdges.length > 0
    ? pbConfig.pipelineEdges.map((e) => ({
        from: e.from as KaggleAgentRole,
        to: e.to as KaggleAgentRole,
        rel: e.relationship as DelegationEdge['relationship'],
        prose: e.prose,
      }))
    : (dbDef?.pipelineEdges && dbDef.pipelineEdges.length > 0
        ? dbDef.pipelineEdges
        : PIPELINE_EDGES);
  for (const edge of edgeSpecs) {
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
  // Per-role capabilities respect the catch-all (`*`) playbook's
  // `capabilityMatrix` override; missing roles keep historical defaults.
  const bindings = {} as Record<KaggleAgentRole, AccountBinding>;
  const roles = Object.keys(KAGGLE_CAPABILITY_MATRIX) as KaggleAgentRole[];
  for (const role of roles) {
    const id = `binding-${mesh.id}-${role}`;
    const caps = resolveCapabilitiesFor(role, pbConfig.capabilityMatrix);
    const binding: AccountBinding = {
      id,
      agentId: agents[role].id,
      accountId: account.id,
      purpose: `Kaggle role: ${role}`,
      constraints: bindingConstraintsForCaps(caps),
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
    const bridgeOverrides = {
      ...(pbConfig.bridgeTopics ? { allowedTopics: pbConfig.bridgeTopics } : {}),
      ...(pbConfig.bridgeRateLimitPerHour !== undefined
        ? { rateLimitPerHour: pbConfig.bridgeRateLimitPerHour }
        : {}),
      ...(pbConfig.bridgePurposeProse ? { purposeProse: pbConfig.bridgePurposeProse } : {}),
      ...(pbConfig.bridgeConstraintsProse
        ? { constraintsProse: pbConfig.bridgeConstraintsProse }
        : {}),
    };
    bridge = buildKaggleBridge({
      fromMeshId: mesh.id,
      toMeshId: opts.userMeshId,
      authorisedByHumanId: opts.humanOwnerId,
      nowIso,
      ...bridgeOverrides,
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

// ─── DB-driven mesh definition snapshot helpers ──────────────

interface MeshDefinitionSnapshot {
  dualControlRequiredFor?: string[];
  rolePersonas?: Partial<Record<KaggleAgentRole, Partial<KaggleRolePersona>>>;
  pipelineEdges?: Array<{
    from: KaggleAgentRole;
    to: KaggleAgentRole;
    rel: DelegationEdge['relationship'];
    prose: string;
  }>;
}

async function loadMeshDefinitionSnapshot(
  db: DatabaseAdapter | undefined,
  meshKey: string,
): Promise<MeshDefinitionSnapshot | null> {
  if (!db) return null;
  try {
    const def = await db.getLiveMeshDefinitionByKey(meshKey);
    if (!def || !def.enabled) return null;
    const [agents, edges] = await Promise.all([
      db.listLiveAgentDefinitions({ meshDefId: def.id, enabledOnly: true }),
      db.listLiveMeshDelegationEdges({ meshDefId: def.id, enabledOnly: true }),
    ]);

    let dualControl: string[] | undefined;
    try {
      const parsed = JSON.parse(def.dual_control_required_for);
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) dualControl = parsed;
    } catch {
      // Bad JSON in operator-edited row — ignore and let in-code default win.
    }

    const rolePersonas: Partial<Record<KaggleAgentRole, Partial<KaggleRolePersona>>> = {};
    for (const a of agents) {
      rolePersonas[a.role_key as KaggleAgentRole] = {
        name: a.name,
        role: a.role_label,
        persona: a.persona,
        objectives: a.objectives,
        success: a.success_indicators,
      };
    }

    const pipelineEdges = edges.map((e) => ({
      from: e.from_role_key as KaggleAgentRole,
      to: e.to_role_key as KaggleAgentRole,
      rel: e.relationship as DelegationEdge['relationship'],
      prose: e.prose,
    }));

    return {
      ...(dualControl ? { dualControlRequiredFor: dualControl } : {}),
      ...(Object.keys(rolePersonas).length > 0 ? { rolePersonas } : {}),
      ...(pipelineEdges.length > 0 ? { pipelineEdges } : {}),
    };
  } catch {
    // Non-fatal — fall back to in-code defaults.
    return null;
  }
}

function mergeRolePersonas(
  base: Partial<Record<KaggleAgentRole, Partial<KaggleRolePersona>>> | undefined,
  overlay: Partial<Record<KaggleAgentRole, Partial<KaggleRolePersona>>> | undefined,
): Partial<Record<KaggleAgentRole, Partial<KaggleRolePersona>>> | undefined {
  if (!base && !overlay) return undefined;
  const out: Partial<Record<KaggleAgentRole, Partial<KaggleRolePersona>>> = {};
  const roles = new Set<KaggleAgentRole>([
    ...(Object.keys(base ?? {}) as KaggleAgentRole[]),
    ...(Object.keys(overlay ?? {}) as KaggleAgentRole[]),
  ]);
  for (const role of roles) {
    out[role] = { ...(base?.[role] ?? {}), ...(overlay?.[role] ?? {}) };
  }
  return out;
}
