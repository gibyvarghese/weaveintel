/**
 * @weaveintel/geneweave — Database adapter layer
 *
 * Repository-pattern interface so any database backend (SQLite, Postgres, MySQL,
 * MongoDB…) can be plugged in. The default ships SQLite via better-sqlite3.
 * Tables are auto-created on first `initialize()` call.
 */

import { randomUUID } from 'node:crypto';

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

  // ─── Admin: Seed data ──────────────────────────────────────
  seedDefaultData(): Promise<void>;
}

// ─── SQLite adapter ──────────────────────────────────────────

const SCHEMA_SQL = `
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
`;

export class SQLiteAdapter implements DatabaseAdapter {
  private db: import('better-sqlite3').Database | null = null;
  constructor(private readonly path: string) {}

  async initialize(): Promise<void> {
    const BetterSqlite3 = (await import('better-sqlite3')).default;
    this.db = new BetterSqlite3(this.path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA_SQL);
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  private get d() {
    if (!this.db) throw new Error('Database not initialized — call initialize() first');
    return this.db;
  }

  // ── Users ──────────────────────────────────────────────────

  async createUser(u: { id: string; email: string; name: string; passwordHash: string }): Promise<void> {
    this.d.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)').run(u.id, u.email, u.name, u.passwordHash);
  }

  async getUserByEmail(email: string): Promise<UserRow | null> {
    return (this.d.prepare('SELECT * FROM users WHERE email = ?').get(email) as UserRow | undefined) ?? null;
  }

  async getUserById(id: string): Promise<UserRow | null> {
    return (this.d.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined) ?? null;
  }

  // ── Sessions ───────────────────────────────────────────────

  async createSession(s: { id: string; userId: string; csrfToken: string; expiresAt: string }): Promise<void> {
    this.d.prepare('INSERT INTO sessions (id, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)').run(s.id, s.userId, s.csrfToken, s.expiresAt);
  }

  async getSession(id: string): Promise<SessionRow | null> {
    return (this.d.prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > datetime(\'now\')').get(id) as SessionRow | undefined) ?? null;
  }

