import { describe, expect, it } from 'vitest';
import {
  weaveMongoDbStateStore,
  type HeartbeatTick,
  type LiveAgent,
  type Mesh,
} from './index.js';

const MONGODB_URL = process.env['LIVE_AGENTS_TEST_MONGODB_URL'];
const MONGODB_DATABASE = process.env['LIVE_AGENTS_TEST_MONGODB_DATABASE'] ?? 'live_agents_test';

function createFixture(prefix: string): {
  mesh: Mesh;
  agent: LiveAgent;
  tick: HeartbeatTick;
} {
  const now = new Date().toISOString();
  return {
    mesh: {
      id: `${prefix}:mesh`,
      tenantId: `${prefix}:tenant`,
      name: 'MongoDB Phase4 Mesh',
      charter: 'Validate mongodb restart durability',
      status: 'ACTIVE',
      dualControlRequiredFor: [],
      createdAt: now,
    },
    agent: {
      id: `${prefix}:agent`,
      meshId: `${prefix}:mesh`,
      name: 'Mongo Agent',
      role: 'validator',
      contractVersionId: `${prefix}:contract-v1`,
      status: 'ACTIVE',
      createdAt: now,
      archivedAt: null,
    },
    tick: {
      id: `${prefix}:tick`,
      agentId: `${prefix}:agent`,
      scheduledFor: now,
      pickedUpAt: null,
      completedAt: null,
      workerId: 'worker:mongodb',
      leaseExpiresAt: null,
      actionChosen: null,
      actionOutcomeProse: null,
      actionOutcomeStatus: null,
      status: 'SCHEDULED',
    },
  };
}

describe.runIf(Boolean(MONGODB_URL))('mongodb state store (phase 4)', () => {
  it('survives restart with document-backed durable state', async () => {
    const prefix = `weave:test:mongodb:${Date.now()}`;
    const fixture = createFixture(prefix);

    const first = await weaveMongoDbStateStore({
      url: MONGODB_URL!,
      databaseName: MONGODB_DATABASE,
      collectionName: 'la_entities',
    });
    await first.saveMesh(fixture.mesh);
    await first.saveAgent(fixture.agent);
    await first.saveHeartbeatTick(fixture.tick);
    await first.transitionAgentStatus(fixture.agent.id, 'PAUSED', new Date().toISOString());
    await first.close();

    const second = await weaveMongoDbStateStore({
      url: MONGODB_URL!,
      databaseName: MONGODB_DATABASE,
      collectionName: 'la_entities',
    });
    const mesh = await second.loadMesh(fixture.mesh.id);
    const agent = await second.loadAgent(fixture.agent.id);
    const tick = await second.loadHeartbeatTick(fixture.tick.id);
    await second.close();

    expect(mesh?.id).toBe(fixture.mesh.id);
    expect(agent?.status).toBe('PAUSED');
    expect(tick?.status).toBe('SCHEDULED');
  });
});