/**
 * Phase 2.5 — public types for the live-agents LLM loop scaffold.
 *
 * Kept intentionally small so the seam stays narrow. Heavier types
 * (`Model`, `ToolRegistry`, `ExecutionContext`) come from `@weaveintel/core`
 * and flow through the loop unchanged.
 */

/** Capability-style spec used by Phase 3.5 model resolution. */
export interface ModelCapabilitySpec {
  task?: 'reasoning' | 'tool_use' | 'summarisation' | 'classification' | string;
  toolUse?: boolean;
  minContextTokens?: number;
  /** Free-form hints reserved for routing implementations. */
  hints?: Record<string, unknown>;
}

/** Per-run budget envelope. The live-agents runtime decrements these
 *  *outside* a single tick; the loop itself enforces the ceilings the
 *  caller passes in. */
export interface LiveAgentBudget {
  maxSteps?: number;
  maxToolCalls?: number;
  maxTokens?: number;
  maxWallMs?: number;
}

/** Terminal status of a live-react loop. The set is small-on-purpose so
 *  callers can switch on it without unknown-fallback drift. */
export type LiveAgentRunStatus =
  | 'completed'
  | 'awaiting_tool_result'
  | 'awaiting_approval'
  | 'budget_exhausted'
  | 'cancelled'
  | 'paused_until_tick'
  | 'errored';
