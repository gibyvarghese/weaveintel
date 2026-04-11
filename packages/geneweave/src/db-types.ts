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

export interface ChatSettingsRow {
  chat_id: string;
  mode: string;
  system_prompt: string | null;
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

// ─── Admin config row types ──────────────────────────────────

export interface PromptRow {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  template: string;
  variables: string | null;       // JSON array
  version: string;
  is_default: number;
  enabled: number;
  created_at: string;
  updated_at: string;
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

export interface ToolConfigRow {
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  risk_level: string;
  requires_approval: number;
  max_execution_ms: number | null;
  rate_limit_per_min: number | null;
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
  platform: string;               // slack, discord, github
  api_key: string | null;
  api_secret: string | null;
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
  connector_type: string;         // jira, confluence, salesforce, notion
  base_url: string | null;
  auth_type: string | null;       // bearer, oauth2, api_key, basic, service_account
  auth_config: string | null;     // JSON object
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
  createUser(user: { id: string; email: string; name: string; passwordHash: string }): Promise<void>;
  getUserByEmail(email: string): Promise<UserRow | null>;
  getUserById(id: string): Promise<UserRow | null>;

  // Sessions
  createSession(session: { id: string; userId: string; csrfToken: string; expiresAt: string }): Promise<void>;
  getSession(id: string): Promise<SessionRow | null>;
  deleteSession(id: string): Promise<void>;
  deleteExpiredSessions(): Promise<void>;

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

  // Chat settings (agent mode, tools, redaction)
  getChatSettings(chatId: string): Promise<ChatSettingsRow | null>;
  saveChatSettings(settings: {
    chatId: string;
    mode: string;
    systemPrompt?: string;
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

  // Agent activity: assistant messages with parsed metadata
  getAgentActivity(userId: string, limit?: number): Promise<Array<MessageRow & { chat_title: string; chat_model: string; chat_provider: string }>>;

  // ─── Admin: Prompts ────────────────────────────────────────
  createPrompt(p: Omit<PromptRow, 'created_at' | 'updated_at'>): Promise<void>;
  getPrompt(id: string): Promise<PromptRow | null>;
  listPrompts(): Promise<PromptRow[]>;
  updatePrompt(id: string, fields: Partial<Omit<PromptRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deletePrompt(id: string): Promise<void>;

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

  // ─── Admin: Tool configs ───────────────────────────────────
  createToolConfig(t: Omit<ToolConfigRow, 'created_at' | 'updated_at'>): Promise<void>;
  getToolConfig(id: string): Promise<ToolConfigRow | null>;
  listToolConfigs(): Promise<ToolConfigRow[]>;
  updateToolConfig(id: string, fields: Partial<Omit<ToolConfigRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteToolConfig(id: string): Promise<void>;

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

