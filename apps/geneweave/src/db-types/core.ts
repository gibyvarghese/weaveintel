/** Core user, session, chat, metrics, and temporal row types. */

export interface UserRow {
  id: string;
  email: string;
  name: string;
  persona: string;
  tenant_id: string | null;
  password_hash: string;
  created_at: string;
  /**
   * Phase 8 blind index — `HMAC-SHA-256(BIK, "users|email|<email>")` truncated
   * to 24 hex chars. Tenant-scoped, populated only when the resolved tenant
   * has `blind_index_enabled=true`. Lookup path: `WHERE email_bidx = ?`.
   */
  email_bidx?: string | null;
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

export interface MetricsSummary {
  total_tokens: number;
  total_cost: number;
  avg_latency_ms: number;
  total_messages: number;
  total_chats: number;
  by_model: Array<{ model: string; provider: string; tokens: number; cost: number; count: number }>;
  by_day: Array<{ date: string; tokens: number; cost: number; count: number }>;
}
