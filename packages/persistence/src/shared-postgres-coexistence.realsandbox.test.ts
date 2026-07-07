// SPDX-License-Identifier: MIT
/**
 * THE flagship for Phase 2: your whole runtime on ONE Postgres, over ONE connection.
 *
 * Using a throwaway Postgres+pgvector container (no mocks, no external DB), this test wires the FOUR
 * real store packages — memory, workflows, live-agents, triggers — plus the runtime's own key/value
 * slots onto a single shared pool built by `weaveSharedPostgres`, and runs the coexistence contract:
 *   • every store does a real write→read on the shared connection;
 *   • every store's tables actually appear on the one database, with NO two stores sharing a table;
 *   • after all of them have written, each still reads back correctly (no cross-contamination);
 *   • a runtime KV slot passes the full persistence contract on the same Postgres.
 *
 * A final leg (skipped without an OpenAI key) proves the "unified data layer" payoff: real embeddings
 * drive a semantic memory search in the SAME Postgres that holds the workflow/trigger/agent state.
 *
 * Skipped automatically when Docker isn't available.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { weaveContext, type WorkflowState } from '@weaveintel/core';
import { weavePgVectorMemoryStore } from '@weaveintel/memory';
import { weavePostgresCheckpointStore } from '@weaveintel/workflows';
import { weavePostgresStateStore, type HeartbeatTick } from '@weaveintel/live-agents';
import { weavePostgresTriggerStore, type Trigger } from '@weaveintel/triggers';
import { createPostgresNoteRepository } from '@weaveintel/notes';
import { createPostgresNotificationFeedStore } from '@weaveintel/notifications';
import { createPostgresHumanTaskRepository } from '@weaveintel/human-tasks';
import { weaveSharedPostgres, type SqlClient } from './shared-postgres.js';
import { runSharedPostgresCoexistence, coexistenceReport, type StoreProbe } from './shared-postgres-coexistence.js';

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

// pg.Pool satisfies SqlClient; wrap to keep the types tidy (matches the rest of this package).
const asSqlClient = (pool: pg.Pool): SqlClient => ({ query: (text, params) => pool.query(text, params as unknown[]) });

describe.skipIf(!HAS_DOCKER)('weaveSharedPostgres — the whole runtime on ONE Postgres (real, Testcontainers)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;
  let hub: ReturnType<typeof weaveSharedPostgres>;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
    // The ONE shared connection. The domain stores get the same underlying pool.
    hub = weaveSharedPostgres({ client: asSqlClient(pool) });
  }, 180_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await container?.stop().catch(() => {});
  });

  it('hub basics on real Postgres: slots isolate into their own tables, health is ok', async () => {
    const a = hub.slot('alpha');
    const b = hub.slot('beta');
    await a.kv.set('k', 'A');
    await b.kv.set('k', 'B');
    expect(await a.kv.get('k')).toBe('A');
    expect(await b.kv.get('k')).toBe('B'); // same key, different slot → different table, no clash

    // The slot tables really exist on the one database.
    const { rows } = await pool.query(
      `SELECT tablename FROM pg_catalog.pg_tables WHERE tablename = ANY($1)`,
      [['weave_kv_alpha', 'weave_kv_beta']],
    );
    expect(rows.map((r) => r.tablename).sort()).toEqual(['weave_kv_alpha', 'weave_kv_beta']);

    const health = await hub.health();
    expect(health.ok).toBe(true);
  }, 60_000);

  it('FLAGSHIP: all seven stores (memory, workflows, live-agents, triggers, notes, notifications, human-tasks) + KV coexist on the one pool', async () => {
    // Build the seven REAL domain stores — all pointed at the SAME shared pool.
    const checkpoints = await weavePostgresCheckpointStore({ pool });
    const triggers = await weavePostgresTriggerStore({ pool });
    const agents = await weavePostgresStateStore({ pool }); // auto-initialises (creates la_entities)
    const memory = weavePgVectorMemoryStore({ pool, dimensions: 8, tableName: 'memory_vec', indexType: 'none' });
    const notes = createPostgresNoteRepository({ pool });            // Phase 3
    const feed = createPostgresNotificationFeedStore({ pool });      // Phase 3
    const humanTasks = createPostgresHumanTaskRepository({ pool });  // Phase 3

    const ctx = weaveContext({ tenantId: 'acme', userId: 'u-1', metadata: { sessionId: 's-1' } });

    const probes: StoreProbe[] = [
      {
        name: 'workflows.checkpoints',
        expectedTables: ['wf_checkpoints'],
        roundTrip: async () => {
          const state: WorkflowState = { currentStepId: 'step-1', variables: { attempt: 1 }, history: [] };
          const saved = await checkpoints.save('run-coexist', 'step-1', state, 'wf-coexist');
          const loaded = await checkpoints.load(saved.id);
          if (loaded?.stepId !== 'step-1') throw new Error(`checkpoint reload mismatch: ${JSON.stringify(loaded)}`);
        },
      },
      {
        name: 'triggers',
        expectedTables: ['triggers', 'trigger_invocations'],
        roundTrip: async () => {
          const trigger: Trigger = {
            id: 'trg-coexist',
            key: 'demo-trigger',
            enabled: true,
            source: { kind: 'manual', config: {} },
            target: { kind: 'workflow', config: { workflowId: 'wf-coexist' } },
          } as Trigger;
          await triggers.save(trigger);
          const got = await triggers.get('trg-coexist');
          if (got?.key !== 'demo-trigger') throw new Error(`trigger reload mismatch: ${JSON.stringify(got)}`);
        },
      },
      {
        name: 'live-agents.state',
        expectedTables: ['la_entities'],
        roundTrip: async () => {
          const now = new Date().toISOString();
          const tick: HeartbeatTick = {
            id: 'tick-coexist', agentId: 'agent-1', scheduledFor: now, pickedUpAt: null, completedAt: null,
            workerId: 'worker-1', leaseExpiresAt: null, actionChosen: null, actionOutcomeProse: null,
            actionOutcomeStatus: null, status: 'SCHEDULED',
          };
          await agents.saveHeartbeatTick(tick);
          const got = await agents.loadHeartbeatTick('tick-coexist');
          if (got?.status !== 'SCHEDULED') throw new Error(`heartbeat reload mismatch: ${JSON.stringify(got)}`);
        },
      },
      {
        name: 'memory.pgvector',
        expectedTables: ['memory_vec'],
        roundTrip: async () => {
          const embedding = [1, 0, 0, 0, 0, 0, 0, 0];
          await memory.write(ctx, [{
            id: 'mem-coexist', type: 'semantic', content: 'Acme prefers net-30 invoicing.',
            metadata: {}, embedding, createdAt: new Date().toISOString(),
            tenantId: 'acme', userId: 'u-1', sessionId: 's-1',
          }]);
          const rows = await memory.query(ctx, { type: 'semantic', embedding, topK: 3 });
          if (!rows.some((r) => r.id === 'mem-coexist')) throw new Error(`memory reload mismatch: ${JSON.stringify(rows)}`);
        },
      },
      {
        name: 'notes.repository',
        expectedTables: ['notes', 'note_links', 'note_databases', 'note_db_rows'],
        roundTrip: async () => {
          await notes.createNote({ id: 'note-coexist', owner_user_id: 'u-1', title: 'Coexistence note' });
          const got = await notes.getNote('note-coexist', 'u-1');
          if (got?.title !== 'Coexistence note') throw new Error(`note reload mismatch: ${JSON.stringify(got)}`);
        },
      },
      {
        name: 'notifications.feed',
        expectedTables: ['notification_feed'],
        roundTrip: async () => {
          await feed.append({
            id: 'ntf-coexist', tenantId: 'acme', principalId: 'u-1', category: 'run',
            title: 'Run finished', priority: 'normal', createdAt: Date.now(), readAt: null,
            dedupeKey: 'coexist-1', // idempotent so the isolation re-run doesn't duplicate
          });
          if (await feed.unreadCount('acme', 'u-1') !== 1) throw new Error('feed unread count mismatch');
        },
      },
      {
        name: 'human-tasks.repository',
        expectedTables: ['human_tasks'],
        roundTrip: async () => {
          await humanTasks.save({
            id: 'task-coexist', type: 'approval', title: 'Approve coexistence', status: 'pending',
            priority: 'high', createdAt: new Date().toISOString(),
          });
          const got = await humanTasks.get('task-coexist');
          if (got?.title !== 'Approve coexistence') throw new Error(`task reload mismatch: ${JSON.stringify(got)}`);
        },
      },
    ];

    const results = await runSharedPostgresCoexistence({ hub, probes });
    const report = coexistenceReport(results);
    // Surface any failure detail before asserting.
    expect(report.failures.map((f) => `${f.tier}/${f.name}: ${f.detail}`), report.failures.map((f) => `${f.tier}/${f.name}: ${f.detail}`).join('\n')).toEqual([]);
    expect(report.ok).toBe(true);
    // Sanity: we actually exercised all seven stores across the tiers.
    expect(report.byTier.positive.total).toBe(7);
    expect(report.byTier.isolation.total).toBe(7);
    expect(report.byTier['kv-slot'].passed).toBe(1);

    await memory.close();
    await agents.close();
  }, 180_000);

  it.skipIf(!KEY)('REAL LLM: semantic memory search on the SAME Postgres as the workflow/agent state', async () => {
    const embed = async (texts: string[]): Promise<number[][]> => {
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'text-embedding-3-small', input: texts }),
      });
      if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`);
      return ((await res.json()) as { data: Array<{ embedding: number[] }> }).data.map((d) => d.embedding);
    };

    const memory = weavePgVectorMemoryStore({ pool, dimensions: 1536, tableName: 'mem_semantic', indexType: 'none' });
    const ctx = weaveContext({ tenantId: 'acme', userId: 'u-1', metadata: { sessionId: 's-2' } });

    const facts = [
      'The invoice total for Acme was $4,200 due net-30.',
      'Our hiking trip to the Alps is planned for July.',
      'Refund policy: customers may return items within 14 days.',
      'The quarterly sales report shows revenue up 18%.',
    ];
    const vecs = await embed(facts);
    await memory.write(ctx, facts.map((content, i) => ({
      id: `f${i}`, type: 'semantic' as const, content, metadata: {}, embedding: vecs[i]!,
      createdAt: new Date().toISOString(), tenantId: 'acme', userId: 'u-1', sessionId: 's-2',
    })));

    // Plain-language query that matches the invoice fact by MEANING (shares no keywords with it).
    const [q] = await embed(['how much does the customer owe us and when']);
    const rows = await memory.query(ctx, { type: 'semantic', embedding: q!, topK: 2 });
    expect(rows[0]!.content).toContain('$4,200'); // semantic hit, in the same DB as everything else

    // Coexistence is intact: the workflow/agent/trigger tables from the previous test still stand here.
    const { rows: tables } = await pool.query(
      `SELECT tablename FROM pg_catalog.pg_tables WHERE tablename = ANY($1)`,
      [['wf_checkpoints', 'triggers', 'la_entities', 'mem_semantic']],
    );
    expect(tables.map((r) => r.tablename).sort()).toEqual(['la_entities', 'mem_semantic', 'triggers', 'wf_checkpoints']);

    await memory.close();
  }, 180_000);
});
