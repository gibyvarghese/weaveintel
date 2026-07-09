// SPDX-License-Identifier: MIT
/**
 * The ONE Drizzle state store, proven on a REAL Postgres (Testcontainers — no mocks). Skipped when
 * Docker isn't available. The Postgres adapter was previously never run against a database in this
 * package; here it's exercised for real, including the crucial property: state written by one process
 * survives and is rehydrated by another.
 *
 *   1. Durability — save entities, then a FRESH store on the same database rehydrates them exactly.
 *   2. claimNextTicks — the array-returning mutation persists every claimed tick.
 *   3. Stress — a mesh with 1,000 agents rehydrates completely.
 *   4. Security — hostile content is stored as data.
 *   5. REAL LLM — a model charters a mesh + names an agent; the roster is durable across a restart.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { weavePostgresStateStore } from './postgres-state-store.js';
import type { HeartbeatTick, LiveAgent, Mesh } from './index.js';

function hasDocker(): boolean {
  try { execSync('docker info', { stdio: 'ignore' }); return true; } catch { return false; }
}
const HAS_DOCKER = hasDocker();

function loadKey(): string | undefined {
  if (process.env['OPENAI_API_KEY']) return process.env['OPENAI_API_KEY'];
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../../../.env', '../../.env', '../.env']) {
    try { const m = readFileSync(join(here, rel), 'utf8').match(/^OPENAI_API_KEY=(.+)$/m); if (m) return m[1]!.trim().replace(/^["']|["']$/g, ''); } catch { /* */ }
  }
  return undefined;
}
const KEY = loadKey();

let seq = 0;
const uid = (p: string) => `${p}-${++seq}`;
const iso = () => new Date().toISOString();
const mkMesh = (id: string): Mesh => ({ id, tenantId: 'acme', name: 'Mesh', charter: 'do things', status: 'ACTIVE', dualControlRequiredFor: [], createdAt: iso() });
const mkAgent = (id: string, meshId: string): LiveAgent => ({ id, meshId, name: 'Agent', role: 'worker', contractVersionId: `${id}-c1`, status: 'ACTIVE', createdAt: iso(), archivedAt: null });
const mkTick = (id: string, agentId: string): HeartbeatTick => ({ id, agentId, scheduledFor: iso(), pickedUpAt: null, completedAt: null, workerId: 'w', leaseExpiresAt: null, actionChosen: null, actionOutcomeProse: null, actionOutcomeStatus: null, status: 'SCHEDULED' });

describe.skipIf(!HAS_DOCKER)('Drizzle state store → real Postgres (Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16').start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
    pool.on('error', () => {}); // swallow idle-client disconnects (e.g. 57P01) at container teardown
    await weavePostgresStateStore({ pool }); // create the schema once
  }, 180_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await container?.stop().catch(() => {});
  });

  it('DURABILITY: entities written by one store are rehydrated by a fresh one', async () => {
    await pool.query('TRUNCATE la_entities');
    const mesh = mkMesh(uid('mesh'));
    const agent = mkAgent(uid('agent'), mesh.id);
    const tick = mkTick(uid('tick'), agent.id);

    const first = await weavePostgresStateStore({ pool });
    await first.saveMesh(mesh);
    await first.saveAgent(agent);
    await first.saveHeartbeatTick(tick);
    await first.transitionAgentStatus(agent.id, 'PAUSED', iso()); // a returning-mutator persists too

    // A brand-new store on the same database rehydrates everything on construction.
    const second = await weavePostgresStateStore({ pool });
    expect((await second.loadMesh(mesh.id))?.id).toBe(mesh.id);
    expect((await second.loadAgent(agent.id))?.status).toBe('PAUSED'); // the transition survived
    expect((await second.loadHeartbeatTick(tick.id))?.id).toBe(tick.id);
  }, 60_000);

  it('claimNextTicks: an array-returning mutation persists every claimed tick', async () => {
    await pool.query('TRUNCATE la_entities');
    const mesh = mkMesh(uid('mesh'));
    const agent = mkAgent(uid('agent'), mesh.id);
    const tick = mkTick(uid('tick'), agent.id);
    const first = await weavePostgresStateStore({ pool });
    await first.saveMesh(mesh);
    await first.saveAgent(agent);
    await first.saveHeartbeatTick(tick);
    const claimed = await first.claimNextTicks('worker-99', iso(), 10);
    expect(claimed.map((c) => c.id)).toContain(tick.id);
    const claimedTick = claimed.find((c) => c.id === tick.id)!;

    const second = await weavePostgresStateStore({ pool });
    expect(await second.loadHeartbeatTick(tick.id)).toEqual(claimedTick); // the claim was durably snapshotted
  }, 60_000);

  it('STRESS: a mesh with 1,000 agents rehydrates completely', async () => {
    await pool.query('TRUNCATE la_entities');
    const mesh = mkMesh(uid('mesh'));
    const first = await weavePostgresStateStore({ pool });
    await first.saveMesh(mesh);
    const t0 = Date.now();
    for (let i = 0; i < 1000; i++) await first.saveAgent(mkAgent(`a-${i}`, mesh.id));

    const second = await weavePostgresStateStore({ pool }); // hydrates all 1,000
    expect((await second.listAgents(mesh.id)).length).toBe(1000);
    expect(Date.now() - t0).toBeLessThan(60_000);
  }, 120_000);

  it('SECURITY: hostile content in an entity is stored as data, not executed', async () => {
    await pool.query('TRUNCATE la_entities');
    const evil = `'; DROP TABLE la_entities; -- "x"`;
    const mesh = mkMesh(uid('mesh'));
    mesh.charter = evil;
    const first = await weavePostgresStateStore({ pool });
    await first.saveMesh(mesh);
    const second = await weavePostgresStateStore({ pool });
    expect((await second.loadMesh(mesh.id))?.charter).toBe(evil);
    // Table still works.
    const m2 = mkMesh(uid('mesh'));
    await second.saveMesh(m2);
    expect((await second.loadMesh(m2.id))?.id).toBe(m2.id);
  }, 60_000);

  it.skipIf(!KEY)('REAL LLM: a model charters a mesh + names an agent; the roster is durable', async () => {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Charter a small AI team for customer support. Reply as strict JSON: {"meshName": string, "charter": string, "agentName": string, "agentRole": string}.' }],
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) throw new Error(`chat HTTP ${res.status}`);
    const plan = JSON.parse(((await res.json()) as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content) as { meshName: string; charter: string; agentName: string; agentRole: string };
    expect(plan.charter.length).toBeGreaterThan(0);

    await pool.query('TRUNCATE la_entities');
    const mesh: Mesh = { ...mkMesh(uid('mesh')), name: plan.meshName, charter: plan.charter };
    const agent: LiveAgent = { ...mkAgent(uid('agent'), mesh.id), name: plan.agentName, role: plan.agentRole };
    const first = await weavePostgresStateStore({ pool });
    await first.saveMesh(mesh);
    await first.saveAgent(agent);

    // Restart: a fresh store rehydrates the AI-designed roster from Postgres.
    const second = await weavePostgresStateStore({ pool });
    const loadedMesh = await second.loadMesh(mesh.id);
    const roster = await second.listAgents(mesh.id);
    expect(loadedMesh?.charter).toBe(plan.charter);
    expect(roster.map((a) => a.name)).toContain(plan.agentName);
  }, 180_000);
});
