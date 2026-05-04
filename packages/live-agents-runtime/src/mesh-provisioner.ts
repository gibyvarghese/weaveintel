/**
 * Phase 5 — Generic, DB-driven mesh provisioner.
 *
 * --- Why this exists ---
 *
 * Historically each domain (Kaggle, …) ships a bespoke `bootXxxMesh()` that
 * hardcodes the role names, capability matrix, and cross-mesh bridge wiring.
 * That made it impossible for an operator to spin up a new mesh from the
 * admin UI: every new mesh required a code change and a redeploy.
 *
 * `provisionMesh()` replaces those bespoke boots with a single generic
 * routine that reads the blueprint from `live_mesh_definitions`,
 * `live_agent_definitions`, and `live_mesh_delegation_edges`, then writes:
 *
 *   1. one `live_meshes` row              (the runtime mesh per tenant)
 *   2. one `live_agents` row per agent def
 *   3. one `live_agent_handler_bindings`  per agent (from `default_handler_kind`)
 *   4. one `live_agent_tool_bindings`     per agent per tool key
 *      (from `default_tool_catalog_keys`)
 *   5. mirrors of Mesh / LiveAgent / DelegationEdge / Account / AccountBinding
 *      / AgentContract into the live-agents StateStore so the heartbeat
 *      engine can immediately dispatch ticks against them.
 *
 * The live mesh definition table fields consumed are documented inline so
 * operators editing the blueprint know which knobs map where at runtime.
 *
 * --- Boundary ---
 *
 * - This package never imports SQLite or geneweave's `DatabaseAdapter`.
 *   Callers pass a thin `ProvisionMeshDb` that exposes only the rows we
 *   need to read/write.
 * - StateStore mirroring is best-effort — failures are logged and the DB
 *   provision still succeeds, so the admin operator can retry the mirror
 *   without re-creating duplicate runtime rows.
 */

import type {
  Account,
  AccountBinding,
  AgentContract,
  DelegationEdge,
  LiveAgent,
  Mesh,
  StateStore,
} from '@weaveintel/live-agents';

// ─── Lightweight DB row shapes ───────────────────────────────
// Mirrors of geneweave's row interfaces. Only the columns this provisioner
// actually reads/writes are listed. This keeps the package free of any
// dependency on the geneweave app.

export interface MeshDefinitionRowLike {
  id: string;
  mesh_key: string;
  name: string;
  charter_prose: string;
  dual_control_required_for: string;        // JSON array of tool keys
  /** Optional Phase 1 columns. Provisioner reads them when present. */
  domain?: string | null;
}

export interface AgentDefinitionRowLike {
  id: string;
  mesh_def_id: string;
  role_key: string;
  name: string;
  role_label: string;
  persona: string;
  objectives: string;
  success_indicators: string;
  ordering: number;
  enabled: number;
  /** Phase 1 extension: which handler kind drives this role. */
  default_handler_kind?: string | null;
  /** Phase 1 extension: opaque handler config JSON. */
  default_handler_config_json?: string | null;
  /** Phase 1 extension: JSON array of tool catalog keys to wire on boot. */
  default_tool_catalog_keys?: string | null;
  /** Phase 1 extension: which DB attention policy this agent uses. */
  default_attention_policy_key?: string | null;
  /** Phase 3.5 — model routing defaults. */
  model_capability_json?: string | null;
  model_routing_policy_key?: string | null;
  model_pinned_id?: string | null;
}

export interface MeshDelegationEdgeRowLike {
  id: string;
  mesh_def_id: string;
  from_role_key: string;
  to_role_key: string;
  relationship: string;
  prose: string;
  ordering: number;
  enabled: number;
}

export interface ToolCatalogRowLike {
  id: string;
  tool_key: string | null;
}

export interface LiveMeshRowLike {
  id: string;
  tenant_id: string | null;
  mesh_def_id: string;
  name: string;
  status: string;
  domain: string | null;
  dual_control_required_for: string;
  owner_human_id: string | null;
  mcp_server_ref: string | null;
  account_id: string | null;
  context_json: string | null;
}

