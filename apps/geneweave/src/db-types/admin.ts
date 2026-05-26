/** Admin policy, governance, connector, and configuration row types. */

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
