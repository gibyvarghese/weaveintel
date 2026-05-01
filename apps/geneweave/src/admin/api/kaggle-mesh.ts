/**
 * Phase K5 — Kaggle Live-Agents Mesh admin routes.
 *
 * Operator-facing CRUD over the Kaggle live-agents mesh provisioned by
 * `bootKaggleMesh`. All read routes are flat list endpoints that match the
 * AdminTabDef shape (returns `{ '<listKey>': T[] }`). Write routes:
 *   - POST /api/admin/kaggle-mesh-provision  → bootKaggleMesh + return summary
 *   - POST /api/admin/kaggle-mesh-bindings/:id/revoke → human revokes a binding
 *
 * The data lives in the live-agents StateStore (see ./store.ts), not in
 * geneweave.db. Source of truth for live-agent topology stays in @weaveintel/live-agents.
 */

import { createIdempotencyStore } from '@weaveintel/reliability';
import type { Account, AccountBinding, AgentContract, CrossMeshBridge, DelegationEdge, LiveAgent, Mesh, StateStore } from '@weaveintel/live-agents';
import type { DatabaseAdapter } from '../../db.js';
import type { RouterLike, AdminHelpers } from './types.js';
import { bootKaggleMesh, revokeKaggleBinding } from '../../live-agents/kaggle/boot.js';
import { getKaggleLiveStore } from '../../live-agents/kaggle/store.js';

const provisionIdempotency = createIdempotencyStore({ ttlMs: 24 * 60 * 60 * 1000 });

/** Resolve the StateStore: tests inject via helpers.providers, prod uses singleton. */
async function resolveStore(helpers: AdminHelpers & { liveStore?: StateStore }): Promise<StateStore> {
  return helpers.liveStore ?? (await getKaggleLiveStore());
}

async function gatherMeshes(store: StateStore, db: DatabaseAdapter): Promise<Mesh[]> {
  const index = await db.listKaggleLiveMeshes();
  const meshes: Mesh[] = [];
  for (const row of index) {
    const m = await store.loadMesh(row.mesh_id);
    if (m) meshes.push(m);
  }
  return meshes;
}

