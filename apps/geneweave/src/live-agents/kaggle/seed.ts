/**
 * Phase K5 — Demo Kaggle live-agents mesh seed.
 *
 * On first boot (when the geneweave pointer index is empty), provisions a
 * single demo mesh into the live-agents StateStore so operators have data
 * to browse in the admin UI. Skipped on subsequent boots.
 *
 * Production deployments set KAGGLE_DEMO_SEED=false to disable.
 */

import type { DatabaseAdapter } from '../../db-types.js';
import { bootKaggleMesh } from './boot.js';
import { getKaggleLiveStore } from './store.js';

const DEMO_TENANT = 'demo-tenant';
const DEMO_USER = 'demo-user';
const DEMO_HUMAN = 'human:demo-owner';
const DEMO_USER_MESH = 'mesh-user-demo';
const DEMO_MCP_URL = 'http://localhost:8788/mcp';

export async function seedKaggleDemoMesh(db: DatabaseAdapter): Promise<void> {
  if (process.env['KAGGLE_DEMO_SEED'] === 'false') return;

  const existing = await db.listKaggleLiveMeshes();
  if (existing.length > 0) return;

  try {
    const store = await getKaggleLiveStore();
    const result = await bootKaggleMesh({
      store,
      tenantId: DEMO_TENANT,
      kaggleUsername: DEMO_USER,
      humanOwnerId: DEMO_HUMAN,
      mcpUrl: DEMO_MCP_URL,
      userMeshId: DEMO_USER_MESH,
      credentialVaultRef: 'env:KAGGLE_KEY',
    });
    await db.upsertKaggleLiveMesh({
      mesh_id: result.template.mesh.id,
      tenant_id: DEMO_TENANT,
      kaggle_username: DEMO_USER,
    });
    // eslint-disable-next-line no-console
    console.log(`[kaggle-seed] provisioned demo mesh ${result.template.mesh.id}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[kaggle-seed] demo mesh seed skipped:', (err as Error).message);
  }
}
