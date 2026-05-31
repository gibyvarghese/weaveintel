/**
 * SQLite-backed TriggerStore. Two tables: `triggers` (1 row per trigger,
 * JSON columns for source/target/filter/inputMap/metadata) and
 * `trigger_invocations` (append-only audit ledger).
 */
import Database from 'better-sqlite3';
import { newUUIDv7 } from '@weaveintel/core';
import type {
  Trigger,
  TriggerInvocation,
  TriggerStore,
  ListInvocationsFilter,
  TriggerSourceKind,
  TriggerTargetKind,
  TriggerInvocationStatus,
} from './dispatcher.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  source_kind TEXT NOT NULL,
  source_config TEXT NOT NULL,
  filter_expr TEXT,
  target_kind TEXT NOT NULL,
  target_config TEXT NOT NULL,
  input_map TEXT,
  rate_limit_per_minute INTEGER,
  metadata TEXT
);
CREATE TABLE IF NOT EXISTS trigger_invocations (
  id TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL,
  fired_at INTEGER NOT NULL,
  source_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  target_ref TEXT,
  error_message TEXT,
  source_event TEXT
);
CREATE INDEX IF NOT EXISTS idx_trigger_invocations_trigger ON trigger_invocations(trigger_id, fired_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_trigger_invocations_status ON trigger_invocations(status, fired_at DESC, id);
`;

export interface WeaveSqliteTriggerStoreOptions {
  database?: Database.Database;
  databasePath?: string;
}

interface TriggerRow {
  id: string;
  key: string;
  enabled: number;
  source_kind: string;
  source_config: string;
  filter_expr: string | null;
  target_kind: string;
  target_config: string;
  input_map: string | null;
  rate_limit_per_minute: number | null;
  metadata: string | null;
}

interface InvocationRow {
  id: string;
  trigger_id: string;
  fired_at: number;
  source_kind: string;
  status: string;
  target_ref: string | null;
  error_message: string | null;
  source_event: string | null;
}

function parseJson<T>(s: string | null | undefined): T | undefined {
  if (!s) return undefined;
  try { return JSON.parse(s) as T; } catch { return undefined; }
}

function rowToTrigger(row: TriggerRow): Trigger {
  const filter = parseJson<{ expression?: unknown }>(row.filter_expr);
  const inputMap = parseJson<Record<string, string>>(row.input_map);
  const metadata = parseJson<Record<string, unknown>>(row.metadata);
  return {
    id: row.id,
    key: row.key,
    enabled: row.enabled === 1,
    source: {
      kind: row.source_kind as TriggerSourceKind,
      config: parseJson<Record<string, unknown>>(row.source_config) ?? {},
    },
    target: {
      kind: row.target_kind as TriggerTargetKind,
      config: parseJson<Record<string, unknown>>(row.target_config) ?? {},
    },
    ...(filter && filter.expression !== undefined ? { filter: { expression: filter.expression } } : {}),
    ...(inputMap ? { inputMap } : {}),
    ...(row.rate_limit_per_minute != null ? { rateLimit: { perMinute: row.rate_limit_per_minute } } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function rowToInvocation(row: InvocationRow): TriggerInvocation {
  const ev = parseJson<Record<string, unknown>>(row.source_event);
  return {
    id: row.id,
    triggerId: row.trigger_id,
    firedAt: row.fired_at,
    sourceKind: row.source_kind as TriggerSourceKind,
    status: row.status as TriggerInvocationStatus,
    ...(row.target_ref != null ? { targetRef: row.target_ref } : {}),
    ...(row.error_message != null ? { errorMessage: row.error_message } : {}),
    ...(ev ? { sourceEvent: ev } : {}),
  };
}

export function weaveSqliteTriggerStore(opts: WeaveSqliteTriggerStoreOptions = {}): TriggerStore {
  const db = opts.database ?? new Database(opts.databasePath ?? ':memory:');
  db.exec(MIGRATIONS_SQL);

  const upsertStmt = db.prepare(
    `INSERT INTO triggers (id, key, enabled, source_kind, source_config, filter_expr, target_kind, target_config, input_map, rate_limit_per_minute, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       key=excluded.key,
       enabled=excluded.enabled,
       source_kind=excluded.source_kind,
       source_config=excluded.source_config,
       filter_expr=excluded.filter_expr,
       target_kind=excluded.target_kind,
       target_config=excluded.target_config,
       input_map=excluded.input_map,
       rate_limit_per_minute=excluded.rate_limit_per_minute,
       metadata=excluded.metadata`,
  );
  const selectAll = db.prepare('SELECT * FROM triggers ORDER BY key ASC');
  const selectById = db.prepare('SELECT * FROM triggers WHERE id = ?');
  const selectByKey = db.prepare('SELECT * FROM triggers WHERE key = ?');
  const deleteById = db.prepare('DELETE FROM triggers WHERE id = ?');

  const insertInv = db.prepare(
    `INSERT INTO trigger_invocations (id, trigger_id, fired_at, source_kind, status, target_ref, error_message, source_event)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  return {
    async list() { return (selectAll.all() as TriggerRow[]).map(rowToTrigger); },
    async get(id) { const r = selectById.get(id) as TriggerRow | undefined; return r ? rowToTrigger(r) : null; },
    async getByKey(key) { const r = selectByKey.get(key) as TriggerRow | undefined; return r ? rowToTrigger(r) : null; },
    async save(t) {
      upsertStmt.run(
        t.id,
        t.key,
        t.enabled ? 1 : 0,
        t.source.kind,
        JSON.stringify(t.source.config ?? {}),
        t.filter ? JSON.stringify({ expression: t.filter.expression }) : null,
        t.target.kind,
        JSON.stringify(t.target.config ?? {}),
        t.inputMap ? JSON.stringify(t.inputMap) : null,
        t.rateLimit?.perMinute ?? null,
        t.metadata ? JSON.stringify(t.metadata) : null,
      );
    },
    async delete(id) { deleteById.run(id); },
    async recordInvocation(inv) {
      insertInv.run(
        inv.id || newUUIDv7(),
        inv.triggerId,
        inv.firedAt,
        inv.sourceKind,
        inv.status,
        inv.targetRef ?? null,
        inv.errorMessage ?? null,
        inv.sourceEvent ? JSON.stringify(inv.sourceEvent) : null,
      );
    },
    async listInvocations(filter: ListInvocationsFilter = {}) {
      const wheres: string[] = [];
      const params: unknown[] = [];
      if (filter.triggerId) { wheres.push('trigger_id = ?'); params.push(filter.triggerId); }
      if (filter.status) { wheres.push('status = ?'); params.push(filter.status); }
      const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
      const limit = filter.limit ?? 100;
      const offset = filter.offset ?? 0;
      const stmt = db.prepare(
        `SELECT * FROM trigger_invocations ${where} ORDER BY fired_at DESC, id DESC LIMIT ? OFFSET ?`,
      );
      const rows = stmt.all(...params, limit, offset) as InvocationRow[];
      return rows.map(rowToInvocation);
    },
  };
}
