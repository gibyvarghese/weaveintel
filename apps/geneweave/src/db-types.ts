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
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface WorkerAgentRow {
  id: string;
  name: string;
  description: string;
  system_prompt: string;
  tool_names: string;            // JSON string[]
  persona: string;
  trigger_patterns: string | null; // JSON string[]
  task_contract_id: string | null;
  max_retries: number;
  priority: number;
  enabled: number;
  created_at: string;
  updated_at: string;
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

// ─── Adapter interface ───────────────────────────────────────

export interface DatabaseAdapter {
  initialize(): Promise<void>;
  close(): Promise<void>;

  // Users
  createUser(user: { id: string; email: string; name: string; passwordHash: string; persona?: string; tenantId?: string | null }): Promise<void>;
  getUserByEmail(email: string): Promise<UserRow | null>;
  getUserById(id: string): Promise<UserRow | null>;
  listUsers(): Promise<UserRow[]>;
  updateUserPersona(userId: string, persona: string): Promise<void>;

  // Sessions
  createSession(session: { id: string; userId: string; csrfToken: string; expiresAt: string }): Promise<void>;
  getSession(id: string): Promise<SessionRow | null>;
  deleteSession(id: string): Promise<void>;
  deleteExpiredSessions(): Promise<void>;

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
  saveUserPreferences(userId: string, defaultMode: string, theme: string): Promise<void>;

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

  // ─── Admin: Skills ─────────────────────────────────────────
  createSkill(s: Omit<SkillRow, 'created_at' | 'updated_at'>): Promise<void>;
  getSkill(id: string): Promise<SkillRow | null>;
  listSkills(): Promise<SkillRow[]>;
  listEnabledSkills(): Promise<SkillRow[]>;
  updateSkill(id: string, fields: Partial<Omit<SkillRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteSkill(id: string): Promise<void>;

  // ─── Worker Agents ─────────────────────────────────────────
  createWorkerAgent(w: Omit<WorkerAgentRow, 'created_at' | 'updated_at'>): Promise<void>;
  getWorkerAgent(id: string): Promise<WorkerAgentRow | null>;
  listWorkerAgents(): Promise<WorkerAgentRow[]>;
  listEnabledWorkerAgents(): Promise<WorkerAgentRow[]>;
  updateWorkerAgent(id: string, fields: Partial<Omit<WorkerAgentRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteWorkerAgent(id: string): Promise<void>;

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
}


export interface DatabaseConfig {
  type: 'sqlite' | 'custom';
  /** SQLite file path (default: './geneweave.db') */
  path?: string;
  /** Provide your own adapter for Postgres, MySQL, Mongo, etc. */
  adapter?: DatabaseAdapter;
}

