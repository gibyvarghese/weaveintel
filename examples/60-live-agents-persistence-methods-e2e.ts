/**
 * Example 60 — Live-Agents Persistence Backends End-to-End
 *
 * This example demonstrates practical end-to-end scenarios for the persistence
 * backends introduced across Phase 1 and Phase 2:
 *
 * 1) In-memory backend (baseline local flow)
 * 2) Postgres backend (restart durability)
 * 3) Redis backend in coordination-only mode (distributed claim coordination)
 * 4) Redis backend in durable-explicit mode (restart durability)
 * 5) SQLite backend (single-node local durable mode)
 * 6) MongoDB backend (document-store durable mode)
 *
 * Environment variables:
 * - LIVE_AGENTS_EXAMPLE_POSTGRES_URL=postgres://...
 * - LIVE_AGENTS_EXAMPLE_REDIS_URL=redis://...
 * - LIVE_AGENTS_EXAMPLE_SQLITE_PATH=/absolute/path/to/file.db (optional)
 * - LIVE_AGENTS_EXAMPLE_MONGODB_URL=mongodb://...
 * - LIVE_AGENTS_EXAMPLE_MONGODB_DATABASE=live_agents_example (optional)
 */

import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  weaveInMemoryStateStore,
  weaveMongoDbStateStore,
  weavePostgresStateStore,
  weaveRedisStateStore,
  weaveSqliteStateStore,
  type HeartbeatTick,
  type LiveAgent,
  type Mesh,
  type StateStore,
} from '@weaveintel/live-agents';

const POSTGRES_URL = process.env['LIVE_AGENTS_EXAMPLE_POSTGRES_URL'];
const REDIS_URL = process.env['LIVE_AGENTS_EXAMPLE_REDIS_URL'];
const SQLITE_PATH = process.env['LIVE_AGENTS_EXAMPLE_SQLITE_PATH'];
const MONGODB_URL = process.env['LIVE_AGENTS_EXAMPLE_MONGODB_URL'];
const MONGODB_DATABASE = process.env['LIVE_AGENTS_EXAMPLE_MONGODB_DATABASE'] ?? 'live_agents_example';

interface ScenarioFixture {
  mesh: Mesh;
  agent: LiveAgent;
  tick: HeartbeatTick;
}

function createFixture(prefix: string): ScenarioFixture {
  const now = new Date().toISOString();

  return {
    mesh: {
      id: `${prefix}:mesh`,
      tenantId: `${prefix}:tenant`,
      name: 'Persistence Scenario Mesh',
      charter: 'Validate backend behavior end-to-end',
      status: 'ACTIVE',
      dualControlRequiredFor: [],
      createdAt: now,
    },
    agent: {
      id: `${prefix}:agent`,
      meshId: `${prefix}:mesh`,
      name: 'Scenario Agent',
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
      workerId: 'worker:seed',
      leaseExpiresAt: null,
      actionChosen: null,
      actionOutcomeProse: null,
      actionOutcomeStatus: null,
      status: 'SCHEDULED',
    },
  };
}

async function initIfNeeded(store: StateStore): Promise<void> {
  const initialize = (store as { initialize?: () => Promise<void> }).initialize;
  if (initialize) {
    await initialize.call(store);
  }
}

async function closeIfNeeded(store: StateStore): Promise<void> {
  const close = (store as { close?: () => Promise<void> }).close;
  if (close) {
    await close.call(store);
  }
}

async function seedAndClaim(store: StateStore, fixture: ScenarioFixture): Promise<void> {
  await store.saveMesh(fixture.mesh);
  await store.saveAgent(fixture.agent);
  await store.saveHeartbeatTick(fixture.tick);

  const claimed = await store.claimNextTicks('worker:example', new Date().toISOString(), 1, 30_000);
  if (claimed.length !== 1) {
    throw new Error(`Expected exactly one claimed tick, received ${claimed.length}`);
  }
}

async function runInMemoryScenario(): Promise<void> {
  console.log('\n[1/6] In-memory scenario');
  const fixture = createFixture(`example:memory:${Date.now()}`);
  const store = weaveInMemoryStateStore();

  await seedAndClaim(store, fixture);
  const loadedAgent = await store.loadAgent(fixture.agent.id);

  if (!loadedAgent) {
    throw new Error('In-memory scenario failed to load seeded agent');
  }

  console.log('  ✓ in-memory flow completed');
}

async function runPostgresScenario(): Promise<void> {
  console.log('\n[2/6] Postgres restart-durability scenario');
  if (!POSTGRES_URL) {
    console.log('  - skipped (LIVE_AGENTS_EXAMPLE_POSTGRES_URL not set)');
    return;
  }

  const fixture = createFixture(`example:postgres:${Date.now()}`);

  const first = await weavePostgresStateStore({ url: POSTGRES_URL });
  await seedAndClaim(first, fixture);
  await closeIfNeeded(first);

  const second = await weavePostgresStateStore({ url: POSTGRES_URL });
  const persistedMesh = await second.loadMesh(fixture.mesh.id);
  const persistedTick = await second.loadHeartbeatTick(fixture.tick.id);
  await closeIfNeeded(second);

  if (!persistedMesh || !persistedTick) {
    throw new Error('Postgres durability scenario failed after restart');
  }

  console.log('  ✓ postgres durability verified');
}

