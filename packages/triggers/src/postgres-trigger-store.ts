/**
 * Postgres-backed TriggerStore. Two tables: `triggers` + `trigger_invocations`.
 */
import type { Pool } from 'pg';
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
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  source_kind TEXT NOT NULL,
  source_config JSONB NOT NULL,
  filter_expr JSONB,
  target_kind TEXT NOT NULL,
  target_config JSONB NOT NULL,
  input_map JSONB,
  rate_limit_per_minute INTEGER,
  metadata JSONB
);
CREATE TABLE IF NOT EXISTS trigger_invocations (
  id TEXT PRIMARY KEY,
  trigger_id TEXT NOT NULL,
  fired_at BIGINT NOT NULL,
  source_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  target_ref TEXT,
  error_message TEXT,
  source_event JSONB
);
CREATE INDEX IF NOT EXISTS idx_trigger_invocations_trigger ON trigger_invocations(trigger_id, fired_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_trigger_invocations_status ON trigger_invocations(status, fired_at DESC, id);
`;

export interface WeavePostgresTriggerStoreOptions {
  pool: Pool;
  ensureSchema?: boolean;
}

interface TriggerRow {
  id: string;
  key: string;
  enabled: boolean;
  source_kind: string;
  source_config: Record<string, unknown>;
  filter_expr: { expression?: unknown } | null;
  target_kind: string;
  target_config: Record<string, unknown>;
  input_map: Record<string, string> | null;
  rate_limit_per_minute: number | null;
  metadata: Record<string, unknown> | null;
}

interface InvocationRow {
  id: string;
  trigger_id: string;
  fired_at: string | number;
  source_kind: string;
  status: string;
  target_ref: string | null;
  error_message: string | null;
  source_event: Record<string, unknown> | null;
}

function rowToTrigger(row: TriggerRow): Trigger {
  return {
    id: row.id,
    key: row.key,
    enabled: row.enabled,
    source: { kind: row.source_kind as TriggerSourceKind, config: row.source_config ?? {} },
    target: { kind: row.target_kind as TriggerTargetKind, config: row.target_config ?? {} },
    ...(row.filter_expr && row.filter_expr.expression !== undefined
      ? { filter: { expression: row.filter_expr.expression } }
      : {}),
    ...(row.input_map ? { inputMap: row.input_map } : {}),
    ...(row.rate_limit_per_minute != null ? { rateLimit: { perMinute: row.rate_limit_per_minute } } : {}),
    ...(row.metadata ? { metadata: row.metadata } : {}),
  };
}

function rowToInvocation(row: InvocationRow): TriggerInvocation {
  return {
    id: row.id,
    triggerId: row.trigger_id,
    firedAt: typeof row.fired_at === 'string' ? Number(row.fired_at) : row.fired_at,
    sourceKind: row.source_kind as TriggerSourceKind,
    status: row.status as TriggerInvocationStatus,
    ...(row.target_ref != null ? { targetRef: row.target_ref } : {}),
    ...(row.error_message != null ? { errorMessage: row.error_message } : {}),
    ...(row.source_event ? { sourceEvent: row.source_event } : {}),
  };
}

export async function weavePostgresTriggerStore(
  opts: WeavePostgresTriggerStoreOptions,
): Promise<TriggerStore> {
  if (opts.ensureSchema !== false) await opts.pool.query(MIGRATIONS_SQL);
  const pool = opts.pool;

  return {
    async list() {
      const r = await pool.query<TriggerRow>('SELECT * FROM triggers ORDER BY key ASC');
      return r.rows.map(rowToTrigger);
    },
    async get(id) {
      const r = await pool.query<TriggerRow>('SELECT * FROM triggers WHERE id = $1', [id]);
      return r.rows[0] ? rowToTrigger(r.rows[0]) : null;
    },
    async getByKey(key) {
      const r = await pool.query<TriggerRow>('SELECT * FROM triggers WHERE key = $1', [key]);
      return r.rows[0] ? rowToTrigger(r.rows[0]) : null;
    },
    async save(t) {
      await pool.query(
        `INSERT INTO triggers (id, key, enabled, source_kind, source_config, filter_expr, target_kind, target_config, input_map, rate_limit_per_minute, metadata)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8::jsonb,$9::jsonb,$10,$11::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           key=EXCLUDED.key, enabled=EXCLUDED.enabled, source_kind=EXCLUDED.source_kind,
           source_config=EXCLUDED.source_config, filter_expr=EXCLUDED.filter_expr,
           target_kind=EXCLUDED.target_kind, target_config=EXCLUDED.target_config,
           input_map=EXCLUDED.input_map, rate_limit_per_minute=EXCLUDED.rate_limit_per_minute,
           metadata=EXCLUDED.metadata`,
        [
          t.id,
          t.key,
          t.enabled,
          t.source.kind,
          JSON.stringify(t.source.config ?? {}),
          t.filter ? JSON.stringify({ expression: t.filter.expression }) : null,
          t.target.kind,
          JSON.stringify(t.target.config ?? {}),
          t.inputMap ? JSON.stringify(t.inputMap) : null,
          t.rateLimit?.perMinute ?? null,
          t.metadata ? JSON.stringify(t.metadata) : null,
        ],
      );
    },
    async delete(id) { await pool.query('DELETE FROM triggers WHERE id = $1', [id]); },
    async recordInvocation(inv) {
      await pool.query(
        `INSERT INTO trigger_invocations (id, trigger_id, fired_at, source_kind, status, target_ref, error_message, source_event)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [
          inv.id || newUUIDv7(),
          inv.triggerId,
          inv.firedAt,
          inv.sourceKind,
          inv.status,
          inv.targetRef ?? null,
          inv.errorMessage ?? null,
          inv.sourceEvent ? JSON.stringify(inv.sourceEvent) : null,
        ],
      );
    },
    async listInvocations(filter: ListInvocationsFilter = {}) {
      const wheres: string[] = [];
      const params: unknown[] = [];
      let i = 1;
      if (filter.triggerId) { wheres.push(`trigger_id = $${i++}`); params.push(filter.triggerId); }
      if (filter.status) { wheres.push(`status = $${i++}`); params.push(filter.status); }
      const where = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
      const limit = filter.limit ?? 100;
      const offset = filter.offset ?? 0;
      params.push(limit, offset);
      const r = await pool.query<InvocationRow>(
        `SELECT * FROM trigger_invocations ${where} ORDER BY fired_at DESC, id DESC LIMIT $${i++} OFFSET $${i}`,
        params,
      );
      return r.rows.map(rowToInvocation);
    },
    async listByOwner(principalId: string) {
      const result = await pool.query<TriggerRow>('SELECT * FROM triggers ORDER BY key ASC');
      return result.rows.map(rowToTrigger).filter((t) => t.ownerPrincipalId === principalId);
    },
  };
}
