/**
 * Example 79 — Kaggle Live-Agents Mesh end-to-end (Phase K5)
 *
 * Provisions a complete Kaggle research mesh into an in-memory StateStore
 * and walks through the full lifecycle:
 *
 *   1. bootKaggleMesh() — mesh + 6 role agents + contracts + delegation
 *      pipeline + Kaggle credentials account + 6 capability-scoped bindings
 *      + optional cross-mesh bridge to a user mesh
 *   2. Inspect what was provisioned (agents, bindings, edges, bridge)
 *   3. Verify dual-control list contains submit + kernel.push
 *   4. Verify capability matrix per role (e.g. only submitter can submit)
 *   5. Revoke one binding (validator) and confirm immediate effect
 *
 * No model calls, no real Kaggle API calls — this example demonstrates the
 * provisioning + governance contract that operators control via
 * /api/admin/kaggle-mesh-* admin routes in GeneWeave.
 */

import { weaveInMemoryStateStore } from '@weaveintel/live-agents';
import {
  bootKaggleMesh,
  revokeKaggleBinding,
  KAGGLE_CAPABILITY_MATRIX,
  KAGGLE_BRIDGE_TOPICS,
  type KaggleAgentRole,
} from '../apps/geneweave/src/live-agents/kaggle/index.js';

async function main(): Promise<void> {
  const store = weaveInMemoryStateStore();
  const tenantId = 'demo-tenant';
  const humanOwnerId = 'human:demo-owner';

  console.log('━━━ Phase K5: Kaggle Live-Agents Mesh ━━━\n');

  // ─── 1. Boot the mesh ─────────────────────────────────────────────
  const result = await bootKaggleMesh({
    store,
    tenantId,
    kaggleUsername: 'demo-user',
    mcpUrl: 'http://localhost:8788/mcp',
    humanOwnerId,
    userMeshId: 'mesh-user-demo',
    credentialVaultRef: 'env:KAGGLE_KEY',
  });

  const mesh = result.template.mesh;
  console.log(`✓ Mesh provisioned: ${mesh.id}`);
  console.log(`  • status: ${mesh.status}`);
  console.log(`  • dualControlRequiredFor: ${JSON.stringify(mesh.dualControlRequiredFor)}\n`);

  // ─── 2. Inspect agents + contracts ────────────────────────────────
  const agents = await store.listAgents(mesh.id);
  console.log(`✓ ${agents.length} role-bound agents:`);
  for (const a of agents) {
    console.log(`  • ${a.id}  (contract: ${a.contractVersionId})`);
  }
  console.log();

  // ─── 3. Inspect delegation pipeline ───────────────────────────────
  const edges = await store.listDelegationEdges(mesh.id);
  console.log(`✓ ${edges.length} delegation edges (pipeline topology):`);
  for (const e of edges) {
    console.log(`  • ${e.fromAgentId} ──${e.relationship}──▶ ${e.toAgentId}`);
  }
  console.log();

  // ─── 4. Inspect single Kaggle account + per-role bindings ─────────
  const accounts = await store.listAccounts(mesh.id);
  console.log(`✓ ${accounts.length} Kaggle account(s):`);
  for (const acc of accounts) {
    console.log(`  • ${acc.id} → ${acc.accountIdentifier}@${acc.provider} (vault: ${acc.credentialVaultRef})`);
  }
  console.log();

  console.log('✓ Capability matrix (which role can call which Kaggle tool):');
  const roles = Object.keys(KAGGLE_CAPABILITY_MATRIX) as KaggleAgentRole[];
  for (const role of roles) {
    const caps = KAGGLE_CAPABILITY_MATRIX[role];
    console.log(`  • ${role.padEnd(12)} → ${caps.length === 0 ? '(no Kaggle tools)' : caps.join(', ')}`);
  }
  console.log();

  // ─── 5. Inspect cross-mesh bridge ─────────────────────────────────
  if (result.bridge) {
    console.log(`✓ Cross-mesh bridge: ${result.bridge.fromMeshId} → ${result.bridge.toMeshId}`);
    console.log(`  • allowedTopics: ${JSON.stringify(result.bridge.allowedTopics)}`);
    console.log(`  • rateLimitPerHour: ${result.bridge.rateLimitPerHour}`);
    console.log(`  • topics constant matches: ${JSON.stringify(KAGGLE_BRIDGE_TOPICS) === JSON.stringify(result.bridge.allowedTopics)}\n`);
  }

  // ─── 6. Revoke validator binding (immediate effect) ───────────────
  const validatorBinding = result.bindings.validator;
  console.log(`✓ Revoking binding for validator (${validatorBinding.id})...`);
  const revoked = await revokeKaggleBinding(
    store,
    validatorBinding.id,
    humanOwnerId,
    'Demo: rotating credentials',
  );
  if (revoked && revoked.revokedAt) {
    console.log(`  • revokedAt: ${revoked.revokedAt}`);
    console.log(`  • revocationReason: ${revoked.revocationReason}`);
    console.log(`  • next tick will see revoked binding → validator stops working.\n`);
  }

  console.log('━━━ Done. ━━━');
  console.log('In production: operators manage all of this via the GeneWeave admin');
  console.log('UI under Kaggle → Live Meshes / Live Agents / Account Bindings /');
  console.log('Cross-Mesh Bridges. Provision via POST /api/admin/kaggle-mesh-provision.');
}

main().catch((err) => {
  console.error('Example 79 failed:', err);
  process.exit(1);
});
