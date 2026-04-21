/**
 * @weaveintel/geneweave — Database schema
 *
 * SQLite DDL for all geneWeave tables.
 */

// ─── SQLite adapter ──────────────────────────────────────────

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  persona TEXT NOT NULL DEFAULT 'tenant_user',
  tenant_id TEXT,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL DEFAULT 'New Chat',
  model TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  default_mode TEXT NOT NULL DEFAULT 'agent',
  theme TEXT NOT NULL DEFAULT 'light',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_settings (
  chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'agent',
  system_prompt TEXT,
  timezone TEXT,
  enabled_tools TEXT,
  redaction_enabled INTEGER NOT NULL DEFAULT 1,
  redaction_patterns TEXT,
  workers TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT,
  tokens_used INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS metrics (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  chat_id TEXT,
  type TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS eval_results (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  chat_id TEXT,
  eval_name TEXT NOT NULL,
  score REAL NOT NULL,
  passed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  system_prompt TEXT,
  timezone TEXT,
  enabled_tools TEXT,
  redaction_enabled INTEGER NOT NULL DEFAULT 0,
  redaction_patterns TEXT,
  workers TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS traces (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE,
  message_id TEXT,
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  parent_span_id TEXT,
  name TEXT NOT NULL,
  start_time INTEGER NOT NULL,
  end_time INTEGER,
  status TEXT,
  attributes TEXT,
  events TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS temporal_timers (
  id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  label TEXT,
  duration_ms INTEGER,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  paused_at TEXT,
  resumed_at TEXT,
  stopped_at TEXT,
  elapsed_ms INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (scope_id, id)
);

CREATE TABLE IF NOT EXISTS temporal_stopwatches (
  id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  label TEXT,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  paused_at TEXT,
  resumed_at TEXT,
  stopped_at TEXT,
  elapsed_ms INTEGER NOT NULL DEFAULT 0,
  laps_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (scope_id, id)
);

CREATE TABLE IF NOT EXISTS temporal_reminders (
  id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  text TEXT NOT NULL,
  due_at TEXT NOT NULL,
  timezone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  created_at TEXT NOT NULL,
  cancelled_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (scope_id, id)
);

CREATE TABLE IF NOT EXISTS prompts (
  id TEXT PRIMARY KEY,
  key TEXT,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  prompt_type TEXT NOT NULL DEFAULT 'template',
  owner TEXT,
  status TEXT NOT NULL DEFAULT 'published',
  tags TEXT,
  template TEXT NOT NULL,
  variables TEXT,
  version TEXT NOT NULL DEFAULT '1.0',
  model_compatibility TEXT,
  execution_defaults TEXT,
  framework TEXT,
  metadata TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prompt_frameworks (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  sections TEXT NOT NULL DEFAULT '[]',
  section_separator TEXT NOT NULL DEFAULT '\n\n',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prompt_fragments (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  content TEXT NOT NULL,
  variables TEXT,
  tags TEXT,
  version TEXT NOT NULL DEFAULT '1.0',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prompt_contracts (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  contract_type TEXT NOT NULL,
  schema TEXT,
  config TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prompt_strategies (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  instruction_prefix TEXT,
  instruction_suffix TEXT,
  config TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prompt_versions (
  id TEXT PRIMARY KEY,
  prompt_id TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  template TEXT NOT NULL,
  variables TEXT,
  model_compatibility TEXT,
  execution_defaults TEXT,
  framework TEXT,
  metadata TEXT,
  is_active INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(prompt_id, version)
);

CREATE TABLE IF NOT EXISTS prompt_experiments (
  id TEXT PRIMARY KEY,
  prompt_id TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  variants_json TEXT NOT NULL DEFAULT '[]',
  assignment_key_template TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prompt_eval_datasets (
  id TEXT PRIMARY KEY,
  prompt_id TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  prompt_version TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  pass_threshold REAL NOT NULL DEFAULT 0.75,
  cases_json TEXT NOT NULL DEFAULT '[]',
  rubric_json TEXT,
  metadata TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prompt_eval_runs (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES prompt_eval_datasets(id) ON DELETE CASCADE,
  prompt_id TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  prompt_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  avg_score REAL NOT NULL DEFAULT 0,
  passed_cases INTEGER NOT NULL DEFAULT 0,
  failed_cases INTEGER NOT NULL DEFAULT 0,
  total_cases INTEGER NOT NULL DEFAULT 0,
  results_json TEXT NOT NULL DEFAULT '[]',
  summary_json TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS prompt_optimizers (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  implementation_kind TEXT NOT NULL DEFAULT 'rule',
  config TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prompt_optimization_runs (
  id TEXT PRIMARY KEY,
  prompt_id TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  source_version TEXT NOT NULL,
  candidate_version TEXT NOT NULL,
  optimizer_id TEXT REFERENCES prompt_optimizers(id) ON DELETE SET NULL,
  objective TEXT NOT NULL,
  source_template TEXT NOT NULL,
  candidate_template TEXT NOT NULL,
  diff_json TEXT NOT NULL,
  eval_baseline_json TEXT,
  eval_candidate_json TEXT,
  status TEXT NOT NULL DEFAULT 'completed',
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS guardrails (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL,
  stage TEXT NOT NULL DEFAULT 'pre',
  config TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS routing_policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  strategy TEXT NOT NULL DEFAULT 'priority',
  constraints TEXT,
  weights TEXT,
  fallback_model TEXT,
  fallback_provider TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS model_pricing (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  display_name TEXT,
  input_cost_per_1m REAL NOT NULL DEFAULT 0,
  output_cost_per_1m REAL NOT NULL DEFAULT 0,
  quality_score REAL NOT NULL DEFAULT 0.7,
  source TEXT NOT NULL DEFAULT 'manual',
  last_synced_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(model_id, provider)
);

CREATE TABLE IF NOT EXISTS workflow_defs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  version TEXT NOT NULL DEFAULT '1.0',
  steps TEXT NOT NULL,
  entry_step_id TEXT NOT NULL,
  metadata TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tool_catalog (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  risk_level TEXT NOT NULL DEFAULT 'read-only',
  requires_approval INTEGER NOT NULL DEFAULT 0,
  max_execution_ms INTEGER,
  rate_limit_per_min INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  tool_key TEXT UNIQUE,
  version TEXT NOT NULL DEFAULT '1.0',
  side_effects INTEGER NOT NULL DEFAULT 0,
  tags TEXT,
  source TEXT NOT NULL DEFAULT 'builtin',
  credential_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tool_policies (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  applies_to TEXT,              -- JSON array of tool names or wildcards
  applies_to_risk_levels TEXT,  -- JSON array of ToolRiskLevel values
  approval_required INTEGER NOT NULL DEFAULT 0,
  allowed_risk_levels TEXT,     -- JSON array of ToolRiskLevel values
  max_execution_ms INTEGER,
  rate_limit_per_minute INTEGER,
  max_concurrent INTEGER,
  require_dry_run INTEGER NOT NULL DEFAULT 0,
  log_input_output INTEGER NOT NULL DEFAULT 1,
  persona_scope TEXT,           -- JSON array of persona identifiers
  active_hours_utc TEXT,        -- JSON object { start: "HH:MM", end: "HH:MM" }
  expires_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tool_rate_limit_buckets (
  id TEXT PRIMARY KEY,
  tool_name TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(tool_name, scope_key, window_start)
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  state TEXT NOT NULL DEFAULT '{}',
  input TEXT,
  error TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS guardrail_evals (
  id TEXT PRIMARY KEY,
  chat_id TEXT,
  message_id TEXT,
  stage TEXT NOT NULL,
  input_preview TEXT,
  results TEXT NOT NULL DEFAULT '[]',
  overall_decision TEXT NOT NULL DEFAULT 'allow',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS human_task_policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  trigger TEXT NOT NULL,
  task_type TEXT NOT NULL DEFAULT 'approval',
  default_priority TEXT NOT NULL DEFAULT 'normal',
  sla_hours REAL,
  auto_escalate_after_hours REAL,
  assignment_strategy TEXT NOT NULL DEFAULT 'round-robin',
  assign_to TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_contracts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  input_schema TEXT,
  output_schema TEXT,
  acceptance_criteria TEXT NOT NULL DEFAULT '[]',
  max_attempts INTEGER,
  timeout_ms INTEGER,
  evidence_required TEXT,
  min_confidence REAL,
  require_human_review INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cache_policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  scope TEXT NOT NULL DEFAULT 'global',
  ttl_ms INTEGER NOT NULL DEFAULT 300000,
  max_entries INTEGER NOT NULL DEFAULT 1000,
  bypass_patterns TEXT,
  invalidate_on TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS identity_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  resource TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT '*',
  roles TEXT,
  scopes TEXT,
  result TEXT NOT NULL DEFAULT 'allow',
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memory_governance (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  memory_types TEXT,
  tenant_id TEXT,
  block_patterns TEXT,
  redact_patterns TEXT,
  max_age TEXT,
  max_entries INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memory_extraction_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  rule_type TEXT NOT NULL,
  entity_type TEXT,
  pattern TEXT NOT NULL,
  flags TEXT,
  facts_template TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS search_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  provider_type TEXT NOT NULL,
  api_key TEXT,
  base_url TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  options TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS http_endpoints (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  url TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'GET',
  auth_type TEXT,
  auth_config TEXT,
  headers TEXT,
  body_template TEXT,
  response_transform TEXT,
  retry_count INTEGER NOT NULL DEFAULT 2,
  rate_limit_rpm INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS social_accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  platform TEXT NOT NULL,
  api_key TEXT,
  api_secret TEXT,
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at TEXT,
  oauth_state TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected',
  base_url TEXT,
  options TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS enterprise_connectors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  connector_type TEXT NOT NULL,
  base_url TEXT,
  auth_type TEXT,
  auth_config TEXT,
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at TEXT,
  oauth_state TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected',
  options TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tool_registry (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  package_name TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1.0',
  category TEXT NOT NULL DEFAULT 'custom',
  risk_level TEXT NOT NULL DEFAULT 'low',
  tags TEXT,
  config TEXT,
  requires_approval INTEGER NOT NULL DEFAULT 0,
  max_execution_ms INTEGER,
  rate_limit_per_min INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS replay_scenarios (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  golden_prompt TEXT NOT NULL,
  golden_response TEXT NOT NULL,
  model TEXT,
  provider TEXT,
  tags TEXT,
  acceptance_criteria TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trigger_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  trigger_type TEXT NOT NULL,
  expression TEXT,
  config TEXT,
  target_workflow TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  last_fired_at TEXT,
  fire_count INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tenant_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'tenant',
  allowed_models TEXT,
  denied_models TEXT,
  allowed_tools TEXT,
  max_tokens_daily INTEGER,
  max_cost_daily REAL,
  max_tokens_monthly INTEGER,
  max_cost_monthly REAL,
  features TEXT,
  config_overrides TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sandbox_policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  max_cpu_ms INTEGER,
  max_memory_mb INTEGER,
  max_duration_ms INTEGER NOT NULL DEFAULT 30000,
  max_output_bytes INTEGER,
  allowed_modules TEXT,
  denied_modules TEXT,
  network_access INTEGER NOT NULL DEFAULT 0,
  filesystem_access TEXT NOT NULL DEFAULT 'none',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS extraction_pipelines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  stages TEXT NOT NULL,
  input_mime_types TEXT,
  max_input_size_bytes INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS artifact_policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  max_size_bytes INTEGER,
  allowed_types TEXT,
  retention_days INTEGER,
  require_versioning INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reliability_policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  policy_type TEXT NOT NULL DEFAULT 'retry',
  max_retries INTEGER,
  initial_delay_ms INTEGER,
  max_delay_ms INTEGER,
  backoff_multiplier REAL,
  max_concurrent INTEGER,
  queue_size INTEGER,
  strategy TEXT,
  ttl_ms INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS collaboration_sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  session_type TEXT NOT NULL DEFAULT 'team',
  max_participants INTEGER NOT NULL DEFAULT 10,
  presence_ttl_ms INTEGER NOT NULL DEFAULT 30000,
  auto_close_idle_ms INTEGER,
  handoff_enabled INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS compliance_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  rule_type TEXT NOT NULL DEFAULT 'retention',
  target_resource TEXT NOT NULL DEFAULT '*',
  retention_days INTEGER,
  region TEXT,
  consent_purpose TEXT,
  action TEXT NOT NULL DEFAULT 'notify',
  config TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS graph_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  graph_type TEXT NOT NULL DEFAULT 'entity',
  max_depth INTEGER NOT NULL DEFAULT 3,
  entity_types TEXT,
  relationship_types TEXT,
  auto_link INTEGER NOT NULL DEFAULT 1,
  scoring_weights TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plugin_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  plugin_type TEXT NOT NULL DEFAULT 'community',
  package_name TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1.0.0',
  capabilities TEXT,
  trust_level TEXT NOT NULL DEFAULT 'community',
  auto_update INTEGER NOT NULL DEFAULT 0,
  config TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Phase 9: Developer Experience ──────────────────────────

CREATE TABLE IF NOT EXISTS scaffold_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  template_type TEXT NOT NULL DEFAULT 'basic-agent',
  files TEXT,
  dependencies TEXT,
  dev_dependencies TEXT,
  variables TEXT,
  post_install TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS recipe_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  recipe_type TEXT NOT NULL DEFAULT 'workflow',
  model TEXT,
  provider TEXT,
  system_prompt TEXT,
  tools TEXT,
  guardrails TEXT,
  max_steps INTEGER DEFAULT 10,
  options TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS widget_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  widget_type TEXT NOT NULL DEFAULT 'table',
  default_options TEXT,
  allowed_contexts TEXT,
  max_data_points INTEGER DEFAULT 1000,
  refresh_interval_ms INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS validation_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  rule_type TEXT NOT NULL DEFAULT 'required',
  target TEXT NOT NULL DEFAULT 'agent-config',
  condition TEXT,
  severity TEXT NOT NULL DEFAULT 'error',
  message TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS semantic_memory (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
  tenant_id TEXT,
  content TEXT NOT NULL,
  memory_type TEXT NOT NULL DEFAULT 'semantic',
  source TEXT NOT NULL DEFAULT 'assistant',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS entity_memory (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
  tenant_id TEXT,
  entity_name TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT 'general',
  facts TEXT NOT NULL DEFAULT '{}',
  confidence REAL NOT NULL DEFAULT 0.5,
  source TEXT NOT NULL DEFAULT 'regex',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, entity_name)
);

CREATE TABLE IF NOT EXISTS memory_extraction_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
  tenant_id TEXT,
  self_disclosure INTEGER NOT NULL DEFAULT 0,
  regex_entities_count INTEGER NOT NULL DEFAULT 0,
  llm_entities_count INTEGER NOT NULL DEFAULT 0,
  merged_entities_count INTEGER NOT NULL DEFAULT 0,
  events TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS website_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_name TEXT NOT NULL,
  site_url_pattern TEXT NOT NULL,
  auth_method TEXT NOT NULL DEFAULT 'form_fill',
  credentials_encrypted TEXT NOT NULL,
  encryption_iv TEXT NOT NULL,
  last_used_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Skills: reusable agent capability bundles ──────────────

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'general',
  -- JSON string[] — phrases that trigger this skill via pattern matching
  trigger_patterns TEXT NOT NULL DEFAULT '[]',
  -- System-prompt snippet injected when this skill is active
  instructions TEXT NOT NULL DEFAULT '',
  -- JSON string[] — tool names to make available when skill is active
  tool_names TEXT,
  -- JSON array of {input,output} examples (few-shot demonstrations)
  examples TEXT,
  -- JSON string[] — searchable tags
  tags TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  version TEXT NOT NULL DEFAULT '1.0',
  -- Phase 6: optional key referencing a tool_policies row; overrides the global tool policy for all tool calls while this skill is active
  tool_policy_key TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Tool Approval Requests (Phase 6) ──────────────────────
-- Created by DbToolApprovalGate when a tool invocation requires operator approval.
-- Operators approve or deny via the admin UI; the policy-enforced tool gate
-- checks this table before allowing or blocking execution.

CREATE TABLE IF NOT EXISTS tool_approval_requests (
  id TEXT PRIMARY KEY,
  tool_name TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  user_id TEXT,
  -- JSON snapshot of the tool input at the time of the request
  input_json TEXT NOT NULL DEFAULT '{}',
  -- Tool policy key that triggered the approval requirement
  policy_key TEXT,
  -- Skill that was active when the request was created (if any)
  skill_key TEXT,
  -- pending | approved | denied | expired
  status TEXT NOT NULL DEFAULT 'pending',
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolved_by TEXT,
  resolution_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_tool_approval_chat ON tool_approval_requests(chat_id, status);
CREATE INDEX IF NOT EXISTS idx_tool_approval_tool ON tool_approval_requests(tool_name, status);

-- ── Worker Agents: database-driven supervisor workers ──────

CREATE TABLE IF NOT EXISTS worker_agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  -- System prompt / instructions for this worker
  system_prompt TEXT NOT NULL DEFAULT '',
  -- JSON string[] — tool names available to this worker
  tool_names TEXT NOT NULL DEFAULT '[]',
  -- RBAC persona for tool filtering (e.g. 'agent_worker', 'agent_researcher')
  persona TEXT NOT NULL DEFAULT 'agent_worker',
  -- JSON string[] — trigger patterns for auto-routing (supervisor uses these to decide when to delegate)
  trigger_patterns TEXT,
  -- Optional task contract ID for completion validation
  task_contract_id TEXT REFERENCES task_contracts(id),
  -- Max retry attempts when contract validation fails
  max_retries INTEGER NOT NULL DEFAULT 0,
  -- Priority for ordering when building supervisor worker list (higher = listed first)
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Scientific Validation ────────────────────────────────────

-- Budget envelopes cap cost/time for a validation run. Created once, never mutated after use.
CREATE TABLE IF NOT EXISTS sv_budget_envelope (
  id TEXT PRIMARY KEY,                       -- uuid v7
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  max_llm_cents INTEGER NOT NULL,            -- max LLM cost in US cents
  max_sandbox_cents INTEGER NOT NULL,        -- max container compute cost in US cents
  max_wall_seconds INTEGER NOT NULL,         -- wall-clock timeout
  max_rounds INTEGER NOT NULL,               -- max deliberation rounds
  diminishing_returns_epsilon REAL NOT NULL, -- halt when CI improvement < epsilon
  created_at TEXT NOT NULL
);

-- A scientific hypothesis submitted for multi-agent validation.
CREATE TABLE IF NOT EXISTS sv_hypothesis (
  id TEXT PRIMARY KEY,                       -- uuid v7
  tenant_id TEXT NOT NULL,
  submitted_by TEXT NOT NULL,                -- user id
  title TEXT NOT NULL,
  statement TEXT NOT NULL,
  domain_tags TEXT NOT NULL,                 -- JSON: string[]
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','verdict','abandoned')),
  budget_envelope_id TEXT NOT NULL REFERENCES sv_budget_envelope(id),
  workflow_run_id TEXT,
  trace_id TEXT,                             -- @weaveintel/replay trace
  contract_id TEXT,                          -- @weaveintel/contracts completion contract
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sv_hypothesis_tenant ON sv_hypothesis(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sv_hypothesis_status ON sv_hypothesis(tenant_id, status);

-- Sub-claims decomposed from a hypothesis by the Decomposer agent.
CREATE TABLE IF NOT EXISTS sv_sub_claim (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  hypothesis_id TEXT NOT NULL REFERENCES sv_hypothesis(id) ON DELETE CASCADE,
  parent_sub_claim_id TEXT REFERENCES sv_sub_claim(id),
  statement TEXT NOT NULL,
  claim_type TEXT NOT NULL
    CHECK (claim_type IN ('mechanism','epidemiological','mathematical','dose_response','causal','other')),
  testability_score REAL NOT NULL CHECK (testability_score BETWEEN 0 AND 1),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sv_sub_claim_hypothesis ON sv_sub_claim(hypothesis_id);

-- Supervisor-emitted verdict for a completed hypothesis run.
CREATE TABLE IF NOT EXISTS sv_verdict (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  hypothesis_id TEXT NOT NULL UNIQUE REFERENCES sv_hypothesis(id) ON DELETE CASCADE,
  verdict TEXT NOT NULL
    CHECK (verdict IN ('supported','refuted','inconclusive','ill_posed','out_of_scope')),
  confidence_lo REAL NOT NULL CHECK (confidence_lo BETWEEN 0 AND 1),
  confidence_hi REAL NOT NULL CHECK (confidence_hi BETWEEN 0 AND 1),
  key_evidence_ids TEXT NOT NULL,  -- JSON: string[]
  falsifiers TEXT NOT NULL,        -- JSON: string[]
  limitations TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  replay_trace_id TEXT NOT NULL,
  emitted_by TEXT NOT NULL DEFAULT 'supervisor',
  created_at TEXT NOT NULL,
  CHECK (confidence_lo <= confidence_hi)
);
`;

