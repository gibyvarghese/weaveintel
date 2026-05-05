/**
 * @weaveintel/geneweave — Database types
 *
 * Row interfaces, metric summaries, and the DatabaseAdapter interface.
 */

// ─── Row types ───────────────────────────────────────────────

export interface UserRow {
  id: string;
  email: string;
  name: string;
  persona: string;
  tenant_id: string | null;
  password_hash: string;
  created_at: string;
}

export interface SessionRow {
  id: string;
  user_id: string;
  csrf_token: string;
  expires_at: string;
  created_at: string;
}

export interface OAuthLinkedAccountRow {
  id: string;
  user_id: string;
  provider: string;              // google | github | microsoft | apple | facebook
  provider_user_id: string;      // ID from OAuth provider
  email: string;
  name: string;
  picture_url: string | null;
  linked_at: string;
  last_used_at: string | null;
}

export interface ChatRow {
  id: string;
  user_id: string;
  title: string;
  model: string;
  provider: string;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  chat_id: string;
  role: string;
  content: string;
  metadata: string | null;
  tokens_used: number;
  cost: number;
  latency_ms: number;
  created_at: string;
}

export interface MetricRow {
  id: string;
  user_id: string;
  chat_id: string | null;
  type: string;
  provider: string | null;
  model: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost: number;
  latency_ms: number;
  metadata: string | null;
  created_at: string;
}

export interface EvalRow {
  id: string;
  user_id: string;
  chat_id: string | null;
  eval_name: string;
  score: number;
  passed: number;
  failed: number;
  total: number;
  details: string | null;
  created_at: string;
}

export interface UserPreferencesRow {
  user_id: string;
  default_mode: string;
  theme: string;
  show_process_card: number;
  updated_at: string;
}

export interface ChatSettingsRow {
  chat_id: string;
  mode: string;
  system_prompt: string | null;
  timezone: string | null;
  enabled_tools: string | null;
  redaction_enabled: number;
  redaction_patterns: string | null;
  workers: string | null;
  updated_at: string;
}

export interface TraceRow {
  id: string;
  user_id: string;
  chat_id: string | null;
  message_id: string | null;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  start_time: number;
  end_time: number | null;
  status: string | null;
  attributes: string | null;
  events: string | null;
  created_at: string;
}

export interface TemporalTimerRow {
  id: string;
  scope_id: string;
  label: string | null;
  duration_ms: number | null;
  state: string;
  created_at: string;
  started_at: string | null;
  paused_at: string | null;
  resumed_at: string | null;
  stopped_at: string | null;
  elapsed_ms: number;
  updated_at: string;
}

export interface TemporalStopwatchRow {
  id: string;
  scope_id: string;
  label: string | null;
  state: string;
  created_at: string;
  started_at: string | null;
  paused_at: string | null;
  resumed_at: string | null;
  stopped_at: string | null;
  elapsed_ms: number;
  laps_json: string;
  updated_at: string;
}

export interface TemporalReminderRow {
  id: string;
  scope_id: string;
  text: string;
  due_at: string;
  timezone: string;
  status: string;
  created_at: string;
  cancelled_at: string | null;
  updated_at: string;
}

// ─── Admin config row types ──────────────────────────────────

