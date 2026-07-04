/**
 * @weaveintel/cost-governor — (Telemetry & Cost Ledger)
 *
 * Phase 1 is purely observational. The ledger records every model + tool
 * invocation with token + $ + lever attribution so downstream phases can
 * measure savings against a real baseline.
 *
 * No behaviour change at this layer — it never blocks, never gates, and
 * never throws into the hot path. Sinks are best-effort.
 */

/**
 * Logical lever a cost entry should be attributed to. Used by the admin
 * breakdown UI and (later) by Phase 2+ governors that want to enforce
 * per-lever ceilings.
 *
 *  - `model`     — generative LLM tokens (the dominant lever today).
 *  - `tool`      — tool/MCP invocation. $0 in Phase 1 (inventory only).
 *  - `rag`       — embedding / retrieval calls.
 *  - `reasoning` — explicit reasoning-token premium (o-series, claude-thinking).
 *  - `cache`     — cached-prompt write/read accounting.
 *  - `other`     — uncategorised.
 */
export type CostLever = 'model' | 'tool' | 'rag' | 'reasoning' | 'cache' | 'other';

/** A model `usage` block normalised across providers. */
export interface ModelUsageObservation {
  readonly modelId: string;
  readonly provider?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedTokens?: number;
  readonly reasoningTokens?: number;
}

/** One ledger row. Append-only; sinks decide where it lands. */
export interface CostLedgerEntry {
  readonly id: string;
  /** Logical run this entry belongs to (e.g. kgl_competition_runs.id). */
  readonly runId: string;
  /** Optional step id when the entry happens inside a known workflow step. */
  readonly stepId?: string;
  /** Optional agent id when the entry happens inside a live-agent tick. */
  readonly agentId?: string;
  /** Optional human-readable agent role label (strategist, validator, …). */
  readonly agentRole?: string;
  /** What kind of work produced the cost — model call, tool call, etc. */
  readonly source: 'model' | 'tool';
  /** Lever attribution (see CostLever). */
  readonly lever: CostLever;
  /** Model id when source = 'model'; tool name when source = 'tool'. */
  readonly subject: string;
  /** Provider id when known. */
  readonly provider?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedTokens?: number;
  readonly reasoningTokens?: number;
  /** Cost in USD. 0 is a valid value (e.g. tool inventory rows). */
  readonly costUsd: number;
  readonly observedAt: number; // epoch ms
  readonly metadata?: Record<string, unknown>;
}

/** Per-run rollup returned by `ledger.breakdown(runId)`. */
export interface CostBreakdown {
  readonly runId: string;
  readonly totalUsd: number;
  readonly entryCount: number;
  readonly byLever: Record<CostLever, number>;
  readonly byModel: Record<string, number>;
  readonly bySubject: Record<string, number>;
  readonly byAgent: Record<string, number>;
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly cached: number;
    readonly reasoning: number;
  };
  readonly entries: ReadonlyArray<CostLedgerEntry>;
}

/**
 * Ledger interface — record now, query later. Implementations MUST be
 * idempotent on duplicate ids and MUST NOT throw on sink failure.
 */
export interface CostLedger {
  record(entry: CostLedgerEntry): Promise<void>;
  total(runId: string): Promise<number>;
  breakdown(runId: string): Promise<CostBreakdown>;
}

/**
 * Sink primitive — narrower than the full CostLedger so apps can plug in
 * a DB writer (e.g. live_run_events) without re-implementing breakdown
 * aggregation. The aggregator side is provided by the in-memory ledger
 * or by an app-side query that reads the same backing store.
 */
export interface CostLedgerSink {
  append(entry: CostLedgerEntry): Promise<void>;
}

/** Lookup of $/1M token rates for cost calculation. */
export interface PricingResolver {
  /**
   * Returns input + output dollars-per-million for the given model id, or
   * `null` when no pricing is known. Implementations should be cached.
   */
  resolve(modelId: string): Promise<PricingRate | null> | PricingRate | null;
}

export interface PricingRate {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
}

/** Compute USD cost from a token usage observation + pricing rate. */
export function computeUsd(usage: ModelUsageObservation, rate: PricingRate | null | undefined): number {
  if (!rate) return 0;
  return (usage.inputTokens / 1_000_000) * rate.inputPerMillion
       + (usage.outputTokens / 1_000_000) * rate.outputPerMillion;
}
