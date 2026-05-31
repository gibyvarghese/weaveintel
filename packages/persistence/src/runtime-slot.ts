/**
 * Phase 4 — concrete `RuntimePersistenceSlot` factories for durable backends.
 *
 * Adopters pass one of these into `weaveRuntime({ persistence })` and every
 * downstream durable subsystem (DLQ, cost meter, idempotency, audit ledger,
 * etc.) inherits restart-safe behavior automatically — no per-call-site
 * wiring, no module-level singletons.
 *
 *   const runtime = weaveRuntime({ persistence: weaveSqlitePersistence({ path: './weave.db' }) });
 *
 * Concrete backends live here so `@weaveintel/core` stays vendor-dep-free.
 */
import type { RuntimePersistenceSlot, RuntimeKvStore } from '@weaveintel/core';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);

interface SqliteStmt {
  run(...args: unknown[]): unknown;
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
}
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStmt;
  close(): void;
}

export interface SqliteRuntimePersistenceOptions {
  /** Filesystem path. Use `':memory:'` for an ephemeral instance. */
  path: string;
  /** Table name. Defaults to `runtime_kv`. */
  table?: string;
}

/**
 * SQLite-backed `RuntimePersistenceSlot`. Uses `better-sqlite3` (lazy-loaded
 * so the persistence package does not force the dep on apps that pick a
 * different backend).
 *
 * Schema (created on first use):
 *
 *   CREATE TABLE <table> (
 *     k TEXT PRIMARY KEY,
 *     v TEXT NOT NULL,
 *     expires_at INTEGER  -- ms epoch, NULL = never
 *   )
 *
 * TTL is enforced lazily on read / list (matches the in-memory slot in core).
 * Synchronous SQLite calls are wrapped in `async` to satisfy the contract.
 */
export function weaveSqlitePersistence(opts: SqliteRuntimePersistenceOptions): RuntimePersistenceSlot {
  const table = opts.table ?? 'runtime_kv';
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = requireCjs('better-sqlite3') as new (path: string) => SqliteDb;
  const db = new Database(opts.path);
  db.exec(`CREATE TABLE IF NOT EXISTS ${table} (k TEXT PRIMARY KEY, v TEXT NOT NULL, expires_at INTEGER);`);

  const stGet = db.prepare(`SELECT v, expires_at FROM ${table} WHERE k = ?`);
  const stSet = db.prepare(`INSERT INTO ${table}(k,v,expires_at) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, expires_at=excluded.expires_at`);
  const stDel = db.prepare(`DELETE FROM ${table} WHERE k = ?`);
  const stList = db.prepare(`SELECT k, v, expires_at FROM ${table} WHERE k >= ? AND k < ? ORDER BY k ASC`);

  function alive(expiresAt: number | null | undefined): boolean {
    if (expiresAt === null || expiresAt === undefined) return true;
    return expiresAt > Date.now();
  }

  const kv: RuntimeKvStore = {
    async get(key) {
      const row = stGet.get(key) as { v: string; expires_at: number | null } | undefined;
      if (!row) return undefined;
      if (!alive(row.expires_at)) { stDel.run(key); return undefined; }
      return row.v;
    },
    async set(key, value, options) {
      const expiresAt = options?.ttlMs && options.ttlMs > 0 ? Date.now() + options.ttlMs : null;
      stSet.run(key, value, expiresAt);
    },
    async delete(key) {
      const res = stDel.run(key) as { changes?: number };
      return (res.changes ?? 0) > 0;
    },
    async list(prefix) {
      // Lexicographic upper bound: prefix + '\uFFFF' is sufficient for ASCII keys.
      const upper = prefix + '\uFFFF';
      const rows = stList.all(prefix, upper) as { k: string; v: string; expires_at: number | null }[];
      const out: { key: string; value: string }[] = [];
      for (const r of rows) {
        if (!alive(r.expires_at)) { stDel.run(r.k); continue; }
        out.push({ key: r.k, value: r.v });
      }
      return out;
    },
  };

  return { kind: 'sqlite', kv };
}