export interface LiveAgentRowLike {
  id: string;
  mesh_id: string;
  agent_def_id: string | null;
  role_key: string;
  name: string;
  role_label: string;
  persona: string;
  objectives: string;
  success_indicators: string;
  attention_policy_key: string | null;
  contract_version_id: string | null;
  status: string;
  ordering: number;
  archived_at: string | null;
  model_capability_json?: string | null;
  model_routing_policy_key?: string | null;
  model_pinned_id?: string | null;
}

export interface LiveAgentHandlerBindingRowLike {
  id: string;
  agent_id: string;
  handler_kind: string;
  config_json: string;
  enabled: number;
}

export interface LiveAgentToolBindingRowLike {
  id: string;
  agent_id: string;
  tool_catalog_id: string | null;
  mcp_server_url: string | null;
  capability_keys: string;
  enabled: number;
}

/** The slice of `DatabaseAdapter` the provisioner needs. */
export interface ProvisionMeshDb {
  // Reads (blueprint)
  getLiveMeshDefinition(id: string): Promise<MeshDefinitionRowLike | null>;
  getLiveMeshDefinitionByKey(meshKey: string): Promise<MeshDefinitionRowLike | null>;
  listLiveAgentDefinitions(opts: {
    meshDefId: string;
    enabledOnly?: boolean;
  }): Promise<AgentDefinitionRowLike[]>;
  listLiveMeshDelegationEdges(opts: {
    meshDefId: string;
    enabledOnly?: boolean;
  }): Promise<MeshDelegationEdgeRowLike[]>;
  // Tool catalog lookup (returns null when key is unknown — that becomes a
  // `mcp_server_url` fallback or is logged-and-skipped by the caller).
  listToolConfigs(): Promise<ToolCatalogRowLike[]>;

  // Writes (runtime)
  createLiveMesh(row: Omit<LiveMeshRowLike, 'created_at' | 'updated_at'>): Promise<LiveMeshRowLike>;
  createLiveAgent(row: Omit<LiveAgentRowLike, 'created_at' | 'updated_at'>): Promise<LiveAgentRowLike>;
  createLiveAgentHandlerBinding(
    row: Omit<LiveAgentHandlerBindingRowLike, 'created_at' | 'updated_at'>,
  ): Promise<LiveAgentHandlerBindingRowLike>;
  createLiveAgentToolBinding(
    row: Omit<LiveAgentToolBindingRowLike, 'created_at' | 'updated_at'>,
  ): Promise<LiveAgentToolBindingRowLike>;
}

// ─── Public API ──────────────────────────────────────────────

export interface ProvisionAccountSpec {
  /** Provider id (e.g. `'kaggle.com'`, `'gmail.com'`). */
  provider: string;
  /** External identity (e.g. user email or username). */
  accountIdentifier: string;
  /** MCP server URL that exposes this provider's tools. */
  mcpServerUrl: string;
  /** Vault reference (e.g. `'env:GMAIL_TOKEN'`). */
  credentialVaultRef: string;
  /** Free-text describing what scopes the credential carries. */
  upstreamScopesDescription?: string;
  /** Free-text human description of the account. */
  description?: string;
}

export interface ProvisionMeshOptions {
  /** Either pass `meshDefId` directly or look up by `meshDefKey`. Exactly one
   *  of the two is required. */
  meshDefId?: string;
  meshDefKey?: string;
  /** Tenant scope for the new mesh. `null` is permitted for global meshes. */
  tenantId: string | null;
  /** Human owner authorising the mesh + any account bindings. */
  ownerHumanId: string;
  /** Optional override for the runtime mesh name (defaults to the def name). */
  name?: string;
  /** Optional initial status (default 'ACTIVE'). */
  status?: 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
  /** Optional account spec — when supplied, a single Account + per-agent
   *  AccountBindings are written so agents can call MCP-backed tools. */
  account?: ProvisionAccountSpec;
  /** Live-agents StateStore. When omitted the provisioner only writes DB
   *  rows; the operator can call `mirrorMeshToStateStore` later. Most
   *  callers should pass the same store the supervisor uses. */
  store?: StateStore;
  /** Logger (defaults to console.log with a tag). */
  logger?: (msg: string) => void;
  /** Override `now()` for deterministic tests. */
  nowIso?: string;
}

export interface ProvisionMeshResult {
  meshId: string;
  agentIds: string[];
  handlerBindingIds: string[];
  toolBindingIds: string[];
  delegationEdgeIds: string[];
  accountId: string | null;
  accountBindingIds: string[];
}