async function runRedisCoordinationScenario(): Promise<void> {
  console.log('\n[3/6] Redis coordination-only scenario');
  if (!REDIS_URL) {
    console.log('  - skipped (LIVE_AGENTS_EXAMPLE_REDIS_URL not set)');
    return;
  }

  const prefix = `example:redis:coord:${Date.now()}`;
  const fixture = createFixture(prefix);

  const workerA = weaveRedisStateStore({
    url: REDIS_URL,
    mode: 'coordination-only',
    keyPrefix: prefix,
  });
  const workerB = weaveRedisStateStore({
    url: REDIS_URL,
    mode: 'coordination-only',
    keyPrefix: prefix,
  });

  await initIfNeeded(workerA);
  await initIfNeeded(workerB);

  await workerA.saveHeartbeatTick(fixture.tick);

  const now = new Date().toISOString();
  const [a, b] = await Promise.all([
    workerA.claimNextTicks('worker:a', now, 1, 30_000),
    workerB.claimNextTicks('worker:b', now, 1, 30_000),
  ]);

  await closeIfNeeded(workerA);
  await closeIfNeeded(workerB);

  if (a.length + b.length !== 1) {
    throw new Error('Redis coordination-only scenario allowed duplicate claim');
  }

  console.log('  ✓ redis coordination-only claim guard verified');
}

async function runRedisDurableScenario(): Promise<void> {
  console.log('\n[4/6] Redis durable-explicit restart scenario');
  if (!REDIS_URL) {
    console.log('  - skipped (LIVE_AGENTS_EXAMPLE_REDIS_URL not set)');
    return;
  }

  const prefix = `example:redis:durable:${Date.now()}`;
  const fixture = createFixture(prefix);

  const first = weaveRedisStateStore({
    url: REDIS_URL,
    mode: 'durable-explicit',
    keyPrefix: prefix,
  });
  await initIfNeeded(first);
  await first.saveMesh(fixture.mesh);
  await first.saveAgent(fixture.agent);
  await first.saveHeartbeatTick(fixture.tick);
  await closeIfNeeded(first);

  const second = weaveRedisStateStore({
    url: REDIS_URL,
    mode: 'durable-explicit',
    keyPrefix: prefix,
  });
  await initIfNeeded(second);
  const mesh = await second.loadMesh(fixture.mesh.id);
  const agent = await second.loadAgent(fixture.agent.id);
  await closeIfNeeded(second);

  if (!mesh || !agent) {
    throw new Error('Redis durable-explicit scenario failed after restart');
  }

  console.log('  ✓ redis durable-explicit restart verified');
}

async function runSqliteScenario(): Promise<void> {
  console.log('\n[5/6] SQLite local durable scenario');

  const sqlitePath = SQLITE_PATH ?? join(tmpdir(), `weave-live-agents-${Date.now()}.db`);
  const fixture = createFixture(`example:sqlite:${Date.now()}`);

  rmSync(sqlitePath, { force: true });

  const first = await weaveSqliteStateStore({ path: sqlitePath });
  await seedAndClaim(first, fixture);
  await closeIfNeeded(first);

  const second = await weaveSqliteStateStore({ path: sqlitePath });
  const mesh = await second.loadMesh(fixture.mesh.id);
  const tick = await second.loadHeartbeatTick(fixture.tick.id);
  await closeIfNeeded(second);

  rmSync(sqlitePath, { force: true });

  if (!mesh || !tick) {
    throw new Error('SQLite local durability scenario failed after restart');
  }

  console.log('  ✓ sqlite local durability verified');
}

async function runMongoDbScenario(): Promise<void> {
  console.log('\n[6/6] MongoDB durable scenario');
  if (!MONGODB_URL) {
    console.log('  - skipped (LIVE_AGENTS_EXAMPLE_MONGODB_URL not set)');
    return;
  }

  const fixture = createFixture(`example:mongodb:${Date.now()}`);

  const first = await weaveMongoDbStateStore({
    url: MONGODB_URL,
    databaseName: MONGODB_DATABASE,
    collectionName: 'la_entities',
  });
  await seedAndClaim(first, fixture);
  await closeIfNeeded(first);

  const second = await weaveMongoDbStateStore({
    url: MONGODB_URL,
    databaseName: MONGODB_DATABASE,
    collectionName: 'la_entities',
  });
  const mesh = await second.loadMesh(fixture.mesh.id);
  const tick = await second.loadHeartbeatTick(fixture.tick.id);
  await closeIfNeeded(second);

  if (!mesh || !tick) {
    throw new Error('MongoDB durability scenario failed after restart');
  }

  console.log('  ✓ mongodb durability verified');
}

async function main(): Promise<void> {
  console.log('Live-agents persistence backend E2E scenarios');

  await runInMemoryScenario();
  await runPostgresScenario();
  await runRedisCoordinationScenario();
  await runRedisDurableScenario();
  await runSqliteScenario();
  await runMongoDbScenario();

  console.log('\nAll requested persistence scenarios completed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