export interface PromptRow {
  id: string;
  key: string | null;
  name: string;
  description: string | null;
  category: string | null;
  prompt_type: string;
  owner: string | null;
  status: string;
  tags: string | null;            // JSON array
  template: string;
  variables: string | null;       // JSON PromptVariable[]
  version: string;
  model_compatibility: string | null; // JSON object
  execution_defaults: string | null;  // JSON object
  framework: string | null;       // JSON object
  metadata: string | null;        // JSON object
  is_default: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/**
 * A named, ordered prompt section structure stored in the `prompt_frameworks` table.
 * Rows are loaded at runtime into an InMemoryFrameworkRegistry via frameworkFromRecord().
 */
export interface PromptFrameworkRow {
  id: string;
  key: string;                    // Unique short identifier, e.g. 'rtce'
  name: string;                   // Display name
  description: string | null;
  sections: string;               // JSON: PromptFrameworkSectionDef[]
  section_separator: string;      // Separator between assembled sections (default '\n\n')
  enabled: number;
  created_at: string;
  updated_at: string;
}

/**
 * A reusable text block stored in `prompt_fragments`, includable via `{{>key}}` syntax.
 * Rows are loaded at runtime into an InMemoryFragmentRegistry via fragmentFromRecord().
 */
export interface PromptFragmentRow {
  id: string;
  key: string;                    // Unique fragment key, referenced in templates as {{>key}}
  name: string;                   // Display name
  description: string | null;
  category: string | null;        // Organisational grouping (e.g. 'safety', 'personas')
  content: string;                // The fragment text body (may contain {{variables}})
  variables: string | null;       // JSON: FragmentVariable[]
  tags: string | null;            // JSON: string[]
  version: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/**
 * Output contract stored in `prompt_contracts`. Contracts validate or enforce constraints
 * on LLM output: JSON structure, markdown sections, code quality, length, forbidden content, etc.
 * Rows are loaded at runtime into an InMemoryContractRegistry via contractFromRecord().
 */
export interface PromptContractRow {
  id: string;
  key: string;                    // Unique contract key
  name: string;                   // Display name
  description: string | null;     // Detailed description for model understanding
  contract_type: string;          // 'json' | 'markdown' | 'code' | 'max_length' | 'forbidden_content' | 'structured'
  schema: string | null;          // JSON: JSONSchema7 (for json contracts)
  config: string;                 // JSON: Contract-specific config (severity, repairHook, constraints, etc.)
  enabled: number;
  created_at: string;
  updated_at: string;
}

/**
 * Prompt strategy stored in `prompt_strategies`. Strategies are model-facing
 * execution overlays selected by execution_defaults.strategy.
 */
export interface PromptStrategyRow {
  id: string;
  key: string;                    // Unique strategy key, e.g. 'singlePass' or 'critiqueRevise'
  name: string;                   // Display name
  description: string | null;     // Detailed model-facing description
  instruction_prefix: string | null;
  instruction_suffix: string | null;
  config: string;                 // JSON object for strategy runtime options
  enabled: number;
  created_at: string;
  updated_at: string;
}

/**
 * Prompt version rows for lifecycle-safe resolution. This separates mutable
 * prompt metadata from concrete version payloads used at runtime.
 */
export interface PromptVersionRow {
  id: string;
  prompt_id: string;
  version: string;
  status: string;                // draft | published | retired
  template: string;
  variables: string | null;      // JSON PromptVariable[]
  model_compatibility: string | null;
  execution_defaults: string | null;
  framework: string | null;
  metadata: string | null;
  is_active: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/**
 * Prompt experiment rows used for deterministic variant assignment.
 */
export interface PromptExperimentRow {
  id: string;
  prompt_id: string;
  name: string;
  description: string | null;
  status: string;                // draft | active | completed
  variants_json: string;         // JSON: [{ version, weight, label? }]
  assignment_key_template: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/**
 * Prompt evaluation datasets for Phase 7. Each dataset is attached to one
 * prompt and optionally pins a specific prompt version.
 */
export interface PromptEvalDatasetRow {
  id: string;
  prompt_id: string;
  name: string;
  description: string | null;
  prompt_version: string | null;
  status: string;                // draft | active | archived
  pass_threshold: number;
  cases_json: string;            // JSON: PromptEvalCase[]
  rubric_json: string | null;    // JSON: PromptEvalRubricCriterion[]
  metadata: string | null;       // JSON object
  enabled: number;
  created_at: string;
  updated_at: string;
}

/**
 * Historical evaluation execution artifacts for prompt versions.
 */
export interface PromptEvalRunRow {
  id: string;
  dataset_id: string;
  prompt_id: string;
  prompt_version: string;
  status: string;                // completed | failed
  avg_score: number;
  passed_cases: number;
  failed_cases: number;
  total_cases: number;
  results_json: string;          // JSON: case-level outputs
  summary_json: string | null;   // JSON: aggregate summary
  metadata: string | null;       // JSON object
  created_at: string;
  completed_at: string | null;
}

/**
 * DB-managed prompt optimizer profiles used by app runtimes to select and
 * configure optimization engines.
 */
export interface PromptOptimizerRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  implementation_kind: string;   // rule | llm | hybrid
  config: string;                // JSON object
  enabled: number;
  created_at: string;
  updated_at: string;
}

/**
 * Historical optimization run artifacts for audit and rollback workflows.
 */
export interface PromptOptimizationRunRow {
  id: string;
  prompt_id: string;
  source_version: string;
  candidate_version: string;
  optimizer_id: string | null;
  objective: string;
  source_template: string;
  candidate_template: string;
  diff_json: string;             // JSON: normalized diff metadata
  eval_baseline_json: string | null;
  eval_candidate_json: string | null;
  status: string;                // completed | failed
  metadata: string | null;
  created_at: string;
}

export interface GuardrailRow {
  id: string;
  name: string;
  description: string | null;
  type: string;
  stage: string;
  config: string | null;          // JSON object
  priority: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface RoutingPolicyRow {
  id: string;
  name: string;
  description: string | null;
  strategy: string;
  constraints: string | null;     // JSON object
  weights: string | null;         // JSON object
  fallback_model: string | null;
  fallback_provider: string | null;
  /** Phase 1 anyWeave routing — JSON [{modelId, provider, priority}]. */
  fallback_chain?: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface ModelPricingRow {
  id: string;
  model_id: string;
  provider: string;
  display_name: string | null;
  input_cost_per_1m: number;
  output_cost_per_1m: number;
  quality_score: number;
  source: string;                 // 'manual' | 'sync' | 'seed'
  last_synced_at: string | null;
  enabled: number;
  /** Phase 1 anyWeave routing — 'text' | 'image' | 'audio' | 'video' | 'embedding' | 'multimodal'. */
  output_modality?: string;
  created_at: string;
  updated_at: string;
}

// ─── anyWeave Task-Aware Routing — Phase 1 row types ──────────
// Design doc: docs/ANYWEAVE_TASK_AWARE_ROUTING.md.
// All UUID PKs (TEXT). String JSON columns are decoded by callers.

export interface TaskTypeDefinitionRow {
  id: string;
  task_key: string;
  display_name: string;
  category: string;
  description: string;
  /** 'text' | 'code' | 'image' | 'audio' | 'video' | 'embedding' | 'multimodal'. */
  output_modality: string;
  /** 'cost' | 'speed' | 'quality' | 'capability' | 'balanced'. */
  default_strategy: string;
  /** JSON {cost,speed,quality,capability} summing to 1. */
  default_weights: string;
  /** JSON {keywords?: string[], requiresVision?: boolean, ...}. */
  inference_hints: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface ModelCapabilityScoreRow {
  id: string;
  /** NULL = global default; otherwise tenant-specific override. */
  tenant_id: string | null;
  model_id: string;
  provider: string;
  task_key: string;
  /** 0–100 quality score for this (model, task) pair. */
  quality_score: number;
  supports_tools: number;
  supports_streaming: number;
  supports_thinking: number;
  supports_json_mode: number;
  supports_vision: number;
  max_output_tokens: number | null;
  benchmark_source: string | null;
  raw_benchmark_score: number | null;
  is_active: number;
  last_evaluated_at: string | null;
  /** Phase 5 — separate production telemetry signal (0–100). Null until first signal. */
  production_signal_score: number | null;
  /** Phase 5 — number of signals contributing to production_signal_score. */
  signal_sample_count: number;
  created_at: string;
  updated_at: string;
}

export interface TaskTypeTenantOverrideRow {
  id: string;
  tenant_id: string;
  task_key: string;
  /** JSON {cost,speed,quality,capability}. */
  weights: string | null;
  preferred_model_id: string | null;
  preferred_provider: string | null;
  preferred_boost_pct: number;
  cost_ceiling_per_call: number | null;
  optimisation_strategy: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface ProviderToolAdapterRow {
  id: string;
  provider: string;
  display_name: string;
  /** Module path (e.g. '@weaveintel/tool-schema/anthropic'). */
  adapter_module: string;
  /** 'anthropic_xml' | 'openai_json' | 'google_function' | 'mistral_function' | 'custom'. */
  tool_format: string;
  /** 'tool_use_block' | 'function_call' | 'tool_calls_array'. */
  tool_call_response_format: string;
  /** 'tool_result_block' | 'tool_message' | 'function_response'. */
  tool_result_format: string;
  /** 'system_message' | 'first_user_message' | 'separate_field'. */
  system_prompt_location: string;
  name_validation_regex: string;
  max_tool_count: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface RoutingDecisionTraceRow {
  id: string;
  tenant_id: string | null;
  agent_id: string | null;
  workflow_step_id: string | null;
  task_key: string | null;
  /** 'agent_default' | 'inference' | 'explicit' | 'workflow_step'. */
  inference_source: string | null;
  selected_model_id: string;
  selected_provider: string;
  selected_capability_score: number | null;
  /** JSON {cost,speed,quality,capability}. */
  weights_used: string;
  /** JSON [{modelId, provider, score, breakdown:{...}}]. */
  candidate_breakdown: string;
  tool_translation_applied: number;
  source_provider: string | null;
  estimated_cost_usd: number | null;
  decided_at: string;
}

/** Phase 5 — append-only signal log feeding capability score recompute. */
export interface RoutingCapabilitySignalRow {
  id: string;
  tenant_id: string | null;
  model_id: string;
  provider: string;
  task_key: string;
  /** 'eval' | 'chat' | 'cache' | 'production'. */
  source: string;
  /** Free-form per source (e.g. 'thumbs_up', 'json_compliance', 'rouge'). */
  signal_type: string;
  /** Normalised 0–100 contribution to quality_score. */
  value: number;
  /** Multiplier applied to the rolling-avg recompute (default 1.0). */
  weight: number;
  evidence_id: string | null;
  message_id: string | null;
  trace_id: string | null;
  /** JSON object for source-specific context. */
  metadata: string | null;
  created_at: string;
}

/** Phase 5 — chat UI feedback (👍/👎/regenerate/copy) per message. */
export interface MessageFeedbackRow {
  id: string;
  message_id: string;
  chat_id: string | null;
  user_id: string | null;
  /** 'thumbs_up' | 'thumbs_down' | 'regenerate' | 'copy'. */
  signal: string;
  comment: string | null;
  /** Snapshot of resolved (model, provider, task_key) at submit time. */
  model_id: string | null;
  provider: string | null;
  task_key: string | null;
  created_at: string;
}

/** Phase 5 — alerts emitted by the regression detection job. */
export interface RoutingSurfaceItemRow {
  id: string;
  /** 'quality_regression' | 'auto_disabled' | 'low_signal_volume'. */
  kind: string;
  /** 'info' | 'warning' | 'critical'. */
  severity: string;
  model_id: string;
  provider: string;
  task_key: string;
  tenant_id: string | null;
  message: string;
  metric_7d: number | null;
  metric_30d: number | null;
  drop_pct: number | null;
  sample_count_7d: number | null;
  sample_count_30d: number | null;
  auto_disabled: number;
  /** 'open' | 'acknowledged' | 'resolved'. */
  status: string;
  resolution_note: string | null;
  created_at: string;
  resolved_at: string | null;
}

/** Phase 6 — A/B routing experiment definitions. */
export interface RoutingExperimentRow {
  id: string;
  name: string;
  description: string | null;
  /** null = applies to all tenants. */
  tenant_id: string | null;
  /** null = applies to all task keys. */
  task_key: string | null;
  baseline_provider: string;
  baseline_model_id: string;
  candidate_provider: string;
  candidate_model_id: string;
  /** 0–100. Percentage of matching traffic routed to candidate. */
  traffic_pct: number;
  /** 'active' | 'paused' | 'completed'. */
  status: string;
  /** JSON object — free-form experiment metadata. */
  metadata: string | null;
  started_at: string;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

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

export interface ToolCatalogRow {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  risk_level: string;
  requires_approval: number;
  max_execution_ms: number | null;
  rate_limit_per_min: number | null;
  enabled: number;
  tool_key: string | null;
  version: string;
  side_effects: number;
  tags: string | null;           // JSON string[]
  source: string;                // 'builtin' | 'mcp' | 'a2a' | 'custom'
  credential_id: string | null;
  config?: string | null;        // JSON: e.g. { endpoint } for MCP, { agentUrl } for A2A
  allocation_class?: string | null; // utility | web | social | search | cse | http | enterprise | code | data | communication
  created_at: string;
  updated_at: string;
}

/** @deprecated Use ToolCatalogRow */
export type ToolConfigRow = ToolCatalogRow;

export interface ToolPolicyRow {
  id: string;
  key: string;
  name: string;
  description: string | null;
  applies_to: string | null;              // JSON string[]
  applies_to_risk_levels: string | null;  // JSON string[]
  approval_required: number;
  allowed_risk_levels: string | null;     // JSON string[]
  max_execution_ms: number | null;
  rate_limit_per_minute: number | null;
  max_concurrent: number | null;
  require_dry_run: number;
  log_input_output: number;
  persona_scope: string | null;           // JSON string[]
  active_hours_utc: string | null;        // JSON { start: "HH:MM", end: "HH:MM" }
  expires_at: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface ToolRateLimitBucketRow {
  id: string;
  tool_name: string;
  scope_key: string;
  window_start: string;
  count: number;
}

// ─── Phase 3: Audit + Health ──────────────────────────────────

export interface ToolAuditEventRow {
  id: string;
  tool_name: string;
  chat_id: string | null;
  user_id: string | null;
  agent_persona: string | null;
  skill_key: string | null;
  policy_id: string | null;
  outcome: string;             // ToolAuditOutcome
  violation_reason: string | null;
  duration_ms: number | null;
  input_preview: string | null;
  output_preview: string | null;
  error_message: string | null;
  metadata: string | null;     // JSON
  created_at: string;
}

export interface ToolHealthSnapshotRow {
  id: string;
  tool_name: string;
  snapshot_at: string;
  invocation_count: number;
  success_count: number;
  error_count: number;
  denied_count: number;
  avg_duration_ms: number | null;
  p95_duration_ms: number | null;
  error_rate: number;
  availability: number;
  created_at: string;
}

export interface ToolHealthSummary {
  tool_name: string;
  total_invocations: number;
  success_count: number;
  error_count: number;
  denied_count: number;
  avg_duration_ms: number | null;
  error_rate: number;
  availability: number;
  last_invoked_at: string | null;
}

/** Phase 4: Credential binding for tools that require external API keys.
 *  The actual secret lives in the env var named by `env_var_name`; no
 *  plaintext secrets are stored in this row. */
export interface ToolCredentialRow {
  id: string;
  name: string;
  description: string | null;
  /** Type of credential: api_key | oauth_token | basic_auth | jwt | custom */
  credential_type: string;
  /** JSON array of tool_key strings that use this credential */
  tool_names: string | null;
  /** Name of the environment variable that holds the secret value */
  env_var_name: string | null;
  /** JSON blob: { headerName?: string; prefix?: string; [key: string]: unknown } */
  config: string | null;
  /** ISO datetime when the credential is due for rotation */
  rotation_due_at: string | null;
  /** Validation status: valid | invalid | unknown | expired */
  validation_status: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/** Phase 5: Per-client MCP gateway bearer token. The plaintext token is
 *  never persisted — only its SHA-256 digest in `token_hash`. The client
 *  presents the raw token; we hash + look up by hash in constant time. */
export interface MCPGatewayClientRow {
  id: string;
  /** Operator-facing name (e.g. "claude-desktop-laptop", "ci-runner"). */
  name: string;
  description: string | null;
  /** SHA-256 hex digest of the bearer token. Never null; never plaintext. */
  token_hash: string;
  /** JSON array of allocation classes this client may reach.
   *  When null, the client inherits the gateway-wide exposed_classes set. */
  allowed_classes: string | null;
  /** Audit chat_id stamped on every tool_audit_events row from this client.
   *  When null, defaults to `mcp-gateway:<name>`. */
  audit_chat_id: string | null;
  enabled: number;
  last_used_at: string | null;
  /** ISO timestamp set when the operator revokes this client. NULL = active. */
  revoked_at: string | null;
  /** Phase 7: per-client request rate cap (requests per minute). NULL = no cap. */
  rate_limit_per_minute: number | null;
  /** Phase 9: ISO timestamp at which this token stops being honored.
   *  NULL = no expiry (token is valid until manually revoked or rotated). */
  expires_at: string | null;
  /** Phase 9: ISO timestamp of the last successful token rotation.
   *  NULL = never rotated since creation. */
  rotated_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Phase 8: terminal outcome of a single MCP gateway request. */
export type MCPGatewayRequestOutcome =
  | 'ok'
  | 'rate_limited'
  | 'unauthorized'
  | 'disabled'
  | 'error'
  | 'expired';

/** Phase 8: Append-only log row capturing one MCP gateway request. */
export interface MCPGatewayRequestLogRow {
  id: string;
  /** Matched client id; null for unauthorized requests or single-tenant mode. */
  client_id: string | null;
  /** Snapshot of the client name at request time (helps when clients are deleted). */
  client_name: string | null;
  /** JSON-RPC method (e.g. 'tools/list', 'tools/call'). Null when unparseable. */
  method: string | null;
  /** Tool name when method='tools/call'; null otherwise. */
  tool_name: string | null;
  outcome: MCPGatewayRequestOutcome;
  status_code: number;
  duration_ms: number | null;
  error_message: string | null;
  created_at: string;
}

/** Phase 8: aggregate counts per gateway client over a time window. */
export interface MCPGatewayActivitySummary {
  client_id: string | null;
  client_name: string | null;
  total: number;
  ok: number;
  rate_limited: number;
  unauthorized: number;
  errors: number;
  last_seen: string | null;
}

export interface SkillRow {
  id: string;
  name: string;
  description: string;
  category: string;
  trigger_patterns: string;      // JSON string[]
  instructions: string;
  tool_names: string | null;     // JSON string[]
  examples: string | null;       // JSON array
  tags: string | null;           // JSON string[]
  priority: number;
  version: string;
  /** Phase 6: tool policy key that overrides the global tool policy while this skill is active */
  tool_policy_key: string | null;
  /** Phase 1B: optional pin to a specific supervisor agent row in `agents`. */
  supervisor_agent_id?: string | null;
  /**
   * Optional JSON array of {key,label?,content,tags?} domain-scoped
   * sub-playbooks. When set, the skill prompt renderer scores each section
   * against the user query and includes only the most relevant ones,
   * instead of merging the whole playbook into the supervisor prompt.
   */
  domain_sections?: string | null;
  /**
   * Optional JSON object describing a machine-enforced execution contract
   * for this skill (e.g. minimum delegations, required output substrings).
   * Shape: { minDelegations?: number; requiredOutputSubstrings?: string[];
   * requiredOutputPatterns?: string[] }. When set, the chat runtime
   * validates the agent result against it and reports concrete deltas
   * back to the model on retry.
   */
  execution_contract?: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/** Phase 6: Tool Approval Request — created by DbToolApprovalGate when a tool requires operator approval */
export interface ToolApprovalRequestRow {
  id: string;
  tool_name: string;
  chat_id: string;
  user_id: string | null;
  /** JSON snapshot of the tool input at the time of the request */
  input_json: string;
  policy_key: string | null;
  skill_key: string | null;
  /** pending | approved | denied | expired */
  status: string;
  requested_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
}

export interface IdempotencyRecordRow {
  id: string;
  key: string;
  result_json: string;
  expires_at: string;
  created_at: string;
}

export interface OAuthFlowStateRow {
  id: string;
  state_key: string;
  user_id: string | null;
  provider: string;
  expires_at: string;
  created_at: string;
}

export interface WorkerAgentRow {
  id: string;
  name: string;
  display_name: string | null;
  job_profile: string | null;
  description: string;
  system_prompt: string;
  tool_names: string;            // JSON string[]
  persona: string;
  trigger_patterns: string | null; // JSON string[]
  task_contract_id: string | null;
  max_retries: number;
  priority: number;
  /** Feature grouping: 'general' | 'hypothesis-validation' | other domain categories. */
  category: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/**
 * Phase 1B — DB-driven supervisor agent definition.
 * Operators register supervisor agents per-tenant and per-category. The
 * runtime resolves which row applies to a chat session and uses it to drive
 * the supervisor's name, system prompt, default timezone, utility-tools
 * inclusion flag, and curated tool bundle (via `agent_tools`).
 */
export interface SupervisorAgentRow {
  id: string;
  /** Null = global default applicable across tenants. */
  tenant_id: string | null;
  /** Routing key — 'general' or domain-scoped (e.g. 'hypothesis-validation'). */
  category: string;
  name: string;
  display_name: string | null;
  description: string | null;
  /** Optional override for supervisor system prompt. Falls back to settings.systemPrompt when null. */
  system_prompt: string | null;
  /** When 1, package-provided datetime/math_eval/unit_convert tools are auto-bound. */
  include_utility_tools: number;
  /** IANA timezone string used by the datetime utility tool. Falls back to settings.timezone. */
  default_timezone: string | null;
  /** When 1, this row is the global fallback agent if nothing else matches. */
  is_default: number;
  enabled: number;
  // ─── Phase 1 anyWeave Task-Aware Routing (optional, additive) ─────
  /** Default task type when none is inferred (e.g. 'reasoning', 'summarization'). */
  default_task_type?: string | null;
  /** JSON string[] — restricts the router to a whitelist of task keys. */
  allowed_task_types?: string | null;
  /** JSON {[taskKey]: {modelId, provider}} — agent-level model preferences per task. */
  preferred_models?: string | null;
  /** Per-call USD ceiling. Router excludes models whose estimated cost exceeds this. */
  cost_ceiling_per_call?: number | null;
  created_at: string;
  updated_at: string;
}

/** Phase 1B — explicit tool allocation per supervisor agent row. */
export interface AgentToolRow {
  agent_id: string;
  tool_name: string;
  /** 'default' | 'required' | 'optional' — operator hint, currently advisory. */
  allocation: string;
}

/**
 * Phase 1B — resolved supervisor agent + its tool allocations, ready for chat
 * runtime consumption. The runtime never queries `agents`/`agent_tools`
 * directly — it always goes through `resolveSupervisorAgent`.
 */
export interface ResolvedSupervisorAgent {
  agent: SupervisorAgentRow;
  tools: AgentToolRow[];
}

export interface HumanTaskPolicyRow {
  id: string;
  name: string;
  description: string | null;
  trigger: string;
  task_type: string;
  default_priority: string;
  sla_hours: number | null;
  auto_escalate_after_hours: number | null;
  assignment_strategy: string;
  assign_to: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface TaskContractRow {
  id: string;
  name: string;
  description: string | null;
  input_schema: string | null;           // JSON object
  output_schema: string | null;          // JSON object
  acceptance_criteria: string;           // JSON array
  max_attempts: number | null;
  timeout_ms: number | null;
  evidence_required: string | null;      // JSON array
  min_confidence: number | null;
  require_human_review: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface CachePolicyRow {
  id: string;
  name: string;
  description: string | null;
  scope: string;               // 'global' | 'tenant' | 'user' | 'session' | 'agent'
  ttl_ms: number;
  max_entries: number;
  bypass_patterns: string | null;  // JSON array
  invalidate_on: string | null;    // JSON array of event types
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface IdentityRuleRow {
  id: string;
  name: string;
  description: string | null;
  resource: string;
  action: string;
  roles: string | null;           // JSON array
  scopes: string | null;          // JSON array
  result: string;                 // 'allow' | 'deny' | 'challenge'
  priority: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface MemoryGovernanceRow {
  id: string;
  name: string;
  description: string | null;
  memory_types: string | null;    // JSON array
  tenant_id: string | null;
  block_patterns: string | null;  // JSON array
  redact_patterns: string | null; // JSON array
  max_age: string | null;         // ISO 8601 duration
  max_entries: number | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface MemoryExtractionRuleRow {
  id: string;
  name: string;
  description: string | null;
  rule_type: string;              // 'self_disclosure' | 'entity_extraction'
  entity_type: string | null;     // used for entity_extraction rules
  pattern: string;
  flags: string | null;           // regex flags e.g. 'i', 'gi'
  facts_template: string | null;  // JSON object for additional facts
  priority: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface SearchProviderRow {
  id: string;
  name: string;
  description: string | null;
  provider_type: string;          // e.g. 'duckduckgo','brave','google','tavily','bing','searxng','jina','exa','serper'
  api_key: string | null;
  base_url: string | null;
  priority: number;
  options: string | null;         // JSON object
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface HttpEndpointRow {
  id: string;
  name: string;
  description: string | null;
  url: string;
  method: string;                 // GET, POST, PUT, DELETE, PATCH
  auth_type: string | null;       // api_key, bearer, basic, oauth2
  auth_config: string | null;     // JSON object
  headers: string | null;         // JSON object
  body_template: string | null;
  response_transform: string | null;
  retry_count: number;
  rate_limit_rpm: number | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface SocialAccountRow {
  id: string;
  name: string;
  description: string | null;
  platform: string;               // facebook, instagram, slack, discord
  api_key: string | null;
  api_secret: string | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  oauth_state: string | null;
  status: string;                 // disconnected, connected, error
  base_url: string | null;
  options: string | null;         // JSON object
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface EnterpriseConnectorRow {
  id: string;
  name: string;
  description: string | null;
  connector_type: string;         // jira, servicenow, canva, confluence, salesforce
  base_url: string | null;
  auth_type: string | null;       // bearer, oauth2, api_key, basic, service_account
  auth_config: string | null;     // JSON object
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
  oauth_state: string | null;
  status: string;                 // disconnected, connected, error
  options: string | null;         // JSON object
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface ToolRegistryRow {
  id: string;
  name: string;
  description: string | null;
  package_name: string;           // npm package or internal identifier
  version: string;
  category: string;
  risk_level: string;             // low, medium, high, critical
  tags: string | null;            // JSON array
  config: string | null;          // JSON object
  requires_approval: number;
  max_execution_ms: number | null;
  rate_limit_per_min: number | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface ReplayScenarioRow {
  id: string;
  name: string;
  description: string | null;
  golden_prompt: string;
  golden_response: string;
  model: string | null;
  provider: string | null;
  tags: string | null;           // JSON array
  acceptance_criteria: string | null; // JSON object
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface TriggerDefinitionRow {
  id: string;
  name: string;
  description: string | null;
  trigger_type: string;          // cron, webhook, queue, change, event
  expression: string | null;     // cron expression or filter pattern
  config: string | null;         // JSON object
  target_workflow: string | null;
  status: string;                // active, paused, disabled
  last_fired_at: string | null;
  fire_count: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface TenantConfigRow {
  id: string;
  name: string;
  description: string | null;
  tenant_id: string;
  scope: string;                 // global, organization, tenant, user
  allowed_models: string | null; // JSON array
  denied_models: string | null;  // JSON array
  allowed_tools: string | null;  // JSON array
  max_tokens_daily: number | null;
  max_cost_daily: number | null;
  max_tokens_monthly: number | null;
  max_cost_monthly: number | null;
  features: string | null;       // JSON array
  config_overrides: string | null; // JSON object
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface SandboxPolicyRow {
  id: string;
  name: string;
  description: string | null;
  max_cpu_ms: number | null;
  max_memory_mb: number | null;
  max_duration_ms: number;
  max_output_bytes: number | null;
  allowed_modules: string | null;    // JSON array
  denied_modules: string | null;     // JSON array
  network_access: number;
  filesystem_access: string;         // 'none' | 'read-only' | 'read-write'
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface ExtractionPipelineRow {
  id: string;
  name: string;
  description: string | null;
  stages: string;                    // JSON array of stage configs
  input_mime_types: string | null;   // JSON array
  max_input_size_bytes: number | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface ArtifactPolicyRow {
  id: string;
  name: string;
  description: string | null;
  max_size_bytes: number | null;
  allowed_types: string | null;      // JSON array of ArtifactType
  retention_days: number | null;
  require_versioning: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface ReliabilityPolicyRow {
  id: string;
  name: string;
  description: string | null;
  policy_type: string;               // 'retry' | 'idempotency' | 'concurrency' | 'backpressure'
  max_retries: number | null;
  initial_delay_ms: number | null;
  max_delay_ms: number | null;
  backoff_multiplier: number | null;
  max_concurrent: number | null;
  queue_size: number | null;
  strategy: string | null;           // 'reject' | 'queue' | 'shed-oldest'
  ttl_ms: number | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface CollaborationSessionRow {
  id: string;
  name: string;
  description: string | null;
  session_type: string;              // 'pair' | 'team' | 'broadcast'
  max_participants: number;
  presence_ttl_ms: number;
  auto_close_idle_ms: number | null;
  handoff_enabled: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface ComplianceRuleRow {
  id: string;
  name: string;
  description: string | null;
  rule_type: string;                 // 'retention' | 'deletion' | 'legal-hold' | 'residency' | 'consent'
  target_resource: string;
  retention_days: number | null;
  region: string | null;
  consent_purpose: string | null;
  action: string;                    // 'delete' | 'archive' | 'anonymize' | 'block' | 'notify'
  config: string | null;             // JSON
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface GraphConfigRow {
  id: string;
  name: string;
  description: string | null;
  graph_type: string;                // 'entity' | 'timeline' | 'knowledge'
  max_depth: number;
  entity_types: string | null;       // JSON array
  relationship_types: string | null; // JSON array
  auto_link: number;
  scoring_weights: string | null;    // JSON object
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface PluginConfigRow {
  id: string;
  name: string;
  description: string | null;
  plugin_type: string;               // 'official' | 'verified' | 'community' | 'private'
  package_name: string;
  version: string;
  capabilities: string | null;       // JSON array
  trust_level: string;               // 'official' | 'verified' | 'community' | 'private'
  auto_update: number;
  config: string | null;             // JSON
  enabled: number;
  created_at: string;
  updated_at: string;
}

// ─── Phase 9: Developer Experience row types ─────────────────

export interface ScaffoldTemplateRow {
  id: string;
  name: string;
  description: string | null;
  template_type: string;             // 'basic-agent' | 'tool-calling-agent' | 'rag-pipeline' | 'workflow' | 'multi-agent' | 'mcp-server' | 'full-stack'
  files: string | null;              // JSON object { [path]: content }
  dependencies: string | null;       // JSON object { [pkg]: version }
  dev_dependencies: string | null;   // JSON object { [pkg]: version }
  variables: string | null;          // JSON array of variable names
  post_install: string | null;       // shell command to run after scaffold
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface RecipeConfigRow {
  id: string;
  name: string;
  description: string | null;
  recipe_type: string;               // 'workflow' | 'governed' | 'approval' | 'acl-rag' | 'multi-tenant' | 'eval-routed' | 'memory' | 'event-driven' | 'safe-exec'
  model: string | null;
  provider: string | null;
  system_prompt: string | null;
  tools: string | null;              // JSON array
  guardrails: string | null;         // JSON array
  max_steps: number | null;
  options: string | null;            // JSON object
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface WidgetConfigRow {
  id: string;
  name: string;
  description: string | null;
  widget_type: string;               // 'table' | 'chart' | 'form' | 'code' | 'timeline' | 'image'
  default_options: string | null;    // JSON object
  allowed_contexts: string | null;   // JSON array
  max_data_points: number | null;
  refresh_interval_ms: number | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface ValidationRuleRow {
  id: string;
  name: string;
  description: string | null;
  rule_type: string;                 // 'required' | 'range' | 'pattern' | 'custom'
  target: string;                    // 'agent-config' | 'workflow-config' | 'tool-config'
  condition: string | null;          // JSON condition expression
  severity: string;                  // 'error' | 'warning' | 'info'
  message: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface SemanticMemoryRow {
  id: string;
  user_id: string;
  chat_id: string | null;
  tenant_id: string | null;
  content: string;
  memory_type: string;   // 'semantic' | 'user_fact' | 'preference' | 'summary'
  source: string;        // 'user' | 'assistant'
  created_at: string;
  updated_at: string;
}

export interface EntityMemoryRow {
  id: string;
  user_id: string;
  chat_id: string | null;
  tenant_id: string | null;
  entity_name: string;
  entity_type: string;   // 'person' | 'location' | 'organization' | 'preference' | 'topic' | 'general'
  facts: string;         // JSON object of key→value facts
  confidence: number;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface MemoryExtractionEventRow {
  id: string;
  user_id: string;
  chat_id: string | null;
  tenant_id: string | null;
  self_disclosure: number;
  regex_entities_count: number;
  llm_entities_count: number;
  merged_entities_count: number;
  events: string | null;
  created_at: string;
}

export interface WebsiteCredentialRow {
  id: string;
  user_id: string;
  site_name: string;
  site_url_pattern: string;
  auth_method: string;           // form_fill | cookie | header | oauth
  credentials_encrypted: string; // AES-256-GCM encrypted JSON blob
  encryption_iv: string;
  last_used_at: string | null;
  status: string;                // active | expired | needs_reauth
  created_at: string;
  updated_at: string;
}

export interface SSOLinkedAccountRow {
  id: string;
  user_id: string;
  identity_provider: string;     // google | github | microsoft | apple | facebook
  email: string | null;
  session_encrypted: string;     // AES-256-GCM encrypted SSOPassThroughAuth JSON
  encryption_iv: string;
  status: string;                // active | expired | needs_reauth
  linked_at: string;
  updated_at: string;
}

export interface MetricsSummary {
  total_tokens: number;
  total_cost: number;
  avg_latency_ms: number;
  total_messages: number;
  total_chats: number;
  by_model: Array<{ model: string; provider: string; tokens: number; cost: number; count: number }>;
  by_day: Array<{ date: string; tokens: number; cost: number; count: number }>;
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
}

export interface GuardrailEvalRow {
  id: string;
  chat_id: string | null;
  message_id: string | null;
  stage: string;
  input_preview: string | null;
  results: string;
  overall_decision: string;
  created_at: string;
}

// ─── Hypothesis Validation row types ────────────────────────

/**
 * A budget envelope caps LLM cost, sandbox cost, wall-clock time, and deliberation
 * rounds for one hypothesis validation run. Never mutated after use.
 */
export interface SvBudgetEnvelopeRow {
  id: string;                         // uuid v7
  tenant_id: string;
  name: string;
  max_llm_cents: number;              // max LLM cost in US cents
  max_sandbox_cents: number;          // max container compute cost in US cents
  max_wall_seconds: number;           // wall-clock timeout seconds
  max_rounds: number;                 // max deliberation rounds
  diminishing_returns_epsilon: number; // halt when CI improvement < epsilon
  created_at: string;
}

/** Status of a hypothesis validation run. */
export type SvHypothesisStatus = 'queued' | 'running' | 'verdict' | 'abandoned';

/**
 * A hypothesis submitted for multi-agent validation.
 */
export interface SvHypothesisRow {
  id: string;                         // uuid v7
  tenant_id: string;
  submitted_by: string;               // user id
  title: string;
  statement: string;
  domain_tags: string;                // JSON: string[]
  status: SvHypothesisStatus;
  budget_envelope_id: string;         // FK → hv_budget_envelope.id
  workflow_run_id: string | null;
  trace_id: string | null;            // @weaveintel/replay trace
  contract_id: string | null;         // @weaveintel/contracts completion contract
  created_at: string;
  updated_at: string;
}

/** The type of claim for a sub-claim. */
export type SvClaimType = 'mechanism' | 'epidemiological' | 'mathematical' | 'dose_response' | 'causal' | 'other';

/**
 * A sub-claim decomposed from a hypothesis by the Decomposer agent.
 */
export interface SvSubClaimRow {
  id: string;
  tenant_id: string;
  hypothesis_id: string;              // FK → hv_hypothesis.id ON DELETE CASCADE
  parent_sub_claim_id: string | null; // self-ref for nested decomposition
  statement: string;
  claim_type: SvClaimType;
  testability_score: number;          // 0–1 float
  created_at: string;
}

/** The possible verdicts a Supervisor can emit. */
export type SvVerdictValue = 'supported' | 'refuted' | 'inconclusive' | 'ill_posed' | 'out_of_scope';

/**
 * Supervisor-emitted verdict for a completed hypothesis run.
 * Invariant: confidence_lo <= confidence_hi.
 * Invariant: supported/refuted verdicts must cite ≥1 sandbox-tool evidence item.
 */
export interface SvVerdictRow {
  id: string;
  tenant_id: string;
  hypothesis_id: string;              // FK → hv_hypothesis.id ON DELETE CASCADE (UNIQUE)
  verdict: SvVerdictValue;
  confidence_lo: number;              // 0–1 float
  confidence_hi: number;              // 0–1 float, ≥ confidence_lo
  key_evidence_ids: string;           // JSON: string[]
  falsifiers: string;                 // JSON: string[]
  limitations: string;
  contract_id: string;
  replay_trace_id: string;
  emitted_by: string;                 // default 'supervisor'
  created_at: string;
}

export interface SvEvidenceEventRow {
  id: string;                         // UUID
  hypothesis_id: string;             // FK → hv_hypothesis.id
  step_id: string;                   // workflow step that emitted this (e.g. 'statistical')
  agent_id: string;                  // agent name
  evidence_id: string;               // contract evidence item id
  kind: string;                      // 'stat_finding' | 'lit_hit' | 'sim_result' | etc.
  summary: string;
  source_type: string;               // 'sandbox_tool_run' | 'http_fetch' | 'model_inference'
  tool_key: string | null;
  reproducibility_hash: string | null;
  created_at: string;
}

export interface SvAgentTurnRow {
  id: string;                         // UUID
  hypothesis_id: string;             // FK → hv_hypothesis.id
  round_index: number;
  from_agent: string;
  to_agent: string | null;           // null = broadcast
  message: string;
  cites_evidence_ids: string;        // JSON: string[]
  dissent: number;                   // 0 | 1 (boolean)
  created_at: string;
}

// ─── Phase K3: Kaggle projection rows ────────────────────────
// Source of truth for evidence + agent decisions remains
// @weaveintel/contracts and live-agents StateStore. These three
// rows back the GeneWeave admin UI and analytics views.

export interface KaggleCompetitionTrackedRow {
  id: string;
  tenant_id: string | null;
  competition_ref: string;
  title: string | null;
  category: string | null;
  deadline: string | null;
  reward: string | null;
  url: string | null;
  status: string;                   // 'watching' | 'active' | 'paused' | 'archived'
  notes: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface KaggleApproachRow {
  id: string;
  tenant_id: string | null;
  competition_ref: string;
  summary: string;
  expected_metric: string | null;
  model: string | null;
  source_kernel_refs: string | null; // JSON string[]
  embedding: Buffer | null;
  status: string;                   // 'draft' | 'approved' | 'rejected' | 'implemented'
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface KaggleRunRow {
  id: string;
  tenant_id: string | null;
  competition_ref: string;
  approach_id: string | null;
  contract_id: string | null;
  replay_trace_id: string | null;
  mesh_id: string | null;
  agent_id: string | null;
  kernel_ref: string | null;
  submission_id: string | null;
  public_score: number | null;
  validator_report: string | null;  // JSON snapshot
  status: string;                   // 'queued' | 'running' | 'validated' | 'submitted' | 'completed' | 'failed'
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

// Phase K4 — One artifact per kaggle_run row. Stores the actual
// @weaveintel/contracts CompletionReport JSON and the @weaveintel/replay
// RunLog JSON so admin UI + replay endpoint can reconstruct deterministically.
export interface KaggleRunArtifactRow {
  id: string;
  run_id: string;
  contract_id: string;
  replay_trace_id: string;
  contract_report_json: string;     // JSON CompletionReport
  replay_run_log_json: string;      // JSON RunLog
  created_at: string;
}

// Phase K6 — per-tenant kill switch for the Kaggle discussion bot. The
// runtime checks `discussion_enabled === 1` before invoking
// `kaggle.discussions.create`. UNIQUE(tenant_id) so each tenant has at
// most one row; admin UI upserts by tenant_id.
export interface KaggleDiscussionSettingsRow {
  id: string;
  tenant_id: string;
  discussion_enabled: number;       // 0 = off (default), 1 = enabled
  notes: string | null;
  updated_at: string;
}

// Phase K6 — append-only log of every Kaggle discussion post the platform
// has executed. Source of truth for "what did the bot say in public" lives
// here for fast operator review; the underlying contract + replay trace
// remain in @weaveintel/contracts and @weaveintel/replay.
export interface KaggleDiscussionPostRow {
  id: string;
  tenant_id: string | null;
  competition_ref: string;
  topic_id: string;
  parent_topic_id: string | null;
  title: string | null;
  body_preview: string | null;
  url: string | null;
  status: string;                   // 'posted' | 'failed' | 'killswitch_blocked'
  contract_id: string | null;
  replay_trace_id: string | null;
  posted_at: string;
}

// Phase K7d — Competition-agnostic submission validation rubric. Defines
// what "a good submission for this competition" means in machine-checkable
// terms (metric direction, baseline, expected file shape). One row per
// competition_ref per tenant. Auto-inferred from Kaggle metadata on first
// contact, then editable by operators.
export interface KaggleCompetitionRubricRow {
  id: string;
  tenant_id: string | null;
  competition_ref: string;
  metric_name: string | null;
  metric_direction: 'maximize' | 'minimize' | null;
  baseline_score: number | null;
  target_score: number | null;
  expected_row_count: number | null;
  id_column: string | null;
  id_range_min: number | null;
  id_range_max: number | null;
  target_column: string | null;
  target_type: string | null;        // 'binary' | 'multiclass' | 'continuous' | 'probability' | 'ranking' | 'other'
  expected_distribution_json: string | null;
  sample_submission_sha256: string | null;
  inference_source: string | null;   // free text describing how the rubric was derived
  auto_generated: number;             // 1 = auto-inferred, 0 = operator-authored
  inferred_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// Phase K7d — Append-only ledger of every validator pass. One row per
// kernel run the validator reviews. Holds the structured pass/warn/fail
// verdict and the per-check booleans + violations so admin UX can show
// exactly why a submission was held back.
export interface KaggleValidationResultRow {
  id: string;
  run_id: string;
  competition_ref: string;
  rubric_id: string | null;
  kernel_ref: string | null;
  schema_check_passed: number | null;
  distribution_check_passed: number | null;
  baseline_check_passed: number | null;
  cv_score: number | null;
  cv_std: number | null;
  cv_metric: string | null;
  n_folds: number | null;
  predicted_distribution_json: string | null;
  violations_json: string | null;
  verdict: 'pass' | 'warn' | 'fail' | null;
  summary: string | null;
  validated_at: string | null;
  created_at: string;
}

// Phase K7d — Append-only ledger of leaderboard readbacks observed by the
// Leaderboard Observer role after the submitter pushes. cv_lb_delta is the
// reproducibility-critical signal: large gaps imply CV is mis-calibrated.
export interface KaggleLeaderboardScoreRow {
  id: string;
  run_id: string | null;
  competition_ref: string;
  submission_id: string | null;
  public_score: number | null;
  private_score: number | null;
  cv_lb_delta: number | null;
  percentile_estimate: number | null;
  rank_estimate: number | null;
  leaderboard_size: number | null;
  raw_status: string | null;
  observed_at: string | null;
  created_at: string;
}

// ─── Kaggle competition run ledger (per-run UUIDv7 isolation) ──
export type KglRunStatus = 'queued' | 'running' | 'completed' | 'abandoned' | 'failed';
export interface KglCompetitionRunRow {
  id: string;                      // UUIDv7
  tenant_id: string;
  submitted_by: string;
  competition_ref: string;
  title: string | null;
  objective: string | null;
  mesh_id: string | null;
  status: KglRunStatus;
  step_count: number;
  event_count: number;
  summary: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export type KglRunStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
export interface KglRunStepRow {
  id: string;                      // UUIDv7
  run_id: string;
  step_index: number;
  role: string;                    // e.g. 'kaggle_discoverer'
  title: string;                   // human-readable label
  description: string | null;
  agent_id: string | null;
  status: KglRunStepStatus;
  started_at: string | null;
  completed_at: string | null;
  summary: string | null;
  input_preview: string | null;
  output_preview: string | null;
  created_at: string;
  updated_at: string;
}

export interface KglRunEventRow {
  id: string;                      // UUIDv7
  run_id: string;
  step_id: string | null;
  kind: string;                    // 'tool_call' | 'agent_message' | 'evidence' | 'log' | ...
  agent_id: string | null;
  tool_key: string | null;
  summary: string;
  payload_json: string | null;
  created_at: string;
}

/**
 * Projection of a single inter-agent message stored in the live-agents
 * StateStore (`la_entities` where `entity_type='message'`). Surfaced to the
 * Run record view so operators can inspect the dialogue between agents.
 */
export interface LiveMeshMessageView {
  id: string;
  meshId: string | null;
  fromType: string | null;
  fromId: string | null;
  toType: string | null;
  toId: string | null;
  topic: string | null;
  kind: string | null;
  subject: string | null;
  body: string | null;
  status: string | null;
  createdAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  processedAt: string | null;
}


// Mesh blueprint stored in `live_mesh_definitions`; per-role agent persona
// in `live_agent_definitions`; pipeline graph in `live_mesh_delegation_edges`.
// Runtime boot loads a snapshot at provision time; per-competition playbook
// overlays still apply on top via the `kaggle_playbook` skill resolver.
export interface LiveMeshDefinitionRow {
  id: string;                                  // UUIDv7
  mesh_key: string;                            // unique slug (e.g. 'kaggle')
  name: string;
  charter_prose: string;
  dual_control_required_for: string;           // JSON array of tool keys
  enabled: number;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface LiveAgentDefinitionRow {
  id: string;                                  // UUIDv7
  mesh_def_id: string;
  role_key: string;                            // e.g. 'discoverer'
  name: string;                                // e.g. 'Kaggle Discoverer'
  role_label: string;                          // e.g. 'Competition Discoverer'
  persona: string;
  objectives: string;
  success_indicators: string;
  ordering: number;
  enabled: number;
  // ─── Phase 3.5 — DB-driven model routing defaults ────────────
  // JSON capability spec (e.g. {task:'reasoning', toolUse:true}). Consumed by
  // resolveLiveAgentModel() in @weaveintel/live-agents. Null = inherit
  // platform default.
  model_capability_json?: string | null;
  // Optional override key into the routing policy registry.
  model_routing_policy_key?: string | null;
  // Escape hatch: pin a specific model id for reproducibility runs.
  model_pinned_id?: string | null;
  // ─── Phase 5 — Generic provisioner defaults ─────────────────
  // Used by `provisionMesh()` to seed `live_agent_handler_bindings`,
  // `live_agent_tool_bindings`, and the runtime `attention_policy_key`
  // when an operator instantiates this blueprint.
  default_handler_kind?: string | null;        // e.g. 'agentic.react'
  default_handler_config_json?: string | null; // JSON config for that kind
  default_tool_catalog_keys?: string | null;   // JSON array of tool_key strings
  default_attention_policy_key?: string | null;// e.g. 'heuristic.inbox-first'
  created_at: string;
  updated_at: string;
}

export interface LiveMeshDelegationEdgeRow {
  id: string;                                  // UUIDv7
  mesh_def_id: string;
  from_role_key: string;
  to_role_key: string;
  relationship: string;                        // 'DIRECTS' | 'COLLABORATES_WITH' | ...
  prose: string;
  ordering: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

// ─── DB-Driven Live-Agents Runtime (M22, Phase 1) ────────────
// Provisioned runtime entities (vs blueprint definitions above). Splits the
// "what an operator designed" from "what is actually live for a tenant" so
// tenants can spin up N runtime meshes from one blueprint.

/** Catalog of runtime handler kinds (e.g. agentic.react). Plugins implement these. */
export interface LiveHandlerKindRow {
  id: string;
  kind: string;                                // unique key, e.g. 'agentic.react'
  description: string;
  config_schema_json: string;                  // JSON schema for handler config
  source: string;                              // 'builtin' | 'plugin'
  enabled: number;
  created_at: string;
  updated_at: string;
}

/** DB-managed attention policies (when should an agent take a tick). */
export interface LiveAttentionPolicyRow {
  id: string;
  key: string;                                 // e.g. 'heuristic.inbox-first'
  kind: string;                                // 'heuristic' | 'cron' | 'model'
  description: string;
  config_json: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/** A provisioned runtime mesh (one per tenant per blueprint). */
export interface LiveMeshRow {
  id: string;
  tenant_id: string | null;
  mesh_def_id: string;
  name: string;
  status: string;                              // 'ACTIVE' | 'PAUSED' | 'ARCHIVED'
  domain: string | null;
  dual_control_required_for: string;           // JSON array of tool keys
  owner_human_id: string | null;
  mcp_server_ref: string | null;
  account_id: string | null;
  context_json: string | null;
  created_at: string;
  updated_at: string;
}

/** A provisioned agent inside a runtime mesh. */
export interface LiveAgentRow {
  id: string;
  mesh_id: string;
  agent_def_id: string | null;
  role_key: string;
  name: string;
  role_label: string;
  persona: string;
  objectives: string;
  success_indicators: string;
  attention_policy_key: string | null;
  contract_version_id: string | null;
  status: string;                              // 'ACTIVE' | 'PAUSED' | 'ARCHIVED'
  ordering: number;
  archived_at: string | null;
  // ─── Phase 3.5 — model routing (mirror of definition defaults) ──
  // Resolution order at runtime: pinned id → capability spec via routing
  // policy → inherited from agent_def → platform default.
  model_capability_json?: string | null;
  model_routing_policy_key?: string | null;
  model_pinned_id?: string | null;
  created_at: string;
  updated_at: string;
}

/** Which handler kind dispatches this agent's ticks plus opaque config. */
export interface LiveAgentHandlerBindingRow {
  id: string;
  agent_id: string;
  handler_kind: string;
  config_json: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

/** M2M: agent → tool_catalog row OR external MCP endpoint. */
export interface LiveAgentToolBindingRow {
  id: string;
  agent_id: string;
  tool_catalog_id: string | null;
  mcp_server_url: string | null;
  capability_keys: string;                     // JSON array
  enabled: number;
  created_at: string;
  updated_at: string;
}

/** A "campaign" inside a mesh — generic replacement for kgl_competition_runs. */
export interface LiveRunRow {
  id: string;
  mesh_id: string;
  tenant_id: string | null;
  run_key: string;
  label: string | null;
  status: string;                              // 'RUNNING' | 'COMPLETED' | 'FAILED' | 'ABANDONED'
  started_at: string;
  completed_at: string | null;
  summary: string | null;
  context_json: string | null;
  created_at: string;
  updated_at: string;
}

/** Per-agent progress ledger inside a run. Generic replacement for kgl_run_step. */
export interface LiveRunStepRow {
  id: string;
  run_id: string;
  mesh_id: string;
  agent_id: string | null;
  role_key: string;
  status: string;                              // 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED'
  started_at: string | null;
  completed_at: string | null;
  summary: string | null;
  payload_json: string | null;
  created_at: string;
  updated_at: string;
}

/** Append-only event log. Generic replacement for kgl_run_event. */
export interface LiveRunEventRow {
  id: string;
  run_id: string;
  step_id: string | null;
  kind: string;                                // e.g. 'tool_call', 'handoff', 'error'
  agent_id: string | null;
  tool_key: string | null;
  summary: string | null;
  payload_json: string | null;
  created_at: string;
}

// ─── Adapter interface ───────────────────────────────────────

export interface DatabaseAdapter {
  initialize(): Promise<void>;
  close(): Promise<void>;

  // Users
  createUser(user: { id: string; email: string; name: string; passwordHash: string; persona?: string; tenantId?: string | null }): Promise<void>;
  getUserByEmail(email: string): Promise<UserRow | null>;
  getUserById(id: string): Promise<UserRow | null>;
  listUsers(): Promise<UserRow[]>;
  updateUser(userId: string, updates: {
    email?: string;
    name?: string;
    persona?: string;
    tenantId?: string | null;
    passwordHash?: string;
  }): Promise<void>;
  deleteUser(userId: string): Promise<void>;
  updateUserPersona(userId: string, persona: string): Promise<void>;

  // Sessions
  createSession(session: { id: string; userId: string; csrfToken: string; expiresAt: string }): Promise<void>;
  getSession(id: string): Promise<SessionRow | null>;
  deleteSession(id: string): Promise<void>;
  deleteExpiredSessions(): Promise<void>;

  // Idempotency records
  createIdempotencyRecord(record: Omit<IdempotencyRecordRow, 'created_at'>): Promise<void>;
  getIdempotencyRecordByKey(key: string): Promise<IdempotencyRecordRow | null>;
  deleteExpiredIdempotencyRecords(nowIso?: string): Promise<void>;
  trimIdempotencyRecords(maxEntries: number): Promise<void>;
  clearIdempotencyRecords(): Promise<void>;

  // OAuth flow state (authorization state nonce persistence)
  createOAuthFlowState(state: Omit<OAuthFlowStateRow, 'created_at'>): Promise<void>;
  consumeOAuthFlowStateByKey(stateKey: string): Promise<OAuthFlowStateRow | null>;
  deleteOAuthFlowStateByKey(stateKey: string): Promise<void>;
  deleteExpiredOAuthFlowStates(nowIso?: string): Promise<void>;

  // OAuth Linked Accounts
  createOAuthLinkedAccount(account: Omit<OAuthLinkedAccountRow, 'linked_at'>): Promise<void>;
  getOAuthLinkedAccount(userId: string, provider: string): Promise<OAuthLinkedAccountRow | null>;
  getOAuthLinkedAccountByProviderUserId(provider: string, providerUserId: string): Promise<OAuthLinkedAccountRow | null>;
  listOAuthLinkedAccounts(userId: string): Promise<OAuthLinkedAccountRow[]>;
  updateOAuthAccountLastUsed(userId: string, provider: string): Promise<void>;
  deleteOAuthLinkedAccount(userId: string, provider: string): Promise<void>;

  // Chats
  createChat(chat: { id: string; userId: string; title: string; model: string; provider: string }): Promise<void>;
  getChat(id: string, userId: string): Promise<ChatRow | null>;
  getUserChats(userId: string): Promise<ChatRow[]>;
  updateChatTitle(id: string, userId: string, title: string): Promise<void>;
  deleteChat(id: string, userId: string): Promise<void>;

  // Messages
  addMessage(msg: {
    id: string;
    chatId: string;
    role: string;
    content: string;
    metadata?: string;
    tokensUsed?: number;
    cost?: number;
    latencyMs?: number;
  }): Promise<void>;
  getMessages(chatId: string): Promise<MessageRow[]>;

  // Metrics
  recordMetric(metric: {
    id: string;
    userId: string;
    chatId?: string;
    type: string;
    provider?: string;
    model?: string;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    cost?: number;
    latencyMs?: number;
    metadata?: string;
  }): Promise<void>;
  getMetrics(userId: string, from?: string, to?: string): Promise<MetricRow[]>;
  getMetricsSummary(userId: string, from?: string, to?: string): Promise<MetricsSummary>;

  // Evals
  recordEval(result: {
    id: string;
    userId: string;
    chatId?: string;
    evalName: string;
    score: number;
    passed: number;
    failed: number;
    total: number;
    details?: string;
  }): Promise<void>;
  getEvals(userId: string, from?: string, to?: string): Promise<EvalRow[]>;

  // User preferences
  getUserPreferences(userId: string): Promise<UserPreferencesRow | null>;
  saveUserPreferences(userId: string, defaultMode: string, theme: string, showProcessCard?: boolean): Promise<void>;

  // Chat settings (agent mode, tools, redaction)
  getChatSettings(chatId: string): Promise<ChatSettingsRow | null>;
  saveChatSettings(settings: {
    chatId: string;
    mode: string;
    systemPrompt?: string;
    timezone?: string;
    enabledTools?: string;
    redactionEnabled?: boolean;
    redactionPatterns?: string;
    workers?: string;
  }): Promise<void>;

  // Traces (observability)
  saveTrace(trace: {
    id: string;
    userId: string;
    chatId?: string;
    messageId?: string;
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    name: string;
    startTime: number;
    endTime?: number;
    status?: string;
    attributes?: string;
    events?: string;
  }): Promise<void>;
  getChatTraces(chatId: string): Promise<TraceRow[]>;
  getUserTraces(userId: string, limit?: number): Promise<TraceRow[]>;

  // Temporal tools persistence (timers, stopwatches, reminders)
  upsertTemporalTimer(row: {
    id: string;
    scopeId: string;
    label?: string | null;
    durationMs?: number | null;
    state: string;
    createdAt: string;
    startedAt?: string | null;
    pausedAt?: string | null;
    resumedAt?: string | null;
    stoppedAt?: string | null;
    elapsedMs: number;
  }): Promise<void>;
  getTemporalTimer(scopeId: string, id: string): Promise<TemporalTimerRow | null>;
  listTemporalTimers(scopeId: string): Promise<TemporalTimerRow[]>;

  upsertTemporalStopwatch(row: {
    id: string;
    scopeId: string;
    label?: string | null;
    state: string;
    createdAt: string;
    startedAt?: string | null;
    pausedAt?: string | null;
    resumedAt?: string | null;
    stoppedAt?: string | null;
    elapsedMs: number;
    lapsJson: string;
  }): Promise<void>;
  getTemporalStopwatch(scopeId: string, id: string): Promise<TemporalStopwatchRow | null>;
  listTemporalStopwatches(scopeId: string): Promise<TemporalStopwatchRow[]>;

  upsertTemporalReminder(row: {
    id: string;
    scopeId: string;
    text: string;
    dueAt: string;
    timezone: string;
    status: string;
    createdAt: string;
    cancelledAt?: string | null;
  }): Promise<void>;
  getTemporalReminder(scopeId: string, id: string): Promise<TemporalReminderRow | null>;
  listTemporalReminders(scopeId: string): Promise<TemporalReminderRow[]>;

  // Agent activity: assistant messages with parsed metadata
  getAgentActivity(userId: string, limit?: number): Promise<Array<MessageRow & { chat_title: string; chat_model: string; chat_provider: string }>>;

  // ─── Admin: Model Pricing ────────────────────────────────────
  createModelPricing(p: Omit<ModelPricingRow, 'created_at' | 'updated_at'>): Promise<void>;
  getModelPricing(id: string): Promise<ModelPricingRow | null>;
  listModelPricing(): Promise<ModelPricingRow[]>;
  updateModelPricing(id: string, fields: Partial<Omit<ModelPricingRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteModelPricing(id: string): Promise<void>;
  upsertModelPricing(p: Omit<ModelPricingRow, 'created_at' | 'updated_at'>): Promise<void>;

  // ─── Admin: Prompts ────────────────────────────────────────
  createPrompt(p: Omit<PromptRow, 'created_at' | 'updated_at'>): Promise<void>;
  getPrompt(id: string): Promise<PromptRow | null>;
  getPromptByKey(key: string): Promise<PromptRow | null>;
  getPromptByName(name: string): Promise<PromptRow | null>;
  listPrompts(): Promise<PromptRow[]>;
  updatePrompt(id: string, fields: Partial<Omit<PromptRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deletePrompt(id: string): Promise<void>;

  // ─── Admin: Prompt Versions (Phase 5) ─────────────────────
  createPromptVersion(v: Omit<PromptVersionRow, 'created_at' | 'updated_at'>): Promise<void>;
  getPromptVersion(id: string): Promise<PromptVersionRow | null>;
  listPromptVersions(promptId?: string): Promise<PromptVersionRow[]>;
  updatePromptVersion(id: string, fields: Partial<Omit<PromptVersionRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deletePromptVersion(id: string): Promise<void>;

  // ─── Admin: Prompt Experiments (Phase 5) ──────────────────
  createPromptExperiment(e: Omit<PromptExperimentRow, 'created_at' | 'updated_at'>): Promise<void>;
  getPromptExperiment(id: string): Promise<PromptExperimentRow | null>;
  listPromptExperiments(promptId?: string): Promise<PromptExperimentRow[]>;
  updatePromptExperiment(id: string, fields: Partial<Omit<PromptExperimentRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deletePromptExperiment(id: string): Promise<void>;

  // ─── Admin: Prompt Evaluation Datasets (Phase 7) ─────────
  createPromptEvalDataset(d: Omit<PromptEvalDatasetRow, 'created_at' | 'updated_at'>): Promise<void>;
  getPromptEvalDataset(id: string): Promise<PromptEvalDatasetRow | null>;
  listPromptEvalDatasets(promptId?: string): Promise<PromptEvalDatasetRow[]>;
  updatePromptEvalDataset(id: string, fields: Partial<Omit<PromptEvalDatasetRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deletePromptEvalDataset(id: string): Promise<void>;

  // ─── Admin: Prompt Evaluation Runs (Phase 7) ─────────────
  createPromptEvalRun(r: Omit<PromptEvalRunRow, 'created_at'>): Promise<void>;
  getPromptEvalRun(id: string): Promise<PromptEvalRunRow | null>;
  listPromptEvalRuns(datasetId?: string): Promise<PromptEvalRunRow[]>;
  deletePromptEvalRun(id: string): Promise<void>;

  // ─── Admin: Prompt Optimizers (Phase 7) ──────────────────
  createPromptOptimizer(o: Omit<PromptOptimizerRow, 'created_at' | 'updated_at'>): Promise<void>;
  getPromptOptimizer(id: string): Promise<PromptOptimizerRow | null>;
  getPromptOptimizerByKey(key: string): Promise<PromptOptimizerRow | null>;
  listPromptOptimizers(): Promise<PromptOptimizerRow[]>;
  updatePromptOptimizer(id: string, fields: Partial<Omit<PromptOptimizerRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deletePromptOptimizer(id: string): Promise<void>;

  // ─── Admin: Prompt Optimization Runs (Phase 7) ───────────
  createPromptOptimizationRun(r: Omit<PromptOptimizationRunRow, 'created_at'>): Promise<void>;
  getPromptOptimizationRun(id: string): Promise<PromptOptimizationRunRow | null>;
  listPromptOptimizationRuns(promptId?: string): Promise<PromptOptimizationRunRow[]>;
  deletePromptOptimizationRun(id: string): Promise<void>;

  // ─── Admin: Prompt Frameworks (Phase 2) ───────────────────
  createPromptFramework(f: Omit<PromptFrameworkRow, 'created_at' | 'updated_at'>): Promise<void>;
  getPromptFramework(id: string): Promise<PromptFrameworkRow | null>;
  getPromptFrameworkByKey(key: string): Promise<PromptFrameworkRow | null>;
  listPromptFrameworks(): Promise<PromptFrameworkRow[]>;
  updatePromptFramework(id: string, fields: Partial<Omit<PromptFrameworkRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deletePromptFramework(id: string): Promise<void>;

  // ─── Admin: Prompt Fragments (Phase 2) ────────────────────
  createPromptFragment(f: Omit<PromptFragmentRow, 'created_at' | 'updated_at'>): Promise<void>;
  getPromptFragment(id: string): Promise<PromptFragmentRow | null>;
  getPromptFragmentByKey(key: string): Promise<PromptFragmentRow | null>;
  listPromptFragments(): Promise<PromptFragmentRow[]>;
  updatePromptFragment(id: string, fields: Partial<Omit<PromptFragmentRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deletePromptFragment(id: string): Promise<void>;

  // ─── Admin: Prompt Contracts (Phase 3) ─────────────────────
  createPromptContract(c: Omit<PromptContractRow, 'created_at' | 'updated_at'>): Promise<void>;
  getPromptContract(id: string): Promise<PromptContractRow | null>;
  getPromptContractByKey(key: string): Promise<PromptContractRow | null>;
  listPromptContracts(): Promise<PromptContractRow[]>;
  updatePromptContract(id: string, fields: Partial<Omit<PromptContractRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deletePromptContract(id: string): Promise<void>;

  // ─── Admin: Prompt Strategies (Phase 4) ────────────────────
  createPromptStrategy(s: Omit<PromptStrategyRow, 'created_at' | 'updated_at'>): Promise<void>;
  getPromptStrategy(id: string): Promise<PromptStrategyRow | null>;
  getPromptStrategyByKey(key: string): Promise<PromptStrategyRow | null>;
  listPromptStrategies(): Promise<PromptStrategyRow[]>;
  updatePromptStrategy(id: string, fields: Partial<Omit<PromptStrategyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deletePromptStrategy(id: string): Promise<void>;

  // ─── Admin: Guardrails ─────────────────────────────────────
  createGuardrail(g: Omit<GuardrailRow, 'created_at' | 'updated_at'>): Promise<void>;
  getGuardrail(id: string): Promise<GuardrailRow | null>;
  listGuardrails(): Promise<GuardrailRow[]>;
  updateGuardrail(id: string, fields: Partial<Omit<GuardrailRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteGuardrail(id: string): Promise<void>;

  // ─── Admin: Routing policies ───────────────────────────────
  createRoutingPolicy(r: Omit<RoutingPolicyRow, 'created_at' | 'updated_at'>): Promise<void>;
  getRoutingPolicy(id: string): Promise<RoutingPolicyRow | null>;
  listRoutingPolicies(): Promise<RoutingPolicyRow[]>;
  updateRoutingPolicy(id: string, fields: Partial<Omit<RoutingPolicyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteRoutingPolicy(id: string): Promise<void>;

  // ─── anyWeave routing Phase 2: task-aware routing ─────────
  listTaskTypes(): Promise<TaskTypeDefinitionRow[]>;
  getTaskType(taskKey: string): Promise<TaskTypeDefinitionRow | null>;
  getTaskTypeById(id: string): Promise<TaskTypeDefinitionRow | null>;
  createTaskType(row: Omit<TaskTypeDefinitionRow, 'created_at' | 'updated_at'>): Promise<void>;
  updateTaskType(id: string, fields: Partial<Omit<TaskTypeDefinitionRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteTaskType(id: string): Promise<void>;

  listCapabilityScores(opts?: { taskKey?: string; tenantId?: string | null; modelId?: string; provider?: string }): Promise<ModelCapabilityScoreRow[]>;
  getCapabilityScore(id: string): Promise<ModelCapabilityScoreRow | null>;
  upsertCapabilityScore(row: Omit<ModelCapabilityScoreRow, 'created_at' | 'updated_at'>): Promise<void>;
  updateCapabilityScore(id: string, fields: Partial<Omit<ModelCapabilityScoreRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteCapabilityScore(id: string): Promise<void>;

  listProviderToolAdapters(): Promise<ProviderToolAdapterRow[]>;
  getProviderToolAdapter(provider: string): Promise<ProviderToolAdapterRow | null>;
  getProviderToolAdapterById(id: string): Promise<ProviderToolAdapterRow | null>;
  createProviderToolAdapter(row: Omit<ProviderToolAdapterRow, 'created_at' | 'updated_at'>): Promise<void>;
  updateProviderToolAdapter(id: string, fields: Partial<Omit<ProviderToolAdapterRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteProviderToolAdapter(id: string): Promise<void>;

  listTaskTypeTenantOverrides(opts?: { tenantId?: string; taskKey?: string }): Promise<TaskTypeTenantOverrideRow[]>;
  getTaskTypeTenantOverride(id: string): Promise<TaskTypeTenantOverrideRow | null>;
  createTaskTypeTenantOverride(row: Omit<TaskTypeTenantOverrideRow, 'created_at' | 'updated_at'>): Promise<void>;
  updateTaskTypeTenantOverride(id: string, fields: Partial<Omit<TaskTypeTenantOverrideRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteTaskTypeTenantOverride(id: string): Promise<void>;

  insertRoutingDecisionTrace(row: Omit<RoutingDecisionTraceRow, 'decided_at'> & { decided_at?: string }): Promise<void>;
  listRoutingDecisionTraces(opts?: { tenantId?: string; agentId?: string; taskKey?: string; limit?: number; after?: string }): Promise<RoutingDecisionTraceRow[]>;
  getRoutingDecisionTrace(id: string): Promise<RoutingDecisionTraceRow | null>;
  aggregateCostByTask(opts?: { since?: string; until?: string; tenantId?: string }): Promise<Array<{
    task_key: string | null;
    selected_provider: string | null;
    selected_model_id: string | null;
    invocation_count: number;
    total_cost_usd: number;
    avg_cost_usd: number;
    last_used: string | null;
  }>>;

  // ─── anyWeave Phase 5: Feedback loop ───────────────────────
  insertRoutingCapabilitySignal(row: Omit<RoutingCapabilitySignalRow, 'created_at'> & { created_at?: string }): Promise<void>;
  listRoutingCapabilitySignals(opts?: {
    tenantId?: string | null; modelId?: string; provider?: string; taskKey?: string;
    source?: string; afterIso?: string; beforeIso?: string; limit?: number;
  }): Promise<RoutingCapabilitySignalRow[]>;
  getRoutingCapabilitySignal(id: string): Promise<RoutingCapabilitySignalRow | null>;

  insertMessageFeedback(row: Omit<MessageFeedbackRow, 'created_at'> & { created_at?: string }): Promise<void>;
  listMessageFeedback(opts?: { messageId?: string; chatId?: string; signal?: string; limit?: number }): Promise<MessageFeedbackRow[]>;
  getMessageFeedback(id: string): Promise<MessageFeedbackRow | null>;

  insertRoutingSurfaceItem(row: Omit<RoutingSurfaceItemRow, 'created_at' | 'resolved_at'> & { created_at?: string; resolved_at?: string | null }): Promise<void>;
  listRoutingSurfaceItems(opts?: { status?: string; modelId?: string; provider?: string; taskKey?: string; limit?: number }): Promise<RoutingSurfaceItemRow[]>;
  getRoutingSurfaceItem(id: string): Promise<RoutingSurfaceItemRow | null>;
  updateRoutingSurfaceItem(id: string, fields: Partial<Omit<RoutingSurfaceItemRow, 'id' | 'created_at'>>): Promise<void>;

  // ─── Phase 6: A/B Routing Experiments ─────────────────────
  createRoutingExperiment(r: Omit<RoutingExperimentRow, 'created_at' | 'updated_at' | 'started_at' | 'ended_at'> & { started_at?: string; ended_at?: string | null }): Promise<void>;
  getRoutingExperiment(id: string): Promise<RoutingExperimentRow | null>;
  listRoutingExperiments(opts?: { status?: string; taskKey?: string; tenantId?: string | null }): Promise<RoutingExperimentRow[]>;
  updateRoutingExperiment(id: string, fields: Partial<Omit<RoutingExperimentRow, 'id' | 'created_at'>>): Promise<void>;
  deleteRoutingExperiment(id: string): Promise<void>;

  // ─── Admin: Workflow definitions ───────────────────────────
  createWorkflowDef(w: Omit<WorkflowDefRow, 'created_at' | 'updated_at'>): Promise<void>;
  getWorkflowDef(id: string): Promise<WorkflowDefRow | null>;
  listWorkflowDefs(): Promise<WorkflowDefRow[]>;
  updateWorkflowDef(id: string, fields: Partial<Omit<WorkflowDefRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteWorkflowDef(id: string): Promise<void>;

  // ─── Admin: Tool catalog ───────────────────────────────────
  createToolConfig(t: Omit<ToolCatalogRow, 'created_at' | 'updated_at'>): Promise<void>;
  getToolConfig(id: string): Promise<ToolCatalogRow | null>;
  getToolCatalogByKey(toolKey: string): Promise<ToolCatalogRow | null>;
  listToolConfigs(): Promise<ToolCatalogRow[]>;
  listEnabledToolCatalog(): Promise<ToolCatalogRow[]>;
  updateToolConfig(id: string, fields: Partial<Omit<ToolCatalogRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteToolConfig(id: string): Promise<void>;

  // ─── Admin: Tool policies ──────────────────────────────────
  createToolPolicy(p: Omit<ToolPolicyRow, 'created_at' | 'updated_at'>): Promise<void>;
  getToolPolicy(id: string): Promise<ToolPolicyRow | null>;
  getToolPolicyByKey(key: string): Promise<ToolPolicyRow | null>;
  listToolPolicies(): Promise<ToolPolicyRow[]>;
  updateToolPolicy(id: string, fields: Partial<Omit<ToolPolicyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteToolPolicy(id: string): Promise<void>;
  /** Rate limiting: check window count and increment if within limit. Returns true if allowed. */
  checkAndIncrementRateLimit(toolName: string, scopeKey: string, windowStartIso: string, limitPerMinute: number): Promise<boolean>;

  // ─── Phase 3: Tool Audit Events ─────────────────────────────
  /** Append-only insert for audit trail. */
  insertToolAuditEvent(event: Omit<ToolAuditEventRow, 'created_at'>): Promise<void>;
  /** List audit events with optional filters (all filters are AND-combined). */
  listToolAuditEvents(filters?: {
    toolName?: string;
    chatId?: string;
    outcome?: string;
    afterIso?: string;
    beforeIso?: string;
    limit?: number;
    offset?: number;
  }): Promise<ToolAuditEventRow[]>;
  /** Get a single audit event by ID. */
  getToolAuditEvent(id: string): Promise<ToolAuditEventRow | null>;

  // ─── Phase 3: Tool Health Snapshots ─────────────────────────
  /** Insert a point-in-time health snapshot (written by background job). */
  insertToolHealthSnapshot(snapshot: Omit<ToolHealthSnapshotRow, 'created_at'>): Promise<void>;
  /** Get snapshots for a tool (up to limit, newest first). */
  listToolHealthSnapshots(toolName: string, limit?: number): Promise<ToolHealthSnapshotRow[]>;
  /** Get live health summary per tool aggregated from audit events (last 24 h). */
  getToolHealthSummary(sinceIso?: string): Promise<ToolHealthSummary[]>;

  // ─── Phase 4: Tool Credentials ──────────────────────────────
  createToolCredential(c: Omit<ToolCredentialRow, 'created_at' | 'updated_at'>): Promise<void>;
  getToolCredential(id: string): Promise<ToolCredentialRow | null>;
  listToolCredentials(): Promise<ToolCredentialRow[]>;
  listEnabledToolCredentials(): Promise<ToolCredentialRow[]>;
  updateToolCredential(id: string, fields: Partial<Omit<ToolCredentialRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteToolCredential(id: string): Promise<void>;
  /** Resolve a credential by ID and attempt validation by checking env var presence.
   *  Updates validation_status in DB and returns the resolved secret value or null. */
  validateToolCredential(id: string): Promise<{ status: 'valid' | 'invalid' | 'unknown'; value: string | null }>;

  // ─── Phase 5: MCP Gateway Clients (per-client bearer tokens) ──
  /** Insert a new gateway client row. The token must be hashed by the
   *  caller before being passed in (see `hashGatewayToken()`). */
  createMCPGatewayClient(c: Omit<MCPGatewayClientRow, 'created_at' | 'updated_at' | 'last_used_at' | 'revoked_at' | 'expires_at' | 'rotated_at'> & Partial<Pick<MCPGatewayClientRow, 'expires_at' | 'rotated_at'>>): Promise<void>;
  getMCPGatewayClient(id: string): Promise<MCPGatewayClientRow | null>;
  /** Constant-time-ish lookup by token digest. Used on every gateway request
   *  to attribute the call to a specific client and stamp audit events. */
  getMCPGatewayClientByTokenHash(tokenHash: string): Promise<MCPGatewayClientRow | null>;
  listMCPGatewayClients(): Promise<MCPGatewayClientRow[]>;
  listEnabledMCPGatewayClients(): Promise<MCPGatewayClientRow[]>;
  updateMCPGatewayClient(id: string, fields: Partial<Omit<MCPGatewayClientRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  /** Stamp last_used_at on the client row. Best-effort; called from the
   *  gateway request hot path so failures must not block the request. */
  touchMCPGatewayClient(id: string): Promise<void>;
  /** Soft-delete: set revoked_at and enabled=0. The row stays for audit
   *  trail. Hard delete is via `deleteMCPGatewayClient`. */
  revokeMCPGatewayClient(id: string): Promise<void>;
  deleteMCPGatewayClient(id: string): Promise<void>;
  /** Phase 7: atomic 1-minute tumbling rate-limit check for a gateway client.
   *  Returns the bucket count after a successful increment, or `false` when
   *  the client has already exhausted `limitPerMinute` for the current
   *  window. Mirrors the tool_rate_limit_buckets contract. */
  checkAndIncrementGatewayRateLimit(
    clientId: string,
    windowStartIso: string,
    limitPerMinute: number,
  ): Promise<boolean>;
  /** Phase 8: append-only gateway request log. Records every terminal
   *  outcome (ok / rate_limited / unauthorized / error) so operators can
   *  build per-client activity dashboards independent of tool_audit_events. */
  insertMCPGatewayRequestLog(row: Omit<MCPGatewayRequestLogRow, 'created_at'>): Promise<void>;
  /** Recent gateway requests, newest-first, optionally filtered by client. */
  listMCPGatewayRequestLog(opts: {
    clientId?: string;
    outcome?: MCPGatewayRequestOutcome;
    limit?: number;
    offset?: number;
  }): Promise<MCPGatewayRequestLogRow[]>;
  /** Aggregate per-client counts since the given ISO timestamp.
   *  Returns one row per client_id (NULL groups under client_id=null). */
  summarizeMCPGatewayActivity(opts: {
    sinceIso: string;
  }): Promise<MCPGatewayActivitySummary[]>;

  /** Phase 9: list clients whose `expires_at` falls between now and
   *  `now + windowSeconds` and which are still enabled / non-revoked.
   *  Used by the admin "expiring soon" view to nudge operators to
   *  rotate before the token starts being rejected. */
  listExpiringMCPGatewayClients(windowSeconds: number): Promise<MCPGatewayClientRow[]>;

  // ─── Admin: Skills ─────────────────────────────────────────
  createSkill(s: Omit<SkillRow, 'created_at' | 'updated_at'>): Promise<void>;
  getSkill(id: string): Promise<SkillRow | null>;
  listSkills(): Promise<SkillRow[]>;
  listEnabledSkills(): Promise<SkillRow[]>;
  updateSkill(id: string, fields: Partial<Omit<SkillRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteSkill(id: string): Promise<void>;

  // ─── Phase 6: Tool Approval Requests ──────────────────────
  createToolApprovalRequest(r: Omit<ToolApprovalRequestRow, 'requested_at'>): Promise<void>;
  getToolApprovalRequest(id: string): Promise<ToolApprovalRequestRow | null>;
  /** Returns most-recent approved request for a specific tool in a chat session, or null. */
  getApprovedToolRequest(toolName: string, chatId: string): Promise<ToolApprovalRequestRow | null>;
  /** Returns the oldest pending approval request for a tool+chat combo, or null. */
  getPendingToolRequest(toolName: string, chatId: string): Promise<ToolApprovalRequestRow | null>;
  listToolApprovalRequests(opts?: { status?: string; chatId?: string; toolName?: string; limit?: number; offset?: number }): Promise<ToolApprovalRequestRow[]>;
  resolveToolApprovalRequest(id: string, fields: { status: string; resolved_by?: string; resolution_note?: string }): Promise<void>;

  // ─── Worker Agents ─────────────────────────────────────────
  createWorkerAgent(w: Omit<WorkerAgentRow, 'created_at' | 'updated_at'>): Promise<void>;
  getWorkerAgent(id: string): Promise<WorkerAgentRow | null>;
  listWorkerAgents(): Promise<WorkerAgentRow[]>;
  listEnabledWorkerAgents(): Promise<WorkerAgentRow[]>;
  /** Returns enabled worker agents for a specific category (e.g. 'hypothesis-validation'). */
  listWorkerAgentsByCategory(category: string): Promise<WorkerAgentRow[]>;
  updateWorkerAgent(id: string, fields: Partial<Omit<WorkerAgentRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteWorkerAgent(id: string): Promise<void>;

  // ─── Phase 1B: Supervisor Agents ───────────────────────────
  createSupervisorAgent(a: Omit<SupervisorAgentRow, 'created_at' | 'updated_at'>, tools?: Array<{ tool_name: string; allocation?: string }>): Promise<void>;
  getSupervisorAgent(id: string): Promise<SupervisorAgentRow | null>;
  listSupervisorAgents(opts?: { tenantId?: string | null; category?: string; enabledOnly?: boolean }): Promise<SupervisorAgentRow[]>;
  updateSupervisorAgent(id: string, fields: Partial<Omit<SupervisorAgentRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteSupervisorAgent(id: string): Promise<void>;
  listAgentTools(agentId: string): Promise<AgentToolRow[]>;
  setAgentTools(agentId: string, tools: Array<{ tool_name: string; allocation?: string }>): Promise<void>;
  /**
   * Resolve which supervisor agent row applies to a chat session.
   * Precedence: skill.supervisor_agent_id (if skillId provided) ->
   *   tenant_id+category match -> tenant_id IS NULL+category match ->
   *   is_default=1 row -> null (caller falls back to package defaults).
   */
  resolveSupervisorAgent(opts: { tenantId?: string | null; category?: string; skillId?: string | null }): Promise<ResolvedSupervisorAgent | null>;

  // ─── Workflow Runs ─────────────────────────────────────────
  createWorkflowRun(r: Omit<WorkflowRunRow, 'completed_at'>): Promise<void>;
  getWorkflowRun(id: string): Promise<WorkflowRunRow | null>;
  listWorkflowRuns(workflowId?: string): Promise<WorkflowRunRow[]>;
  updateWorkflowRun(id: string, fields: Partial<Omit<WorkflowRunRow, 'id' | 'started_at'>>): Promise<void>;

  // ─── Guardrail Evaluations ─────────────────────────────────
  createGuardrailEval(e: Omit<GuardrailEvalRow, 'created_at'>): Promise<void>;
  listGuardrailEvals(chatId?: string, limit?: number): Promise<GuardrailEvalRow[]>;

  // ─── Admin: Human Task Policies ────────────────────────────
  createHumanTaskPolicy(p: Omit<HumanTaskPolicyRow, 'created_at' | 'updated_at'>): Promise<void>;
  getHumanTaskPolicy(id: string): Promise<HumanTaskPolicyRow | null>;
  listHumanTaskPolicies(): Promise<HumanTaskPolicyRow[]>;
  updateHumanTaskPolicy(id: string, fields: Partial<Omit<HumanTaskPolicyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteHumanTaskPolicy(id: string): Promise<void>;

  // ─── Admin: Task Contracts ─────────────────────────────────
  createTaskContract(c: Omit<TaskContractRow, 'created_at' | 'updated_at'>): Promise<void>;
  getTaskContract(id: string): Promise<TaskContractRow | null>;
  listTaskContracts(): Promise<TaskContractRow[]>;
  updateTaskContract(id: string, fields: Partial<Omit<TaskContractRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteTaskContract(id: string): Promise<void>;

  // ─── Admin: Cache Policies ─────────────────────────────────
  createCachePolicy(p: Omit<CachePolicyRow, 'created_at' | 'updated_at'>): Promise<void>;
  getCachePolicy(id: string): Promise<CachePolicyRow | null>;
  listCachePolicies(): Promise<CachePolicyRow[]>;
  updateCachePolicy(id: string, fields: Partial<Omit<CachePolicyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteCachePolicy(id: string): Promise<void>;

  // ─── Admin: Identity Rules ─────────────────────────────────
  createIdentityRule(r: Omit<IdentityRuleRow, 'created_at' | 'updated_at'>): Promise<void>;
  getIdentityRule(id: string): Promise<IdentityRuleRow | null>;
  listIdentityRules(): Promise<IdentityRuleRow[]>;
  updateIdentityRule(id: string, fields: Partial<Omit<IdentityRuleRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteIdentityRule(id: string): Promise<void>;

  // ─── Admin: Memory Governance ──────────────────────────────
  createMemoryGovernance(g: Omit<MemoryGovernanceRow, 'created_at' | 'updated_at'>): Promise<void>;
  getMemoryGovernance(id: string): Promise<MemoryGovernanceRow | null>;
  listMemoryGovernance(): Promise<MemoryGovernanceRow[]>;
  updateMemoryGovernance(id: string, fields: Partial<Omit<MemoryGovernanceRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteMemoryGovernance(id: string): Promise<void>;

  // ─── Admin: Memory Extraction Rules ────────────────────────
  createMemoryExtractionRule(r: Omit<MemoryExtractionRuleRow, 'created_at' | 'updated_at'>): Promise<void>;
  getMemoryExtractionRule(id: string): Promise<MemoryExtractionRuleRow | null>;
  listMemoryExtractionRules(ruleType?: string): Promise<MemoryExtractionRuleRow[]>;
  updateMemoryExtractionRule(id: string, fields: Partial<Omit<MemoryExtractionRuleRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteMemoryExtractionRule(id: string): Promise<void>;

  // ─── Admin: Search Providers ─────────────────────────────────
  createSearchProvider(p: Omit<SearchProviderRow, 'created_at' | 'updated_at'>): Promise<void>;
  getSearchProvider(id: string): Promise<SearchProviderRow | null>;
  listSearchProviders(): Promise<SearchProviderRow[]>;
  updateSearchProvider(id: string, fields: Partial<Omit<SearchProviderRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteSearchProvider(id: string): Promise<void>;

  // ─── Admin: HTTP Endpoints ─────────────────────────────────
  createHttpEndpoint(e: Omit<HttpEndpointRow, 'created_at' | 'updated_at'>): Promise<void>;
  getHttpEndpoint(id: string): Promise<HttpEndpointRow | null>;
  listHttpEndpoints(): Promise<HttpEndpointRow[]>;
  updateHttpEndpoint(id: string, fields: Partial<Omit<HttpEndpointRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteHttpEndpoint(id: string): Promise<void>;

  // ─── Admin: Social Accounts ────────────────────────────────
  createSocialAccount(a: Omit<SocialAccountRow, 'created_at' | 'updated_at'>): Promise<void>;
  getSocialAccount(id: string): Promise<SocialAccountRow | null>;
  listSocialAccounts(): Promise<SocialAccountRow[]>;
  updateSocialAccount(id: string, fields: Partial<Omit<SocialAccountRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteSocialAccount(id: string): Promise<void>;

  // ─── Admin: Enterprise Connectors ──────────────────────────
  createEnterpriseConnector(c: Omit<EnterpriseConnectorRow, 'created_at' | 'updated_at'>): Promise<void>;
  getEnterpriseConnector(id: string): Promise<EnterpriseConnectorRow | null>;
  listEnterpriseConnectors(): Promise<EnterpriseConnectorRow[]>;
  updateEnterpriseConnector(id: string, fields: Partial<Omit<EnterpriseConnectorRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteEnterpriseConnector(id: string): Promise<void>;

  // ─── Admin: Tool Registry ──────────────────────────────────
  createToolRegistryEntry(t: Omit<ToolRegistryRow, 'created_at' | 'updated_at'>): Promise<void>;
  getToolRegistryEntry(id: string): Promise<ToolRegistryRow | null>;
  listToolRegistry(): Promise<ToolRegistryRow[]>;
  updateToolRegistryEntry(id: string, fields: Partial<Omit<ToolRegistryRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteToolRegistryEntry(id: string): Promise<void>;

  // ─── Admin: Replay Scenarios ─────────────────────────────────
  createReplayScenario(s: Omit<ReplayScenarioRow, 'created_at' | 'updated_at'>): Promise<void>;
  getReplayScenario(id: string): Promise<ReplayScenarioRow | null>;
  listReplayScenarios(): Promise<ReplayScenarioRow[]>;
  updateReplayScenario(id: string, fields: Partial<Omit<ReplayScenarioRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteReplayScenario(id: string): Promise<void>;

  // ─── Admin: Trigger Definitions ──────────────────────────────
  createTriggerDefinition(t: Omit<TriggerDefinitionRow, 'created_at' | 'updated_at'>): Promise<void>;
  getTriggerDefinition(id: string): Promise<TriggerDefinitionRow | null>;
  listTriggerDefinitions(): Promise<TriggerDefinitionRow[]>;
  updateTriggerDefinition(id: string, fields: Partial<Omit<TriggerDefinitionRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteTriggerDefinition(id: string): Promise<void>;

  // ─── Admin: Tenant Configs ───────────────────────────────────
  createTenantConfig(c: Omit<TenantConfigRow, 'created_at' | 'updated_at'>): Promise<void>;
  getTenantConfig(id: string): Promise<TenantConfigRow | null>;
  listTenantConfigs(): Promise<TenantConfigRow[]>;
  updateTenantConfig(id: string, fields: Partial<Omit<TenantConfigRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteTenantConfig(id: string): Promise<void>;

  // ─── Admin: Sandbox Policies ─────────────────────────────────
  createSandboxPolicy(p: Omit<SandboxPolicyRow, 'created_at' | 'updated_at'>): Promise<void>;
  getSandboxPolicy(id: string): Promise<SandboxPolicyRow | null>;
  listSandboxPolicies(): Promise<SandboxPolicyRow[]>;
  updateSandboxPolicy(id: string, fields: Partial<Omit<SandboxPolicyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteSandboxPolicy(id: string): Promise<void>;

  // ─── Admin: Extraction Pipelines ─────────────────────────────
  createExtractionPipeline(p: Omit<ExtractionPipelineRow, 'created_at' | 'updated_at'>): Promise<void>;
  getExtractionPipeline(id: string): Promise<ExtractionPipelineRow | null>;
  listExtractionPipelines(): Promise<ExtractionPipelineRow[]>;
  updateExtractionPipeline(id: string, fields: Partial<Omit<ExtractionPipelineRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteExtractionPipeline(id: string): Promise<void>;

  // ─── Admin: Artifact Policies ────────────────────────────────
  createArtifactPolicy(p: Omit<ArtifactPolicyRow, 'created_at' | 'updated_at'>): Promise<void>;
  getArtifactPolicy(id: string): Promise<ArtifactPolicyRow | null>;
  listArtifactPolicies(): Promise<ArtifactPolicyRow[]>;
  updateArtifactPolicy(id: string, fields: Partial<Omit<ArtifactPolicyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteArtifactPolicy(id: string): Promise<void>;

  // ─── Admin: Reliability Policies ─────────────────────────────
  createReliabilityPolicy(p: Omit<ReliabilityPolicyRow, 'created_at' | 'updated_at'>): Promise<void>;
  getReliabilityPolicy(id: string): Promise<ReliabilityPolicyRow | null>;
  listReliabilityPolicies(): Promise<ReliabilityPolicyRow[]>;
  updateReliabilityPolicy(id: string, fields: Partial<Omit<ReliabilityPolicyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteReliabilityPolicy(id: string): Promise<void>;

  // ─── Admin: Collaboration Sessions ───────────────────────────
  createCollaborationSession(s: Omit<CollaborationSessionRow, 'created_at' | 'updated_at'>): Promise<void>;
  getCollaborationSession(id: string): Promise<CollaborationSessionRow | null>;
  listCollaborationSessions(): Promise<CollaborationSessionRow[]>;
  updateCollaborationSession(id: string, fields: Partial<Omit<CollaborationSessionRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteCollaborationSession(id: string): Promise<void>;

  // ─── Admin: Compliance Rules ─────────────────────────────────
  createComplianceRule(r: Omit<ComplianceRuleRow, 'created_at' | 'updated_at'>): Promise<void>;
  getComplianceRule(id: string): Promise<ComplianceRuleRow | null>;
  listComplianceRules(): Promise<ComplianceRuleRow[]>;
  updateComplianceRule(id: string, fields: Partial<Omit<ComplianceRuleRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteComplianceRule(id: string): Promise<void>;

  // ─── Admin: Graph Configs ────────────────────────────────────
  createGraphConfig(g: Omit<GraphConfigRow, 'created_at' | 'updated_at'>): Promise<void>;
  getGraphConfig(id: string): Promise<GraphConfigRow | null>;
  listGraphConfigs(): Promise<GraphConfigRow[]>;
  updateGraphConfig(id: string, fields: Partial<Omit<GraphConfigRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteGraphConfig(id: string): Promise<void>;

  // ─── Admin: Plugin Configs ───────────────────────────────────
  createPluginConfig(p: Omit<PluginConfigRow, 'created_at' | 'updated_at'>): Promise<void>;
  getPluginConfig(id: string): Promise<PluginConfigRow | null>;
  listPluginConfigs(): Promise<PluginConfigRow[]>;
  updatePluginConfig(id: string, fields: Partial<Omit<PluginConfigRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deletePluginConfig(id: string): Promise<void>;

  // ─── Admin: Scaffold Templates (Phase 9) ─────────────────────
  createScaffoldTemplate(t: Omit<ScaffoldTemplateRow, 'created_at' | 'updated_at'>): Promise<void>;
  getScaffoldTemplate(id: string): Promise<ScaffoldTemplateRow | null>;
  listScaffoldTemplates(): Promise<ScaffoldTemplateRow[]>;
  updateScaffoldTemplate(id: string, fields: Partial<Omit<ScaffoldTemplateRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteScaffoldTemplate(id: string): Promise<void>;

  // ─── Admin: Recipe Configs (Phase 9) ─────────────────────────
  createRecipeConfig(r: Omit<RecipeConfigRow, 'created_at' | 'updated_at'>): Promise<void>;
  getRecipeConfig(id: string): Promise<RecipeConfigRow | null>;
  listRecipeConfigs(): Promise<RecipeConfigRow[]>;
  updateRecipeConfig(id: string, fields: Partial<Omit<RecipeConfigRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteRecipeConfig(id: string): Promise<void>;

  // ─── Admin: Widget Configs (Phase 9) ─────────────────────────
  createWidgetConfig(w: Omit<WidgetConfigRow, 'created_at' | 'updated_at'>): Promise<void>;
  getWidgetConfig(id: string): Promise<WidgetConfigRow | null>;
  listWidgetConfigs(): Promise<WidgetConfigRow[]>;
  updateWidgetConfig(id: string, fields: Partial<Omit<WidgetConfigRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteWidgetConfig(id: string): Promise<void>;

  // ─── Admin: Validation Rules (Phase 9) ───────────────────────
  createValidationRule(r: Omit<ValidationRuleRow, 'created_at' | 'updated_at'>): Promise<void>;
  getValidationRule(id: string): Promise<ValidationRuleRow | null>;
  listValidationRules(): Promise<ValidationRuleRow[]>;
  updateValidationRule(id: string, fields: Partial<Omit<ValidationRuleRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteValidationRule(id: string): Promise<void>;

  // ─── Website Credentials (Browser Auth Vault) ─────────────────
  createWebsiteCredential(c: Omit<WebsiteCredentialRow, 'created_at' | 'updated_at'>): Promise<void>;
  getWebsiteCredential(id: string, userId: string): Promise<WebsiteCredentialRow | null>;
  listWebsiteCredentials(userId: string): Promise<WebsiteCredentialRow[]>;
  listAllActiveWebsiteCredentials(): Promise<WebsiteCredentialRow[]>;
  findWebsiteCredential(userId: string, url: string): Promise<WebsiteCredentialRow | null>;
  updateWebsiteCredential(id: string, userId: string, fields: Partial<Omit<WebsiteCredentialRow, 'id' | 'user_id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteWebsiteCredential(id: string, userId: string): Promise<void>;

  // ─── SSO Linked Accounts (SSO Pass-Through) ──────────────────
  createSSOLinkedAccount(acct: { id: string; user_id: string; identity_provider: string; email?: string; session_encrypted: string; encryption_iv: string }): Promise<void>;
  getSSOLinkedAccount(userId: string, identityProvider: string): Promise<SSOLinkedAccountRow | null>;
  listSSOLinkedAccounts(userId: string): Promise<Array<Omit<SSOLinkedAccountRow, 'session_encrypted' | 'encryption_iv'>>>;
  deleteSSOLinkedAccount(userId: string, identityProvider: string): Promise<void>;

  // ─── Semantic Memory ──────────────────────────────────────────
  saveSemanticMemory(m: {
    id: string;
    userId: string;
    chatId?: string;
    tenantId?: string;
    content: string;
    memoryType?: string;
    source?: string;
  }): Promise<void>;
  searchSemanticMemory(opts: {
    userId: string;
    query: string;
    limit?: number;
  }): Promise<SemanticMemoryRow[]>;
  listSemanticMemory(userId: string, limit?: number): Promise<SemanticMemoryRow[]>;
  deleteSemanticMemory(id: string, userId: string): Promise<void>;
  clearUserSemanticMemory(userId: string): Promise<void>;

  // ─── Entity Memory ────────────────────────────────────────────
  upsertEntity(e: {
    userId: string;
    entityName: string;
    entityType?: string;
    facts: Record<string, unknown>;
    confidence?: number;
    source?: string;
    chatId?: string;
    tenantId?: string;
  }): Promise<void>;
  getEntity(userId: string, entityName: string): Promise<EntityMemoryRow | null>;
  searchEntities(userId: string, query: string): Promise<EntityMemoryRow[]>;
  listEntities(userId: string): Promise<EntityMemoryRow[]>;
  deleteEntity(userId: string, entityName: string): Promise<void>;
  clearUserEntityMemory(userId: string): Promise<void>;

  recordMemoryExtractionEvent(e: {
    id: string;
    userId: string;
    chatId?: string;
    tenantId?: string;
    selfDisclosure: boolean;
    regexEntitiesCount: number;
    llmEntitiesCount: number;
    mergedEntitiesCount: number;
    events?: string;
  }): Promise<void>;
  getMemoryExtractionEvent(id: string): Promise<MemoryExtractionEventRow | null>;
  listMemoryExtractionEvents(chatId?: string, limit?: number): Promise<MemoryExtractionEventRow[]>;

  // ─── Admin: Seed data ──────────────────────────────────────
  seedDefaultData(): Promise<void>;

  // ─── Scientific Validation ───────────────────────────────────

  // Budget envelopes
  createBudgetEnvelope(envelope: Omit<SvBudgetEnvelopeRow, 'created_at'>): Promise<void>;
  getBudgetEnvelope(id: string, tenantId: string): Promise<SvBudgetEnvelopeRow | null>;
  listBudgetEnvelopes(tenantId: string): Promise<SvBudgetEnvelopeRow[]>;

  // Hypotheses
  createHypothesis(hypothesis: Omit<SvHypothesisRow, 'created_at' | 'updated_at'>): Promise<void>;
  getHypothesis(id: string, tenantId: string): Promise<SvHypothesisRow | null>;
  listHypotheses(tenantId: string, limit?: number, offset?: number): Promise<SvHypothesisRow[]>;
  updateHypothesisStatus(id: string, status: SvHypothesisStatus, updatedAt: string): Promise<void>;
  updateHypothesisWorkflowIds(id: string, opts: { workflowRunId?: string; traceId?: string; contractId?: string; updatedAt: string }): Promise<void>;

  // Sub-claims
  createSubClaim(claim: Omit<SvSubClaimRow, 'created_at'>): Promise<void>;
  getSubClaim(id: string): Promise<SvSubClaimRow | null>;
  listSubClaims(hypothesisId: string): Promise<SvSubClaimRow[]>;

  // Verdicts
  createVerdict(verdict: Omit<SvVerdictRow, 'created_at'>): Promise<void>;
  getVerdictByHypothesis(hypothesisId: string): Promise<SvVerdictRow | null>;
  getVerdictById(id: string): Promise<SvVerdictRow | null>;

  // Evidence events (SSE /events stream)
  createEvidenceEvent(event: Omit<SvEvidenceEventRow, 'created_at'>): Promise<void>;
  listEvidenceEvents(hypothesisId: string, afterId?: string, limit?: number): Promise<SvEvidenceEventRow[]>;

  // Agent dialogue turns (SSE /dialogue stream)
  createAgentTurn(turn: Omit<SvAgentTurnRow, 'created_at'>): Promise<void>;
  listAgentTurns(hypothesisId: string, afterId?: string, limit?: number): Promise<SvAgentTurnRow[]>;

  // ─── Phase K3: Kaggle projections ───────────────────────────
  // Tracked competitions
  upsertKaggleCompetitionTracked(row: Omit<KaggleCompetitionTrackedRow, 'created_at' | 'updated_at'>): Promise<void>;
  getKaggleCompetitionTracked(id: string): Promise<KaggleCompetitionTrackedRow | null>;
  listKaggleCompetitionsTracked(opts?: { status?: string; tenantId?: string | null; limit?: number; offset?: number }): Promise<KaggleCompetitionTrackedRow[]>;
  updateKaggleCompetitionTracked(id: string, patch: Partial<Omit<KaggleCompetitionTrackedRow, 'id' | 'created_at'>>): Promise<void>;
  deleteKaggleCompetitionTracked(id: string): Promise<void>;

  // Approaches
  createKaggleApproach(row: Omit<KaggleApproachRow, 'created_at' | 'updated_at'>): Promise<void>;
  getKaggleApproach(id: string): Promise<KaggleApproachRow | null>;
  listKaggleApproaches(opts?: { competitionRef?: string; status?: string; tenantId?: string | null; limit?: number; offset?: number }): Promise<KaggleApproachRow[]>;
  updateKaggleApproach(id: string, patch: Partial<Omit<KaggleApproachRow, 'id' | 'created_at'>>): Promise<void>;
  deleteKaggleApproach(id: string): Promise<void>;

  // Runs
  createKaggleRun(row: Omit<KaggleRunRow, 'created_at' | 'updated_at'>): Promise<void>;
  getKaggleRun(id: string): Promise<KaggleRunRow | null>;
  listKaggleRuns(opts?: { competitionRef?: string; approachId?: string; status?: string; tenantId?: string | null; limit?: number; offset?: number }): Promise<KaggleRunRow[]>;
  updateKaggleRun(id: string, patch: Partial<Omit<KaggleRunRow, 'id' | 'created_at'>>): Promise<void>;
  deleteKaggleRun(id: string): Promise<void>;

  // Phase K4 — Run artifacts (contract + replay payloads)
  upsertKaggleRunArtifact(row: Omit<KaggleRunArtifactRow, 'created_at'>): Promise<void>;
  getKaggleRunArtifactByRunId(runId: string): Promise<KaggleRunArtifactRow | null>;
  listKaggleRunArtifacts(opts?: { limit?: number; offset?: number }): Promise<KaggleRunArtifactRow[]>;
  deleteKaggleRunArtifact(id: string): Promise<void>;

  // Phase K7d — Competition-agnostic submission validation
  upsertKaggleCompetitionRubric(row: Omit<KaggleCompetitionRubricRow, 'created_at' | 'updated_at'>): Promise<KaggleCompetitionRubricRow>;
  getKaggleCompetitionRubric(id: string): Promise<KaggleCompetitionRubricRow | null>;
  getKaggleCompetitionRubricByRef(competitionRef: string, tenantId?: string | null): Promise<KaggleCompetitionRubricRow | null>;
  listKaggleCompetitionRubrics(opts?: { competitionRef?: string; tenantId?: string | null; limit?: number; offset?: number }): Promise<KaggleCompetitionRubricRow[]>;
  updateKaggleCompetitionRubric(id: string, patch: Partial<Omit<KaggleCompetitionRubricRow, 'id' | 'created_at'>>): Promise<void>;
  deleteKaggleCompetitionRubric(id: string): Promise<void>;

  createKaggleValidationResult(row: Omit<KaggleValidationResultRow, 'created_at'>): Promise<void>;
  getKaggleValidationResult(id: string): Promise<KaggleValidationResultRow | null>;
  listKaggleValidationResults(opts?: { runId?: string; competitionRef?: string; verdict?: string; limit?: number; offset?: number }): Promise<KaggleValidationResultRow[]>;
  deleteKaggleValidationResult(id: string): Promise<void>;

  createKaggleLeaderboardScore(row: Omit<KaggleLeaderboardScoreRow, 'created_at'>): Promise<void>;
  getKaggleLeaderboardScore(id: string): Promise<KaggleLeaderboardScoreRow | null>;
  listKaggleLeaderboardScores(opts?: { runId?: string; competitionRef?: string; limit?: number; offset?: number }): Promise<KaggleLeaderboardScoreRow[]>;
  deleteKaggleLeaderboardScore(id: string): Promise<void>;

  // Phase K5 — Live-agents Kaggle mesh index (pointer table to la_entities)
  upsertKaggleLiveMesh(row: { mesh_id: string; tenant_id: string; kaggle_username: string }): Promise<void>;
  listKaggleLiveMeshes(opts?: { tenantId?: string }): Promise<Array<{ mesh_id: string; tenant_id: string; kaggle_username: string; created_at: string }>>;

  // Phase K6 — Kaggle discussion bot (kill switch + post log)
  getKaggleDiscussionSettings(tenantId: string): Promise<KaggleDiscussionSettingsRow | null>;
  listKaggleDiscussionSettings(): Promise<KaggleDiscussionSettingsRow[]>;
  upsertKaggleDiscussionSettings(row: { tenant_id: string; discussion_enabled: number; notes?: string | null }): Promise<KaggleDiscussionSettingsRow>;
  isKaggleDiscussionEnabledForTenant(tenantId: string): Promise<boolean>;
  recordKaggleDiscussionPost(row: Omit<KaggleDiscussionPostRow, 'posted_at'> & { posted_at?: string }): Promise<void>;
  listKaggleDiscussionPosts(opts?: { tenantId?: string; competitionRef?: string; limit?: number; offset?: number }): Promise<KaggleDiscussionPostRow[]>;
  getKaggleDiscussionPost(id: string): Promise<KaggleDiscussionPostRow | null>;

  // Phase K8 — Kaggle competition run ledger (per-run UUIDv7 isolation).
  // Each "Start Competition" click writes a fresh run row; steps and events
  // are scoped to that run id so successive runs produce independent flows.
  createKglCompetitionRun(row: Omit<KglCompetitionRunRow, 'created_at' | 'updated_at' | 'step_count' | 'event_count'>): Promise<KglCompetitionRunRow>;
  getKglCompetitionRun(id: string, tenantId?: string | null): Promise<KglCompetitionRunRow | null>;
  listKglCompetitionRuns(opts?: { tenantId?: string | null; status?: KglRunStatus; competitionRef?: string; limit?: number; offset?: number }): Promise<KglCompetitionRunRow[]>;
  updateKglCompetitionRun(id: string, patch: Partial<Omit<KglCompetitionRunRow, 'id' | 'created_at'>>): Promise<void>;

  appendKglRunStep(row: Omit<KglRunStepRow, 'created_at' | 'updated_at'>): Promise<KglRunStepRow>;
  updateKglRunStep(id: string, patch: Partial<Omit<KglRunStepRow, 'id' | 'run_id' | 'created_at'>>): Promise<void>;
  listKglRunSteps(runId: string): Promise<KglRunStepRow[]>;

  appendKglRunEvent(row: Omit<KglRunEventRow, 'created_at'>): Promise<KglRunEventRow>;
  listKglRunEvents(runId: string, opts?: { afterId?: string; limit?: number }): Promise<KglRunEventRow[]>;

  /** Inter-agent messages for a live mesh, derived from la_entities (StateStore). */
  listLiveMeshMessages(meshId: string, opts?: { limit?: number }): Promise<LiveMeshMessageView[]>;

  // ─── Live mesh / agent definitions (M21) ─────────────────────
  listLiveMeshDefinitions(opts?: { enabledOnly?: boolean }): Promise<LiveMeshDefinitionRow[]>;
  getLiveMeshDefinition(id: string): Promise<LiveMeshDefinitionRow | null>;
  getLiveMeshDefinitionByKey(meshKey: string): Promise<LiveMeshDefinitionRow | null>;
  createLiveMeshDefinition(row: Omit<LiveMeshDefinitionRow, 'created_at' | 'updated_at'>): Promise<LiveMeshDefinitionRow>;
  updateLiveMeshDefinition(id: string, patch: Partial<Omit<LiveMeshDefinitionRow, 'id' | 'created_at'>>): Promise<void>;
  deleteLiveMeshDefinition(id: string): Promise<void>;

  listLiveAgentDefinitions(opts?: { meshDefId?: string; enabledOnly?: boolean }): Promise<LiveAgentDefinitionRow[]>;
  getLiveAgentDefinition(id: string): Promise<LiveAgentDefinitionRow | null>;
  createLiveAgentDefinition(row: Omit<LiveAgentDefinitionRow, 'created_at' | 'updated_at'>): Promise<LiveAgentDefinitionRow>;
  updateLiveAgentDefinition(id: string, patch: Partial<Omit<LiveAgentDefinitionRow, 'id' | 'mesh_def_id' | 'created_at'>>): Promise<void>;
  deleteLiveAgentDefinition(id: string): Promise<void>;

  listLiveMeshDelegationEdges(opts?: { meshDefId?: string; enabledOnly?: boolean }): Promise<LiveMeshDelegationEdgeRow[]>;
  getLiveMeshDelegationEdge(id: string): Promise<LiveMeshDelegationEdgeRow | null>;
  createLiveMeshDelegationEdge(row: Omit<LiveMeshDelegationEdgeRow, 'created_at' | 'updated_at'>): Promise<LiveMeshDelegationEdgeRow>;
  updateLiveMeshDelegationEdge(id: string, patch: Partial<Omit<LiveMeshDelegationEdgeRow, 'id' | 'mesh_def_id' | 'created_at'>>): Promise<void>;
  deleteLiveMeshDelegationEdge(id: string): Promise<void>;

  // ─── DB-Driven Live-Agents Runtime (M22, Phase 1) ─────────
  // Handler kinds (framework registry)
  listLiveHandlerKinds(opts?: { enabledOnly?: boolean }): Promise<LiveHandlerKindRow[]>;
  getLiveHandlerKind(id: string): Promise<LiveHandlerKindRow | null>;
  getLiveHandlerKindByKind(kind: string): Promise<LiveHandlerKindRow | null>;
  createLiveHandlerKind(row: Omit<LiveHandlerKindRow, 'created_at' | 'updated_at'>): Promise<LiveHandlerKindRow>;
  updateLiveHandlerKind(id: string, patch: Partial<Omit<LiveHandlerKindRow, 'id' | 'created_at'>>): Promise<void>;
  deleteLiveHandlerKind(id: string): Promise<void>;

  // Attention policies
  listLiveAttentionPolicies(opts?: { enabledOnly?: boolean }): Promise<LiveAttentionPolicyRow[]>;
  getLiveAttentionPolicy(id: string): Promise<LiveAttentionPolicyRow | null>;
  getLiveAttentionPolicyByKey(key: string): Promise<LiveAttentionPolicyRow | null>;
  createLiveAttentionPolicy(row: Omit<LiveAttentionPolicyRow, 'created_at' | 'updated_at'>): Promise<LiveAttentionPolicyRow>;
  updateLiveAttentionPolicy(id: string, patch: Partial<Omit<LiveAttentionPolicyRow, 'id' | 'created_at'>>): Promise<void>;
  deleteLiveAttentionPolicy(id: string): Promise<void>;

  // Provisioned meshes
  listLiveMeshes(opts?: { tenantId?: string; meshDefId?: string; status?: string }): Promise<LiveMeshRow[]>;
  getLiveMesh(id: string): Promise<LiveMeshRow | null>;
  createLiveMesh(row: Omit<LiveMeshRow, 'created_at' | 'updated_at'>): Promise<LiveMeshRow>;
  updateLiveMesh(id: string, patch: Partial<Omit<LiveMeshRow, 'id' | 'created_at'>>): Promise<void>;
  deleteLiveMesh(id: string): Promise<void>;

  // Provisioned agents
  listLiveAgents(opts?: { meshId?: string; status?: string }): Promise<LiveAgentRow[]>;
  getLiveAgent(id: string): Promise<LiveAgentRow | null>;
  createLiveAgent(row: Omit<LiveAgentRow, 'created_at' | 'updated_at'>): Promise<LiveAgentRow>;
  updateLiveAgent(id: string, patch: Partial<Omit<LiveAgentRow, 'id' | 'mesh_id' | 'created_at'>>): Promise<void>;
  deleteLiveAgent(id: string): Promise<void>;

  // Handler bindings
  listLiveAgentHandlerBindings(opts?: { agentId?: string; enabledOnly?: boolean }): Promise<LiveAgentHandlerBindingRow[]>;
  getLiveAgentHandlerBinding(id: string): Promise<LiveAgentHandlerBindingRow | null>;
  createLiveAgentHandlerBinding(row: Omit<LiveAgentHandlerBindingRow, 'created_at' | 'updated_at'>): Promise<LiveAgentHandlerBindingRow>;
  updateLiveAgentHandlerBinding(id: string, patch: Partial<Omit<LiveAgentHandlerBindingRow, 'id' | 'agent_id' | 'created_at'>>): Promise<void>;
  deleteLiveAgentHandlerBinding(id: string): Promise<void>;

  // Tool bindings
  listLiveAgentToolBindings(opts?: { agentId?: string; enabledOnly?: boolean }): Promise<LiveAgentToolBindingRow[]>;
  getLiveAgentToolBinding(id: string): Promise<LiveAgentToolBindingRow | null>;
  createLiveAgentToolBinding(row: Omit<LiveAgentToolBindingRow, 'created_at' | 'updated_at'>): Promise<LiveAgentToolBindingRow>;
  updateLiveAgentToolBinding(id: string, patch: Partial<Omit<LiveAgentToolBindingRow, 'id' | 'agent_id' | 'created_at'>>): Promise<void>;
  deleteLiveAgentToolBinding(id: string): Promise<void>;

  // Runs
  listLiveRuns(opts?: { meshId?: string; tenantId?: string; status?: string; limit?: number }): Promise<LiveRunRow[]>;
  getLiveRun(id: string): Promise<LiveRunRow | null>;
  createLiveRun(row: Omit<LiveRunRow, 'created_at' | 'updated_at'>): Promise<LiveRunRow>;
  updateLiveRun(id: string, patch: Partial<Omit<LiveRunRow, 'id' | 'mesh_id' | 'created_at'>>): Promise<void>;
  deleteLiveRun(id: string): Promise<void>;

  // Run steps
  listLiveRunSteps(opts?: { runId?: string; meshId?: string; agentId?: string }): Promise<LiveRunStepRow[]>;
  getLiveRunStep(id: string): Promise<LiveRunStepRow | null>;
  createLiveRunStep(row: Omit<LiveRunStepRow, 'created_at' | 'updated_at'>): Promise<LiveRunStepRow>;
  updateLiveRunStep(id: string, patch: Partial<Omit<LiveRunStepRow, 'id' | 'run_id' | 'mesh_id' | 'created_at'>>): Promise<void>;
  deleteLiveRunStep(id: string): Promise<void>;

  // Run events (append-only — no update)
  listLiveRunEvents(opts?: { runId?: string; afterId?: string; limit?: number }): Promise<LiveRunEventRow[]>;
  getLiveRunEvent(id: string): Promise<LiveRunEventRow | null>;
  appendLiveRunEvent(row: Omit<LiveRunEventRow, 'created_at'>): Promise<LiveRunEventRow>;
}


export interface DatabaseConfig {
  type: 'sqlite' | 'custom';
  /** SQLite file path (default: './geneweave.db') */
  path?: string;
  /** Provide your own adapter for Postgres, MySQL, Mongo, etc. */
  adapter?: DatabaseAdapter;
}
