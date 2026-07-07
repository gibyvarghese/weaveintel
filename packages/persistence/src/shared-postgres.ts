// SPDX-License-Identifier: MIT
/**
 * `weaveSharedPostgres` — one Postgres, one connection, your whole runtime remembers.
 *
 * weaveIntel keeps each subsystem's storage behind its own small "port" (memory has one, workflows
 * has one, live-agents and triggers each have one, and the runtime itself uses key/value "slots" for
 * the dead-letter queue, cost meter, and step-idempotency). Every one of those already ships a
 * Postgres backend. What was missing was the obvious thing an adopter wants: a single place that hands
 * *the same* Postgres connection to all of them, so the whole system runs on ONE database with ONE
 * pool — instead of each part quietly opening its own.
 *
 * That is all this is. You bring one connection (a `pg.Pool` you configured, or just a connection
 * string), and you get back a small "hub" that:
 *   • exposes that one connection as `.pool` / `.client` so you pass it to every store, and
 *   • mints durable key/value `slot(name)`s on it (each in its own table) for the runtime's own state.
 *
 * Why one pool matters (and why we don't just let each store open its own): opening many pools to the
 * same database wastes connections and is the classic way to exhaust a Postgres server — the standard
 * guidance is *one pool per process, shared*. Serverless poolers (e.g. Neon/PgBouncer in transaction
 * mode) add a second rule: never rely on `SET search_path` to separate things, because the connection
 * is handed back to the pool after every transaction. So this hub separates each slot by using a
 * distinct, explicitly-named table — never a session setting — which is safe on any pooler.
 *
 * This package deliberately does NOT import memory/workflows/live-agents/triggers. It stays a light,
 * dependency-free primitive; you wire the domain stores yourself by passing them `hub.pool`. See the
 * README "Run your whole runtime on one Postgres" recipe (and the coexistence contract) for the exact,
 * type-checked wiring.
 */

import { createRequire } from 'node:module';
import type { RuntimePersistenceSlot } from '@weaveintel/core';
import type { PersistenceCapabilities } from './types.js';
import { weavePostgresPersistence, type SqlClient } from './postgres-slot.js';

const requireCjs = createRequire(import.meta.url);

export type { SqlClient };

export interface SharedPostgresOptions<C extends SqlClient = SqlClient> {
  /**
   * Bring your own connection — a `pg.Pool` (recommended: its type then flows to every store) or any
   * `{ query(text, params) }` client (a serverless driver, a proxy, a test container…). This is the
   * ONE pool your whole runtime shares. When you inject it, YOU own its lifecycle (`close()` leaves it
   * open).
   */
  readonly client?: C;
  /**
   * …or just a connection string. The hub lazily creates a pool via the optional `pg` package and
   * closes it for you on `close()`. Prefer injecting your own `pg.Pool` when you want full type-safety
   * wiring the pool into `weavePostgres*Store({ pool })` factories.
   */
  readonly connectionString?: string;
  /**
   * Prefix for the tables that `slot(name)` creates. Lets two independent hubs share one database
   * without colliding. Default `weave_kv_`. Validated as a plain SQL identifier.
   */
  readonly tablePrefix?: string;
}

export interface SharedPostgres<C extends SqlClient = SqlClient> {
  /** The one shared client. A `pg.Pool` satisfies this. Pass it to any injected-client store. */
  readonly client: C;
  /**
   * Alias of `client`, named to read naturally at the call sites that ask for a pool
   * (`weavePostgresCheckpointStore({ pool: hub.pool })`, `weavePostgresStateStore({ pool: hub.pool })`,
   * `weavePgVectorMemoryStore({ pool: hub.pool })`, …). It is the same object — one pool, shared.
   */
  readonly pool: C;
  /**
   * A durable key/value slot on this Postgres, living in its OWN table (`<tablePrefix><name>`), so the
   * dead-letter queue, cost meter, and step-idempotency don't tread on each other. Calling with the
   * same name returns a slot on the same table (idempotent). Reuses `weavePostgresPersistence`.
   */
  slot(name: string): RuntimePersistenceSlot;
  /** What this backend supports (transactions, TTL, JSON query, pub/sub) for capability negotiation. */
  capabilities(): PersistenceCapabilities;
  /** A single-round-trip liveness probe (`SELECT 1`). Never throws — reports `{ ok:false, error }`. */
  health(): Promise<{ ok: boolean; latencyMs: number; error?: string }>;
  /** Every table name this hub has claimed via `slot()` — so you can see what coexists on the DB. */
  registeredTables(): readonly string[];
  /** Close the pool — but ONLY if the hub created it (from a `connectionString`). Injected pools stay open. */
  close(): Promise<void>;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Turn a friendly slot name ("cost-meter", "DLQ") into a safe table suffix ("cost_meter", "dlq"). */
function sanitizeName(name: string): string {
  const cleaned = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!cleaned) throw new Error(`weaveSharedPostgres.slot: name "${name}" has no letters or digits to make a table name from.`);
  return cleaned;
}

