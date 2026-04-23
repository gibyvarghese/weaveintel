import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  weaveSqliteStateStore,
  type HeartbeatTick,
  type LiveAgent,
  type Mesh,
} from './index.js';

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
      name: 'SQLite Phase3 Mesh',
      charter: 'Validate sqlite restart durability',
      status: 'ACTIVE',
      dualControlRequiredFor: [],
      createdAt: now,
    },
    agent: {
      id: `${prefix}:agent`,
      meshId: `${prefix}:mesh`,
      name: 'SQLite Agent',
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
      workerId: 'worker:sqlite',
      leaseExpiresAt: null,
      actionChosen: null,
      actionOutcomeProse: null,
      actionOutcomeStatus: null,
      status: 'SCHEDULED',
    },
  };
}

describe('sqlite state store (phase 3)', () => {
  it('survives restart with file-backed durable state', async () => {
    const dbPath = join(tmpdir(), `weave-live-agents-sqlite-${Date.now()}.db`);
    const fixture = createFixture(`weave:test:sqlite:${Date.now()}`);

    rmSync(dbPath, { force: true });

    const first = await weaveSqliteStateStore({ path: dbPath });
    await first.saveMesh(fixture.mesh);
    await first.saveAgent(fixture.agent);
    await first.saveHeartbeatTick(fixture.tick);
    await first.transitionAgentStatus(fixture.agent.id, 'PAUSED', new Date().toISOString());
    await first.close();

    const second = await weaveSqliteStateStore({ path: dbPath });
    const mesh = await second.loadMesh(fixture.mesh.id);
    const agent = await second.loadAgent(fixture.agent.id);
    const tick = await second.loadHeartbeatTick(fixture.tick.id);
    await second.close();

    rmSync(dbPath, { force: true });

    expect(mesh?.id).toBe(fixture.mesh.id);
    expect(agent?.status).toBe('PAUSED');
    expect(tick?.status).toBe('SCHEDULED');
  });
});