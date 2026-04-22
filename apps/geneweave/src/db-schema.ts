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

-- ── Social Growth Acceleration Platform (SGAP) ─────────────

CREATE TABLE IF NOT EXISTS sg_brands (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  voice TEXT,
  website_url TEXT,
  goals_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sg_channels (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES sg_brands(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  handle TEXT,
  account_ref TEXT,
  posting_timezone TEXT,
  cadence_json TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sg_channels_brand ON sg_channels(brand_id, platform);

CREATE TABLE IF NOT EXISTS sg_campaigns (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES sg_brands(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  objective TEXT,
  target_audience TEXT,
  start_date TEXT,
  end_date TEXT,
  budget_json TEXT,
  status TEXT NOT NULL DEFAULT 'planning',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sg_campaigns_brand ON sg_campaigns(brand_id, status);

CREATE TABLE IF NOT EXISTS sg_content_pillars (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES sg_brands(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  weight REAL NOT NULL DEFAULT 1,
  themes_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sg_content_queue (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES sg_brands(id) ON DELETE CASCADE,
  campaign_id TEXT REFERENCES sg_campaigns(id) ON DELETE SET NULL,
  channel_id TEXT REFERENCES sg_channels(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  brief TEXT,
  content_text TEXT,
  format TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  scheduled_for TEXT,
  asset_urls_json TEXT,
  metadata_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sg_content_queue_brand ON sg_content_queue(brand_id, status, scheduled_for);

CREATE TABLE IF NOT EXISTS sg_growth_experiments (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES sg_brands(id) ON DELETE CASCADE,
  campaign_id TEXT REFERENCES sg_campaigns(id) ON DELETE SET NULL,
  hypothesis TEXT NOT NULL,
  variant_a_json TEXT,
  variant_b_json TEXT,
  success_metric TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  result_summary TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sg_kpi_snapshots (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES sg_brands(id) ON DELETE CASCADE,
  channel_id TEXT REFERENCES sg_channels(id) ON DELETE SET NULL,
  snapshot_date TEXT NOT NULL,
  metrics_json TEXT NOT NULL,
  source TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sg_kpi_snapshots_brand ON sg_kpi_snapshots(brand_id, snapshot_date DESC);

CREATE TABLE IF NOT EXISTS sg_agent_profiles (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES sg_brands(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  instructions TEXT,
  tool_names TEXT,
  policy_key TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sg_workflow_templates (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES sg_brands(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  step_graph_json TEXT NOT NULL,
  trigger_type TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sg_tool_bindings (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES sg_brands(id) ON DELETE CASCADE,
  channel_id TEXT REFERENCES sg_channels(id) ON DELETE SET NULL,
  tool_name TEXT NOT NULL,
  provider TEXT,
  config_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sg_strategy_settings (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES sg_brands(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(brand_id, key)
);

CREATE TABLE IF NOT EXISTS sg_prompt_variants (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES sg_brands(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  template TEXT NOT NULL,
  variables TEXT,
  version TEXT NOT NULL DEFAULT '1.0',
  is_active INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(brand_id, key, version)
);

CREATE TABLE IF NOT EXISTS sgap_phase2_configs (
  id TEXT PRIMARY KEY,
  application_scope TEXT NOT NULL DEFAULT 'sgap',
  brand_id TEXT NOT NULL REFERENCES sg_brands(id) ON DELETE CASCADE,
  workflow_template_id TEXT NOT NULL REFERENCES sg_workflow_templates(id) ON DELETE CASCADE,
  writer_agent_id TEXT NOT NULL REFERENCES sgap_agents(id),
  researcher_agent_id TEXT NOT NULL REFERENCES sgap_agents(id),
  editor_agent_id TEXT NOT NULL REFERENCES sgap_agents(id),
  max_feedback_rounds INTEGER NOT NULL DEFAULT 2,
  min_research_confidence REAL NOT NULL DEFAULT 0.7,
  require_research_citations INTEGER NOT NULL DEFAULT 1,
  auto_escalate_to_compliance INTEGER NOT NULL DEFAULT 1,
  output_format TEXT NOT NULL DEFAULT 'markdown',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(brand_id, workflow_template_id)
);
CREATE INDEX IF NOT EXISTS idx_sgap_phase2_configs_brand ON sgap_phase2_configs(brand_id, enabled);

CREATE TABLE IF NOT EXISTS sgap_content_revisions (
  id TEXT PRIMARY KEY,
  application_scope TEXT NOT NULL DEFAULT 'sgap',
  workflow_run_id TEXT NOT NULL REFERENCES sgap_workflow_runs(id) ON DELETE CASCADE,
  content_item_id TEXT NOT NULL REFERENCES sg_content_queue(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES sgap_agents(id),
  stage TEXT NOT NULL,
  revision_index INTEGER NOT NULL DEFAULT 1,
  content_text TEXT NOT NULL,
  notes_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sgap_content_revisions_run ON sgap_content_revisions(workflow_run_id, content_item_id, revision_index);

CREATE TABLE IF NOT EXISTS sgap_phase3_configs (
  id TEXT PRIMARY KEY,
  application_scope TEXT NOT NULL DEFAULT 'sgap',
  brand_id TEXT NOT NULL REFERENCES sg_brands(id) ON DELETE CASCADE,
  workflow_template_id TEXT NOT NULL REFERENCES sg_workflow_templates(id) ON DELETE CASCADE,
  social_manager_agent_id TEXT NOT NULL REFERENCES sgap_agents(id),
  analytics_agent_id TEXT NOT NULL REFERENCES sgap_agents(id),
  primary_platforms_json TEXT,
  publish_mode TEXT NOT NULL DEFAULT 'draft',
  schedule_strategy TEXT NOT NULL DEFAULT 'best_window',
  min_engagement_target REAL NOT NULL DEFAULT 0.03,
  require_analytics_snapshot INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(brand_id, workflow_template_id)
);
CREATE INDEX IF NOT EXISTS idx_sgap_phase3_configs_brand ON sgap_phase3_configs(brand_id, enabled);

CREATE TABLE IF NOT EXISTS sgap_distribution_plans (
  id TEXT PRIMARY KEY,
  application_scope TEXT NOT NULL DEFAULT 'sgap',
  workflow_run_id TEXT NOT NULL REFERENCES sgap_workflow_runs(id) ON DELETE CASCADE,
  content_item_id TEXT NOT NULL REFERENCES sg_content_queue(id) ON DELETE CASCADE,
  social_manager_agent_id TEXT NOT NULL REFERENCES sgap_agents(id),
  analytics_agent_id TEXT NOT NULL REFERENCES sgap_agents(id),
  platform TEXT NOT NULL,
  publish_mode TEXT NOT NULL DEFAULT 'draft',
  scheduled_for TEXT,
  tool_name TEXT,
  distribution_text TEXT NOT NULL,
  hashtags_json TEXT,
  optimization_notes_json TEXT,
  tool_result_json TEXT,
  status TEXT NOT NULL DEFAULT 'planned',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sgap_distribution_plans_run ON sgap_distribution_plans(workflow_run_id, content_item_id, platform);

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
  display_name TEXT,
  job_profile TEXT,
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
  -- Feature grouping: 'general' | 'hypothesis-validation' | other domain categories
  -- Workers with category != 'general' are excluded from the main chat supervisor dispatch list
  category TEXT NOT NULL DEFAULT 'general',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Hypothesis Validation ────────────────────────────────────

-- Budget envelopes cap cost/time for a validation run. Created once, never mutated after use.
CREATE TABLE IF NOT EXISTS hv_budget_envelope (
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

-- A hypothesis submitted for multi-agent validation.
CREATE TABLE IF NOT EXISTS hv_hypothesis (
  id TEXT PRIMARY KEY,                       -- uuid v7
  tenant_id TEXT NOT NULL,
  submitted_by TEXT NOT NULL,                -- user id
  title TEXT NOT NULL,
  statement TEXT NOT NULL,
  domain_tags TEXT NOT NULL,                 -- JSON: string[]
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','verdict','abandoned')),
  budget_envelope_id TEXT NOT NULL REFERENCES hv_budget_envelope(id),
  workflow_run_id TEXT,
  trace_id TEXT,                             -- @weaveintel/replay trace
  contract_id TEXT,                          -- @weaveintel/contracts completion contract
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hv_hypothesis_tenant ON hv_hypothesis(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hv_hypothesis_status ON hv_hypothesis(tenant_id, status);

-- Sub-claims decomposed from a hypothesis by the Decomposer agent.
CREATE TABLE IF NOT EXISTS hv_sub_claim (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  hypothesis_id TEXT NOT NULL REFERENCES hv_hypothesis(id) ON DELETE CASCADE,
  parent_sub_claim_id TEXT REFERENCES hv_sub_claim(id),
  statement TEXT NOT NULL,
  claim_type TEXT NOT NULL
    CHECK (claim_type IN ('mechanism','epidemiological','mathematical','dose_response','causal','other')),
  testability_score REAL NOT NULL CHECK (testability_score BETWEEN 0 AND 1),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hv_sub_claim_hypothesis ON hv_sub_claim(hypothesis_id);

-- Supervisor-emitted verdict for a completed hypothesis run.
CREATE TABLE IF NOT EXISTS hv_verdict (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  hypothesis_id TEXT NOT NULL UNIQUE REFERENCES hv_hypothesis(id) ON DELETE CASCADE,
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

-- Evidence events emitted by specialist agents during a run.
-- Powers GET /api/hv/hypotheses/:id/events SSE stream.
CREATE TABLE IF NOT EXISTS hv_evidence_event (
  id TEXT PRIMARY KEY,                           -- UUID
  hypothesis_id TEXT NOT NULL REFERENCES hv_hypothesis(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,                         -- workflow step that emitted this (e.g. 'statistical')
  agent_id TEXT NOT NULL,                        -- agent name
  evidence_id TEXT NOT NULL,                     -- contract evidence item id
  kind TEXT NOT NULL,                            -- e.g. 'stat_finding', 'lit_hit', 'sim_result'
  summary TEXT NOT NULL,
  source_type TEXT NOT NULL,                     -- 'sandbox_tool_run' | 'http_fetch' | 'model_inference'
  tool_key TEXT,                                 -- tool that produced this (nullable for model inferences)
  reproducibility_hash TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hv_evidence_event_hypothesis ON hv_evidence_event(hypothesis_id, created_at ASC);

-- Agent-to-agent dialogue turns during the deliberation loop.
-- Powers GET /api/hv/hypotheses/:id/dialogue SSE stream.
CREATE TABLE IF NOT EXISTS hv_agent_turn (
  id TEXT PRIMARY KEY,                           -- UUID
  hypothesis_id TEXT NOT NULL REFERENCES hv_hypothesis(id) ON DELETE CASCADE,
  round_index INTEGER NOT NULL DEFAULT 0,
  from_agent TEXT NOT NULL,
  to_agent TEXT,                                 -- null = broadcast
  message TEXT NOT NULL,
  cites_evidence_ids TEXT NOT NULL DEFAULT '[]', -- JSON: string[]
  dissent INTEGER NOT NULL DEFAULT 0,            -- boolean (0 | 1)
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hv_agent_turn_hypothesis ON hv_agent_turn(hypothesis_id, created_at ASC);

-- Backward-compatible read-only aliases for legacy SV names.
CREATE VIEW IF NOT EXISTS sv_budget_envelope AS SELECT * FROM hv_budget_envelope;
CREATE VIEW IF NOT EXISTS sv_hypothesis AS SELECT * FROM hv_hypothesis;
CREATE VIEW IF NOT EXISTS sv_sub_claim AS SELECT * FROM hv_sub_claim;
CREATE VIEW IF NOT EXISTS sv_verdict AS SELECT * FROM hv_verdict;
CREATE VIEW IF NOT EXISTS sv_evidence_event AS SELECT * FROM hv_evidence_event;
CREATE VIEW IF NOT EXISTS sv_agent_turn AS SELECT * FROM hv_agent_turn;

-- ── SGAP Multi-Agent Organization (Phase 1) ──────────────────

-- Agent role definitions for organizational structure
CREATE TABLE IF NOT EXISTS sgap_agents (
  id TEXT PRIMARY KEY,
  application_scope TEXT NOT NULL DEFAULT 'sgap',
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  description TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  tool_names TEXT NOT NULL DEFAULT '[]',
  authority_level TEXT NOT NULL,
  skill_key TEXT,
  worker_agent_id TEXT REFERENCES worker_agents(id),
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sgap_agents_role ON sgap_agents(role, enabled);

-- Workflow execution instances
CREATE TABLE IF NOT EXISTS sgap_workflow_runs (
  id TEXT PRIMARY KEY,
  application_scope TEXT NOT NULL DEFAULT 'sgap',
  brand_id TEXT NOT NULL REFERENCES sg_brands(id) ON DELETE CASCADE,
  workflow_template_id TEXT NOT NULL REFERENCES sg_workflow_templates(id),
  status TEXT NOT NULL DEFAULT 'pending',
  current_stage TEXT,
  current_agent_id TEXT REFERENCES sgap_agents(id),
  input_json TEXT NOT NULL DEFAULT '{}',
  state_json TEXT NOT NULL DEFAULT '{}',
  error_message TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sgap_workflow_runs_brand ON sgap_workflow_runs(brand_id, status);
CREATE INDEX IF NOT EXISTS idx_sgap_workflow_runs_status ON sgap_workflow_runs(status, created_at DESC);

-- Inter-agent conversation threads
CREATE TABLE IF NOT EXISTS sgap_agent_threads (
  id TEXT PRIMARY KEY,
  application_scope TEXT NOT NULL DEFAULT 'sgap',
  workflow_run_id TEXT NOT NULL REFERENCES sgap_workflow_runs(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sgap_agent_threads_run ON sgap_agent_threads(workflow_run_id);

-- Agent-to-agent messages
CREATE TABLE IF NOT EXISTS sgap_agent_messages (
  id TEXT PRIMARY KEY,
  application_scope TEXT NOT NULL DEFAULT 'sgap',
  thread_id TEXT NOT NULL REFERENCES sgap_agent_threads(id) ON DELETE CASCADE,
  from_agent_id TEXT NOT NULL REFERENCES sgap_agents(id),
  to_agent_id TEXT REFERENCES sgap_agents(id),
  message_type TEXT NOT NULL,
  content_json TEXT NOT NULL,
  requires_response INTEGER NOT NULL DEFAULT 0,
  responded INTEGER NOT NULL DEFAULT 0,
  response_message_id TEXT,
  response_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  responded_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sgap_agent_messages_thread ON sgap_agent_messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_sgap_agent_messages_from ON sgap_agent_messages(from_agent_id, responded);

-- Approval gates
CREATE TABLE IF NOT EXISTS sgap_approvals (
  id TEXT PRIMARY KEY,
  application_scope TEXT NOT NULL DEFAULT 'sgap',
  workflow_run_id TEXT NOT NULL REFERENCES sgap_workflow_runs(id) ON DELETE CASCADE,
  content_item_id TEXT REFERENCES sg_content_queue(id),
  required_by_agent_id TEXT NOT NULL REFERENCES sgap_agents(id),
  approval_from_agent_id TEXT REFERENCES sgap_agents(id),
  status TEXT NOT NULL DEFAULT 'pending',
  feedback_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolved_by_agent_id TEXT REFERENCES sgap_agents(id)
);
CREATE INDEX IF NOT EXISTS idx_sgap_approvals_run ON sgap_approvals(workflow_run_id, status);
CREATE INDEX IF NOT EXISTS idx_sgap_approvals_content ON sgap_approvals(content_item_id, status);

-- Audit trail for all SGAP actions
CREATE TABLE IF NOT EXISTS sgap_audit_log (
  id TEXT PRIMARY KEY,
  application_scope TEXT NOT NULL DEFAULT 'sgap',
  workflow_run_id TEXT NOT NULL REFERENCES sgap_workflow_runs(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES sgap_agents(id),
  action TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sgap_audit_log_run ON sgap_audit_log(workflow_run_id);
CREATE INDEX IF NOT EXISTS idx_sgap_audit_log_agent ON sgap_audit_log(agent_id, created_at DESC);

-- SGAP-specific skills mapping
CREATE TABLE IF NOT EXISTS sgap_skills (
  id TEXT PRIMARY KEY,
  application_scope TEXT NOT NULL DEFAULT 'sgap',
  agent_role TEXT NOT NULL,
  skill_id TEXT NOT NULL REFERENCES skills(id),
  tool_policy_key TEXT REFERENCES tool_policies(key),
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Social media platform configurations
CREATE TABLE IF NOT EXISTS sgap_social_media_tools (
  id TEXT PRIMARY KEY,
  application_scope TEXT NOT NULL DEFAULT 'sgap',
  platform TEXT NOT NULL UNIQUE,
  api_base_url TEXT NOT NULL,
  api_version TEXT NOT NULL DEFAULT '1.0',
  auth_type TEXT NOT NULL,
  rate_limit_per_min INTEGER NOT NULL DEFAULT 100,
  supports_scheduling INTEGER NOT NULL DEFAULT 0,
  supports_video INTEGER NOT NULL DEFAULT 0,
  supports_images INTEGER NOT NULL DEFAULT 0,
  supports_analytics INTEGER NOT NULL DEFAULT 0,
  max_characters INTEGER,
  config_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sgap_social_media_tools_platform ON sgap_social_media_tools(platform);

-- Content performance metrics
CREATE TABLE IF NOT EXISTS sgap_content_performance (
  id TEXT PRIMARY KEY,
  application_scope TEXT NOT NULL DEFAULT 'sgap',
  content_item_id TEXT NOT NULL REFERENCES sg_content_queue(id) ON DELETE CASCADE,
  brand_id TEXT NOT NULL REFERENCES sg_brands(id),
  platform TEXT NOT NULL,
  published_at TEXT NOT NULL DEFAULT (datetime('now')),
  views INTEGER NOT NULL DEFAULT 0,
  engagement INTEGER NOT NULL DEFAULT 0,
  reach INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  conversions INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT,
  synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sgap_content_performance_item ON sgap_content_performance(content_item_id, platform);
CREATE INDEX IF NOT EXISTS idx_sgap_content_performance_brand ON sgap_content_performance(brand_id, published_at DESC);
`;

