/**
 * @weaveintel/geneweave — Admin tab schema
 *
 * Data-driven configuration for all admin CRUD tabs.
 * Each tab defines its form fields, table columns, API paths, and
 * field-level transformations.  The UI, save, edit, and column logic
 * in ui.ts reference this schema instead of per-tab switch/if blocks.
 */

/* ── Field transform types ────────────────────────────────────
 *  json     – parse from JSON string → object for API payload
 *  jsonStr  – parse then re-stringify (text column in DB)
 *  int      – parseInt
 *  float    – parseFloat
 *  csvArr   – split by comma → array
 *  bool     – boolean
 *  intBool  – boolean → 0 | 1
 * ──────────────────────────────────────────────────────────── */

export interface AdminFieldDef {
  key: string;
  label: string;
  textarea?: boolean;
  rows?: number;
  options?: string[];
  type?: 'checkbox' | 'number';
  save?: 'json' | 'jsonStr' | 'int' | 'float' | 'csvArr' | 'bool' | 'intBool';
  default?: unknown;
}

export interface AdminTabDef {
  singular: string;
  apiPath: string;
  listKey: string;
  cols: string[];
  fields: AdminFieldDef[];
  readOnly?: boolean;
}

export interface AdminTabGroup {
  label: string;
  icon: string;
  tabs: Array<{ key: string; label: string }>;
}

// ─── Tab groups (sidebar navigation) ─────────────────────────

export const ADMIN_TAB_GROUPS: AdminTabGroup[] = [
  { label: 'Core AI', icon: '\uD83E\uDD16', tabs: [
    { key: 'prompts', label: 'Prompts' },
    { key: 'guardrails', label: 'Guardrails' },
    { key: 'routing', label: 'Routing' },
    { key: 'model-pricing', label: 'Model Pricing' },
    { key: 'workflows', label: 'Workflows' },
    { key: 'tools', label: 'Tools' },
  ]},
  { label: 'Governance', icon: '\u2696\uFE0F', tabs: [
    { key: 'task-policies', label: 'Task Policies' },
    { key: 'contracts', label: 'Contracts' },
    { key: 'identity-rules', label: 'Identity Rules' },
    { key: 'memory-governance', label: 'Memory Gov' },
    { key: 'compliance-rules', label: 'Compliance' },
  ]},
  { label: 'Integrations', icon: '\uD83D\uDD0C', tabs: [
    { key: 'search-providers', label: 'Search' },
    { key: 'http-endpoints', label: 'HTTP' },
    { key: 'social-accounts', label: 'Social' },
    { key: 'enterprise-connectors', label: 'Enterprise' },
    { key: 'tool-registry', label: 'Registry' },
  ]},
  { label: 'Automation', icon: '\u26A1', tabs: [
    { key: 'trigger-definitions', label: 'Triggers' },
    { key: 'replay-scenarios', label: 'Replay' },
    { key: 'cache-policies', label: 'Cache' },
    { key: 'reliability-policies', label: 'Reliability' },
  ]},
  { label: 'Infrastructure', icon: '\uD83C\uDFD7\uFE0F', tabs: [
    { key: 'sandbox-policies', label: 'Sandbox' },
    { key: 'extraction-pipelines', label: 'Extraction' },
    { key: 'artifact-policies', label: 'Artifacts' },
    { key: 'tenant-configs', label: 'Tenants' },
  ]},
  { label: 'Advanced', icon: '\uD83E\uDDE9', tabs: [
    { key: 'collaboration-sessions', label: 'Collaboration' },
    { key: 'graph-configs', label: 'Graph' },
    { key: 'plugin-configs', label: 'Plugins' },
  ]},
  { label: 'Developer', icon: '\uD83D\uDEE0\uFE0F', tabs: [
    { key: 'scaffold-templates', label: 'Scaffolds' },
    { key: 'recipe-configs', label: 'Recipes' },
    { key: 'widget-configs', label: 'Widgets' },
    { key: 'validation-rules', label: 'Validation' },
  ]},
  { label: 'Monitoring', icon: '\uD83D\uDCCA', tabs: [
    { key: 'workflow-runs', label: 'Workflow Runs' },
    { key: 'guardrail-evals', label: 'Guardrail Evals' },
  ]},
  { label: 'System', icon: '\u2139\uFE0F', tabs: [
    { key: 'about', label: 'About' },
  ]},
];

