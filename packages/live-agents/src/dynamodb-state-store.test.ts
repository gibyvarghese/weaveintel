import { describe, expect, it } from 'vitest';
import {
  weaveCloudNoSqlStateStore,
  type HeartbeatTick,
  type LiveAgent,
  type Mesh,
} from './index.js';

const DYNAMODB_ENDPOINT = process.env['LIVE_AGENTS_TEST_DYNAMODB_ENDPOINT'];
const DYNAMODB_REGION = process.env['LIVE_AGENTS_TEST_DYNAMODB_REGION'] ?? 'us-east-1';
const DYNAMODB_TABLE = process.env['LIVE_AGENTS_TEST_DYNAMODB_TABLE'] ?? 'la_entities';

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
      name: 'DynamoDB Phase5 Mesh',
      charter: 'Validate dynamodb local durability',
      status: 'ACTIVE',
      dualControlRequiredFor: [],
      createdAt: now,
    },
    agent: {
      id: `${prefix}:agent`,
      meshId: `${prefix}:mesh`,
      name: 'Dynamo Agent',
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
      workerId: 'worker:dynamo',
      leaseExpiresAt: null,
      actionChosen: null,
      actionOutcomeProse: null,
      actionOutcomeStatus: null,
      status: 'SCHEDULED',
    },
  };
}

describe.runIf(Boolean(DYNAMODB_ENDPOINT))('dynamodb state store (phase 5)', () => {
  it('survives restart with cloud-nosql snapshot persistence', async () => {
    const prefix = `weave:test:dynamodb:${Date.now()}`;
    const fixture = createFixture(prefix);

    const first = await weaveCloudNoSqlStateStore({
      provider: 'dynamodb',
      dynamodb: {
        endpoint: DYNAMODB_ENDPOINT,
        region: DYNAMODB_REGION,
        tableName: DYNAMODB_TABLE,
      },
    });
    await first.saveMesh(fixture.mesh);
    await first.saveAgent(fixture.agent);
    await first.saveHeartbeatTick(fixture.tick);
    await first.transitionAgentStatus(fixture.agent.id, 'PAUSED', new Date().toISOString());
    await first.close();

    const second = await weaveCloudNoSqlStateStore({
      provider: 'dynamodb',
      dynamodb: {
        endpoint: DYNAMODB_ENDPOINT,
        region: DYNAMODB_REGION,
        tableName: DYNAMODB_TABLE,
      },
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