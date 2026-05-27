/** Workflow definitions, triggers, mesh contracts, and run types. */

export interface WorkflowDefRow {
  id: string;
  name: string;
  description: string | null;
  version: string;
  steps: string;                  // JSON array
  entry_step_id: string;
  metadata: string | null;        // JSON object
  enabled: number;
  created_at: string;
  updated_at: string;
}

/**
 * Workflow Platform Phase 1 — Catalog of registered HandlerResolver kinds.
 * One row per kind a host process registers (e.g. 'tool', 'prompt',
 * 'agent', 'mcp', 'script', 'subworkflow', 'noop'). Synced from the
 * @weaveintel/workflows resolver registry at startup so admin UIs can
 * render handler-kind pickers without hardcoded enums.
 */
export interface WorkflowHandlerKindRow {
  id: string;
  kind: string;
  description: string | null;
  config_schema: string | null;   // JSON schema
  enabled: number;
  source: string;                 // 'builtin' | 'plugin'
  created_at: string;
  updated_at: string;
}

/**
 * Phase 3 — Unified Triggers (DB-driven dispatch fabric).
 * One row per operator-defined trigger. The `@weaveintel/triggers`
 * dispatcher hydrates these at startup and routes events through
 * filter -> rate-limit -> target dispatch. UUID PK; `key` is the
 * unique operator-facing alias.
 */
export interface TriggerRow {
  id: string;
  key: string;
  enabled: number;                       // 0 | 1
  source_kind: string;                   // TriggerSourceKind
  source_config: string;                 // JSON
  filter_expr: string | null;            // JSON (JSONLogic-lite)
  target_kind: string;                   // TriggerTargetKind
  target_config: string;                 // JSON
  input_map: string | null;              // JSON: { 'targetPath': 'sourcePath' }
  rate_limit_per_minute: number | null;
  metadata: string | null;               // JSON
  created_at: string;
  updated_at: string;
}

/**
 * Append-only audit row for every dispatch attempt. `status` mirrors
 * the dispatcher's `TriggerInvocationStatus` enum.
 */
export interface TriggerInvocationRow {
  id: string;
  trigger_id: string;
  fired_at: string;                      // ISO datetime
  source_kind: string;                   // TriggerSourceKind
  status: string;                        // TriggerInvocationStatus
  target_ref: string | null;
  error_message: string | null;
  source_event: string | null;           // JSON preview (truncated by dispatcher)
  created_at: string;
}

/**
 * Phase 4 (DB-driven capability plan) — Mesh contract ledger.
 * One row per emission via `ContractEmitter`. The triggers dispatcher
 * subscribes to a Node EventEmitter the writer also notifies, so each
 * row doubles as audit trail and the source event for
 * `sourceKind: 'contract_emitted'` triggers.
 */
export interface MeshContractRow {
  id: string;
  kind: string;
  body_json: string;                     // JSON-encoded body
  evidence_json: string | null;          // JSON-encoded evidence (optional)
  mesh_id: string | null;
  source_workflow_definition_id: string | null;
  source_workflow_run_id: string | null;
  source_agent_id: string | null;
  metadata: string | null;               // JSON-encoded metadata
  emitted_at: string;
  created_at: string;
}

export interface WorkflowRunRow {
  id: string;
  workflow_id: string;
  status: string;
  state: string;
  input: string | null;
  error: string | null;
  started_at: string;
  completed_at: string | null;
  cost_total?: number | null;
  metadata?: string | null;
  /** Phase W3 — distributed trace ID for context propagation. */
  trace_id?: string | null;
  /** Phase W3 — tenant identifier for multi-tenant deployments. */
  tenant_id?: string | null;
}

/** Phase W3 — large payload offload store row. */
export interface WorkflowPayloadRow {
  key: string;
  run_id: string;
  step_id: string;
  data: string;   // JSON-serialised payload
  created_at: string;
}

export interface WorkflowCheckpointRow {
  id: string;
  run_id: string;
  workflow_id: string;
  step_id: string;
  state: string;
  created_at: string;
}

export interface CapabilityPolicyBindingRow {
  id: string;
  binding_kind: string;
  binding_ref: string;
  policy_kind: string;
  policy_ref: string;
  precedence: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}
