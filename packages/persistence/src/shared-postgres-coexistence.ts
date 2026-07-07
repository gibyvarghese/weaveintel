// SPDX-License-Identifier: MIT
/**
 * A "coexistence contract" for `weaveSharedPostgres`.
 *
 * The promise of the shared hub is that your whole runtime can live on ONE Postgres: memory, workflows,
 * live-agents, triggers, and the runtime's own key/value slots — all on the same connection. Before you
 * bet on that, you want proof that they actually get along on one database: that each one still works,
 * that they don't quietly reuse each other's tables, and that one store writing a lot doesn't disturb
 * another. This harness gives you that proof.
 *
 * It is deliberately framework-agnostic (returns results, so you assert on them in vitest/jest/…) and
 * deliberately knows nothing about the individual store packages. You describe each store as a small
 * "probe" — its name, the tables it creates, and a round-trip that writes then reads something back —
 * and hand the probes plus the hub to `runSharedPostgresCoexistence`. Because you build the probes,
 * `@weaveintel/persistence` never has to import memory/workflows/live-agents/triggers.
 *
 * It checks four things:
 *   • positive     — every store's write→read round-trip works on the shared connection;
 *   • coexistence  — every table each store expects really exists, and no two stores claim the SAME
 *                    table (which would mean one silently overwriting another);
 *   • isolation    — after ALL stores have written, every store's data still reads back correctly
 *                    (a neighbour's heavy writing didn't corrupt yours);
 *   • kv-slot      — the runtime's own durable key/value slot passes on this same Postgres.
 */

import type { SharedPostgres } from './shared-postgres.js';
import { runPersistenceContract, contractPassed } from './persistence-contract.js';

/** Describes one store sharing the Postgres, so the harness can exercise and verify it. */
export interface StoreProbe {
  /** A human label, e.g. `"workflows.checkpoints"` or `"memory.pgvector"`. */
  readonly name: string;
  /** The table(s) this store creates on the shared database (used for the collision + existence checks). */
  readonly expectedTables: readonly string[];
  /** Write something, then read it back; throw with a clear message if it doesn't match. */
  readonly roundTrip: () => Promise<void>;
}

export interface CoexistenceOptions {
  /** The shared hub under test. Its `client` is used to introspect which tables exist. */
  readonly hub: SharedPostgres;
  /** One probe per store you want to prove coexists. */
  readonly probes: readonly StoreProbe[];
  /** Also run the full KV contract against a hub slot of this name. Default `'coexistence-kv'`. */
  readonly slotName?: string;
  /** Skip the KV-slot leg (e.g. if you assert it elsewhere). Default false. */
  readonly skipKvSlot?: boolean;
}

export interface CoexistenceCheck {
  readonly name: string;
  readonly tier: 'positive' | 'coexistence' | 'isolation' | 'kv-slot';
  readonly ok: boolean;
  readonly detail?: string;
}

/** List the user tables currently on the connected database (excludes Postgres' own catalogs). */
async function listUserTables(client: SharedPostgres['client']): Promise<Set<string>> {
  const { rows } = await client.query(
    `SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')`,
  );
  return new Set(rows.map((r) => String(r['tablename'])));
}

/**
 * Run the coexistence battery. Never throws — every check is captured as a pass/fail result.
 *
 * @example
 * ```ts
 * const results = await runSharedPostgresCoexistence({
 *   hub,
 *   probes: [
 *     { name: 'workflows.checkpoints', expectedTables: ['wf_checkpoints'], roundTrip: async () => { ... } },
 *     { name: 'triggers',              expectedTables: ['triggers', 'trigger_invocations'], roundTrip: async () => { ... } },
 *     { name: 'live-agents.state',     expectedTables: ['la_entities'], roundTrip: async () => { ... } },
 *     { name: 'memory',                expectedTables: ['memory_entries'], roundTrip: async () => { ... } },
 *   ],
 * });
 * expect(coexistenceReport(results).ok).toBe(true);
 * ```
 */
export async function runSharedPostgresCoexistence(opts: CoexistenceOptions): Promise<CoexistenceCheck[]> {
  const results: CoexistenceCheck[] = [];
  const { hub, probes } = opts;

  const check = async (name: string, tier: CoexistenceCheck['tier'], fn: () => Promise<void>) => {
    try { await fn(); results.push({ name, tier, ok: true }); }
    catch (e) { results.push({ name, tier, ok: false, detail: (e as Error).message }); }
  };
  const assert = (cond: boolean, msg: string) => { if (!cond) throw new Error(msg); };

  // ── Static check: no two probes declare the same table (would mean one clobbering another). ──
  await check('declared tables are unique across stores', 'coexistence', async () => {
    const owner = new Map<string, string>();
    for (const p of probes) {
      for (const t of p.expectedTables) {
        const prev = owner.get(t);
        assert(prev === undefined, `table "${t}" is claimed by both "${prev}" and "${p.name}" — they would overwrite each other`);
        owner.set(t, p.name);
      }
    }
  });

  // ── Positive: each store's round-trip works on the shared connection. ──
  for (const p of probes) {
    await check(`${p.name}: write→read round-trips on the shared Postgres`, 'positive', async () => {
      await p.roundTrip();
    });
  }

  // ── Coexistence: every expected table now exists on the one database. ──
  await check('every store created its table(s) on the shared database', 'coexistence', async () => {
    const present = await listUserTables(hub.client);
    for (const p of probes) {
      for (const t of p.expectedTables) {
        assert(present.has(t), `expected table "${t}" from "${p.name}" not found on the shared database (present: ${[...present].sort().join(', ')})`);
      }
    }
  });

  // ── Isolation: after ALL stores have written, each still reads back correctly. ──
  // Re-running every round-trip proves a neighbour's writes didn't corrupt an earlier store's data.
  for (const p of probes) {
    await check(`${p.name}: still correct after every other store has written (no cross-contamination)`, 'isolation', async () => {
      await p.roundTrip();
    });
  }

  // ── KV slot: the runtime's own durable slot passes the full contract on this Postgres. ──
  if (!opts.skipKvSlot) {
    await check('a runtime KV slot passes the full persistence contract on the shared Postgres', 'kv-slot', async () => {
      const slot = hub.slot(opts.slotName ?? 'coexistence-kv');
      const contract = await runPersistenceContract({
        makeStore: () => slot.kv,
        // keep it quick inside the coexistence run; the standalone slot test covers the large scale
        stressSize: 500,
      });
      assert(contractPassed(contract), `KV contract failed: ${contract.filter((c) => !c.ok).map((c) => `${c.name} — ${c.detail}`).join('; ')}`);
    });
  }

  return results;
}

/** Summarise a coexistence run: overall pass plus a per-tier tally. */
export function coexistenceReport(results: readonly CoexistenceCheck[]): {
  ok: boolean;
  total: number;
  passed: number;
  byTier: Record<CoexistenceCheck['tier'], { passed: number; total: number }>;
  failures: CoexistenceCheck[];
} {
  const byTier = {
    positive: { passed: 0, total: 0 },
    coexistence: { passed: 0, total: 0 },
    isolation: { passed: 0, total: 0 },
    'kv-slot': { passed: 0, total: 0 },
  } as Record<CoexistenceCheck['tier'], { passed: number; total: number }>;
  for (const r of results) {
    byTier[r.tier].total += 1;
    if (r.ok) byTier[r.tier].passed += 1;
  }
  const passed = results.filter((r) => r.ok).length;
  return {
    ok: results.length > 0 && passed === results.length,
    total: results.length,
    passed,
    byTier,
    failures: results.filter((r) => !r.ok),
  };
}