export function registerKaggleMeshRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers & { liveStore?: StateStore },
): void {
  const { json, readBody } = helpers;

  // ─── List meshes ────────────────────────────────────────────────────
  router.get('/api/admin/kaggle-meshes', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const store = await resolveStore(helpers);
    const meshes = await gatherMeshes(store, db);
    json(res, 200, { 'kaggle-meshes': meshes });
  }, { auth: true });

  router.get('/api/admin/kaggle-meshes/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const store = await resolveStore(helpers);
    const mesh = await store.loadMesh(params['id']!);
    if (!mesh) { json(res, 404, { error: 'Mesh not found' }); return; }
    const agents: LiveAgent[] = await store.listAgents(mesh.id);
    const accounts: Account[] = await store.listAccounts(mesh.id);
    const edges: DelegationEdge[] = await store.listDelegationEdges(mesh.id);
    const bridgesOut = await store.listCrossMeshBridges(mesh.id);
    // Inbound bridges (where this mesh is the target) require a from-mesh id;
    // we cannot enumerate without one, so we surface only outbound here.
    const bridgesIn: CrossMeshBridge[] = [];
    const contracts: AgentContract[] = [];
    const bindings: AccountBinding[] = [];
    for (const a of agents) {
      const c = await store.loadContract(a.contractVersionId);
      if (c) contracts.push(c);
      const b = await store.listAccountBindings(a.id);
      bindings.push(...b);
    }
    json(res, 200, {
      'kaggle-mesh': mesh,
      agents,
      contracts,
      accounts,
      bindings,
      delegationEdges: edges,
      bridges: [...bridgesOut, ...bridgesIn],
    });
  }, { auth: true });

  // ─── List agents (across meshes, optional ?meshId=) ─────────────────
  router.get('/api/admin/kaggle-mesh-agents', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const store = await resolveStore(helpers);
    const url = new URL(req.url ?? '', 'http://x');
    const meshId = url.searchParams.get('meshId');
    let baseMeshes: Mesh[];
    if (meshId) {
      const m = await store.loadMesh(meshId);
      baseMeshes = m ? [m] : [];
    } else {
      baseMeshes = await gatherMeshes(store, db);
    }
    const agents: LiveAgent[] = [];
    for (const m of baseMeshes) agents.push(...await store.listAgents(m.id));
    json(res, 200, { 'kaggle-mesh-agents': agents });
  }, { auth: true });

  // ─── List bindings (across agents) ──────────────────────────────────
  router.get('/api/admin/kaggle-mesh-bindings', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const store = await resolveStore(helpers);
    const url = new URL(req.url ?? '', 'http://x');
    const meshId = url.searchParams.get('meshId');
    let baseMeshes: Mesh[];
    if (meshId) {
      const m = await store.loadMesh(meshId);
      baseMeshes = m ? [m] : [];
    } else {
      baseMeshes = await gatherMeshes(store, db);
    }
    const bindings: AccountBinding[] = [];
    for (const m of baseMeshes) {
      const agents = await store.listAgents(m.id);
      for (const a of agents) {
        bindings.push(...await store.listAccountBindings(a.id));
      }
    }
    json(res, 200, { 'kaggle-mesh-bindings': bindings });
  }, { auth: true });

  // ─── List bridges ───────────────────────────────────────────────────
  router.get('/api/admin/kaggle-mesh-bridges', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const store = await resolveStore(helpers);
    const url = new URL(req.url ?? '', 'http://x');
    const meshId = url.searchParams.get('meshId');
    let baseMeshes: Mesh[];
    if (meshId) {
      const m = await store.loadMesh(meshId);
      baseMeshes = m ? [m] : [];
    } else {
      baseMeshes = await gatherMeshes(store, db);
    }
    const bridges: CrossMeshBridge[] = [];
    for (const m of baseMeshes) {
      bridges.push(...await store.listCrossMeshBridges(m.id, undefined));
    }
    json(res, 200, { 'kaggle-mesh-bridges': bridges });
  }, { auth: true });

  // ─── Provision a fresh mesh (idempotent on Idempotency-Key header) ──
  router.post('/api/admin/kaggle-mesh-provision', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const idemKey = (req.headers['idempotency-key'] as string | undefined)?.trim();
    if (idemKey) {
      const cached = provisionIdempotency.check(`kaggle-mesh:${idemKey}`);
      if (cached.isDuplicate) { json(res, 200, cached.previousResult); return; }
    }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const tenantId = (body['tenantId'] as string | null) ?? '';
    const kaggleUsername = (body['kaggleUsername'] as string | null) ?? '';
    const mcpUrl = (body['mcpUrl'] as string | null) ?? '';
    const humanOwnerId = (body['humanOwnerId'] as string | null) ?? '';
    if (!tenantId || !kaggleUsername || !mcpUrl || !humanOwnerId) {
      json(res, 400, { error: 'tenantId, kaggleUsername, mcpUrl, humanOwnerId required' });
      return;
    }
    const store = await resolveStore(helpers);
    const result = await bootKaggleMesh({
      store,
      tenantId,
      kaggleUsername,
      mcpUrl,
      humanOwnerId,
      ...(typeof body['userMeshId'] === 'string' ? { userMeshId: body['userMeshId'] as string } : {}),
      ...(typeof body['credentialVaultRef'] === 'string' ? { credentialVaultRef: body['credentialVaultRef'] as string } : {}),
      ...(typeof body['meshId'] === 'string' ? { meshId: body['meshId'] as string } : {}),
    });
    // Record in geneweave's pointer index so admin GETs can enumerate.
    await db.upsertKaggleLiveMesh({
      mesh_id: result.template.mesh.id,
      tenant_id: tenantId,
      kaggle_username: kaggleUsername,
    });
    const summary = {
      meshId: result.template.mesh.id,
      agentIds: Object.values(result.template.agents).map((a) => a.id),
      bindingIds: Object.values(result.bindings).map((b) => b.id),
      accountId: result.account.id,
      bridgeId: result.bridge?.id ?? null,
      delegationEdgeCount: result.delegationEdges.length,
    };
    if (idemKey) {
      provisionIdempotency.record(`kaggle-mesh:${idemKey}`, summary);
    }
    json(res, 201, summary);
  }, { auth: true, csrf: true });

  // ─── Revoke a single binding ────────────────────────────────────────
  router.post('/api/admin/kaggle-mesh-bindings/:id/revoke', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown> = {};
    if (raw) { try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; } }
    const reason = (body['reason'] as string | null) ?? 'Operator revocation';
    const humanId = (body['revokedByHumanId'] as string | null) ?? `human:${auth.userId ?? 'admin'}`;
    const store = await resolveStore(helpers);
    const updated = await revokeKaggleBinding(store, params['id']!, humanId, reason);
    if (!updated) { json(res, 404, { error: 'Binding not found' }); return; }
    json(res, 200, { 'kaggle-mesh-binding': updated });
  }, { auth: true, csrf: true });
}
