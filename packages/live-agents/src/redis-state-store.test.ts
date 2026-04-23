import { describe, expect, it } from 'vitest';
import {
  weaveRedisStateStore,
  type HeartbeatTick,
  type LiveAgent,
  type Mesh,
} from './index.js';

const REDIS_URL = process.env['LIVE_AGENTS_TEST_REDIS_URL'];

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
      name: 'Redis Phase2 Mesh',
      charter: 'Validate redis persistence behavior',
      status: 'ACTIVE',
      dualControlRequiredFor: [],
      createdAt: now,
    },
    agent: {
      id: `${prefix}:agent`,
      meshId: `${prefix}:mesh`,
      name: 'Redis Agent',
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
      workerId: 'worker:a',
      leaseExpiresAt: null,
      actionChosen: null,
      actionOutcomeProse: null,
      actionOutcomeStatus: null,
      status: 'SCHEDULED',
    },
  };
}

describe.runIf(Boolean(REDIS_URL))('redis state store (phase 2)', () => {
  it('durable-explicit mode survives restart', async () => {
    const prefix = `weave:test:redis:durable:${Date.now()}`;
    const fixture = createFixture(prefix);

    const storeA = weaveRedisStateStore({
      url: REDIS_URL!,
      mode: 'durable-explicit',
      keyPrefix: prefix,
    });
    await storeA.initialize();
    await storeA.saveMesh(fixture.mesh);
    await storeA.saveAgent(fixture.agent);
    await storeA.saveHeartbeatTick(fixture.tick);
    await storeA.transitionAgentStatus(fixture.agent.id, 'PAUSED', new Date().toISOString());
    await storeA.close();

    const storeB = weaveRedisStateStore({
      url: REDIS_URL!,
      mode: 'durable-explicit',
      keyPrefix: prefix,
    });
    await storeB.initialize();

    const loadedMesh = await storeB.loadMesh(fixture.mesh.id);
    const loadedAgent = await storeB.loadAgent(fixture.agent.id);
    const loadedTick = await storeB.loadHeartbeatTick(fixture.tick.id);

    await storeB.close();

    expect(loadedMesh?.id).toBe(fixture.mesh.id);
    expect(loadedAgent?.status).toBe('PAUSED');
    expect(loadedTick?.status).toBe('SCHEDULED');
  });

  it('coordination-only mode prevents double claim across workers', async () => {
    const prefix = `weave:test:redis:coord:${Date.now()}`;
    const fixture = createFixture(prefix);

    const storeA = weaveRedisStateStore({
      url: REDIS_URL!,
      mode: 'coordination-only',
      keyPrefix: prefix,
    });
    const storeB = weaveRedisStateStore({
      url: REDIS_URL!,
      mode: 'coordination-only',
      keyPrefix: prefix,
    });

    await storeA.initialize();
    await storeB.initialize();

    await storeA.saveHeartbeatTick(fixture.tick);

    const now = new Date().toISOString();
    const [claimedA, claimedB] = await Promise.all([
      storeA.claimNextTicks('worker:a', now, 1, 30_000),
      storeB.claimNextTicks('worker:b', now, 1, 30_000),
    ]);

    await storeA.close();
    await storeB.close();

    expect(claimedA.length + claimedB.length).toBe(1);
  });
});
