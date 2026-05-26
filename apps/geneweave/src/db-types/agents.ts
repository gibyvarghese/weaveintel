/** Worker agent, supervisor agent, idempotency, and OAuth flow state row types. */

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
