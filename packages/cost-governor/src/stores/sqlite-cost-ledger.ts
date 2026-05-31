/**
 * SQLite-backed CostLedger.
 *
 * Persists every `CostLedgerEntry` into a single `cost_ledger_entries` table
 * and computes `total()` + `breakdown()` via SQL aggregation. Idempotent on
 * duplicate ids (INSERT OR IGNORE). Best-effort — sink failures are caught.
 */
import Database from 'better-sqlite3';
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
  cost_usd REAL NOT NULL,
  observed_at INTEGER NOT NULL,
  metadata TEXT
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
  input_tokens: number | null;
  output_tokens: number | null;
  cached_tokens: number | null;
  reasoning_tokens: number | null;
  cost_usd: number;
  observed_at: number;
  metadata: string | null;
}

function rowToEntry(r: EntryRow): CostLedgerEntry {
  let metadata: Record<string, unknown> | undefined;
  if (r.metadata) {
    try { metadata = JSON.parse(r.metadata) as Record<string, unknown>; } catch { metadata = undefined; }
  }
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
    ...(r.input_tokens != null ? { inputTokens: r.input_tokens } : {}),
    ...(r.output_tokens != null ? { outputTokens: r.output_tokens } : {}),
    ...(r.cached_tokens != null ? { cachedTokens: r.cached_tokens } : {}),
    ...(r.reasoning_tokens != null ? { reasoningTokens: r.reasoning_tokens } : {}),
    costUsd: r.cost_usd,
    observedAt: r.observed_at,
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

export interface WeaveSqliteCostLedgerOptions {
  database?: Database.Database;
  databasePath?: string;
}

export function weaveSqliteCostLedger(opts: WeaveSqliteCostLedgerOptions = {}): CostLedger {
  const db = opts.database ?? new Database(opts.databasePath ?? ':memory:');
  db.exec(MIGRATIONS_SQL);

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO cost_ledger_entries
      (id, run_id, step_id, agent_id, agent_role, source, lever, subject, provider,
       input_tokens, output_tokens, cached_tokens, reasoning_tokens, cost_usd, observed_at, metadata)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const totalStmt = db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_ledger_entries WHERE run_id = ?');
  const listStmt = db.prepare('SELECT * FROM cost_ledger_entries WHERE run_id = ? ORDER BY observed_at ASC, id ASC');

  return {
    async record(entry: CostLedgerEntry): Promise<void> {
      try {
        insertStmt.run(
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
        );
      } catch {
        // best-effort sink — never throw
      }
    },
    async total(runId: string): Promise<number> {
      const row = totalStmt.get(runId) as { total: number } | undefined;
      return row?.total ?? 0;
    },
    async breakdown(runId: string): Promise<CostBreakdown> {
      const rows = listStmt.all(runId) as EntryRow[];
      const entries = rows.map(rowToEntry);
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