/** UUID v7 generator. We accept it from the caller so tests can be
 *  deterministic and so the package stays free of an explicit uuid dep. */
export type IdGenerator = () => string;

/** Default id generator: RFC 9562 v4 fallback. Geneweave passes its v7 fn
 *  for sortability. */
const defaultIdGen: IdGenerator = () => {
  // Crypto.randomUUID is available in Node 19+ and modern browsers.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Last-resort fallback (non-crypto): timestamp + random. Good enough for
  // local dev when crypto is unavailable.
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
};

/**
 * Provision a runtime mesh from a DB blueprint. Idempotent at the
 * application level only when the caller deduplicates by some external key
 * (no UNIQUE constraint exists on `(mesh_def_id, tenant_id)`); the admin
 * route layered above is responsible for that policy.
 */
export async function provisionMesh(
  db: ProvisionMeshDb,
  opts: ProvisionMeshOptions,
  newId: IdGenerator = defaultIdGen,
): Promise<ProvisionMeshResult> {
  const log = opts.logger ?? ((m) => console.log('[mesh-provisioner]', m));
  const nowIso = opts.nowIso ?? new Date().toISOString();

  // ─ 1. Resolve mesh definition ────────────────────────────
  let def: MeshDefinitionRowLike | null = null;
  if (opts.meshDefId) {
    def = await db.getLiveMeshDefinition(opts.meshDefId);
  } else if (opts.meshDefKey) {
    def = await db.getLiveMeshDefinitionByKey(opts.meshDefKey);
  } else {
    throw new Error('provisionMesh: either meshDefId or meshDefKey is required');
  }
  if (!def) {
    throw new Error(
      `provisionMesh: mesh definition not found (${opts.meshDefId ?? opts.meshDefKey})`,
    );
  }

  // ─ 2. Insert the runtime mesh row ─────────────────────────
  const meshId = newId();
  const meshName = opts.name ?? def.name;
  await db.createLiveMesh({
    id: meshId,
    tenant_id: opts.tenantId,
    mesh_def_id: def.id,
    name: meshName,
    status: opts.status ?? 'ACTIVE',
    domain: def.domain ?? null,
    dual_control_required_for: def.dual_control_required_for,
    owner_human_id: opts.ownerHumanId,
    mcp_server_ref: opts.account?.mcpServerUrl ?? null,
    account_id: null, // backfilled below if account is provisioned
    context_json: null,
  });
  log(`mesh ${meshId} (${meshName}) created from def ${def.id}`);

  // ─ 3. Insert agents + handler/tool bindings ───────────────
  const agentDefs = await db.listLiveAgentDefinitions({
    meshDefId: def.id,
    enabledOnly: true,
  });
  const catalog = await db.listToolConfigs();
  const catalogByKey = new Map(
    catalog
      .filter((c) => typeof c.tool_key === 'string' && c.tool_key.length > 0)
      .map((c) => [c.tool_key as string, c.id] as const),
  );

  // Per role, remember the new agent id so delegation edges can resolve.
  const agentIdByRole = new Map<string, string>();
  const agentIds: string[] = [];
  const handlerBindingIds: string[] = [];
  const toolBindingIds: string[] = [];

  for (const ad of agentDefs) {
    const agentId = newId();
    agentIdByRole.set(ad.role_key, agentId);
    agentIds.push(agentId);

    await db.createLiveAgent({
      id: agentId,
      mesh_id: meshId,
      agent_def_id: ad.id,
      role_key: ad.role_key,
      name: ad.name,
      role_label: ad.role_label,
      persona: ad.persona,
      objectives: ad.objectives,
      success_indicators: ad.success_indicators,
      attention_policy_key: ad.default_attention_policy_key ?? null,
      contract_version_id: null,
      status: 'ACTIVE',
      ordering: ad.ordering,
      archived_at: null,
      model_capability_json: ad.model_capability_json ?? null,
      model_routing_policy_key: ad.model_routing_policy_key ?? null,
      model_pinned_id: ad.model_pinned_id ?? null,
    });

    // Handler binding — only if the def names a kind. Operators can later
    // attach handlers to mesh-def-less agents via the admin UI.
    if (ad.default_handler_kind) {
      const bid = newId();
      await db.createLiveAgentHandlerBinding({
        id: bid,
        agent_id: agentId,
        handler_kind: ad.default_handler_kind,
        config_json: ad.default_handler_config_json ?? '{}',
        enabled: 1,
      });
      handlerBindingIds.push(bid);
    }

    // Tool bindings — one per declared tool key. Unknown keys are logged
    // and skipped (admin can add them later).
    const toolKeys = parseStringArray(ad.default_tool_catalog_keys);
    for (const key of toolKeys) {
      const catalogId = catalogByKey.get(key) ?? null;
      if (!catalogId) {
        log(`agent ${ad.role_key}: tool key "${key}" not in catalog — skipped`);
        continue;
      }
      const tbid = newId();
      await db.createLiveAgentToolBinding({
        id: tbid,
        agent_id: agentId,
        tool_catalog_id: catalogId,
        mcp_server_url: opts.account?.mcpServerUrl ?? null,
        capability_keys: JSON.stringify([key]),
        enabled: 1,
      });
      toolBindingIds.push(tbid);
    }
  }

  // ─ 4. Mirror to StateStore so the heartbeat can dispatch ──
  let accountId: string | null = null;
  const accountBindingIds: string[] = [];
  const delegationEdgeIds: string[] = [];

  if (opts.store) {
    try {
      const { account, bindings, edges } = await mirrorToStateStore({
        store: opts.store,
        meshId,
        meshName,
        tenantId: opts.tenantId ?? '__global__',
        charter: def.charter_prose,
        dualControlRequiredFor: parseStringArray(def.dual_control_required_for),
        agentRows: agentDefs.map((ad) => ({
          ad,
          agentId: agentIdByRole.get(ad.role_key)!,
        })),
        delegations: await db.listLiveMeshDelegationEdges({
          meshDefId: def.id,
          enabledOnly: true,
        }),
        agentIdByRole,
        ownerHumanId: opts.ownerHumanId,
        nowIso,
        ...(opts.account ? { accountSpec: opts.account } : {}),
        newId,
      });
      accountId = account?.id ?? null;
      for (const b of bindings) accountBindingIds.push(b.id);
      for (const e of edges) delegationEdgeIds.push(e.id);
    } catch (err) {
      log(`StateStore mirror failed (DB rows are still committed): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log(
    `provisioned mesh=${meshId} agents=${agentIds.length} handlers=${handlerBindingIds.length} ` +
      `tools=${toolBindingIds.length} edges=${delegationEdgeIds.length} ` +
      `account=${accountId ? 'yes' : 'none'}`,
  );

  return {
    meshId,
    agentIds,
    handlerBindingIds,
    toolBindingIds,
    delegationEdgeIds,
    accountId,
    accountBindingIds,
  };
}

// ─── Internal helpers ────────────────────────────────────────

interface MirrorAgentInput {
  ad: AgentDefinitionRowLike;
  agentId: string;
}

interface MirrorOptions {
  store: StateStore;
  meshId: string;
  meshName: string;
  tenantId: string;
  charter: string;
  dualControlRequiredFor: string[];
  agentRows: MirrorAgentInput[];
  delegations: MeshDelegationEdgeRowLike[];
  agentIdByRole: Map<string, string>;
  ownerHumanId: string;
  nowIso: string;
  accountSpec?: ProvisionAccountSpec;
  newId: IdGenerator;
}

/**
 * Write the runtime topology into the live-agents StateStore. Mirrors
 * mesh + agents + delegation edges + a default contract per agent, plus
 * an Account / AccountBindings if `accountSpec` is provided.
 */
async function mirrorToStateStore(opts: MirrorOptions): Promise<{
  account: Account | null;
  bindings: AccountBinding[];
  edges: DelegationEdge[];
}> {
  const mesh: Mesh = {
    id: opts.meshId,
    tenantId: opts.tenantId,
    name: opts.meshName,
    charter: opts.charter,
    status: 'ACTIVE',
    dualControlRequiredFor: opts.dualControlRequiredFor,
    createdAt: opts.nowIso,
  };
  await opts.store.saveMesh(mesh);

  // Save each agent + a default contract so the heartbeat doesn't pause it
  // for "no contract" / "outside working hours".
  for (const { ad, agentId } of opts.agentRows) {
    const agent: LiveAgent = {
      id: agentId,
      meshId: opts.meshId,
      name: ad.name,
      role: ad.role_key,
      contractVersionId: `${agentId}::contract::v1`,
      status: 'ACTIVE',
      createdAt: opts.nowIso,
      archivedAt: null,
    };
    await opts.store.saveAgent(agent);

    const contract: AgentContract = {
      id: agent.contractVersionId,
      agentId,
      version: 1,
      persona: ad.persona,
      objectives: ad.objectives,
      successIndicators: ad.success_indicators,
      budget: { monthlyUsdCap: 1_000, perActionUsdCap: 5 },
      // 24/7 by default — operators can tighten via admin later.
      workingHoursSchedule: { timezone: 'UTC', cronActive: '* * * * *' },
      accountBindingRefs: [],
      attentionPolicyRef: ad.default_attention_policy_key ?? 'standard',
      reviewCadence: 'monthly',
      contextPolicy: {
        compressors: [],
        weighting: [],
        budgets: {
          attentionTokensMax: 8_000,
          actionTokensMax: 4_000,
          handoffTokensMax: 2_000,
          reportTokensMax: 2_000,
          monthlyCompressionUsdCap: 25,
        },
      },
      createdAt: opts.nowIso,
    };
    await opts.store.saveContract(contract);
  }

  // Delegation edges — resolve role pairs to runtime agent ids.
  const edges: DelegationEdge[] = [];
  for (const de of opts.delegations) {
    const from = opts.agentIdByRole.get(de.from_role_key);
    const to = opts.agentIdByRole.get(de.to_role_key);
    if (!from || !to) continue; // skip edges that reference disabled roles
    const rel = (de.relationship as DelegationEdge['relationship']) ?? 'DIRECTS';
    const edge: DelegationEdge = {
      id: opts.newId(),
      meshId: opts.meshId,
      fromAgentId: from,
      toAgentId: to,
      relationship: rel,
      relationshipProse: de.prose,
      effectiveFrom: opts.nowIso,
      effectiveTo: null,
    };
    await opts.store.saveDelegationEdge(edge);
    edges.push(edge);
  }

  // Optional account + per-agent bindings.
  let account: Account | null = null;
  const bindings: AccountBinding[] = [];
  if (opts.accountSpec) {
    account = {
      id: opts.newId(),
      meshId: opts.meshId,
      provider: opts.accountSpec.provider,
      accountIdentifier: opts.accountSpec.accountIdentifier,
      description:
        opts.accountSpec.description ?? `${opts.accountSpec.provider} account`,
      mcpServerRef: {
        url: opts.accountSpec.mcpServerUrl,
        serverType: 'HTTP',
        discoveryHint: `MCP endpoint for ${opts.accountSpec.provider}`,
      },
      credentialVaultRef: opts.accountSpec.credentialVaultRef,
      upstreamScopesDescription:
        opts.accountSpec.upstreamScopesDescription ??
        `Default scopes for ${opts.accountSpec.provider}.`,
      ownerHumanId: opts.ownerHumanId,
      status: 'ACTIVE',
      createdAt: opts.nowIso,
      revokedAt: null,
    };
    await opts.store.saveAccount(account);

    for (const { ad, agentId } of opts.agentRows) {
      const binding: AccountBinding = {
        id: opts.newId(),
        agentId,
        accountId: account.id,
        purpose: `Role ${ad.role_key} on mesh ${opts.meshName}`,
        // Capabilities live in the DB tool bindings; we keep StateStore
        // constraints permissive and let policy enforcement happen at the
        // tool-registry layer.
        constraints: 'Defer to live_agent_tool_bindings + tool_policies.',
        grantedByHumanId: opts.ownerHumanId,
        grantedAt: opts.nowIso,
        expiresAt: null,
        revokedAt: null,
        revokedByHumanId: null,
        revocationReason: null,
      };
      await opts.store.saveAccountBinding(binding);
      bindings.push(binding);
    }
  }

  return { account, bindings, edges };
}

/** Parse a JSON-encoded string array, tolerating null/undefined/empty. */
function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Re-export so callers can detect the type. */
export type { Account, AccountBinding, DelegationEdge, Mesh, LiveAgent };
