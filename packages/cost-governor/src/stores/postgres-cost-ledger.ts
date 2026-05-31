/**
 * Postgres-backed CostLedger.
 *
 * Persists every `CostLedgerEntry` into `cost_ledger_entries` (JSONB metadata,
 * BIGINT observed_at coerced via num()). Idempotent via ON CONFLICT DO NOTHING.
 * Best-effort — sink failures are caught.
 */
import type { Pool, PoolClient } from 'pg';
import type {
  CostLedger,
  CostLedgerEntry,
  CostBreakdown,
  CostLever,
} from '../types.js';

const MIGRATIONS_SQL = `
CREATE TABLE IF NOT EXISTS cost_ledger_entries (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_id TEXT,
  agent_id TEXT,
  agent_role TEXT,
  source TEXT NOT NULL,
  lever TEXT NOT NULL,
  subject TEXT NOT NULL,
  provider TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cached_tokens INTEGER,
  reasoning_tokens INTEGER,
  cost_usd DOUBLE PRECISION NOT NULL,
  observed_at BIGINT NOT NULL,
  metadata JSONB
);
CREATE INDEX IF NOT EXISTS idx_cost_ledger_run ON cost_ledger_entries(run_id, observed_at ASC);
`;

interface EntryRow {
  id: string;
  run_id: string;
  step_id: string | null;
  agent_id: string | null;
  agent_role: string | null;
  source: string;
  lever: string;
  subject: string;
  provider: string | null;
  input_tokens: number | string | null;
  output_tokens: number | string | null;
  cached_tokens: number | string | null;
  reasoning_tokens: number | string | null;
  cost_usd: number | string;
  observed_at: number | string;
  metadata: unknown;
}

function num(v: number | string): number {
  return typeof v === 'string' ? Number(v) : v;
}
function numOrNull(v: number | string | null): number | null {
  return v == null ? null : num(v);
}

function rowToEntry(r: EntryRow): CostLedgerEntry {
  const meta = (r.metadata && typeof r.metadata === 'object')
    ? (r.metadata as Record<string, unknown>)
    : undefined;
  return {
    id: r.id,
    runId: r.run_id,
    ...(r.step_id != null ? { stepId: r.step_id } : {}),
    ...(r.agent_id != null ? { agentId: r.agent_id } : {}),
    ...(r.agent_role != null ? { agentRole: r.agent_role } : {}),
    source: r.source as 'model' | 'tool',
    lever: r.lever as CostLever,
    subject: r.subject,
    ...(r.provider != null ? { provider: r.provider } : {}),
    ...(r.input_tokens != null ? { inputTokens: num(r.input_tokens) } : {}),
    ...(r.output_tokens != null ? { outputTokens: num(r.output_tokens) } : {}),
    ...(r.cached_tokens != null ? { cachedTokens: num(r.cached_tokens) } : {}),
    ...(r.reasoning_tokens != null ? { reasoningTokens: num(r.reasoning_tokens) } : {}),
    costUsd: num(r.cost_usd),
    observedAt: num(r.observed_at),
    ...(meta !== undefined ? { metadata: meta } : {}),
  };
}

export interface WeavePostgresCostLedgerOptions {
  pool: Pool;
  /** When true (default), runs idempotent CREATE TABLE / CREATE INDEX. */
  ensureSchema?: boolean;
}

export async function weavePostgresCostLedger(opts: WeavePostgresCostLedgerOptions): Promise<CostLedger> {
  const { pool, ensureSchema = true } = opts;
  if (ensureSchema) {
    const c: PoolClient = await pool.connect();
    try { await c.query(MIGRATIONS_SQL); } finally { c.release(); }
  }

  return {
    async record(entry: CostLedgerEntry): Promise<void> {
      try {
        await pool.query(
          `INSERT INTO cost_ledger_entries
            (id, run_id, step_id, agent_id, agent_role, source, lever, subject, provider,
             input_tokens, output_tokens, cached_tokens, reasoning_tokens, cost_usd, observed_at, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           ON CONFLICT (id) DO NOTHING`,
          [
            entry.id,
            entry.runId,
            entry.stepId ?? null,
            entry.agentId ?? null,
            entry.agentRole ?? null,
            entry.source,
            entry.lever,
            entry.subject,
            entry.provider ?? null,
            entry.inputTokens ?? null,
            entry.outputTokens ?? null,
            entry.cachedTokens ?? null,
            entry.reasoningTokens ?? null,
            entry.costUsd,
            entry.observedAt,
            entry.metadata ? JSON.stringify(entry.metadata) : null,
          ],
        );
      } catch {
        // best-effort — never throw
      }
    },
    async total(runId: string): Promise<number> {
      const r = await pool.query<{ total: number | string }>(
        'SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_ledger_entries WHERE run_id = $1',
        [runId],
      );
      const v = r.rows[0]?.total ?? 0;
      return num(v);
    },
    async breakdown(runId: string): Promise<CostBreakdown> {
      const r = await pool.query<EntryRow>(
        'SELECT * FROM cost_ledger_entries WHERE run_id = $1 ORDER BY observed_at ASC, id ASC',
        [runId],
      );
      const entries = r.rows.map(rowToEntry);
      const byLever: Record<string, number> = {};
      const byModel: Record<string, number> = {};
      const bySubject: Record<string, number> = {};
      const byAgent: Record<string, number> = {};
      let totalUsd = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let cachedTokens = 0;
      let reasoningTokens = 0;
      for (const e of entries) {
        totalUsd += e.costUsd;
        byLever[e.lever] = (byLever[e.lever] ?? 0) + e.costUsd;
        bySubject[e.subject] = (bySubject[e.subject] ?? 0) + e.costUsd;
        if (e.source === 'model') byModel[e.subject] = (byModel[e.subject] ?? 0) + e.costUsd;
        if (e.agentId) byAgent[e.agentId] = (byAgent[e.agentId] ?? 0) + e.costUsd;
        inputTokens += e.inputTokens ?? 0;
        outputTokens += e.outputTokens ?? 0;
        cachedTokens += e.cachedTokens ?? 0;
        reasoningTokens += e.reasoningTokens ?? 0;
      }
      // unused helper kept for symmetry with numOrNull at boundary
      void numOrNull;
      return {
        runId,
        totalUsd,
        entryCount: entries.length,
        byLever: byLever as Record<CostLever, number>,
        byModel,
        bySubject,
        byAgent,
        tokens: { input: inputTokens, output: outputTokens, cached: cachedTokens, reasoning: reasoningTokens },
        entries,
      };
    },
  };
}