/**
 * Build the shared-Postgres hub. Pass exactly one of `client` (recommended) or `connectionString`.
 *
 * @example One database for the whole runtime
 * ```ts
 * import pg from 'pg';
 * import { weaveSharedPostgres } from '@weaveintel/persistence';
 *
 * const hub = weaveSharedPostgres({ client: new pg.Pool({ connectionString: process.env.DATABASE_URL }) });
 *
 * // Runtime's own durable state — each in its own table on the one pool:
 * const dlq  = hub.slot('dead-letter-queue');
 * const cost = hub.slot('cost-meter');
 *
 * // Domain stores share the SAME pool (you wire these — persistence doesn't import them):
 * // const checkpoints = await weavePostgresCheckpointStore({ pool: hub.pool });
 * // const memory      = weavePgVectorMemoryStore({ pool: hub.pool });
 *
 * await hub.health(); // { ok: true, latencyMs: 3 }
 * ```
 */
export function weaveSharedPostgres<C extends SqlClient = SqlClient>(
  opts: SharedPostgresOptions<C>,
): SharedPostgres<C> {
  if (opts.client && opts.connectionString) {
    throw new Error('weaveSharedPostgres: pass either `client` or `connectionString`, not both.');
  }

  const prefix = opts.tablePrefix ?? 'weave_kv_';
  if (!IDENTIFIER.test(prefix)) {
    throw new Error(`weaveSharedPostgres: invalid tablePrefix "${prefix}" (letters, numbers and underscores only).`);
  }

  // Resolve the one shared connection + who owns its lifecycle.
  let ownsPool = false;
  let client: SqlClient;
  if (opts.client) {
    client = opts.client;
  } else if (opts.connectionString) {
    // Lazy-require pg so the package doesn't force the driver on adopters who inject their own client.
    let PgPool: new (config: { connectionString: string }) => SqlClient & { end(): Promise<void> };
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      PgPool = (requireCjs('pg') as { Pool: typeof PgPool }).Pool;
    } catch {
      throw new Error(
        'weaveSharedPostgres: `connectionString` needs the `pg` package installed (npm i pg), or inject your own `client`.',
      );
    }
    client = new PgPool({ connectionString: opts.connectionString });
    ownsPool = true;
  } else {
    throw new Error('weaveSharedPostgres: provide a `client` (a pg.Pool) or a `connectionString`.');
  }

  // slot table name → the friendly name it was first created under (collision + idempotency tracking).
  const tables = new Map<string, string>();
  const slots = new Map<string, RuntimePersistenceSlot>();

  const capabilities: PersistenceCapabilities = {
    transactions: true,
    ttl: true, // the KV slots enforce TTL (unlike the generic capability stub)
    optimisticConcurrency: true,
    pubsub: true, // Postgres LISTEN/NOTIFY
    jsonQuery: true,
  };

  return {
    client: client as C,
    pool: client as C,

    slot(name: string): RuntimePersistenceSlot {
      const table = `${prefix}${sanitizeName(name)}`;
      const existingName = tables.get(table);
      if (existingName !== undefined) {
        if (existingName !== name) {
          throw new Error(
            `weaveSharedPostgres.slot: "${name}" and "${existingName}" both map to table "${table}". Pick names that differ by more than punctuation/case.`,
          );
        }
        return slots.get(table)!;
      }
      const slot = weavePostgresPersistence({ client, table });
      tables.set(table, name);
      slots.set(table, slot);
      return slot;
    },

    capabilities: () => ({ ...capabilities }),

    async health() {
      const t0 = performance.now();
      try {
        await client.query('SELECT 1');
        return { ok: true, latencyMs: Math.round(performance.now() - t0) };
      } catch (e) {
        return { ok: false, latencyMs: Math.round(performance.now() - t0), error: (e as Error).message };
      }
    },

    registeredTables: () => [...tables.keys()].sort(),

    async close() {
      if (!ownsPool) return; // injected pool — caller owns it
      const maybePool = client as { end?: () => Promise<void> };
      if (typeof maybePool.end === 'function') await maybePool.end();
    },
  };
}
