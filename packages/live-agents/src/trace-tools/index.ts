// SPDX-License-Identifier: MIT
/**
 * @weaveintel/live-agents/trace-tools — domain-agnostic, run-scoped trace
 * retrieval for any DB-driven live agent.
 *
 * Build a `ToolRegistry` with 5 read-only tools (`live_get_run_timeline`,
 * `live_get_failed_attempts`, `live_get_recent_events`,
 * `live_get_event_details`, `live_get_step_artifact`) closure-bound to one
 * runId. Reuses Phase-2 prepare-config recipes via the
 * `tools: { traceTools: '$auto' }` shape (see
 * `@weaveintel/live-agents-runtime/db-prepare-resolver`).
 *
 * Reusability invariant: depends only on `@weaveintel/core` +
 * `@weaveintel/tools`. Consumers supply structural readers; the package
 * never touches a SQL driver.
 */

export type {
  CostSoFarReader,
  LiveRunEventLike,
  LiveRunEventReader,
  LiveRunStepLike,
  LiveRunStepReader,
} from './reader.js';
export {
  createLiveTraceTools,
  type CreateLiveTraceToolsOptions,
} from './trace-tools.js';
