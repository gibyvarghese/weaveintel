/**
 * Structural reader interfaces for live-agent trace tools.
 *
 * The package never imports any DB type. Consumers (a host application, custom apps,
 * tests) implement these slim shapes around their own persistence so the
 * trace tools remain reusable across runtimes (SQLite, Postgres, in-memory).
 *
 * All shapes mirror `live_run_events` / `live_run_steps` columns by name so
 * a `DatabaseAdapter` can satisfy the contract structurally with zero
 * adapter code in the common case.
 */

/** A row from the `live_run_events` append-only ledger. */
export interface LiveRunEventLike {
  id: string;
  run_id: string;
  step_id: string | null;
  kind: string;
  agent_id: string | null;
  tool_key: string | null;
  summary: string | null;
  payload_json: string | null;
  created_at: string;
}

/** A row from the `live_run_steps` per-agent progress ledger. */
export interface LiveRunStepLike {
  id: string;
  run_id: string;
  mesh_id: string;
  agent_id: string | null;
  role_key: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  summary: string | null;
  payload_json: string | null;
  created_at: string;
  updated_at: string;
}

/** Read slice of the live-run-events ledger. */
export interface LiveRunEventReader {
  /** List events for ONE run. The caller controls runId — implementations
   *  MUST scope by `runId` and ignore other runs entirely. `afterId` is a
   *  forward cursor (events strictly newer than that id). */
  listEvents(opts: {
    runId: string;
    afterId?: string;
    limit?: number;
  }): Promise<readonly LiveRunEventLike[]>;
  /** Fetch one event by id. May return events from any run — the trace
   *  tools re-validate `row.run_id === closure runId` before returning,
   *  so a slightly-too-permissive implementation is safe by construction. */
  getEvent(id: string): Promise<LiveRunEventLike | null>;
}

/** Read slice of the live-run-steps ledger. Optional — when omitted, the
 *  timeline tool degrades gracefully and uses event kinds to reconstruct
 *  step progress instead. */
export interface LiveRunStepReader {
  listSteps(opts: { runId: string }): Promise<readonly LiveRunStepLike[]>;
  getStep(id: string): Promise<LiveRunStepLike | null>;
}

/** Optional running-cost reader. When supplied, the timeline tool emits a
 *  `costUsdSoFar` field so the model can reason about its own remaining
 *  budget (Phase 9 cross-cut from the cost-governor budget gate). */
export type CostSoFarReader = (runId: string) => Promise<number | null>;