// ─── Per-tab definitions ─────────────────────────────────────

export const ADMIN_TABS: Record<string, AdminTabDef> = {
  /* ── Core AI ──────────────────────────────── */
  'prompts': {
    singular: 'Prompt', apiPath: 'admin/prompts', listKey: 'prompts',
    cols: ['name', 'category', 'version', 'enabled'],
    fields: [
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Description' },
      { key: 'category', label: 'Category' },
      { key: 'template', label: 'Template', textarea: true, rows: 4 },
      { key: 'variables', label: 'Variables (comma-separated)', save: 'csvArr' },
      { key: 'version', label: 'Version', default: '1.0' },
      { key: 'is_default', label: 'Default', type: 'checkbox', save: 'bool' },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', save: 'bool', default: true },
    ],
  },
  'guardrails': {
    singular: 'Guardrail', apiPath: 'admin/guardrails', listKey: 'guardrails',
    cols: ['name', 'type', 'stage', 'enabled'],
    fields: [
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Description' },
      { key: 'type', label: 'Type', options: ['content_filter', 'pii_detection', 'topic_guard', 'toxicity', 'custom'] },
      { key: 'stage', label: 'Stage', options: ['pre', 'post', 'both'], default: 'pre' },
      { key: 'config', label: 'Config (JSON)', textarea: true, save: 'json' },
      { key: 'priority', label: 'Priority', type: 'number', save: 'int', default: 0 },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', save: 'bool', default: true },
    ],
  },
  'routing': {
    singular: 'Routing Policy', apiPath: 'admin/routing', listKey: 'policies',
    cols: ['name', 'strategy', 'fallback_model', 'enabled'],
    fields: [
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Description' },
      { key: 'strategy', label: 'Strategy', options: ['balanced', 'cost_optimized', 'latency_optimized', 'quality_first', 'custom'], default: 'balanced' },
      { key: 'constraints', label: 'Constraints (JSON)', textarea: true, save: 'json' },
      { key: 'weights', label: 'Weights (JSON)', textarea: true, save: 'json' },
      { key: 'fallback_model', label: 'Fallback Model' },
      { key: 'fallback_provider', label: 'Fallback Provider' },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', save: 'bool', default: true },
    ],
  },
  'model-pricing': {
    singular: 'Model Pricing', apiPath: 'admin/model-pricing', listKey: 'pricing',
    cols: ['model_id', 'provider', 'display_name', 'input_cost_per_1m', 'output_cost_per_1m', 'quality_score', 'source', 'enabled'],
    fields: [
      { key: 'model_id', label: 'Model ID' },
      { key: 'provider', label: 'Provider', options: ['openai', 'anthropic'] },
      { key: 'display_name', label: 'Display Name' },
      { key: 'input_cost_per_1m', label: 'Input Cost / 1M tokens', type: 'number', save: 'float' },
      { key: 'output_cost_per_1m', label: 'Output Cost / 1M tokens', type: 'number', save: 'float' },
      { key: 'quality_score', label: 'Quality Score (0-1)', type: 'number', save: 'float', default: 0.5 },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', save: 'bool', default: true },
    ],
  },
  'workflows': {
    singular: 'Workflow', apiPath: 'admin/workflows', listKey: 'workflows',
    cols: ['name', 'version', 'entry_step_id', 'enabled'],
    fields: [
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Description' },
      { key: 'version', label: 'Version', default: '1.0' },
      { key: 'steps', label: 'Steps (JSON)', textarea: true, rows: 4, save: 'json' },
      { key: 'entry_step_id', label: 'Entry Step ID' },
      { key: 'metadata', label: 'Metadata (JSON)', textarea: true, save: 'json' },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', save: 'bool', default: true },
    ],
  },
  'tools': {
    singular: 'Tool', apiPath: 'admin/tools', listKey: 'tools',
    cols: ['name', 'category', 'risk_level', 'enabled'],
    fields: [
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Description' },
      { key: 'category', label: 'Category' },
      { key: 'risk_level', label: 'Risk Level', options: ['low', 'medium', 'high', 'critical'], default: 'low' },
      { key: 'requires_approval', label: 'Requires Approval', type: 'checkbox', save: 'bool' },
      { key: 'max_execution_ms', label: 'Max Execution (ms)', type: 'number', save: 'int' },
      { key: 'rate_limit_per_min', label: 'Rate Limit/min', type: 'number', save: 'int' },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', save: 'bool', default: true },
    ],
  },

  /* ── Governance ───────────────────────────── */
  'task-policies': {
    singular: 'Task Policy', apiPath: 'admin/task-policies', listKey: 'taskPolicies',
    cols: ['name', 'task_type', 'default_priority', 'enabled'],
    fields: [
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Description' },
      { key: 'trigger', label: 'Trigger' },
      { key: 'task_type', label: 'Task Type', options: ['approval', 'review', 'generation', 'classification'], default: 'approval' },
      { key: 'default_priority', label: 'Priority', options: ['low', 'normal', 'high', 'critical'], default: 'normal' },
      { key: 'sla_hours', label: 'SLA Hours', type: 'number', save: 'float' },
      { key: 'auto_escalate_after_hours', label: 'Auto-escalate (hours)', type: 'number', save: 'float' },
      { key: 'assignment_strategy', label: 'Assignment', options: ['round-robin', 'least-busy', 'manual'], default: 'round-robin' },
      { key: 'assign_to', label: 'Assign To' },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', save: 'bool', default: true },
    ],
  },
  'contracts': {
    singular: 'Contract', apiPath: 'admin/contracts', listKey: 'contracts',
    cols: ['name', 'max_attempts', 'min_confidence', 'enabled'],
    fields: [
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Description' },
      { key: 'input_schema', label: 'Input Schema (JSON)', textarea: true },
      { key: 'output_schema', label: 'Output Schema (JSON)', textarea: true },
      { key: 'acceptance_criteria', label: 'Acceptance Criteria (JSON)', textarea: true, default: '[]' },
      { key: 'max_attempts', label: 'Max Attempts', type: 'number', save: 'int' },
      { key: 'timeout_ms', label: 'Timeout (ms)', type: 'number', save: 'int' },
      { key: 'evidence_required', label: 'Evidence Required', textarea: true },
      { key: 'min_confidence', label: 'Min Confidence', type: 'number', save: 'float' },
      { key: 'require_human_review', label: 'Human Review', type: 'checkbox', save: 'bool' },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', save: 'bool', default: true },
    ],
  },
  'identity-rules': {
    singular: 'Identity Rule', apiPath: 'admin/identity-rules', listKey: 'identity-rules',
    cols: ['name', 'resource', 'action', 'result', 'enabled'],
    fields: [
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Description' },
      { key: 'resource', label: 'Resource', default: '*' },
      { key: 'action', label: 'Action', default: '*' },
      { key: 'roles', label: 'Roles (JSON)', textarea: true, save: 'json' },
      { key: 'scopes', label: 'Scopes (JSON)', textarea: true, save: 'json' },
      { key: 'result', label: 'Result', options: ['allow', 'deny'], default: 'allow' },
      { key: 'priority', label: 'Priority', type: 'number', save: 'int', default: 0 },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', save: 'bool', default: true },
    ],
  },
  'memory-governance': {
    singular: 'Memory Governance Rule', apiPath: 'admin/memory-governance', listKey: 'memory-governance',
    cols: ['name', 'tenant_id', 'max_age', 'enabled'],
    fields: [
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Description' },
      { key: 'memory_types', label: 'Memory Types (JSON)', textarea: true, save: 'json' },
      { key: 'tenant_id', label: 'Tenant ID' },
      { key: 'block_patterns', label: 'Block Patterns (JSON)', textarea: true, save: 'json' },
      { key: 'redact_patterns', label: 'Redact Patterns (JSON)', textarea: true, save: 'json' },
      { key: 'max_age', label: 'Max Age' },
      { key: 'max_entries', label: 'Max Entries', type: 'number', save: 'int' },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', save: 'bool', default: true },
    ],
  },
  'compliance-rules': {
    singular: 'Compliance Rule', apiPath: 'admin/compliance-rules', listKey: 'compliance-rules',
    cols: ['name', 'rule_type', 'target_resource', 'action', 'enabled'],
    fields: [
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Description' },
      { key: 'rule_type', label: 'Rule Type', options: ['retention', 'deletion', 'legal-hold', 'consent', 'residency'], default: 'retention' },
      { key: 'target_resource', label: 'Target Resource', default: '*' },
      { key: 'retention_days', label: 'Retention Days', type: 'number', save: 'int' },
      { key: 'region', label: 'Region' },
      { key: 'consent_purpose', label: 'Consent Purpose' },
      { key: 'action', label: 'Action', options: ['archive', 'delete', 'notify', 'block', 'encrypt'], default: 'notify' },
      { key: 'config', label: 'Config (JSON)', textarea: true, save: 'jsonStr' },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', save: 'bool', default: true },
    ],
  },

  /* ── Integrations ─────────────────────────── */
  'search-providers': {
    singular: 'Search Provider', apiPath: 'admin/search-providers', listKey: 'search-providers',
    cols: ['name', 'provider_type', 'priority', 'enabled'],
    fields: [
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Description' },
      { key: 'provider_type', label: 'Provider Type', options: ['duckduckgo', 'google', 'bing', 'brave', 'custom'], default: 'duckduckgo' },
      { key: 'api_key', label: 'API Key' },
      { key: 'base_url', label: 'Base URL' },
      { key: 'priority', label: 'Priority', type: 'number', save: 'int', default: 0 },
      { key: 'options', label: 'Options (JSON)', textarea: true, save: 'json' },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', save: 'bool', default: true },
    ],
  },
  'http-endpoints': {
    singular: 'HTTP Endpoint', apiPath: 'admin/http-endpoints', listKey: 'http-endpoints',
    cols: ['name', 'method', 'url', 'enabled'],
    fields: [
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Description' },
      { key: 'url', label: 'URL' },
      { key: 'method', label: 'Method', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], default: 'GET' },
      { key: 'auth_type', label: 'Auth Type', options: ['none', 'bearer', 'basic', 'api-key', 'oauth'], default: 'none' },
      { key: 'auth_config', label: 'Auth Config (JSON)', textarea: true, save: 'json' },
      { key: 'headers', label: 'Headers (JSON)', textarea: true, save: 'json' },
      { key: 'body_template', label: 'Body Template', textarea: true },
      { key: 'response_transform', label: 'Response Transform', textarea: true },
      { key: 'retry_count', label: 'Retry Count', type: 'number', save: 'int', default: 0 },
      { key: 'rate_limit_rpm', label: 'Rate Limit RPM', type: 'number', save: 'int', default: 60 },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', save: 'bool', default: true },
    ],
  },
  'social-accounts': {
    singular: 'Social Account', apiPath: 'admin/social-accounts', listKey: 'social-accounts',
    cols: ['name', 'platform', 'enabled'],
    fields: [
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Description' },
      { key: 'platform', label: 'Platform', options: ['slack', 'discord', 'telegram', 'twitter', 'mastodon'], default: 'slack' },
      { key: 'api_key', label: 'API Key' },
      { key: 'api_secret', label: 'API Secret' },
      { key: 'base_url', label: 'Base URL' },
      { key: 'options', label: 'Options (JSON)', textarea: true, save: 'json' },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', save: 'bool', default: true },
    ],
  },
  'enterprise-connectors': {
    singular: 'Enterprise Connector', apiPath: 'admin/enterprise-connectors', listKey: 'enterprise-connectors',
    cols: ['name', 'connector_type', 'base_url', 'enabled'],
    fields: [
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Description' },
      { key: 'connector_type', label: 'Connector Type', options: ['jira', 'confluence', 'sharepoint', 'salesforce', 'servicenow', 'custom'], default: 'jira' },
      { key: 'base_url', label: 'Base URL' },
      { key: 'auth_type', label: 'Auth Type', options: ['bearer', 'basic', 'oauth', 'api-key'], default: 'bearer' },
      { key: 'auth_config', label: 'Auth Config (JSON)', textarea: true, save: 'json' },
      { key: 'options', label: 'Options (JSON)', textarea: true, save: 'json' },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', save: 'bool', default: true },
    ],
  },
  'tool-registry': {
    singular: 'Tool Registry Entry', apiPath: 'admin/tool-registry', listKey: 'tool-registry',
    cols: ['name', 'package_name', 'version', 'risk_level', 'enabled'],
    fields: [
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Description' },
      { key: 'package_name', label: 'Package Name' },
      { key: 'version', label: 'Version', default: '1.0.0' },
      { key: 'category', label: 'Category', options: ['general', 'search', 'browser', 'social', 'enterprise', 'utility'], default: 'general' },
      { key: 'risk_level', label: 'Risk Level', options: ['low', 'medium', 'high', 'critical'], default: 'low' },
      { key: 'tags', label: 'Tags (JSON)', textarea: true, save: 'json' },
      { key: 'config', label: 'Config (JSON)', textarea: true, save: 'json' },
      { key: 'requires_approval', label: 'Requires Approval', type: 'checkbox', save: 'bool' },
      { key: 'max_execution_ms', label: 'Max Execution (ms)', type: 'number', save: 'int' },
      { key: 'rate_limit_per_min', label: 'Rate Limit/min', type: 'number', save: 'int' },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', save: 'bool', default: true },
    ],
  },

  /* ── Automation ───────────────────────────── */
  'trigger-definitions': {
    singular: 'Trigger Definition', apiPath: 'admin/trigger-definitions', listKey: 'trigger-definitions',
    cols: ['name', 'trigger_type', 'status', 'enabled'],
    fields: [
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Description' },
      { key: 'trigger_type', label: 'Trigger Type', options: ['cron', 'webhook', 'event', 'manual'], default: 'cron' },
      { key: 'expression', label: 'Expression' },
      { key: 'config', label: 'Config (JSON)', textarea: true, save: 'json' },
      { key: 'target_workflow', label: 'Target Workflow' },
      { key: 'status', label: 'Status', options: ['active', 'paused', 'disabled'], default: 'active' },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', save: 'bool', default: true },
    ],
  },
  'replay-scenarios': {
    singular: 'Replay Scenario', apiPath: 'admin/replay-scenarios', listKey: 'replay-scenarios',
    cols: ['name', 'model', 'provider', 'enabled'],
    fields: [
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Description' },
      { key: 'golden_prompt', label: 'Golden Prompt', textarea: true, rows: 3 },
      { key: 'golden_response', label: 'Golden Response', textarea: true, rows: 3 },
      { key: 'model', label: 'Model' },
      { key: 'provider', label: 'Provider' },
      { key: 'tags', label: 'Tags (JSON)', textarea: true, save: 'json' },
      { key: 'acceptance_criteria', label: 'Acceptance Criteria (JSON)', textarea: true, save: 'json' },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', save: 'bool', default: true },
    ],
  },
  'cache-policies': {
    singular: 'Cache Policy', apiPath: 'admin/cache-policies', listKey: 'cache-policies',
    cols: ['name', 'scope', 'ttl_ms', 'enabled'],
    fields: [
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Description' },
      { key: 'scope', label: 'Scope', options: ['global', 'model', 'prompt', 'user'], default: 'global' },
      { key: 'ttl_ms', label: 'TTL (ms)', type: 'number', save: 'int', default: 300000 },
      { key: 'max_entries', label: 'Max Entries', type: 'number', save: 'int', default: 1000 },
      { key: 'bypass_patterns', label: 'Bypass Patterns (JSON)', textarea: true, save: 'json' },
      { key: 'invalidate_on', label: 'Invalidate On (JSON)', textarea: true, save: 'json' },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', save: 'bool', default: true },
    ],
  },
  'reliability-policies': {
    singular: 'Reliability Policy', apiPath: 'admin/reliability-policies', listKey: 'reliability-policies',
    cols: ['name', 'policy_type', 'max_retries', 'enabled'],
    fields: [
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Description' },
      { key: 'policy_type', label: 'Policy Type', options: ['retry', 'circuit-breaker', 'bulkhead', 'timeout', 'fallback'], default: 'retry' },
      { key: 'max_retries', label: 'Max Retries', type: 'number', save: 'int' },
      { key: 'initial_delay_ms', label: 'Initial Delay (ms)', type: 'number', save: 'int' },
      { key: 'max_delay_ms', label: 'Max Delay (ms)', type: 'number', save: 'int' },
      { key: 'backoff_multiplier', label: 'Backoff Multiplier', type: 'number', save: 'float' },
      { key: 'max_concurrent', label: 'Max Concurrent', type: 'number', save: 'int' },
      { key: 'queue_size', label: 'Queue Size', type: 'number', save: 'int' },
      { key: 'strategy', label: 'Strategy' },
      { key: 'ttl_ms', label: 'TTL (ms)', type: 'number', save: 'int' },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', save: 'bool', default: true },
    ],
  },

  /* ── Infrastructure ───────────────────────── */
  'sandbox-policies': {
    singular: 'Sandbox Policy', apiPath: 'admin/sandbox-policies', listKey: 'sandbox-policies',
    cols: ['name', 'max_duration_ms', 'filesystem_access', 'enabled'],
    fields: [
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Description' },
      { key: 'max_cpu_ms', label: 'Max CPU (ms)', type: 'number', save: 'int' },
      { key: 'max_memory_mb', label: 'Max Memory (MB)', type: 'number', save: 'int' },
      { key: 'max_duration_ms', label: 'Max Duration (ms)', type: 'number', save: 'int', default: 30000 },
      { key: 'max_output_bytes', label: 'Max Output Bytes', type: 'number', save: 'int' },
      { key: 'allowed_modules', label: 'Allowed Modules (JSON)', textarea: true, save: 'jsonStr' },
      { key: 'denied_modules', label: 'Denied Modules (JSON)', textarea: true, save: 'jsonStr' },
      { key: 'network_access', label: 'Network Access', type: 'checkbox', save: 'intBool' },
      { key: 'filesystem_access', label: 'Filesystem Access', options: ['none', 'readonly', 'readwrite'], default: 'none' },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', save: 'bool', default: true },
    ],
  },
  'extraction-pipelines': {
    singular: 'Extraction Pipeline', apiPath: 'admin/extraction-pipelines', listKey: 'extraction-pipelines',
    cols: ['name', 'max_input_size_bytes', 'enabled'],
    fields: [
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Description' },
      { key: 'stages', label: 'Stages (JSON)', textarea: true, rows: 4, save: 'jsonStr' },
      { key: 'input_mime_types', label: 'Input MIME Types (JSON)', textarea: true, save: 'jsonStr' },
      { key: 'max_input_size_bytes', label: 'Max Input Size (bytes)', type: 'number', save: 'int' },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', save: 'bool', default: true },
    ],
  },
  'artifact-policies': {
    singular: 'Artifact Policy', apiPath: 'admin/artifact-policies', listKey: 'artifact-policies',
    cols: ['name', 'max_size_bytes', 'retention_days', 'enabled'],
    fields: [
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Description' },
      { key: 'max_size_bytes', label: 'Max Size (bytes)', type: 'number', save: 'int' },
      { key: 'allowed_types', label: 'Allowed Types (JSON)', textarea: true, save: 'jsonStr' },
      { key: 'retention_days', label: 'Retention Days', type: 'number', save: 'int' },
      { key: 'require_versioning', label: 'Require Versioning', type: 'checkbox', save: 'intBool' },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', save: 'bool', default: true },
    ],
  },
  'tenant-configs': {
    singular: 'Tenant Config', apiPath: 'admin/tenant-configs', listKey: 'tenant-configs',
    cols: ['name', 'tenant_id', 'scope', 'enabled'],
    fields: [
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Description' },
      { key: 'tenant_id', label: 'Tenant ID' },
      { key: 'scope', label: 'Scope', options: ['tenant', 'user', 'team'], default: 'tenant' },
      { key: 'allowed_models', label: 'Allowed Models (JSON)', textarea: true, save: 'json' },
      { key: 'denied_models', label: 'Denied Models (JSON)', textarea: true, save: 'json' },
      { key: 'allowed_tools', label: 'Allowed Tools (JSON)', textarea: true, save: 'json' },
      { key: 'max_tokens_daily', label: 'Max Tokens/Day', type: 'number', save: 'int' },
      { key: 'max_cost_daily', label: 'Max Cost/Day', type: 'number', save: 'float' },
      { key: 'max_tokens_monthly', label: 'Max Tokens/Month', type: 'number', save: 'int' },
      { key: 'max_cost_monthly', label: 'Max Cost/Month', type: 'number', save: 'float' },
      { key: 'features', label: 'Features (JSON)', textarea: true, save: 'json' },
      { key: 'config_overrides', label: 'Config Overrides (JSON)', textarea: true, save: 'json' },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', save: 'bool', default: true },
    ],
  },

  /* ── Advanced ─────────────────────────────── */
  'collaboration-sessions': {
    singular: 'Collaboration Session', apiPath: 'admin/collaboration-sessions', listKey: 'collaboration-sessions',
    cols: ['name', 'session_type', 'max_participants', 'enabled'],
    fields: [
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Description' },
      { key: 'session_type', label: 'Session Type', options: ['pair', 'team', 'broadcast', 'review'], default: 'team' },
      { key: 'max_participants', label: 'Max Participants', type: 'number', save: 'int', default: 10 },
      { key: 'presence_ttl_ms', label: 'Presence TTL (ms)', type: 'number', save: 'int', default: 30000 },
      { key: 'auto_close_idle_ms', label: 'Auto Close Idle (ms)', type: 'number', save: 'int' },
      { key: 'handoff_enabled', label: 'Handoff Enabled', type: 'checkbox', save: 'bool', default: true },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', save: 'bool', default: true },
    ],
  },
  'graph-configs': {
    singular: 'Graph Config', apiPath: 'admin/graph-configs', listKey: 'graph-configs',
    cols: ['name', 'graph_type', 'max_depth', 'enabled'],
    fields: [
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Description' },
      { key: 'graph_type', label: 'Graph Type', options: ['entity', 'timeline', 'knowledge', 'dependency'], default: 'entity' },
      { key: 'max_depth', label: 'Max Depth', type: 'number', save: 'int', default: 3 },
      { key: 'entity_types', label: 'Entity Types (JSON)', textarea: true, save: 'jsonStr' },
      { key: 'relationship_types', label: 'Relationship Types (JSON)', textarea: true, save: 'jsonStr' },
      { key: 'auto_link', label: 'Auto Link', type: 'checkbox', save: 'bool', default: true },
      { key: 'scoring_weights', label: 'Scoring Weights (JSON)', textarea: true, save: 'jsonStr' },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', save: 'bool', default: true },
    ],
  },
  'plugin-configs': {
    singular: 'Plugin Config', apiPath: 'admin/plugin-configs', listKey: 'plugin-configs',
    cols: ['name', 'plugin_type', 'version', 'trust_level', 'enabled'],
    fields: [
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Description' },
      { key: 'plugin_type', label: 'Plugin Type', options: ['core', 'community', 'private', 'enterprise'], default: 'community' },
      { key: 'package_name', label: 'Package Name', default: 'unknown' },
      { key: 'version', label: 'Version', default: '1.0.0' },
      { key: 'capabilities', label: 'Capabilities (JSON)', textarea: true, save: 'jsonStr' },
      { key: 'trust_level', label: 'Trust Level', options: ['trusted', 'community', 'sandboxed'], default: 'community' },
      { key: 'auto_update', label: 'Auto Update', type: 'checkbox', save: 'bool' },
      { key: 'config', label: 'Config (JSON)', textarea: true, save: 'jsonStr' },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', save: 'bool', default: true },
    ],
  },

  /* ── Developer (Phase 9) ──────────────────── */
  'scaffold-templates': {
    singular: 'Scaffold Template', apiPath: 'admin/scaffold-templates', listKey: 'scaffold-templates',
    cols: ['name', 'template_type', 'enabled'],
    fields: [
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Description' },
      { key: 'template_type', label: 'Template Type', options: ['basic-agent', 'tool-calling-agent', 'rag-pipeline', 'workflow', 'multi-agent', 'mcp-server', 'full-stack'], default: 'basic-agent' },
      { key: 'files', label: 'Files (JSON)', textarea: true, rows: 6, save: 'jsonStr' },
      { key: 'dependencies', label: 'Dependencies (JSON)', textarea: true, save: 'jsonStr' },
      { key: 'dev_dependencies', label: 'Dev Dependencies (JSON)', textarea: true, save: 'jsonStr' },
      { key: 'variables', label: 'Variables (JSON)', textarea: true, save: 'jsonStr' },
      { key: 'post_install', label: 'Post Install Command' },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', save: 'bool', default: true },
    ],
  },
  'recipe-configs': {
    singular: 'Recipe Config', apiPath: 'admin/recipe-configs', listKey: 'recipe-configs',
    cols: ['name', 'recipe_type', 'model', 'enabled'],
    fields: [
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Description' },
      { key: 'recipe_type', label: 'Recipe Type', options: ['workflow', 'governed', 'approval', 'acl-rag', 'multi-tenant', 'eval-routed', 'memory', 'event-driven', 'safe-exec'], default: 'workflow' },
      { key: 'model', label: 'Model' },
      { key: 'provider', label: 'Provider' },
      { key: 'system_prompt', label: 'System Prompt', textarea: true, rows: 3 },
      { key: 'tools', label: 'Tools (JSON)', textarea: true, save: 'json' },
      { key: 'guardrails', label: 'Guardrails (JSON)', textarea: true, save: 'json' },
      { key: 'max_steps', label: 'Max Steps', type: 'number', save: 'int', default: 10 },
      { key: 'options', label: 'Options (JSON)', textarea: true, save: 'json' },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', save: 'bool', default: true },
    ],
  },
  'widget-configs': {
    singular: 'Widget Config', apiPath: 'admin/widget-configs', listKey: 'widget-configs',
    cols: ['name', 'widget_type', 'max_data_points', 'enabled'],
    fields: [
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Description' },
      { key: 'widget_type', label: 'Widget Type', options: ['table', 'chart', 'form', 'code', 'timeline', 'image'], default: 'table' },
      { key: 'default_options', label: 'Default Options (JSON)', textarea: true, save: 'jsonStr' },
      { key: 'allowed_contexts', label: 'Allowed Contexts (JSON)', textarea: true, save: 'jsonStr' },
      { key: 'max_data_points', label: 'Max Data Points', type: 'number', save: 'int' },
      { key: 'refresh_interval_ms', label: 'Refresh Interval (ms)', type: 'number', save: 'int' },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', save: 'bool', default: true },
    ],
  },
  'validation-rules': {
    singular: 'Validation Rule', apiPath: 'admin/validation-rules', listKey: 'validation-rules',
    cols: ['name', 'rule_type', 'target', 'severity', 'enabled'],
    fields: [
      { key: 'name', label: 'Name' },
      { key: 'description', label: 'Description' },
      { key: 'rule_type', label: 'Rule Type', options: ['required', 'range', 'pattern', 'custom'], default: 'required' },
      { key: 'target', label: 'Target', options: ['agent-config', 'workflow-config', 'tool-config'], default: 'agent-config' },
      { key: 'condition', label: 'Condition (JSON)', textarea: true, save: 'jsonStr' },
      { key: 'severity', label: 'Severity', options: ['error', 'warning', 'info'], default: 'error' },
      { key: 'message', label: 'Message' },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', save: 'bool', default: true },
    ],
  },

  /* ── Monitoring (read-only) ───────────────── */
  'workflow-runs': {
    singular: 'Workflow Run', apiPath: 'workflow-runs', listKey: 'runs',
    cols: ['id', 'workflow_id', 'status', 'started_at'],
    fields: [],
    readOnly: true,
  },
  'guardrail-evals': {
    singular: 'Guardrail Eval', apiPath: 'guardrail-evals', listKey: 'evals',
    cols: ['id', 'stage', 'overall_decision', 'created_at'],
    fields: [],
    readOnly: true,
  },
};