  async deleteSession(id: string): Promise<void> {
    this.d.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  async deleteExpiredSessions(): Promise<void> {
    this.d.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
  }

  // ── Chats ──────────────────────────────────────────────────

  async createChat(c: { id: string; userId: string; title: string; model: string; provider: string }): Promise<void> {
    this.d.prepare('INSERT INTO chats (id, user_id, title, model, provider) VALUES (?, ?, ?, ?, ?)').run(c.id, c.userId, c.title, c.model, c.provider);
  }

  async getChat(id: string, userId: string): Promise<ChatRow | null> {
    return (this.d.prepare('SELECT * FROM chats WHERE id = ? AND user_id = ?').get(id, userId) as ChatRow | undefined) ?? null;
  }

  async getUserChats(userId: string): Promise<ChatRow[]> {
    return this.d.prepare('SELECT * FROM chats WHERE user_id = ? ORDER BY updated_at DESC').all(userId) as ChatRow[];
  }

  async updateChatTitle(id: string, userId: string, title: string): Promise<void> {
    this.d.prepare("UPDATE chats SET title = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?").run(title, id, userId);
  }

  async deleteChat(id: string, userId: string): Promise<void> {
    this.d.prepare('DELETE FROM chats WHERE id = ? AND user_id = ?').run(id, userId);
  }

  // ── Messages ───────────────────────────────────────────────

  async addMessage(m: {
    id: string; chatId: string; role: string; content: string;
    metadata?: string; tokensUsed?: number; cost?: number; latencyMs?: number;
  }): Promise<void> {
    this.d.prepare(
      'INSERT INTO messages (id, chat_id, role, content, metadata, tokens_used, cost, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(m.id, m.chatId, m.role, m.content, m.metadata ?? null, m.tokensUsed ?? 0, m.cost ?? 0, m.latencyMs ?? 0);
    this.d.prepare("UPDATE chats SET updated_at = datetime('now') WHERE id = ?").run(m.chatId);
  }

  async getMessages(chatId: string): Promise<MessageRow[]> {
    return this.d.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC').all(chatId) as MessageRow[];
  }

  // ── Metrics ────────────────────────────────────────────────

  async recordMetric(m: {
    id: string; userId: string; chatId?: string; type: string;
    provider?: string; model?: string; promptTokens?: number;
    completionTokens?: number; totalTokens?: number; cost?: number;
    latencyMs?: number; metadata?: string;
  }): Promise<void> {
    this.d.prepare(
      'INSERT INTO metrics (id, user_id, chat_id, type, provider, model, prompt_tokens, completion_tokens, total_tokens, cost, latency_ms, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      m.id, m.userId, m.chatId ?? null, m.type, m.provider ?? null, m.model ?? null,
      m.promptTokens ?? 0, m.completionTokens ?? 0, m.totalTokens ?? 0,
      m.cost ?? 0, m.latencyMs ?? 0, m.metadata ?? null,
    );
  }

  async getMetrics(userId: string, from?: string, to?: string): Promise<MetricRow[]> {
    let sql = 'SELECT * FROM metrics WHERE user_id = ?';
    const params: unknown[] = [userId];
    if (from) { sql += ' AND created_at >= ?'; params.push(from); }
    if (to) { sql += ' AND created_at <= ?'; params.push(to); }
    sql += ' ORDER BY created_at DESC';
    return this.d.prepare(sql).all(...params) as MetricRow[];
  }

  async getMetricsSummary(userId: string, from?: string, to?: string): Promise<MetricsSummary> {
    let where = 'WHERE user_id = ?';
    const params: unknown[] = [userId];
    if (from) { where += ' AND created_at >= ?'; params.push(from); }
    if (to) { where += ' AND created_at <= ?'; params.push(to); }

    const totals = this.d.prepare(
      `SELECT COALESCE(SUM(total_tokens),0) as total_tokens, COALESCE(SUM(cost),0) as total_cost, COALESCE(AVG(latency_ms),0) as avg_latency_ms FROM metrics ${where}`,
    ).get(...params) as { total_tokens: number; total_cost: number; avg_latency_ms: number };

    const msgCount = this.d.prepare(
      `SELECT COUNT(*) as cnt FROM messages WHERE chat_id IN (SELECT id FROM chats WHERE user_id = ?)`,
    ).get(userId) as { cnt: number };

    const chatCount = this.d.prepare(
      'SELECT COUNT(*) as cnt FROM chats WHERE user_id = ?',
    ).get(userId) as { cnt: number };

    const byModel = this.d.prepare(
      `SELECT model, provider, SUM(total_tokens) as tokens, SUM(cost) as cost, COUNT(*) as count FROM metrics ${where} GROUP BY model, provider`,
    ).all(...params) as Array<{ model: string; provider: string; tokens: number; cost: number; count: number }>;

    const byDay = this.d.prepare(
      `SELECT DATE(created_at) as date, SUM(total_tokens) as tokens, SUM(cost) as cost, COUNT(*) as count FROM metrics ${where} GROUP BY DATE(created_at) ORDER BY date`,
    ).all(...params) as Array<{ date: string; tokens: number; cost: number; count: number }>;

    return {
      total_tokens: totals.total_tokens,
      total_cost: totals.total_cost,
      avg_latency_ms: Math.round(totals.avg_latency_ms),
      total_messages: msgCount.cnt,
      total_chats: chatCount.cnt,
      by_model: byModel,
      by_day: byDay,
    };
  }

  // ── Evals ──────────────────────────────────────────────────

  async recordEval(r: {
    id: string; userId: string; chatId?: string; evalName: string;
    score: number; passed: number; failed: number; total: number; details?: string;
  }): Promise<void> {
    this.d.prepare(
      'INSERT INTO eval_results (id, user_id, chat_id, eval_name, score, passed, failed, total, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(r.id, r.userId, r.chatId ?? null, r.evalName, r.score, r.passed, r.failed, r.total, r.details ?? null);
  }

  async getEvals(userId: string, from?: string, to?: string): Promise<EvalRow[]> {
    let sql = 'SELECT * FROM eval_results WHERE user_id = ?';
    const params: unknown[] = [userId];
    if (from) { sql += ' AND created_at >= ?'; params.push(from); }
    if (to) { sql += ' AND created_at <= ?'; params.push(to); }
    sql += ' ORDER BY created_at DESC';
    return this.d.prepare(sql).all(...params) as EvalRow[];
  }

  // ── Chat Settings ──────────────────────────────────────────

  async getChatSettings(chatId: string): Promise<ChatSettingsRow | null> {
    return (this.d.prepare('SELECT * FROM chat_settings WHERE chat_id = ?').get(chatId) as ChatSettingsRow | undefined) ?? null;
  }

  async saveChatSettings(s: {
    chatId: string; mode: string; systemPrompt?: string;
    enabledTools?: string; redactionEnabled?: boolean;
    redactionPatterns?: string; workers?: string;
  }): Promise<void> {
    this.d.prepare(
      `INSERT INTO chat_settings (chat_id, mode, system_prompt, enabled_tools, redaction_enabled, redaction_patterns, workers)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
         mode=excluded.mode, system_prompt=excluded.system_prompt,
         enabled_tools=excluded.enabled_tools, redaction_enabled=excluded.redaction_enabled,
         redaction_patterns=excluded.redaction_patterns, workers=excluded.workers,
         updated_at=datetime('now')`,
    ).run(
      s.chatId, s.mode, s.systemPrompt ?? null,
      s.enabledTools ?? null, s.redactionEnabled ? 1 : 0,
      s.redactionPatterns ?? null, s.workers ?? null,
    );
  }

  // ── Traces ─────────────────────────────────────────────────

  async saveTrace(t: {
    id: string; userId: string; chatId?: string; messageId?: string;
    traceId: string; spanId: string; parentSpanId?: string;
    name: string; startTime: number; endTime?: number;
    status?: string; attributes?: string; events?: string;
  }): Promise<void> {
    this.d.prepare(
      `INSERT INTO traces (id, user_id, chat_id, message_id, trace_id, span_id, parent_span_id, name, start_time, end_time, status, attributes, events)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      t.id, t.userId, t.chatId ?? null, t.messageId ?? null,
      t.traceId, t.spanId, t.parentSpanId ?? null,
      t.name, t.startTime, t.endTime ?? null,
      t.status ?? null, t.attributes ?? null, t.events ?? null,
    );
  }

  async getChatTraces(chatId: string): Promise<TraceRow[]> {
    return this.d.prepare('SELECT * FROM traces WHERE chat_id = ? ORDER BY start_time ASC').all(chatId) as TraceRow[];
  }

  async getUserTraces(userId: string, limit?: number): Promise<TraceRow[]> {
    const sql = 'SELECT * FROM traces WHERE user_id = ? ORDER BY start_time DESC LIMIT ?';
    return this.d.prepare(sql).all(userId, limit ?? 100) as TraceRow[];
  }

  async getAgentActivity(userId: string, limit?: number): Promise<Array<MessageRow & { chat_title: string; chat_model: string; chat_provider: string }>> {
    const sql = `
      SELECT m.*, c.title AS chat_title, c.model AS chat_model, c.provider AS chat_provider
      FROM messages m
      JOIN chats c ON c.id = m.chat_id
      WHERE c.user_id = ? AND m.role = 'assistant' AND m.metadata IS NOT NULL
      ORDER BY m.created_at DESC
      LIMIT ?
    `;
    return this.d.prepare(sql).all(userId, limit ?? 50) as Array<MessageRow & { chat_title: string; chat_model: string; chat_provider: string }>;
  }

  // ─── Admin: Prompts ────────────────────────────────────────

  async createPrompt(p: Omit<PromptRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO prompts (id, name, description, category, template, variables, version, is_default, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.name, p.description ?? null, p.category ?? null, p.template, p.variables ?? null, p.version, p.is_default, p.enabled);
  }

  async getPrompt(id: string): Promise<PromptRow | null> {
    return (this.d.prepare('SELECT * FROM prompts WHERE id = ?').get(id) as PromptRow) ?? null;
  }

  async listPrompts(): Promise<PromptRow[]> {
    return this.d.prepare('SELECT * FROM prompts ORDER BY name ASC').all() as PromptRow[];
  }

  async updatePrompt(id: string, fields: Partial<Omit<PromptRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE prompts SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deletePrompt(id: string): Promise<void> {
    this.d.prepare('DELETE FROM prompts WHERE id = ?').run(id);
  }

  // ─── Admin: Guardrails ─────────────────────────────────────

  async createGuardrail(g: Omit<GuardrailRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO guardrails (id, name, description, type, stage, config, priority, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(g.id, g.name, g.description ?? null, g.type, g.stage, g.config ?? null, g.priority, g.enabled);
  }

  async getGuardrail(id: string): Promise<GuardrailRow | null> {
    return (this.d.prepare('SELECT * FROM guardrails WHERE id = ?').get(id) as GuardrailRow) ?? null;
  }

  async listGuardrails(): Promise<GuardrailRow[]> {
    return this.d.prepare('SELECT * FROM guardrails ORDER BY priority DESC, name ASC').all() as GuardrailRow[];
  }

  async updateGuardrail(id: string, fields: Partial<Omit<GuardrailRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE guardrails SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteGuardrail(id: string): Promise<void> {
    this.d.prepare('DELETE FROM guardrails WHERE id = ?').run(id);
  }

  // ─── Admin: Routing policies ───────────────────────────────

  async createRoutingPolicy(r: Omit<RoutingPolicyRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO routing_policies (id, name, description, strategy, constraints, weights, fallback_model, fallback_provider, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(r.id, r.name, r.description ?? null, r.strategy, r.constraints ?? null, r.weights ?? null, r.fallback_model ?? null, r.fallback_provider ?? null, r.enabled);
  }

  async getRoutingPolicy(id: string): Promise<RoutingPolicyRow | null> {
    return (this.d.prepare('SELECT * FROM routing_policies WHERE id = ?').get(id) as RoutingPolicyRow) ?? null;
  }

  async listRoutingPolicies(): Promise<RoutingPolicyRow[]> {
    return this.d.prepare('SELECT * FROM routing_policies ORDER BY name ASC').all() as RoutingPolicyRow[];
  }

  async updateRoutingPolicy(id: string, fields: Partial<Omit<RoutingPolicyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE routing_policies SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteRoutingPolicy(id: string): Promise<void> {
    this.d.prepare('DELETE FROM routing_policies WHERE id = ?').run(id);
  }

  // ─── Admin: Workflow definitions ───────────────────────────

  async createWorkflowDef(w: Omit<WorkflowDefRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO workflow_defs (id, name, description, version, steps, entry_step_id, metadata, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(w.id, w.name, w.description ?? null, w.version, w.steps, w.entry_step_id, w.metadata ?? null, w.enabled);
  }

  async getWorkflowDef(id: string): Promise<WorkflowDefRow | null> {
    return (this.d.prepare('SELECT * FROM workflow_defs WHERE id = ?').get(id) as WorkflowDefRow) ?? null;
  }

  async listWorkflowDefs(): Promise<WorkflowDefRow[]> {
    return this.d.prepare('SELECT * FROM workflow_defs ORDER BY name ASC').all() as WorkflowDefRow[];
  }

  async updateWorkflowDef(id: string, fields: Partial<Omit<WorkflowDefRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE workflow_defs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteWorkflowDef(id: string): Promise<void> {
    this.d.prepare('DELETE FROM workflow_defs WHERE id = ?').run(id);
  }

  // ─── Admin: Tool configs ───────────────────────────────────

  async createToolConfig(t: Omit<ToolConfigRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO tool_configs (id, name, description, category, risk_level, requires_approval, max_execution_ms, rate_limit_per_min, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(t.id, t.name, t.description ?? null, t.category ?? null, t.risk_level, t.requires_approval, t.max_execution_ms ?? null, t.rate_limit_per_min ?? null, t.enabled);
  }

  async getToolConfig(id: string): Promise<ToolConfigRow | null> {
    return (this.d.prepare('SELECT * FROM tool_configs WHERE id = ?').get(id) as ToolConfigRow) ?? null;
  }

  async listToolConfigs(): Promise<ToolConfigRow[]> {
    return this.d.prepare('SELECT * FROM tool_configs ORDER BY category ASC, name ASC').all() as ToolConfigRow[];
  }

  async updateToolConfig(id: string, fields: Partial<Omit<ToolConfigRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE tool_configs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteToolConfig(id: string): Promise<void> {
    this.d.prepare('DELETE FROM tool_configs WHERE id = ?').run(id);
  }

  // ─── Workflow Runs ─────────────────────────────────────────

  async createWorkflowRun(r: Omit<WorkflowRunRow, 'completed_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, status, state, input, error, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(r.id, r.workflow_id, r.status, r.state, r.input, r.error, r.started_at);
  }

  async getWorkflowRun(id: string): Promise<WorkflowRunRow | null> {
    return (this.d.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(id) as WorkflowRunRow | undefined) ?? null;
  }

  async listWorkflowRuns(workflowId?: string): Promise<WorkflowRunRow[]> {
    if (workflowId) {
      return this.d.prepare('SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY started_at DESC').all(workflowId) as WorkflowRunRow[];
    }
    return this.d.prepare('SELECT * FROM workflow_runs ORDER BY started_at DESC').all() as WorkflowRunRow[];
  }

  async updateWorkflowRun(id: string, fields: Partial<Omit<WorkflowRunRow, 'id' | 'started_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    vals.push(id);
    this.d.prepare(`UPDATE workflow_runs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  // ─── Guardrail Evaluations ─────────────────────────────────

  async createGuardrailEval(e: Omit<GuardrailEvalRow, 'created_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO guardrail_evals (id, chat_id, message_id, stage, input_preview, results, overall_decision) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(e.id, e.chat_id, e.message_id, e.stage, e.input_preview, e.results, e.overall_decision);
  }

  async listGuardrailEvals(chatId?: string, limit = 50): Promise<GuardrailEvalRow[]> {
    if (chatId) {
      return this.d.prepare('SELECT * FROM guardrail_evals WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?').all(chatId, limit) as GuardrailEvalRow[];
    }
    return this.d.prepare('SELECT * FROM guardrail_evals ORDER BY created_at DESC LIMIT ?').all(limit) as GuardrailEvalRow[];
  }

  // ─── Admin: Human Task Policies ────────────────────────────

  async createHumanTaskPolicy(p: Omit<HumanTaskPolicyRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO human_task_policies (id, name, description, trigger, task_type, default_priority, sla_hours, auto_escalate_after_hours, assignment_strategy, assign_to, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.name, p.description ?? null, p.trigger, p.task_type, p.default_priority, p.sla_hours ?? null, p.auto_escalate_after_hours ?? null, p.assignment_strategy, p.assign_to ?? null, p.enabled);
  }

  async getHumanTaskPolicy(id: string): Promise<HumanTaskPolicyRow | null> {
    return (this.d.prepare('SELECT * FROM human_task_policies WHERE id = ?').get(id) as HumanTaskPolicyRow) ?? null;
  }

  async listHumanTaskPolicies(): Promise<HumanTaskPolicyRow[]> {
    return this.d.prepare('SELECT * FROM human_task_policies ORDER BY name ASC').all() as HumanTaskPolicyRow[];
  }

  async updateHumanTaskPolicy(id: string, fields: Partial<Omit<HumanTaskPolicyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE human_task_policies SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteHumanTaskPolicy(id: string): Promise<void> {
    this.d.prepare('DELETE FROM human_task_policies WHERE id = ?').run(id);
  }

  // ─── Admin: Task Contracts ─────────────────────────────────

  async createTaskContract(c: Omit<TaskContractRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO task_contracts (id, name, description, input_schema, output_schema, acceptance_criteria, max_attempts, timeout_ms, evidence_required, min_confidence, require_human_review, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(c.id, c.name, c.description ?? null, c.input_schema ?? null, c.output_schema ?? null, c.acceptance_criteria, c.max_attempts ?? null, c.timeout_ms ?? null, c.evidence_required ?? null, c.min_confidence ?? null, c.require_human_review, c.enabled);
  }

  async getTaskContract(id: string): Promise<TaskContractRow | null> {
    return (this.d.prepare('SELECT * FROM task_contracts WHERE id = ?').get(id) as TaskContractRow) ?? null;
  }

  async listTaskContracts(): Promise<TaskContractRow[]> {
    return this.d.prepare('SELECT * FROM task_contracts ORDER BY name ASC').all() as TaskContractRow[];
  }

  async updateTaskContract(id: string, fields: Partial<Omit<TaskContractRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE task_contracts SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteTaskContract(id: string): Promise<void> {
    this.d.prepare('DELETE FROM task_contracts WHERE id = ?').run(id);
  }

  // ─── Admin: Cache Policies ─────────────────────────────────

  async createCachePolicy(p: Omit<CachePolicyRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO cache_policies (id, name, description, scope, ttl_ms, max_entries, bypass_patterns, invalidate_on, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.name, p.description ?? null, p.scope, p.ttl_ms, p.max_entries, p.bypass_patterns ?? null, p.invalidate_on ?? null, p.enabled);
  }

  async getCachePolicy(id: string): Promise<CachePolicyRow | null> {
    return (this.d.prepare('SELECT * FROM cache_policies WHERE id = ?').get(id) as CachePolicyRow) ?? null;
  }

  async listCachePolicies(): Promise<CachePolicyRow[]> {
    return this.d.prepare('SELECT * FROM cache_policies ORDER BY name ASC').all() as CachePolicyRow[];
  }

  async updateCachePolicy(id: string, fields: Partial<Omit<CachePolicyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE cache_policies SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteCachePolicy(id: string): Promise<void> {
    this.d.prepare('DELETE FROM cache_policies WHERE id = ?').run(id);
  }

  // ─── Admin: Identity Rules ─────────────────────────────────

  async createIdentityRule(r: Omit<IdentityRuleRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO identity_rules (id, name, description, resource, action, roles, scopes, result, priority, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(r.id, r.name, r.description ?? null, r.resource, r.action, r.roles ?? null, r.scopes ?? null, r.result, r.priority, r.enabled);
  }

  async getIdentityRule(id: string): Promise<IdentityRuleRow | null> {
    return (this.d.prepare('SELECT * FROM identity_rules WHERE id = ?').get(id) as IdentityRuleRow) ?? null;
  }

  async listIdentityRules(): Promise<IdentityRuleRow[]> {
    return this.d.prepare('SELECT * FROM identity_rules ORDER BY priority DESC, name ASC').all() as IdentityRuleRow[];
  }

  async updateIdentityRule(id: string, fields: Partial<Omit<IdentityRuleRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE identity_rules SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteIdentityRule(id: string): Promise<void> {
    this.d.prepare('DELETE FROM identity_rules WHERE id = ?').run(id);
  }

  // ─── Admin: Memory Governance ──────────────────────────────

  async createMemoryGovernance(g: Omit<MemoryGovernanceRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO memory_governance (id, name, description, memory_types, tenant_id, block_patterns, redact_patterns, max_age, max_entries, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(g.id, g.name, g.description ?? null, g.memory_types ?? null, g.tenant_id ?? null, g.block_patterns ?? null, g.redact_patterns ?? null, g.max_age ?? null, g.max_entries ?? null, g.enabled);
  }

  async getMemoryGovernance(id: string): Promise<MemoryGovernanceRow | null> {
    return (this.d.prepare('SELECT * FROM memory_governance WHERE id = ?').get(id) as MemoryGovernanceRow) ?? null;
  }

  async listMemoryGovernance(): Promise<MemoryGovernanceRow[]> {
    return this.d.prepare('SELECT * FROM memory_governance ORDER BY name ASC').all() as MemoryGovernanceRow[];
  }

  async updateMemoryGovernance(id: string, fields: Partial<Omit<MemoryGovernanceRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE memory_governance SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteMemoryGovernance(id: string): Promise<void> {
    this.d.prepare('DELETE FROM memory_governance WHERE id = ?').run(id);
  }

  // ─── Admin: Search Providers ───────────────────────────────

  async createSearchProvider(p: Omit<SearchProviderRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO search_providers (id, name, description, provider_type, api_key, base_url, priority, options, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.name, p.description ?? null, p.provider_type, p.api_key ?? null, p.base_url ?? null, p.priority, p.options ?? null, p.enabled);
  }

  async getSearchProvider(id: string): Promise<SearchProviderRow | null> {
    return (this.d.prepare('SELECT * FROM search_providers WHERE id = ?').get(id) as SearchProviderRow) ?? null;
  }

  async listSearchProviders(): Promise<SearchProviderRow[]> {
    return this.d.prepare('SELECT * FROM search_providers ORDER BY priority DESC, name ASC').all() as SearchProviderRow[];
  }

  async updateSearchProvider(id: string, fields: Partial<Omit<SearchProviderRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE search_providers SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteSearchProvider(id: string): Promise<void> {
    this.d.prepare('DELETE FROM search_providers WHERE id = ?').run(id);
  }

  // ─── Admin: HTTP Endpoints ─────────────────────────────────

  async createHttpEndpoint(e: Omit<HttpEndpointRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO http_endpoints (id, name, description, url, method, auth_type, auth_config, headers, body_template, response_transform, retry_count, rate_limit_rpm, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(e.id, e.name, e.description ?? null, e.url, e.method, e.auth_type ?? null, e.auth_config ?? null, e.headers ?? null, e.body_template ?? null, e.response_transform ?? null, e.retry_count, e.rate_limit_rpm ?? null, e.enabled);
  }

  async getHttpEndpoint(id: string): Promise<HttpEndpointRow | null> {
    return (this.d.prepare('SELECT * FROM http_endpoints WHERE id = ?').get(id) as HttpEndpointRow) ?? null;
  }

  async listHttpEndpoints(): Promise<HttpEndpointRow[]> {
    return this.d.prepare('SELECT * FROM http_endpoints ORDER BY name ASC').all() as HttpEndpointRow[];
  }

  async updateHttpEndpoint(id: string, fields: Partial<Omit<HttpEndpointRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE http_endpoints SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteHttpEndpoint(id: string): Promise<void> {
    this.d.prepare('DELETE FROM http_endpoints WHERE id = ?').run(id);
  }

  // ─── Admin: Social Accounts ────────────────────────────────

  async createSocialAccount(a: Omit<SocialAccountRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO social_accounts (id, name, description, platform, api_key, api_secret, base_url, options, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(a.id, a.name, a.description ?? null, a.platform, a.api_key ?? null, a.api_secret ?? null, a.base_url ?? null, a.options ?? null, a.enabled);
  }

  async getSocialAccount(id: string): Promise<SocialAccountRow | null> {
    return (this.d.prepare('SELECT * FROM social_accounts WHERE id = ?').get(id) as SocialAccountRow) ?? null;
  }

  async listSocialAccounts(): Promise<SocialAccountRow[]> {
    return this.d.prepare('SELECT * FROM social_accounts ORDER BY name ASC').all() as SocialAccountRow[];
  }

  async updateSocialAccount(id: string, fields: Partial<Omit<SocialAccountRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE social_accounts SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteSocialAccount(id: string): Promise<void> {
    this.d.prepare('DELETE FROM social_accounts WHERE id = ?').run(id);
  }

  // ─── Admin: Enterprise Connectors ──────────────────────────

  async createEnterpriseConnector(c: Omit<EnterpriseConnectorRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO enterprise_connectors (id, name, description, connector_type, base_url, auth_type, auth_config, options, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(c.id, c.name, c.description ?? null, c.connector_type, c.base_url ?? null, c.auth_type ?? null, c.auth_config ?? null, c.options ?? null, c.enabled);
  }

  async getEnterpriseConnector(id: string): Promise<EnterpriseConnectorRow | null> {
    return (this.d.prepare('SELECT * FROM enterprise_connectors WHERE id = ?').get(id) as EnterpriseConnectorRow) ?? null;
  }

  async listEnterpriseConnectors(): Promise<EnterpriseConnectorRow[]> {
    return this.d.prepare('SELECT * FROM enterprise_connectors ORDER BY name ASC').all() as EnterpriseConnectorRow[];
  }

  async updateEnterpriseConnector(id: string, fields: Partial<Omit<EnterpriseConnectorRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE enterprise_connectors SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteEnterpriseConnector(id: string): Promise<void> {
    this.d.prepare('DELETE FROM enterprise_connectors WHERE id = ?').run(id);
  }

  // ─── Admin: Tool Registry ─────────────────────────────────

  async createToolRegistryEntry(t: Omit<ToolRegistryRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO tool_registry (id, name, description, package_name, version, category, risk_level, tags, config, requires_approval, max_execution_ms, rate_limit_per_min, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(t.id, t.name, t.description ?? null, t.package_name, t.version, t.category, t.risk_level, t.tags ?? null, t.config ?? null, t.requires_approval, t.max_execution_ms ?? null, t.rate_limit_per_min ?? null, t.enabled);
  }

  async getToolRegistryEntry(id: string): Promise<ToolRegistryRow | null> {
    return (this.d.prepare('SELECT * FROM tool_registry WHERE id = ?').get(id) as ToolRegistryRow) ?? null;
  }

  async listToolRegistry(): Promise<ToolRegistryRow[]> {
    return this.d.prepare('SELECT * FROM tool_registry ORDER BY category ASC, name ASC').all() as ToolRegistryRow[];
  }

  async updateToolRegistryEntry(id: string, fields: Partial<Omit<ToolRegistryRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE tool_registry SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteToolRegistryEntry(id: string): Promise<void> {
    this.d.prepare('DELETE FROM tool_registry WHERE id = ?').run(id);
  }

  // ─── Seed default data ─────────────────────────────────────

  async seedDefaultData(): Promise<void> {
    const cnt = (tbl: string) => (this.d.prepare(`SELECT COUNT(*) as cnt FROM ${tbl}`).get() as { cnt: number }).cnt;

    // Prompts
    if (cnt('prompts') === 0) {
    const prompts: Omit<PromptRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'prompt-general-assistant', name: 'General Assistant', description: 'Default conversational assistant prompt',
        category: 'general', template: 'You are a helpful, accurate, and concise AI assistant. Answer the user\'s questions clearly and provide relevant details when asked.',
        variables: null, version: '1.0', is_default: 1, enabled: 1,
      },
      {
        id: 'prompt-code-reviewer', name: 'Code Review Expert', description: 'Technical code review prompt with best practices',
        category: 'engineering', template: 'You are an expert code reviewer. Analyze code for bugs, security issues, performance problems, and style. Provide actionable suggestions with explanations. Focus on: {{focus_areas}}',
        variables: JSON.stringify(['focus_areas']), version: '1.0', is_default: 0, enabled: 1,
      },
      {
        id: 'prompt-summarizer', name: 'Document Summarizer', description: 'Summarize long documents into key points',
        category: 'content', template: 'Summarize the following content into {{format}}. Preserve key facts, numbers, and conclusions. Be concise but thorough.\n\nContent:\n{{content}}',
        variables: JSON.stringify(['format', 'content']), version: '1.0', is_default: 0, enabled: 1,
      },
      {
        id: 'prompt-sql-expert', name: 'SQL Query Builder', description: 'Generate SQL queries from natural language',
        category: 'engineering', template: 'You are an expert SQL developer. Convert the following natural language request into a correct, optimized SQL query. Target database: {{db_type}}. Available tables: {{schema}}',
        variables: JSON.stringify(['db_type', 'schema']), version: '1.0', is_default: 0, enabled: 1,
      },
    ];
    for (const p of prompts) await this.createPrompt(p);
    }

    // Guardrails
    if (cnt('guardrails') === 0) {
    const guardrails: Omit<GuardrailRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'guard-pii-redact', name: 'PII Redaction', description: 'Redact personal identifiable information before sending to LLM',
        type: 'redaction', stage: 'pre', config: JSON.stringify({ patterns: ['email', 'phone', 'ssn', 'credit_card'] }), priority: 100, enabled: 1,
      },
      {
        id: 'guard-toxicity', name: 'Toxicity Filter', description: 'Block toxic or harmful content in responses',
        type: 'content_filter', stage: 'post', config: JSON.stringify({ threshold: 0.7, categories: ['hate', 'violence', 'self_harm'] }), priority: 90, enabled: 1,
      },
      {
        id: 'guard-token-limit', name: 'Token Budget', description: 'Enforce maximum token usage per request',
        type: 'budget', stage: 'pre', config: JSON.stringify({ max_input_tokens: 8000, max_output_tokens: 4000 }), priority: 80, enabled: 1,
      },
      {
        id: 'guard-hallucination', name: 'Hallucination Check', description: 'Flag responses that may contain fabricated information',
        type: 'factuality', stage: 'post', config: JSON.stringify({ confidence_threshold: 0.6, require_citations: false }), priority: 70, enabled: 0,
      },
    ];
    for (const g of guardrails) await this.createGuardrail(g);
    }

    // Routing policies
    if (cnt('routing_policies') === 0) {
    const policies: Omit<RoutingPolicyRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'route-cost-optimized', name: 'Cost Optimized', description: 'Route to the cheapest model that meets quality thresholds',
        strategy: 'cost', constraints: JSON.stringify({ min_quality_score: 0.7 }), weights: JSON.stringify({ cost: 0.7, quality: 0.2, latency: 0.1 }),
        fallback_model: 'gpt-4o-mini', fallback_provider: 'openai', enabled: 1,
      },
      {
        id: 'route-quality-first', name: 'Quality First', description: 'Always route to the highest quality model available',
        strategy: 'quality', constraints: null, weights: JSON.stringify({ cost: 0.1, quality: 0.8, latency: 0.1 }),
        fallback_model: 'claude-sonnet-4-20250514', fallback_provider: 'anthropic', enabled: 1,
      },
      {
        id: 'route-balanced', name: 'Balanced', description: 'Balance between cost, quality and speed',
        strategy: 'balanced', constraints: null, weights: JSON.stringify({ cost: 0.33, quality: 0.34, latency: 0.33 }),
        fallback_model: 'gpt-4o', fallback_provider: 'openai', enabled: 1,
      },
    ];
    for (const r of policies) await this.createRoutingPolicy(r);
    }

    // Workflow definitions
    if (cnt('workflow_defs') === 0) {
    const workflows: Omit<WorkflowDefRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'wf-code-review', name: 'Code Review Pipeline', description: 'Automated code review with human approval gate',
        version: '1.0', entry_step_id: 'analyze',
        steps: JSON.stringify([
          { id: 'analyze', type: 'agent', name: 'Static Analysis', next: 'review' },
          { id: 'review', type: 'agent', name: 'AI Code Review', next: 'approve' },
          { id: 'approve', type: 'human', name: 'Human Approval', next: 'report' },
          { id: 'report', type: 'agent', name: 'Generate Report', next: null },
        ]),
        metadata: JSON.stringify({ category: 'engineering' }), enabled: 1,
      },
      {
        id: 'wf-content-pipeline', name: 'Content Generation', description: 'Draft, review, and publish content workflow',
        version: '1.0', entry_step_id: 'draft',
        steps: JSON.stringify([
          { id: 'draft', type: 'agent', name: 'Generate Draft', next: 'edit' },
          { id: 'edit', type: 'agent', name: 'Edit & Polish', next: 'approve' },
          { id: 'approve', type: 'human', name: 'Editorial Approval', next: null },
        ]),
        metadata: JSON.stringify({ category: 'content' }), enabled: 1,
      },
    ];
    for (const w of workflows) await this.createWorkflowDef(w);
    }

    // Tool configs
    if (cnt('tool_configs') === 0) {
    const tools: Omit<ToolConfigRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'tool-web-search', name: 'Web Search', description: 'Search the web for current information',
        category: 'retrieval', risk_level: 'low', requires_approval: 0, max_execution_ms: 10000, rate_limit_per_min: 30, enabled: 1,
      },
      {
        id: 'tool-code-exec', name: 'Code Execution', description: 'Execute code in a sandboxed environment',
        category: 'compute', risk_level: 'high', requires_approval: 1, max_execution_ms: 30000, rate_limit_per_min: 10, enabled: 1,
      },
      {
        id: 'tool-file-read', name: 'File Reader', description: 'Read files from allowed directories',
        category: 'filesystem', risk_level: 'medium', requires_approval: 0, max_execution_ms: 5000, rate_limit_per_min: 60, enabled: 1,
      },
      {
        id: 'tool-db-query', name: 'Database Query', description: 'Run read-only SQL queries against configured databases',
        category: 'data', risk_level: 'medium', requires_approval: 0, max_execution_ms: 15000, rate_limit_per_min: 20, enabled: 1,
      },
      {
        id: 'tool-api-call', name: 'API Caller', description: 'Make HTTP requests to whitelisted endpoints',
        category: 'integration', risk_level: 'medium', requires_approval: 0, max_execution_ms: 20000, rate_limit_per_min: 15, enabled: 1,
      },
    ];
    for (const t of tools) await this.createToolConfig(t);
    }

    // Workflow runs (sample completed and in-progress runs)
    if (cnt('workflow_runs') === 0) {
    const runs: Omit<WorkflowRunRow, 'completed_at'>[] = [
      {
        id: 'run-001', workflow_id: 'wf-code-review', status: 'completed',
        state: JSON.stringify({ currentStepId: 'report', variables: { repository: 'acme/api' }, history: [
          { stepId: 'analyze', status: 'completed', output: '3 issues found', startedAt: '2025-01-15T10:00:00Z', completedAt: '2025-01-15T10:00:05Z' },
          { stepId: 'review', status: 'completed', output: 'LGTM with minor notes', startedAt: '2025-01-15T10:00:05Z', completedAt: '2025-01-15T10:00:12Z' },
        ] }),
        input: JSON.stringify({ repository: 'acme/api', branch: 'feature/auth' }),
        error: null, started_at: '2025-01-15T10:00:00Z',
      },
      {
        id: 'run-002', workflow_id: 'wf-content-pipeline', status: 'paused',
        state: JSON.stringify({ currentStepId: 'approve', variables: { topic: 'AI Safety' }, history: [
          { stepId: 'draft', status: 'completed', output: 'Draft generated (1200 words)', startedAt: '2025-01-16T09:00:00Z', completedAt: '2025-01-16T09:00:30Z' },
          { stepId: 'edit', status: 'completed', output: 'Edited and polished', startedAt: '2025-01-16T09:00:30Z', completedAt: '2025-01-16T09:01:00Z' },
        ] }),
        input: JSON.stringify({ topic: 'AI Safety', audience: 'technical' }),
        error: null, started_at: '2025-01-16T09:00:00Z',
      },
    ];
    for (const r of runs) await this.createWorkflowRun(r);
    }

    // Guardrail evaluations (sample evaluations)
    if (cnt('guardrail_evals') === 0) {
    const evals: Omit<GuardrailEvalRow, 'created_at'>[] = [
      {
        id: 'geval-001', chat_id: null, message_id: null, stage: 'pre-execution',
        input_preview: 'Tell me about machine learning...',
        results: JSON.stringify([
          { decision: 'allow', guardrailId: 'guard-pii-redact', explanation: 'No PII detected' },
          { decision: 'allow', guardrailId: 'guard-token-limit', explanation: 'Within token limit' },
        ]),
        overall_decision: 'allow',
      },
      {
        id: 'geval-002', chat_id: null, message_id: null, stage: 'pre-execution',
        input_preview: 'My SSN is 123-45-6789...',
        results: JSON.stringify([
          { decision: 'deny', guardrailId: 'guard-pii-redact', explanation: 'SSN pattern detected' },
        ]),
        overall_decision: 'deny',
      },
    ];
    for (const e of evals) await this.createGuardrailEval(e);
    }

    // Human Task Policies
    if (cnt('human_task_policies') === 0) {
    const taskPolicies: Omit<HumanTaskPolicyRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'htp-high-risk-tool', name: 'High-Risk Tool Approval', description: 'Require human approval before executing high-risk tools (code execution, DB writes)',
        trigger: 'tool:high-risk', task_type: 'approval', default_priority: 'high', sla_hours: 1, auto_escalate_after_hours: 2,
        assignment_strategy: 'round-robin', assign_to: null, enabled: 1,
      },
      {
        id: 'htp-sensitive-data', name: 'Sensitive Data Review', description: 'Human review when agent accesses sensitive or PII data',
        trigger: 'data:sensitive', task_type: 'review', default_priority: 'urgent', sla_hours: 0.5, auto_escalate_after_hours: 1,
        assignment_strategy: 'role-based', assign_to: 'security-team', enabled: 1,
      },
      {
        id: 'htp-cost-threshold', name: 'Cost Threshold Approval', description: 'Require approval when estimated cost exceeds threshold',
        trigger: 'cost:threshold', task_type: 'approval', default_priority: 'normal', sla_hours: 4, auto_escalate_after_hours: 8,
        assignment_strategy: 'specific-user', assign_to: 'admin', enabled: 1,
      },
      {
        id: 'htp-workflow-gate', name: 'Workflow Gate Review', description: 'Human review gate at critical workflow checkpoints',
        trigger: 'workflow:gate', task_type: 'review', default_priority: 'normal', sla_hours: 24, auto_escalate_after_hours: 48,
        assignment_strategy: 'least-busy', assign_to: null, enabled: 1,
      },
    ];
    for (const tp of taskPolicies) await this.createHumanTaskPolicy(tp);
    }

    // Task Contracts
    if (cnt('task_contracts') === 0) {
    const contracts: Omit<TaskContractRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'tc-code-review', name: 'Code Review Contract', description: 'Contract for AI-assisted code review tasks',
        input_schema: JSON.stringify({ type: 'object', required: ['code', 'language'], properties: { code: { type: 'string' }, language: { type: 'string' }, context: { type: 'string' } } }),
        output_schema: JSON.stringify({ type: 'object', required: ['summary', 'issues'], properties: { summary: { type: 'string' }, issues: { type: 'array' }, score: { type: 'number' } } }),
        acceptance_criteria: JSON.stringify([
          { id: 'cr-has-summary', description: 'Output must include a summary', type: 'assertion', config: { field: 'summary', operator: 'exists' }, required: true, weight: 1 },
          { id: 'cr-has-issues', description: 'Output must include issues array', type: 'assertion', config: { field: 'issues', operator: 'exists' }, required: true, weight: 1 },
          { id: 'cr-score-range', description: 'Score must be between 0 and 10', type: 'assertion', config: { field: 'score', operator: 'gte', expected: 0 }, required: false, weight: 0.5 },
        ]),
        max_attempts: 3, timeout_ms: 60000,
        evidence_required: JSON.stringify(['text', 'metric']), min_confidence: 0.7, require_human_review: 0, enabled: 1,
      },
      {
        id: 'tc-content-gen', name: 'Content Generation Contract', description: 'Contract for AI content generation tasks',
        input_schema: JSON.stringify({ type: 'object', required: ['topic'], properties: { topic: { type: 'string' }, audience: { type: 'string' }, maxWords: { type: 'number' } } }),
        output_schema: JSON.stringify({ type: 'object', required: ['content', 'wordCount'], properties: { content: { type: 'string' }, wordCount: { type: 'number' }, readabilityScore: { type: 'number' } } }),
        acceptance_criteria: JSON.stringify([
          { id: 'cg-has-content', description: 'Output must include content', type: 'assertion', config: { field: 'content', operator: 'exists' }, required: true, weight: 1 },
          { id: 'cg-word-count', description: 'Must include word count', type: 'assertion', config: { field: 'wordCount', operator: 'gt', expected: 0 }, required: true, weight: 0.5 },
        ]),
        max_attempts: 2, timeout_ms: 120000,
        evidence_required: JSON.stringify(['text']), min_confidence: 0.8, require_human_review: 1, enabled: 1,
      },
      {
        id: 'tc-data-analysis', name: 'Data Analysis Contract', description: 'Contract for data analysis and reporting tasks',
        input_schema: JSON.stringify({ type: 'object', required: ['query'], properties: { query: { type: 'string' }, dataset: { type: 'string' } } }),
        output_schema: JSON.stringify({ type: 'object', required: ['analysis', 'confidence'], properties: { analysis: { type: 'string' }, confidence: { type: 'number' }, charts: { type: 'array' } } }),
        acceptance_criteria: JSON.stringify([
          { id: 'da-has-analysis', description: 'Output must include analysis text', type: 'assertion', config: { field: 'analysis', operator: 'exists' }, required: true, weight: 1 },
          { id: 'da-confidence', description: 'Confidence must be at least 0.5', type: 'assertion', config: { field: 'confidence', operator: 'gte', expected: 0.5 }, required: true, weight: 1 },
        ]),
        max_attempts: 3, timeout_ms: 180000,
        evidence_required: JSON.stringify(['text', 'metric', 'trace']), min_confidence: 0.6, require_human_review: 0, enabled: 1,
      },
    ];
    for (const c of contracts) await this.createTaskContract(c);
    }

    // Cache Policies
    if (cnt('cache_policies') === 0) {
    const cachePolicies: Omit<CachePolicyRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'cp-global-default', name: 'Global Default Cache', description: 'Default caching policy for all responses — 5 minute TTL',
        scope: 'global', ttl_ms: 300000, max_entries: 1000,
        bypass_patterns: JSON.stringify(['password', 'secret', 'token', 'key']),
        invalidate_on: JSON.stringify(['model_change', 'prompt_update']),
        enabled: 1,
      },
      {
        id: 'cp-session-short', name: 'Session Short-Lived', description: 'Short TTL cache scoped to individual sessions',
        scope: 'session', ttl_ms: 60000, max_entries: 100,
        bypass_patterns: null, invalidate_on: JSON.stringify(['session_end']),
        enabled: 1,
      },
      {
        id: 'cp-semantic-lookup', name: 'Semantic Query Cache', description: 'Cache semantically similar queries to avoid redundant LLM calls',
        scope: 'global', ttl_ms: 600000, max_entries: 500,
        bypass_patterns: JSON.stringify(['real-time', 'current date', 'current time']),
        invalidate_on: JSON.stringify(['knowledge_update']),
        enabled: 1,
      },
      {
        id: 'cp-user-personalised', name: 'User Personalised Cache', description: 'Per-user cache that respects personalisation context',
        scope: 'user', ttl_ms: 120000, max_entries: 200,
        bypass_patterns: null, invalidate_on: JSON.stringify(['preference_change']),
        enabled: 0,
      },
    ];
    for (const cp of cachePolicies) await this.createCachePolicy(cp);
    }

    // Identity Rules
    if (cnt('identity_rules') === 0) {
    const identityRules: Omit<IdentityRuleRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'ident-admin-all', name: 'Admin Full Access', description: 'Admins have unrestricted access to all resources',
        resource: '*', action: '*', roles: JSON.stringify(['admin']), scopes: null,
        result: 'allow', priority: 100, enabled: 1,
      },
      {
        id: 'ident-user-chat', name: 'User Chat Access', description: 'Regular users can read and write in chat',
        resource: 'chat:*', action: '*', roles: JSON.stringify(['user', 'agent']), scopes: JSON.stringify(['chat']),
        result: 'allow', priority: 50, enabled: 1,
      },
      {
        id: 'ident-agent-tools', name: 'Agent Tool Access', description: 'AI agents can use tools within defined scopes',
        resource: 'tools:*', action: 'execute', roles: JSON.stringify(['agent']), scopes: JSON.stringify(['tools']),
        result: 'allow', priority: 50, enabled: 1,
      },
      {
        id: 'ident-deny-admin-panel', name: 'Deny Non-Admin Panel', description: 'Non-admins cannot access admin settings',
        resource: 'admin:*', action: '*', roles: null, scopes: null,
        result: 'deny', priority: 10, enabled: 1,
      },
      {
        id: 'ident-sensitive-challenge', name: 'Sensitive Data Challenge', description: 'Challenge access to sensitive data requiring additional verification',
        resource: 'data:sensitive', action: 'read', roles: null, scopes: null,
        result: 'challenge', priority: 60, enabled: 1,
      },
    ];
    for (const ir of identityRules) await this.createIdentityRule(ir);
    }

    // Memory Governance
    if (cnt('memory_governance') === 0) {
    const memGov: Omit<MemoryGovernanceRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'mgov-pii-block', name: 'Block PII in Memory', description: 'Prevent storage of messages containing PII patterns',
        memory_types: JSON.stringify(['conversation', 'semantic']),
        tenant_id: null,
        block_patterns: JSON.stringify(['\\b\\d{3}-\\d{2}-\\d{4}\\b', '\\b\\d{16}\\b']),
        redact_patterns: JSON.stringify(['[\\w.+-]+@[\\w-]+\\.[\\w.]+', '\\b\\d{3}[-.]?\\d{3}[-.]?\\d{4}\\b']),
        max_age: null, max_entries: null, enabled: 1,
      },
      {
        id: 'mgov-conversation-retention', name: 'Conversation Retention', description: 'Limit conversation memory to 30 days with max 10000 entries',
        memory_types: JSON.stringify(['conversation']),
        tenant_id: null,
        block_patterns: null, redact_patterns: null,
        max_age: 'P30D', max_entries: 10000, enabled: 1,
      },
      {
        id: 'mgov-semantic-retention', name: 'Semantic Memory Retention', description: 'Semantic facts retained for 90 days with a cap of 5000 entries',
        memory_types: JSON.stringify(['semantic']),
        tenant_id: null,
        block_patterns: null, redact_patterns: null,
        max_age: 'P90D', max_entries: 5000, enabled: 1,
      },
      {
        id: 'mgov-entity-no-secrets', name: 'No Secrets in Entity Memory', description: 'Block secrets and API keys from being stored as entity facts',
        memory_types: JSON.stringify(['entity']),
        tenant_id: null,
        block_patterns: JSON.stringify(['api[_\\s-]?key', 'secret[_\\s-]?key', 'password', 'bearer\\s+\\S+']),
        redact_patterns: null,
        max_age: null, max_entries: null, enabled: 1,
      },
    ];
    for (const g of memGov) await this.createMemoryGovernance(g);
    }

    // Search Providers
    if (cnt('search_providers') === 0) {
    const searchProviders: Omit<SearchProviderRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'sp-duckduckgo', name: 'DuckDuckGo', description: 'Free web search via DuckDuckGo Instant Answer API — no API key required',
        provider_type: 'duckduckgo', api_key: null, base_url: null, priority: 10,
        options: JSON.stringify({ safesearch: 'moderate', region: 'wt-wt' }), enabled: 1,
      },
      {
        id: 'sp-brave', name: 'Brave Search', description: 'Privacy-focused web search with Brave Search API',
        provider_type: 'brave', api_key: '', base_url: null, priority: 20,
        options: JSON.stringify({ count: 10, freshness: 'none' }), enabled: 0,
      },
      {
        id: 'sp-tavily', name: 'Tavily AI Search', description: 'AI-optimised search engine designed for LLM applications',
        provider_type: 'tavily', api_key: '', base_url: null, priority: 30,
        options: JSON.stringify({ search_depth: 'basic', include_answer: true }), enabled: 0,
      },
      {
        id: 'sp-google-pse', name: 'Google Custom Search', description: 'Google Programmable Search Engine for custom search experiences',
        provider_type: 'google', api_key: '', base_url: null, priority: 15,
        options: JSON.stringify({ cx: '', num: 10 }), enabled: 0,
      },
      {
        id: 'sp-serper', name: 'Serper (Google SERP)', description: 'Fast Google search results via Serper API',
        provider_type: 'serper', api_key: '', base_url: null, priority: 25,
        options: JSON.stringify({ gl: 'us', hl: 'en', num: 10 }), enabled: 0,
      },
    ];
    for (const sp of searchProviders) await this.createSearchProvider(sp);
    }

    // HTTP Endpoints
    if (cnt('http_endpoints') === 0) {
    const httpEndpoints: Omit<HttpEndpointRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'he-jsonplaceholder', name: 'JSONPlaceholder Posts', description: 'Sample REST endpoint for testing — free JSON API',
        url: 'https://jsonplaceholder.typicode.com/posts', method: 'GET',
        auth_type: null, auth_config: null, headers: null,
        body_template: null, response_transform: '$[0:5]', retry_count: 2, rate_limit_rpm: 60, enabled: 1,
      },
      {
        id: 'he-weather', name: 'Open-Meteo Weather', description: 'Free weather API — no key needed. Returns current weather for a location.',
        url: 'https://api.open-meteo.com/v1/forecast?latitude={{lat}}&longitude={{lon}}&current_weather=true', method: 'GET',
        auth_type: null, auth_config: null, headers: null,
        body_template: null, response_transform: '$.current_weather', retry_count: 2, rate_limit_rpm: 30, enabled: 1,
      },
      {
        id: 'he-ip-info', name: 'IP Info', description: 'Get geolocation data from an IP address',
        url: 'https://ipapi.co/{{ip}}/json/', method: 'GET',
        auth_type: null, auth_config: null, headers: null,
        body_template: null, response_transform: null, retry_count: 1, rate_limit_rpm: 30, enabled: 1,
      },
    ];
    for (const he of httpEndpoints) await this.createHttpEndpoint(he);
    }

    // Social Accounts
    if (cnt('social_accounts') === 0) {
    const socialAccounts: Omit<SocialAccountRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'sa-slack-default', name: 'Slack Workspace', description: 'Default Slack workspace integration for team messaging',
        platform: 'slack', api_key: '', api_secret: null, base_url: null,
        options: JSON.stringify({ default_channel: '#general' }), enabled: 0,
      },
      {
        id: 'sa-discord-default', name: 'Discord Server', description: 'Discord server bot integration',
        platform: 'discord', api_key: '', api_secret: null, base_url: null,
        options: JSON.stringify({ guild_id: '' }), enabled: 0,
      },
      {
        id: 'sa-github-default', name: 'GitHub', description: 'GitHub integration for repository and issue management',
        platform: 'github', api_key: '', api_secret: null, base_url: null,
        options: JSON.stringify({ default_owner: '', default_repo: '' }), enabled: 0,
      },
    ];
    for (const sa of socialAccounts) await this.createSocialAccount(sa);
    }

    // Enterprise Connectors
    if (cnt('enterprise_connectors') === 0) {
    const connectors: Omit<EnterpriseConnectorRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'ec-jira', name: 'Jira', description: 'Atlassian Jira for issue tracking and project management',
        connector_type: 'jira', base_url: '', auth_type: 'basic',
        auth_config: JSON.stringify({ username: '', token: '' }),
        options: JSON.stringify({ default_project: '' }), enabled: 0,
      },
      {
        id: 'ec-confluence', name: 'Confluence', description: 'Atlassian Confluence for team documentation and knowledge base',
        connector_type: 'confluence', base_url: '', auth_type: 'basic',
        auth_config: JSON.stringify({ username: '', token: '' }),
        options: JSON.stringify({ default_space: '' }), enabled: 0,
      },
      {
        id: 'ec-salesforce', name: 'Salesforce', description: 'Salesforce CRM integration for customer data and opportunities',
        connector_type: 'salesforce', base_url: '', auth_type: 'oauth2',
        auth_config: JSON.stringify({ client_id: '', client_secret: '', token_url: '' }),
        options: null, enabled: 0,
      },
      {
        id: 'ec-notion', name: 'Notion', description: 'Notion workspace integration for docs and databases',
        connector_type: 'notion', base_url: null, auth_type: 'bearer',
        auth_config: JSON.stringify({ token: '' }),
        options: null, enabled: 0,
      },
    ];
    for (const ec of connectors) await this.createEnterpriseConnector(ec);
    }

    // Tool Registry
    if (cnt('tool_registry') === 0) {
    const toolReg: Omit<ToolRegistryRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'tr-search', name: 'Web Search Tools', description: 'Search provider toolkit with multi-engine routing',
        package_name: '@weaveintel/tools-search', version: '1.0.0', category: 'search', risk_level: 'low',
        tags: JSON.stringify(['search', 'web', 'retrieval']),
        config: JSON.stringify({ defaultProvider: 'duckduckgo', maxResults: 10 }),
        requires_approval: 0, max_execution_ms: 15000, rate_limit_per_min: 30, enabled: 1,
      },
      {
        id: 'tr-http', name: 'HTTP Endpoint Tools', description: 'Dynamic HTTP request toolkit with auth, retry, and transforms',
        package_name: '@weaveintel/tools-http', version: '1.0.0', category: 'integration', risk_level: 'medium',
        tags: JSON.stringify(['http', 'api', 'rest']),
        config: JSON.stringify({ defaultRetries: 2, defaultTimeout: 10000 }),
        requires_approval: 0, max_execution_ms: 20000, rate_limit_per_min: 30, enabled: 1,
      },
      {
        id: 'tr-browser', name: 'Browser & Scraping Tools', description: 'Web page fetching, content extraction, and readability tools',
        package_name: '@weaveintel/tools-browser', version: '1.0.0', category: 'browser', risk_level: 'low',
        tags: JSON.stringify(['browser', 'scrape', 'extract', 'readability']),
        config: JSON.stringify({ defaultTimeout: 10000, maxBodySize: 1048576 }),
        requires_approval: 0, max_execution_ms: 15000, rate_limit_per_min: 20, enabled: 1,
      },
      {
        id: 'tr-social', name: 'Social Platform Tools', description: 'Slack, Discord, and GitHub integrations',
        package_name: '@weaveintel/tools-social', version: '1.0.0', category: 'social', risk_level: 'medium',
        tags: JSON.stringify(['slack', 'discord', 'github', 'social']),
        config: null,
        requires_approval: 0, max_execution_ms: 10000, rate_limit_per_min: 20, enabled: 1,
      },
      {
        id: 'tr-enterprise', name: 'Enterprise Connector Tools', description: 'Jira, Confluence, Salesforce, and Notion integrations',
        package_name: '@weaveintel/tools-enterprise', version: '1.0.0', category: 'enterprise', risk_level: 'medium',
        tags: JSON.stringify(['jira', 'confluence', 'salesforce', 'notion', 'enterprise']),
        config: null,
        requires_approval: 0, max_execution_ms: 20000, rate_limit_per_min: 15, enabled: 1,
      },
    ];
    for (const tr of toolReg) await this.createToolRegistryEntry(tr);
    }
  }
}

// ─── Factory ─────────────────────────────────────────────────

export interface DatabaseConfig {
  type: 'sqlite' | 'custom';
  /** SQLite file path (default: './geneweave.db') */
  path?: string;
  /** Provide your own adapter for Postgres, MySQL, Mongo, etc. */
  adapter?: DatabaseAdapter;
}

export async function createDatabaseAdapter(config: DatabaseConfig): Promise<DatabaseAdapter> {
  if (config.type === 'custom') {
    if (!config.adapter) throw new Error('Custom database type requires an adapter instance');
    await config.adapter.initialize();
    return config.adapter;
  }
  const adapter = new SQLiteAdapter(config.path ?? './geneweave.db');
  await adapter.initialize();
  return adapter;
}
