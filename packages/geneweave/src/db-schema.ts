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
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  default_mode TEXT NOT NULL DEFAULT 'direct',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_settings (
  chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'direct',
  system_prompt TEXT,
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

CREATE TABLE IF NOT EXISTS prompts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  template TEXT NOT NULL,
  variables TEXT,
  version TEXT NOT NULL DEFAULT '1.0',
  is_default INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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

CREATE TABLE IF NOT EXISTS tool_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  risk_level TEXT NOT NULL DEFAULT 'low',
  requires_approval INTEGER NOT NULL DEFAULT 0,
  max_execution_ms INTEGER,
  rate_limit_per_min INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
`;

