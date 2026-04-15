/**
 * @weaveintel/geneweave — SQLite database adapter
 *
 * Concrete DatabaseAdapter backed by better-sqlite3.
 */

import { randomUUID } from 'node:crypto';
import { SCHEMA_SQL } from './db-schema.js';
import type {
  DatabaseAdapter, DatabaseConfig,
  UserRow, SessionRow, ChatRow, MessageRow,
  MetricRow, EvalRow, ChatSettingsRow, TraceRow, UserPreferencesRow,
  TemporalTimerRow, TemporalStopwatchRow, TemporalReminderRow,
  PromptRow, GuardrailRow, RoutingPolicyRow, WorkflowDefRow,
  ToolConfigRow, HumanTaskPolicyRow, TaskContractRow, CachePolicyRow,
  IdentityRuleRow, MemoryGovernanceRow, SearchProviderRow, HttpEndpointRow,
  MemoryExtractionRuleRow,
  SocialAccountRow, EnterpriseConnectorRow, ToolRegistryRow, ReplayScenarioRow,
  TriggerDefinitionRow, TenantConfigRow, SandboxPolicyRow, ExtractionPipelineRow,
  ArtifactPolicyRow, ReliabilityPolicyRow,
  CollaborationSessionRow, ComplianceRuleRow, GraphConfigRow, PluginConfigRow,
  ScaffoldTemplateRow, RecipeConfigRow, WidgetConfigRow, ValidationRuleRow,
  SemanticMemoryRow, EntityMemoryRow,
  MemoryExtractionEventRow,
  MetricsSummary, WorkflowRunRow, GuardrailEvalRow, ModelPricingRow,
  WebsiteCredentialRow,
} from './db-types.js';

export class SQLiteAdapter implements DatabaseAdapter {
  private db: import('better-sqlite3').Database | null = null;
  constructor(private readonly path: string) {}

  async initialize(): Promise<void> {
    const BetterSqlite3 = (await import('better-sqlite3')).default;
    this.db = new BetterSqlite3(this.path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA_SQL);
    // Lightweight migration for existing databases created before timezone support.
    try {
      this.db.exec('ALTER TABLE chat_settings ADD COLUMN timezone TEXT');
    } catch {
      // Ignore when the column already exists.
    }
    try {
      this.db.exec("ALTER TABLE user_preferences ADD COLUMN theme TEXT NOT NULL DEFAULT 'light'");
    } catch {
      // Ignore when the column already exists.
    }
    // Migrations for semantic and entity memory tables (added later, safe to run on new or old DBs)
    try {
      this.db.exec(`CREATE TABLE IF NOT EXISTS semantic_memory (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
        tenant_id TEXT,
        content TEXT NOT NULL,
        memory_type TEXT NOT NULL DEFAULT 'semantic',
        source TEXT NOT NULL DEFAULT 'assistant',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
    } catch { /* ignore */ }
    try {
      this.db.exec(`CREATE TABLE IF NOT EXISTS entity_memory (
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
      )`);
    } catch { /* ignore */ }
    try {
      this.db.exec('ALTER TABLE entity_memory ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5');
    } catch { /* ignore */ }
    try {
      this.db.exec("ALTER TABLE entity_memory ADD COLUMN source TEXT NOT NULL DEFAULT 'regex'");
    } catch { /* ignore */ }
    try {
      this.db.exec(`CREATE TABLE IF NOT EXISTS memory_extraction_events (
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
      )`);
    } catch { /* ignore */ }
    // Migration: website_credentials table for browser auth vault
    try {
      this.db.exec(`CREATE TABLE IF NOT EXISTS website_credentials (
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
      )`);
    } catch { /* ignore */ }
    // Migration: sso_linked_accounts table for SSO pass-through sessions
    try {
      this.db.exec(`CREATE TABLE IF NOT EXISTS sso_linked_accounts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        identity_provider TEXT NOT NULL,
        email TEXT,
        session_encrypted TEXT NOT NULL,
        encryption_iv TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        linked_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(user_id, identity_provider)
      )`);
    } catch { /* ignore */ }
    // Migration: oauth_linked_accounts table for OAuth provider identity linking
    try {
      this.db.exec(`CREATE TABLE IF NOT EXISTS oauth_linked_accounts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        provider_user_id TEXT NOT NULL,
        email TEXT NOT NULL,
        name TEXT NOT NULL,
        picture_url TEXT,
        linked_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT,
        UNIQUE(user_id, provider)
      )`);
    } catch { /* ignore */ }
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

  // ── OAuth Linked Accounts ──────────────────────────────────

  async createOAuthLinkedAccount(account: Omit<import('./db-types.js').OAuthLinkedAccountRow, 'linked_at'>): Promise<void> {
    this.d.prepare(`
      INSERT OR REPLACE INTO oauth_linked_accounts (id, user_id, provider, provider_user_id, email, name, picture_url, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(account.id, account.user_id, account.provider, account.provider_user_id, account.email, account.name, account.picture_url ?? null, account.last_used_at ?? null);
  }

  async getOAuthLinkedAccount(userId: string, provider: string): Promise<import('./db-types.js').OAuthLinkedAccountRow | null> {
    return (this.d.prepare('SELECT * FROM oauth_linked_accounts WHERE user_id = ? AND provider = ?').get(userId, provider) as import('./db-types.js').OAuthLinkedAccountRow | undefined) ?? null;
  }

  async getOAuthLinkedAccountByProviderUserId(provider: string, providerUserId: string): Promise<import('./db-types.js').OAuthLinkedAccountRow | null> {
    return (this.d.prepare('SELECT * FROM oauth_linked_accounts WHERE provider = ? AND provider_user_id = ?').get(provider, providerUserId) as import('./db-types.js').OAuthLinkedAccountRow | undefined) ?? null;
  }

  async listOAuthLinkedAccounts(userId: string): Promise<import('./db-types.js').OAuthLinkedAccountRow[]> {
    return this.d.prepare('SELECT * FROM oauth_linked_accounts WHERE user_id = ? ORDER BY linked_at DESC').all(userId) as import('./db-types.js').OAuthLinkedAccountRow[];
  }

  async updateOAuthAccountLastUsed(userId: string, provider: string): Promise<void> {
    this.d.prepare("UPDATE oauth_linked_accounts SET last_used_at = datetime('now') WHERE user_id = ? AND provider = ?").run(userId, provider);
  }

  async deleteOAuthLinkedAccount(userId: string, provider: string): Promise<void> {
    this.d.prepare('DELETE FROM oauth_linked_accounts WHERE user_id = ? AND provider = ?').run(userId, provider);
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

  // ── User Preferences ──────────────────────────────────────

  async getUserPreferences(userId: string): Promise<UserPreferencesRow | null> {
    return (this.d.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(userId) as UserPreferencesRow | undefined) ?? null;
  }

  async saveUserPreferences(userId: string, defaultMode: string, theme: string): Promise<void> {
    this.d.prepare(
      `INSERT INTO user_preferences (user_id, default_mode, theme)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         default_mode=excluded.default_mode,
         theme=excluded.theme,
         updated_at=datetime('now')`,
    ).run(userId, defaultMode, theme);
  }

  // ── Chat Settings ──────────────────────────────────────────

  async getChatSettings(chatId: string): Promise<ChatSettingsRow | null> {
    return (this.d.prepare('SELECT * FROM chat_settings WHERE chat_id = ?').get(chatId) as ChatSettingsRow | undefined) ?? null;
  }

  async saveChatSettings(s: {
    chatId: string; mode: string; systemPrompt?: string;
    timezone?: string;
    enabledTools?: string; redactionEnabled?: boolean;
    redactionPatterns?: string; workers?: string;
  }): Promise<void> {
    this.d.prepare(
      `INSERT INTO chat_settings (chat_id, mode, system_prompt, timezone, enabled_tools, redaction_enabled, redaction_patterns, workers)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
         mode=excluded.mode, system_prompt=excluded.system_prompt, timezone=excluded.timezone,
         enabled_tools=excluded.enabled_tools, redaction_enabled=excluded.redaction_enabled,
         redaction_patterns=excluded.redaction_patterns, workers=excluded.workers,
         updated_at=datetime('now')`,
    ).run(
      s.chatId, s.mode, s.systemPrompt ?? null,
      s.timezone ?? null,
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

  // ── Temporal tools persistence ────────────────────────────

  async upsertTemporalTimer(row: {
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
  }): Promise<void> {
    this.d.prepare(
      `INSERT INTO temporal_timers
       (id, scope_id, label, duration_ms, state, created_at, started_at, paused_at, resumed_at, stopped_at, elapsed_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope_id, id) DO UPDATE SET
         label=excluded.label,
         duration_ms=excluded.duration_ms,
         state=excluded.state,
         created_at=excluded.created_at,
         started_at=excluded.started_at,
         paused_at=excluded.paused_at,
         resumed_at=excluded.resumed_at,
         stopped_at=excluded.stopped_at,
         elapsed_ms=excluded.elapsed_ms,
         updated_at=datetime('now')`,
    ).run(
      row.id,
      row.scopeId,
      row.label ?? null,
      row.durationMs ?? null,
      row.state,
      row.createdAt,
      row.startedAt ?? null,
      row.pausedAt ?? null,
      row.resumedAt ?? null,
      row.stoppedAt ?? null,
      row.elapsedMs,
    );
  }

  async getTemporalTimer(scopeId: string, id: string): Promise<TemporalTimerRow | null> {
    return (this.d.prepare('SELECT * FROM temporal_timers WHERE scope_id = ? AND id = ?').get(scopeId, id) as TemporalTimerRow | undefined) ?? null;
  }

  async listTemporalTimers(scopeId: string): Promise<TemporalTimerRow[]> {
    return this.d.prepare('SELECT * FROM temporal_timers WHERE scope_id = ? ORDER BY created_at DESC').all(scopeId) as TemporalTimerRow[];
  }

  async upsertTemporalStopwatch(row: {
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
  }): Promise<void> {
    this.d.prepare(
      `INSERT INTO temporal_stopwatches
       (id, scope_id, label, state, created_at, started_at, paused_at, resumed_at, stopped_at, elapsed_ms, laps_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope_id, id) DO UPDATE SET
         label=excluded.label,
         state=excluded.state,
         created_at=excluded.created_at,
         started_at=excluded.started_at,
         paused_at=excluded.paused_at,
         resumed_at=excluded.resumed_at,
         stopped_at=excluded.stopped_at,
         elapsed_ms=excluded.elapsed_ms,
         laps_json=excluded.laps_json,
         updated_at=datetime('now')`,
    ).run(
      row.id,
      row.scopeId,
      row.label ?? null,
      row.state,
      row.createdAt,
      row.startedAt ?? null,
      row.pausedAt ?? null,
      row.resumedAt ?? null,
      row.stoppedAt ?? null,
      row.elapsedMs,
      row.lapsJson,
    );
  }

  async getTemporalStopwatch(scopeId: string, id: string): Promise<TemporalStopwatchRow | null> {
    return (this.d.prepare('SELECT * FROM temporal_stopwatches WHERE scope_id = ? AND id = ?').get(scopeId, id) as TemporalStopwatchRow | undefined) ?? null;
  }

  async listTemporalStopwatches(scopeId: string): Promise<TemporalStopwatchRow[]> {
    return this.d.prepare('SELECT * FROM temporal_stopwatches WHERE scope_id = ? ORDER BY created_at DESC').all(scopeId) as TemporalStopwatchRow[];
  }

  async upsertTemporalReminder(row: {
    id: string;
    scopeId: string;
    text: string;
    dueAt: string;
    timezone: string;
    status: string;
    createdAt: string;
    cancelledAt?: string | null;
  }): Promise<void> {
    this.d.prepare(
      `INSERT INTO temporal_reminders
       (id, scope_id, text, due_at, timezone, status, created_at, cancelled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope_id, id) DO UPDATE SET
         text=excluded.text,
         due_at=excluded.due_at,
         timezone=excluded.timezone,
         status=excluded.status,
         created_at=excluded.created_at,
         cancelled_at=excluded.cancelled_at,
         updated_at=datetime('now')`,
    ).run(
      row.id,
      row.scopeId,
      row.text,
      row.dueAt,
      row.timezone,
      row.status,
      row.createdAt,
      row.cancelledAt ?? null,
    );
  }

  async getTemporalReminder(scopeId: string, id: string): Promise<TemporalReminderRow | null> {
    return (this.d.prepare('SELECT * FROM temporal_reminders WHERE scope_id = ? AND id = ?').get(scopeId, id) as TemporalReminderRow | undefined) ?? null;
  }

  async listTemporalReminders(scopeId: string): Promise<TemporalReminderRow[]> {
    return this.d.prepare('SELECT * FROM temporal_reminders WHERE scope_id = ? ORDER BY due_at ASC').all(scopeId) as TemporalReminderRow[];
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

  // ─── Admin: Model Pricing ──────────────────────────────────

  async createModelPricing(p: Omit<ModelPricingRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO model_pricing (id, model_id, provider, display_name, input_cost_per_1m, output_cost_per_1m, quality_score, source, last_synced_at, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.model_id, p.provider, p.display_name ?? null, p.input_cost_per_1m, p.output_cost_per_1m, p.quality_score, p.source, p.last_synced_at ?? null, p.enabled);
  }

  async getModelPricing(id: string): Promise<ModelPricingRow | null> {
    return (this.d.prepare('SELECT * FROM model_pricing WHERE id = ?').get(id) as ModelPricingRow) ?? null;
  }

  async listModelPricing(): Promise<ModelPricingRow[]> {
    return this.d.prepare('SELECT * FROM model_pricing ORDER BY provider ASC, model_id ASC').all() as ModelPricingRow[];
  }

  async updateModelPricing(id: string, fields: Partial<Omit<ModelPricingRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE model_pricing SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteModelPricing(id: string): Promise<void> {
    this.d.prepare('DELETE FROM model_pricing WHERE id = ?').run(id);
  }

  async upsertModelPricing(p: Omit<ModelPricingRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO model_pricing (id, model_id, provider, display_name, input_cost_per_1m, output_cost_per_1m, quality_score, source, last_synced_at, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(model_id, provider) DO UPDATE SET
         display_name = excluded.display_name,
         input_cost_per_1m = excluded.input_cost_per_1m,
         output_cost_per_1m = excluded.output_cost_per_1m,
         quality_score = excluded.quality_score,
         source = excluded.source,
         last_synced_at = excluded.last_synced_at,
         updated_at = datetime('now')`,
    ).run(p.id, p.model_id, p.provider, p.display_name ?? null, p.input_cost_per_1m, p.output_cost_per_1m, p.quality_score, p.source, p.last_synced_at ?? null, p.enabled);
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

  // ─── Admin: Memory Extraction Rules ───────────────────────

  async createMemoryExtractionRule(r: Omit<MemoryExtractionRuleRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO memory_extraction_rules (id, name, description, rule_type, entity_type, pattern, flags, facts_template, priority, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      r.id,
      r.name,
      r.description ?? null,
      r.rule_type,
      r.entity_type ?? null,
      r.pattern,
      r.flags ?? null,
      r.facts_template ?? null,
      r.priority,
      r.enabled,
    );
  }

  async getMemoryExtractionRule(id: string): Promise<MemoryExtractionRuleRow | null> {
    return (this.d.prepare('SELECT * FROM memory_extraction_rules WHERE id = ?').get(id) as MemoryExtractionRuleRow | undefined) ?? null;
  }

  async listMemoryExtractionRules(ruleType?: string): Promise<MemoryExtractionRuleRow[]> {
    if (ruleType) {
      return this.d.prepare('SELECT * FROM memory_extraction_rules WHERE rule_type = ? ORDER BY priority DESC, name ASC').all(ruleType) as MemoryExtractionRuleRow[];
    }
    return this.d.prepare('SELECT * FROM memory_extraction_rules ORDER BY rule_type ASC, priority DESC, name ASC').all() as MemoryExtractionRuleRow[];
  }

  async updateMemoryExtractionRule(id: string, fields: Partial<Omit<MemoryExtractionRuleRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE memory_extraction_rules SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteMemoryExtractionRule(id: string): Promise<void> {
    this.d.prepare('DELETE FROM memory_extraction_rules WHERE id = ?').run(id);
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
      `INSERT INTO social_accounts (id, name, description, platform, api_key, api_secret, access_token, refresh_token, token_expires_at, oauth_state, status, base_url, options, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(a.id, a.name, a.description ?? null, a.platform, a.api_key ?? null, a.api_secret ?? null, a.access_token ?? null, a.refresh_token ?? null, a.token_expires_at ?? null, a.oauth_state ?? null, a.status ?? 'disconnected', a.base_url ?? null, a.options ?? null, a.enabled);
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
      `INSERT INTO enterprise_connectors (id, name, description, connector_type, base_url, auth_type, auth_config, access_token, refresh_token, token_expires_at, oauth_state, status, options, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(c.id, c.name, c.description ?? null, c.connector_type, c.base_url ?? null, c.auth_type ?? null, c.auth_config ?? null, c.access_token ?? null, c.refresh_token ?? null, c.token_expires_at ?? null, c.oauth_state ?? null, c.status ?? 'disconnected', c.options ?? null, c.enabled);
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

  // ─── Admin: Replay Scenarios ─────────────────────────────────

  async createReplayScenario(s: Omit<ReplayScenarioRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO replay_scenarios (id, name, description, golden_prompt, golden_response, model, provider, tags, acceptance_criteria, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(s.id, s.name, s.description ?? null, s.golden_prompt, s.golden_response, s.model ?? null, s.provider ?? null, s.tags ?? null, s.acceptance_criteria ?? null, s.enabled);
  }

  async getReplayScenario(id: string): Promise<ReplayScenarioRow | null> {
    return (this.d.prepare('SELECT * FROM replay_scenarios WHERE id = ?').get(id) as ReplayScenarioRow) ?? null;
  }

  async listReplayScenarios(): Promise<ReplayScenarioRow[]> {
    return this.d.prepare('SELECT * FROM replay_scenarios ORDER BY name ASC').all() as ReplayScenarioRow[];
  }

  async updateReplayScenario(id: string, fields: Partial<Omit<ReplayScenarioRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE replay_scenarios SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteReplayScenario(id: string): Promise<void> {
    this.d.prepare('DELETE FROM replay_scenarios WHERE id = ?').run(id);
  }

  // ─── Admin: Trigger Definitions ──────────────────────────────

  async createTriggerDefinition(t: Omit<TriggerDefinitionRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO trigger_definitions (id, name, description, trigger_type, expression, config, target_workflow, status, last_fired_at, fire_count, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(t.id, t.name, t.description ?? null, t.trigger_type, t.expression ?? null, t.config ?? null, t.target_workflow ?? null, t.status, t.last_fired_at ?? null, t.fire_count, t.enabled);
  }

  async getTriggerDefinition(id: string): Promise<TriggerDefinitionRow | null> {
    return (this.d.prepare('SELECT * FROM trigger_definitions WHERE id = ?').get(id) as TriggerDefinitionRow) ?? null;
  }

  async listTriggerDefinitions(): Promise<TriggerDefinitionRow[]> {
    return this.d.prepare('SELECT * FROM trigger_definitions ORDER BY name ASC').all() as TriggerDefinitionRow[];
  }

  async updateTriggerDefinition(id: string, fields: Partial<Omit<TriggerDefinitionRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE trigger_definitions SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteTriggerDefinition(id: string): Promise<void> {
    this.d.prepare('DELETE FROM trigger_definitions WHERE id = ?').run(id);
  }

  // ─── Admin: Tenant Configs ───────────────────────────────────

  async createTenantConfig(c: Omit<TenantConfigRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO tenant_configs (id, name, description, tenant_id, scope, allowed_models, denied_models, allowed_tools, max_tokens_daily, max_cost_daily, max_tokens_monthly, max_cost_monthly, features, config_overrides, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(c.id, c.name, c.description ?? null, c.tenant_id, c.scope, c.allowed_models ?? null, c.denied_models ?? null, c.allowed_tools ?? null, c.max_tokens_daily ?? null, c.max_cost_daily ?? null, c.max_tokens_monthly ?? null, c.max_cost_monthly ?? null, c.features ?? null, c.config_overrides ?? null, c.enabled);
  }

  async getTenantConfig(id: string): Promise<TenantConfigRow | null> {
    return (this.d.prepare('SELECT * FROM tenant_configs WHERE id = ?').get(id) as TenantConfigRow) ?? null;
  }

  async listTenantConfigs(): Promise<TenantConfigRow[]> {
    return this.d.prepare('SELECT * FROM tenant_configs ORDER BY tenant_id ASC, name ASC').all() as TenantConfigRow[];
  }

  async updateTenantConfig(id: string, fields: Partial<Omit<TenantConfigRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE tenant_configs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteTenantConfig(id: string): Promise<void> {
    this.d.prepare('DELETE FROM tenant_configs WHERE id = ?').run(id);
  }

  // ─── Admin: Sandbox Policies ─────────────────────────────────

  async createSandboxPolicy(p: Omit<SandboxPolicyRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO sandbox_policies (id, name, description, max_cpu_ms, max_memory_mb, max_duration_ms, max_output_bytes, allowed_modules, denied_modules, network_access, filesystem_access, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.name, p.description ?? null, p.max_cpu_ms ?? null, p.max_memory_mb ?? null, p.max_duration_ms, p.max_output_bytes ?? null, p.allowed_modules ?? null, p.denied_modules ?? null, p.network_access, p.filesystem_access, p.enabled);
  }

  async getSandboxPolicy(id: string): Promise<SandboxPolicyRow | null> {
    return (this.d.prepare('SELECT * FROM sandbox_policies WHERE id = ?').get(id) as SandboxPolicyRow) ?? null;
  }

  async listSandboxPolicies(): Promise<SandboxPolicyRow[]> {
    return this.d.prepare('SELECT * FROM sandbox_policies ORDER BY name ASC').all() as SandboxPolicyRow[];
  }

  async updateSandboxPolicy(id: string, fields: Partial<Omit<SandboxPolicyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE sandbox_policies SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteSandboxPolicy(id: string): Promise<void> {
    this.d.prepare('DELETE FROM sandbox_policies WHERE id = ?').run(id);
  }

  // ─── Admin: Extraction Pipelines ─────────────────────────────

  async createExtractionPipeline(p: Omit<ExtractionPipelineRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO extraction_pipelines (id, name, description, stages, input_mime_types, max_input_size_bytes, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.name, p.description ?? null, p.stages, p.input_mime_types ?? null, p.max_input_size_bytes ?? null, p.enabled);
  }

  async getExtractionPipeline(id: string): Promise<ExtractionPipelineRow | null> {
    return (this.d.prepare('SELECT * FROM extraction_pipelines WHERE id = ?').get(id) as ExtractionPipelineRow) ?? null;
  }

  async listExtractionPipelines(): Promise<ExtractionPipelineRow[]> {
    return this.d.prepare('SELECT * FROM extraction_pipelines ORDER BY name ASC').all() as ExtractionPipelineRow[];
  }

  async updateExtractionPipeline(id: string, fields: Partial<Omit<ExtractionPipelineRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE extraction_pipelines SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteExtractionPipeline(id: string): Promise<void> {
    this.d.prepare('DELETE FROM extraction_pipelines WHERE id = ?').run(id);
  }

  // ─── Admin: Artifact Policies ────────────────────────────────

  async createArtifactPolicy(p: Omit<ArtifactPolicyRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO artifact_policies (id, name, description, max_size_bytes, allowed_types, retention_days, require_versioning, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.name, p.description ?? null, p.max_size_bytes ?? null, p.allowed_types ?? null, p.retention_days ?? null, p.require_versioning, p.enabled);
  }

  async getArtifactPolicy(id: string): Promise<ArtifactPolicyRow | null> {
    return (this.d.prepare('SELECT * FROM artifact_policies WHERE id = ?').get(id) as ArtifactPolicyRow) ?? null;
  }

  async listArtifactPolicies(): Promise<ArtifactPolicyRow[]> {
    return this.d.prepare('SELECT * FROM artifact_policies ORDER BY name ASC').all() as ArtifactPolicyRow[];
  }

  async updateArtifactPolicy(id: string, fields: Partial<Omit<ArtifactPolicyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE artifact_policies SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteArtifactPolicy(id: string): Promise<void> {
    this.d.prepare('DELETE FROM artifact_policies WHERE id = ?').run(id);
  }

  // ─── Admin: Reliability Policies ─────────────────────────────

  async createReliabilityPolicy(p: Omit<ReliabilityPolicyRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO reliability_policies (id, name, description, policy_type, max_retries, initial_delay_ms, max_delay_ms, backoff_multiplier, max_concurrent, queue_size, strategy, ttl_ms, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.name, p.description ?? null, p.policy_type, p.max_retries ?? null, p.initial_delay_ms ?? null, p.max_delay_ms ?? null, p.backoff_multiplier ?? null, p.max_concurrent ?? null, p.queue_size ?? null, p.strategy ?? null, p.ttl_ms ?? null, p.enabled);
  }

  async getReliabilityPolicy(id: string): Promise<ReliabilityPolicyRow | null> {
    return (this.d.prepare('SELECT * FROM reliability_policies WHERE id = ?').get(id) as ReliabilityPolicyRow) ?? null;
  }

  async listReliabilityPolicies(): Promise<ReliabilityPolicyRow[]> {
    return this.d.prepare('SELECT * FROM reliability_policies ORDER BY name ASC').all() as ReliabilityPolicyRow[];
  }

  async updateReliabilityPolicy(id: string, fields: Partial<Omit<ReliabilityPolicyRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE reliability_policies SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteReliabilityPolicy(id: string): Promise<void> {
    this.d.prepare('DELETE FROM reliability_policies WHERE id = ?').run(id);
  }

  // ── Collaboration Sessions ─────────────────────────────────

  async createCollaborationSession(s: Omit<CollaborationSessionRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO collaboration_sessions (id, name, description, session_type, max_participants, presence_ttl_ms, auto_close_idle_ms, handoff_enabled, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(s.id, s.name, s.description ?? null, s.session_type, s.max_participants, s.presence_ttl_ms, s.auto_close_idle_ms ?? null, s.handoff_enabled, s.enabled);
  }

  async getCollaborationSession(id: string): Promise<CollaborationSessionRow | null> {
    return (this.d.prepare('SELECT * FROM collaboration_sessions WHERE id = ?').get(id) as CollaborationSessionRow) ?? null;
  }

  async listCollaborationSessions(): Promise<CollaborationSessionRow[]> {
    return this.d.prepare('SELECT * FROM collaboration_sessions ORDER BY name ASC').all() as CollaborationSessionRow[];
  }

  async updateCollaborationSession(id: string, fields: Partial<Omit<CollaborationSessionRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE collaboration_sessions SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteCollaborationSession(id: string): Promise<void> {
    this.d.prepare('DELETE FROM collaboration_sessions WHERE id = ?').run(id);
  }

  // ── Compliance Rules ───────────────────────────────────────

  async createComplianceRule(r: Omit<ComplianceRuleRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO compliance_rules (id, name, description, rule_type, target_resource, retention_days, region, consent_purpose, action, config, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(r.id, r.name, r.description ?? null, r.rule_type, r.target_resource, r.retention_days ?? null, r.region ?? null, r.consent_purpose ?? null, r.action, r.config ?? null, r.enabled);
  }

  async getComplianceRule(id: string): Promise<ComplianceRuleRow | null> {
    return (this.d.prepare('SELECT * FROM compliance_rules WHERE id = ?').get(id) as ComplianceRuleRow) ?? null;
  }

  async listComplianceRules(): Promise<ComplianceRuleRow[]> {
    return this.d.prepare('SELECT * FROM compliance_rules ORDER BY name ASC').all() as ComplianceRuleRow[];
  }

  async updateComplianceRule(id: string, fields: Partial<Omit<ComplianceRuleRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE compliance_rules SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteComplianceRule(id: string): Promise<void> {
    this.d.prepare('DELETE FROM compliance_rules WHERE id = ?').run(id);
  }

  // ── Graph Configs ──────────────────────────────────────────

  async createGraphConfig(g: Omit<GraphConfigRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO graph_configs (id, name, description, graph_type, max_depth, entity_types, relationship_types, auto_link, scoring_weights, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(g.id, g.name, g.description ?? null, g.graph_type, g.max_depth, g.entity_types ?? null, g.relationship_types ?? null, g.auto_link, g.scoring_weights ?? null, g.enabled);
  }

  async getGraphConfig(id: string): Promise<GraphConfigRow | null> {
    return (this.d.prepare('SELECT * FROM graph_configs WHERE id = ?').get(id) as GraphConfigRow) ?? null;
  }

  async listGraphConfigs(): Promise<GraphConfigRow[]> {
    return this.d.prepare('SELECT * FROM graph_configs ORDER BY name ASC').all() as GraphConfigRow[];
  }

  async updateGraphConfig(id: string, fields: Partial<Omit<GraphConfigRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE graph_configs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteGraphConfig(id: string): Promise<void> {
    this.d.prepare('DELETE FROM graph_configs WHERE id = ?').run(id);
  }

  // ── Plugin Configs ─────────────────────────────────────────

  async createPluginConfig(p: Omit<PluginConfigRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO plugin_configs (id, name, description, plugin_type, package_name, version, capabilities, trust_level, auto_update, config, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(p.id, p.name, p.description ?? null, p.plugin_type, p.package_name, p.version, p.capabilities ?? null, p.trust_level, p.auto_update, p.config ?? null, p.enabled);
  }

  async getPluginConfig(id: string): Promise<PluginConfigRow | null> {
    return (this.d.prepare('SELECT * FROM plugin_configs WHERE id = ?').get(id) as PluginConfigRow) ?? null;
  }

  async listPluginConfigs(): Promise<PluginConfigRow[]> {
    return this.d.prepare('SELECT * FROM plugin_configs ORDER BY name ASC').all() as PluginConfigRow[];
  }

  async updatePluginConfig(id: string, fields: Partial<Omit<PluginConfigRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE plugin_configs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deletePluginConfig(id: string): Promise<void> {
    this.d.prepare('DELETE FROM plugin_configs WHERE id = ?').run(id);
  }

  // ─── Phase 9: Scaffold Templates ────────────────────────────

  async createScaffoldTemplate(t: Omit<ScaffoldTemplateRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO scaffold_templates (id, name, description, template_type, files, dependencies, dev_dependencies, variables, post_install, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(t.id, t.name, t.description ?? null, t.template_type, t.files ?? null, t.dependencies ?? null, t.dev_dependencies ?? null, t.variables ?? null, t.post_install ?? null, t.enabled);
  }

  async getScaffoldTemplate(id: string): Promise<ScaffoldTemplateRow | null> {
    return (this.d.prepare('SELECT * FROM scaffold_templates WHERE id = ?').get(id) as ScaffoldTemplateRow) ?? null;
  }

  async listScaffoldTemplates(): Promise<ScaffoldTemplateRow[]> {
    return this.d.prepare('SELECT * FROM scaffold_templates ORDER BY name ASC').all() as ScaffoldTemplateRow[];
  }

  async updateScaffoldTemplate(id: string, fields: Partial<Omit<ScaffoldTemplateRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = ?`); vals.push(v); }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE scaffold_templates SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteScaffoldTemplate(id: string): Promise<void> {
    this.d.prepare('DELETE FROM scaffold_templates WHERE id = ?').run(id);
  }

  // ─── Phase 9: Recipe Configs ─────────────────────────────────

  async createRecipeConfig(r: Omit<RecipeConfigRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO recipe_configs (id, name, description, recipe_type, model, provider, system_prompt, tools, guardrails, max_steps, options, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(r.id, r.name, r.description ?? null, r.recipe_type, r.model ?? null, r.provider ?? null, r.system_prompt ?? null, r.tools ?? null, r.guardrails ?? null, r.max_steps ?? null, r.options ?? null, r.enabled);
  }

  async getRecipeConfig(id: string): Promise<RecipeConfigRow | null> {
    return (this.d.prepare('SELECT * FROM recipe_configs WHERE id = ?').get(id) as RecipeConfigRow) ?? null;
  }

  async listRecipeConfigs(): Promise<RecipeConfigRow[]> {
    return this.d.prepare('SELECT * FROM recipe_configs ORDER BY name ASC').all() as RecipeConfigRow[];
  }

  async updateRecipeConfig(id: string, fields: Partial<Omit<RecipeConfigRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = ?`); vals.push(v); }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE recipe_configs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteRecipeConfig(id: string): Promise<void> {
    this.d.prepare('DELETE FROM recipe_configs WHERE id = ?').run(id);
  }

  // ─── Phase 9: Widget Configs ─────────────────────────────────

  async createWidgetConfig(w: Omit<WidgetConfigRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO widget_configs (id, name, description, widget_type, default_options, allowed_contexts, max_data_points, refresh_interval_ms, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(w.id, w.name, w.description ?? null, w.widget_type, w.default_options ?? null, w.allowed_contexts ?? null, w.max_data_points ?? null, w.refresh_interval_ms ?? null, w.enabled);
  }

  async getWidgetConfig(id: string): Promise<WidgetConfigRow | null> {
    return (this.d.prepare('SELECT * FROM widget_configs WHERE id = ?').get(id) as WidgetConfigRow) ?? null;
  }

  async listWidgetConfigs(): Promise<WidgetConfigRow[]> {
    return this.d.prepare('SELECT * FROM widget_configs ORDER BY name ASC').all() as WidgetConfigRow[];
  }

  async updateWidgetConfig(id: string, fields: Partial<Omit<WidgetConfigRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = ?`); vals.push(v); }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE widget_configs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteWidgetConfig(id: string): Promise<void> {
    this.d.prepare('DELETE FROM widget_configs WHERE id = ?').run(id);
  }

  // ─── Phase 9: Validation Rules ───────────────────────────────

  async createValidationRule(r: Omit<ValidationRuleRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO validation_rules (id, name, description, rule_type, target, condition, severity, message, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(r.id, r.name, r.description ?? null, r.rule_type, r.target, r.condition ?? null, r.severity, r.message ?? null, r.enabled);
  }

  async getValidationRule(id: string): Promise<ValidationRuleRow | null> {
    return (this.d.prepare('SELECT * FROM validation_rules WHERE id = ?').get(id) as ValidationRuleRow) ?? null;
  }

  async listValidationRules(): Promise<ValidationRuleRow[]> {
    return this.d.prepare('SELECT * FROM validation_rules ORDER BY name ASC').all() as ValidationRuleRow[];
  }

  async updateValidationRule(id: string, fields: Partial<Omit<ValidationRuleRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = ?`); vals.push(v); }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id);
    this.d.prepare(`UPDATE validation_rules SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  async deleteValidationRule(id: string): Promise<void> {
    this.d.prepare('DELETE FROM validation_rules WHERE id = ?').run(id);
  }

  // ─── Semantic Memory ───────────────────────────────────────

  async saveSemanticMemory(m: {
    id: string;
    userId: string;
    chatId?: string;
    tenantId?: string;
    content: string;
    memoryType?: string;
    source?: string;
  }): Promise<void> {
    this.d.prepare(
      `INSERT INTO semantic_memory (id, user_id, chat_id, tenant_id, content, memory_type, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      m.id, m.userId, m.chatId ?? null, m.tenantId ?? null,
      m.content, m.memoryType ?? 'semantic', m.source ?? 'assistant',
    );
  }

  async searchSemanticMemory(opts: {
    userId: string;
    query: string;
    limit?: number;
  }): Promise<SemanticMemoryRow[]> {
    // Keyword-based search: rank entries containing the most query words first
    const words = opts.query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
    if (words.length === 0) {
      return this.d.prepare(
        'SELECT * FROM semantic_memory WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
      ).all(opts.userId, opts.limit ?? 5) as SemanticMemoryRow[];
    }
    // Build CASE score: one point per word match, then order by score DESC, recency DESC
    const scoreParts = words.map(() => `CASE WHEN LOWER(content) LIKE ? THEN 1 ELSE 0 END`).join(' + ');
    const likeParams = words.map(w => `%${w}%`);
    const sql = `
      SELECT *, (${scoreParts}) AS _score
      FROM semantic_memory
      WHERE user_id = ? AND (${words.map(() => 'LOWER(content) LIKE ?').join(' OR ')})
      ORDER BY _score DESC, created_at DESC
      LIMIT ?
    `;
    return this.d.prepare(sql).all(
      ...likeParams, opts.userId, ...likeParams, opts.limit ?? 5,
    ) as SemanticMemoryRow[];
  }

  async listSemanticMemory(userId: string, limit = 20): Promise<SemanticMemoryRow[]> {
    return this.d.prepare(
      'SELECT * FROM semantic_memory WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
    ).all(userId, limit) as SemanticMemoryRow[];
  }

  async deleteSemanticMemory(id: string, userId: string): Promise<void> {
    this.d.prepare('DELETE FROM semantic_memory WHERE id = ? AND user_id = ?').run(id, userId);
  }

  async clearUserSemanticMemory(userId: string): Promise<void> {
    this.d.prepare('DELETE FROM semantic_memory WHERE user_id = ?').run(userId);
  }

  // ─── Entity Memory ─────────────────────────────────────────

  async upsertEntity(e: {
    userId: string;
    entityName: string;
    entityType?: string;
    facts: Record<string, unknown>;
    confidence?: number;
    source?: string;
    chatId?: string;
    tenantId?: string;
  }): Promise<void> {
    // Merge facts: read existing JSON and merge with new facts
    const existing = this.d.prepare(
      'SELECT facts, confidence, source FROM entity_memory WHERE user_id = ? AND entity_name = ?',
    ).get(e.userId, e.entityName) as { facts: string; confidence: number; source: string } | undefined;
    const merged = existing ? { ...JSON.parse(existing.facts), ...e.facts } : e.facts;
    const incomingConfidence = Math.max(0, Math.min(1, e.confidence ?? 0.6));
    const existingConfidence = existing?.confidence ?? 0;
    const chosenConfidence = Math.max(existingConfidence, incomingConfidence);
    const chosenSource = incomingConfidence >= existingConfidence ? (e.source ?? 'regex') : (existing?.source ?? 'regex');
    this.d.prepare(
      `INSERT INTO entity_memory (id, user_id, chat_id, tenant_id, entity_name, entity_type, facts, confidence, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, entity_name) DO UPDATE SET
         entity_type = excluded.entity_type,
         facts = ?,
         confidence = ?,
         source = ?,
         chat_id = COALESCE(excluded.chat_id, chat_id),
         updated_at = datetime('now')`,
    ).run(
      randomUUID(), e.userId, e.chatId ?? null, e.tenantId ?? null,
      e.entityName, e.entityType ?? 'general', JSON.stringify(merged), chosenConfidence, chosenSource,
      JSON.stringify(merged),
      chosenConfidence,
      chosenSource,
    );
  }

  async getEntity(userId: string, entityName: string): Promise<EntityMemoryRow | null> {
    return (this.d.prepare(
      'SELECT * FROM entity_memory WHERE user_id = ? AND entity_name = ? COLLATE NOCASE',
    ).get(userId, entityName) as EntityMemoryRow | undefined) ?? null;
  }

  async searchEntities(userId: string, query: string): Promise<EntityMemoryRow[]> {
    const q = `%${query}%`;
    return this.d.prepare(
      `SELECT * FROM entity_memory WHERE user_id = ?
       AND (LOWER(entity_name) LIKE LOWER(?) OR LOWER(facts) LIKE LOWER(?))
       ORDER BY updated_at DESC LIMIT 10`,
    ).all(userId, q, q) as EntityMemoryRow[];
  }

  async listEntities(userId: string): Promise<EntityMemoryRow[]> {
    return this.d.prepare(
      'SELECT * FROM entity_memory WHERE user_id = ? ORDER BY entity_type ASC, entity_name ASC',
    ).all(userId) as EntityMemoryRow[];
  }

  async deleteEntity(userId: string, entityName: string): Promise<void> {
    this.d.prepare('DELETE FROM entity_memory WHERE user_id = ? AND entity_name = ?').run(userId, entityName);
  }

  async clearUserEntityMemory(userId: string): Promise<void> {
    this.d.prepare('DELETE FROM entity_memory WHERE user_id = ?').run(userId);
  }

  async recordMemoryExtractionEvent(e: {
    id: string;
    userId: string;
    chatId?: string;
    tenantId?: string;
    selfDisclosure: boolean;
    regexEntitiesCount: number;
    llmEntitiesCount: number;
    mergedEntitiesCount: number;
    events?: string;
  }): Promise<void> {
    this.d.prepare(
      `INSERT INTO memory_extraction_events
       (id, user_id, chat_id, tenant_id, self_disclosure, regex_entities_count, llm_entities_count, merged_entities_count, events)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      e.id,
      e.userId,
      e.chatId ?? null,
      e.tenantId ?? null,
      e.selfDisclosure ? 1 : 0,
      e.regexEntitiesCount,
      e.llmEntitiesCount,
      e.mergedEntitiesCount,
      e.events ?? null,
    );
  }

  async getMemoryExtractionEvent(id: string): Promise<MemoryExtractionEventRow | null> {
    return (this.d.prepare('SELECT * FROM memory_extraction_events WHERE id = ?').get(id) as MemoryExtractionEventRow | undefined) ?? null;
  }

  async listMemoryExtractionEvents(chatId?: string, limit = 100): Promise<MemoryExtractionEventRow[]> {
    if (chatId) {
      return this.d.prepare('SELECT * FROM memory_extraction_events WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?').all(chatId, limit) as MemoryExtractionEventRow[];
    }
    return this.d.prepare('SELECT * FROM memory_extraction_events ORDER BY created_at DESC LIMIT ?').all(limit) as MemoryExtractionEventRow[];
  }

  // ─── Website Credentials (Browser Auth Vault) ──────────────

  async createWebsiteCredential(c: Omit<WebsiteCredentialRow, 'created_at' | 'updated_at'>): Promise<void> {
    this.d.prepare(
      `INSERT INTO website_credentials (id, user_id, site_name, site_url_pattern, auth_method, credentials_encrypted, encryption_iv, last_used_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(c.id, c.user_id, c.site_name, c.site_url_pattern, c.auth_method, c.credentials_encrypted, c.encryption_iv, c.last_used_at ?? null, c.status);
  }

  async getWebsiteCredential(id: string, userId: string): Promise<WebsiteCredentialRow | null> {
    return (this.d.prepare('SELECT * FROM website_credentials WHERE id = ? AND user_id = ?').get(id, userId) as WebsiteCredentialRow | undefined) ?? null;
  }

  async listWebsiteCredentials(userId: string): Promise<WebsiteCredentialRow[]> {
    return this.d.prepare('SELECT * FROM website_credentials WHERE user_id = ? ORDER BY updated_at DESC').all(userId) as WebsiteCredentialRow[];
  }

  async listAllActiveWebsiteCredentials(): Promise<WebsiteCredentialRow[]> {
    return this.d.prepare("SELECT * FROM website_credentials WHERE status = 'active' ORDER BY updated_at DESC").all() as WebsiteCredentialRow[];
  }

  async findWebsiteCredential(userId: string, url: string): Promise<WebsiteCredentialRow | null> {
    // Find credentials where the URL matches the site_url_pattern using glob-style matching
    const rows = this.d.prepare(
      `SELECT * FROM website_credentials WHERE user_id = ? AND status = 'active' ORDER BY last_used_at DESC`,
    ).all(userId) as WebsiteCredentialRow[];
    for (const row of rows) {
      const pattern = row.site_url_pattern;
      // Convert simple glob to regex: *.example.com/* → .*\.example\.com\/.*
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      if (new RegExp(`^${escaped}$`, 'i').test(url)) return row;
    }
    return null;
  }

  async updateWebsiteCredential(id: string, userId: string, fields: Partial<Omit<WebsiteCredentialRow, 'id' | 'user_id' | 'created_at' | 'updated_at'>>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      sets.push(`${k} = ?`);
      vals.push(v);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = datetime('now')");
    vals.push(id, userId);
    this.d.prepare(`UPDATE website_credentials SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`).run(...vals);
  }

  async deleteWebsiteCredential(id: string, userId: string): Promise<void> {
    this.d.prepare('DELETE FROM website_credentials WHERE id = ? AND user_id = ?').run(id, userId);
  }

  // ─── SSO Linked Accounts (for SSO pass-through) ─────────────

  async createSSOLinkedAccount(acct: { id: string; user_id: string; identity_provider: string; email?: string; session_encrypted: string; encryption_iv: string }): Promise<void> {
    this.d.prepare(`
      INSERT OR REPLACE INTO sso_linked_accounts (id, user_id, identity_provider, email, session_encrypted, encryption_iv)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(acct.id, acct.user_id, acct.identity_provider, acct.email ?? null, acct.session_encrypted, acct.encryption_iv);
  }

  async getSSOLinkedAccount(userId: string, identityProvider: string): Promise<import('./db-types.js').SSOLinkedAccountRow | null> {
    return (this.d.prepare(`
      SELECT * FROM sso_linked_accounts
      WHERE user_id = ? AND identity_provider = ? AND status = 'active'
    `).get(userId, identityProvider) as import('./db-types.js').SSOLinkedAccountRow | undefined) ?? null;
  }

  async listSSOLinkedAccounts(userId: string): Promise<Array<Omit<import('./db-types.js').SSOLinkedAccountRow, 'session_encrypted' | 'encryption_iv'>>> {
    return this.d.prepare(`
      SELECT id, user_id, identity_provider, email, status, linked_at, updated_at
      FROM sso_linked_accounts
      WHERE user_id = ? AND status = 'active'
      ORDER BY linked_at DESC
    `).all(userId) as Array<any>;
  }

  async deleteSSOLinkedAccount(userId: string, identityProvider: string): Promise<void> {
    this.d.prepare(`
      DELETE FROM sso_linked_accounts
      WHERE user_id = ? AND identity_provider = ?
    `).run(userId, identityProvider);
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
      {
        id: 'guard-cog-pre-sycophancy', name: 'Cognitive Pre: Sycophancy Pressure', description: 'Detect prompts that push for agreement over truth before generation',
        type: 'cognitive_check', stage: 'pre', config: JSON.stringify({ check: 'pre_sycophancy', pattern: "\\b(agree with me|just agree|say yes|validate me|don't challenge|no criticism)\\b", warn_confidence: 0.62, allow_confidence: 0.86 }), priority: 65, enabled: 1,
      },
      {
        id: 'guard-cog-pre-confidence', name: 'Cognitive Pre: Confidence Gate', description: 'Apply risk-aware confidence gate before generation',
        type: 'cognitive_check', stage: 'pre', config: JSON.stringify({ check: 'pre_confidence', gate_threshold: 0.65, gate_on_fail: 'warn', medium_risk_confidence: 0.72, high_risk_confidence: 0.6, critical_risk_confidence: 0.5, low_risk_confidence: 0.82 }), priority: 64, enabled: 1,
      },
      {
        id: 'guard-cog-post-grounding', name: 'Cognitive Post: Grounding', description: 'Check lexical grounding between prompt and response',
        type: 'cognitive_check', stage: 'post', config: JSON.stringify({ check: 'post_grounding', min_overlap: 0.06 }), priority: 63, enabled: 1,
      },
      {
        id: 'guard-cog-post-sycophancy', name: 'Cognitive Post: Sycophancy Phrasing', description: 'Detect strong sycophantic phrasing in assistant output',
        type: 'cognitive_check', stage: 'post', config: JSON.stringify({ check: 'post_sycophancy', pattern: "\\b(you are absolutely right|exactly right|totally correct|you are 100% right)\\b", warn_confidence: 0.58, allow_confidence: 0.86 }), priority: 62, enabled: 1,
      },
      {
        id: 'guard-cog-post-devils-advocate', name: 'Cognitive Post: Devils Advocate', description: 'Ensure decision-style queries include counterpoints and trade-offs',
        type: 'cognitive_check', stage: 'post', config: JSON.stringify({ check: 'post_devils_advocate', needs_pattern: "\\b(should i|is it good|best|recommend|decision|choose|strategy|plan)\\b", has_pattern: "\\b(however|on the other hand|trade-?off|counterpoint|risk|alternative)\\b", warn_confidence: 0.6, allow_confidence: 0.84 }), priority: 61, enabled: 1,
      },
      {
        id: 'guard-cog-post-confidence', name: 'Cognitive Post: Confidence Gate', description: 'Apply post-response confidence gate for outcome signaling',
        type: 'cognitive_check', stage: 'post', config: JSON.stringify({ check: 'post_confidence', gate_threshold: 0.67, gate_on_fail: 'warn' }), priority: 60, enabled: 1,
      },
      {
        id: 'guard-injection-directive-override', name: 'Prompt Injection: Directive Override', description: 'Block attempts to override system or developer instructions',
        type: 'content_filter', stage: 'pre', config: JSON.stringify({
          words: [
            'ignore previous instructions',
            'disregard previous instructions',
            'forget all prior instructions',
            'override system prompt',
            'ignore system prompt',
            'ignore developer instructions',
            'jailbreak',
            'do anything now',
          ],
          action: 'deny',
        }), priority: 95, enabled: 1,
      },
      {
        id: 'guard-injection-prompt-exfil', name: 'Prompt Injection: Prompt Exfiltration', description: 'Block attempts to extract hidden prompts or policies',
        type: 'regex', stage: 'pre', config: JSON.stringify({
          pattern: '(?:show|reveal|print|dump|output).{0,80}(?:system prompt|developer message|hidden instructions|internal policy)',
          flags: 'i',
          action: 'deny',
        }), priority: 94, enabled: 1,
      },
    ];
    for (const g of guardrails) await this.createGuardrail(g);
    }

    // Ensure prompt-injection guardrails exist for existing databases
    const injectionGuardrails: Omit<GuardrailRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'guard-injection-directive-override', name: 'Prompt Injection: Directive Override', description: 'Block attempts to override system or developer instructions',
        type: 'content_filter', stage: 'pre', config: JSON.stringify({
          words: [
            'ignore previous instructions',
            'disregard previous instructions',
            'forget all prior instructions',
            'override system prompt',
            'ignore system prompt',
            'ignore developer instructions',
            'jailbreak',
            'do anything now',
          ],
          action: 'deny',
        }), priority: 95, enabled: 1,
      },
      {
        id: 'guard-injection-prompt-exfil', name: 'Prompt Injection: Prompt Exfiltration', description: 'Block attempts to extract hidden prompts or policies',
        type: 'regex', stage: 'pre', config: JSON.stringify({
          pattern: '(?:show|reveal|print|dump|output).{0,80}(?:system prompt|developer message|hidden instructions|internal policy)',
          flags: 'i',
          action: 'deny',
        }), priority: 94, enabled: 1,
      },
    ];
    for (const g of injectionGuardrails) {
      const existing = await this.getGuardrail(g.id);
      if (!existing) await this.createGuardrail(g);
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

    // Model pricing
    if (cnt('model_pricing') === 0) {
    const pricing: Omit<ModelPricingRow, 'created_at' | 'updated_at'>[] = [
      { id: 'mp-claude-sonnet-4',    model_id: 'claude-sonnet-4-20250514',    provider: 'anthropic', display_name: 'Claude Sonnet 4',    input_cost_per_1m: 3.00,  output_cost_per_1m: 15.00, quality_score: 0.85, source: 'seed', last_synced_at: null, enabled: 1 },
      { id: 'mp-claude-opus-4',      model_id: 'claude-opus-4-20250514',      provider: 'anthropic', display_name: 'Claude Opus 4',      input_cost_per_1m: 15.00, output_cost_per_1m: 75.00, quality_score: 0.95, source: 'seed', last_synced_at: null, enabled: 1 },
      { id: 'mp-claude-haiku-4',     model_id: 'claude-haiku-4-20250414',     provider: 'anthropic', display_name: 'Claude Haiku 4',     input_cost_per_1m: 1.00,  output_cost_per_1m: 5.00,  quality_score: 0.70, source: 'seed', last_synced_at: null, enabled: 1 },
      { id: 'mp-gpt-4o',             model_id: 'gpt-4o',                      provider: 'openai',    display_name: 'GPT-4o',             input_cost_per_1m: 2.50,  output_cost_per_1m: 10.00, quality_score: 0.90, source: 'seed', last_synced_at: null, enabled: 1 },
      { id: 'mp-gpt-4o-mini',        model_id: 'gpt-4o-mini',                 provider: 'openai',    display_name: 'GPT-4o Mini',        input_cost_per_1m: 0.15,  output_cost_per_1m: 0.60,  quality_score: 0.75, source: 'seed', last_synced_at: null, enabled: 1 },
      { id: 'mp-gpt-4.1',            model_id: 'gpt-4.1',                     provider: 'openai',    display_name: 'GPT-4.1',            input_cost_per_1m: 2.00,  output_cost_per_1m: 8.00,  quality_score: 0.90, source: 'seed', last_synced_at: null, enabled: 1 },
      { id: 'mp-gpt-4.1-mini',       model_id: 'gpt-4.1-mini',                provider: 'openai',    display_name: 'GPT-4.1 Mini',       input_cost_per_1m: 0.40,  output_cost_per_1m: 1.60,  quality_score: 0.75, source: 'seed', last_synced_at: null, enabled: 1 },
      { id: 'mp-gpt-4.1-nano',       model_id: 'gpt-4.1-nano',                provider: 'openai',    display_name: 'GPT-4.1 Nano',       input_cost_per_1m: 0.10,  output_cost_per_1m: 0.40,  quality_score: 0.60, source: 'seed', last_synced_at: null, enabled: 1 },
      { id: 'mp-o3',                 model_id: 'o3',                           provider: 'openai',    display_name: 'o3',                 input_cost_per_1m: 2.00,  output_cost_per_1m: 8.00,  quality_score: 0.85, source: 'seed', last_synced_at: null, enabled: 1 },
      { id: 'mp-o4-mini',            model_id: 'o4-mini',                      provider: 'openai',    display_name: 'o4 Mini',            input_cost_per_1m: 1.10,  output_cost_per_1m: 4.40,  quality_score: 0.75, source: 'seed', last_synced_at: null, enabled: 1 },
    ];
    for (const p of pricing) await this.createModelPricing(p);
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

    // Memory extraction rules
    if (cnt('memory_extraction_rules') === 0) {
    const extractionRules: Omit<MemoryExtractionRuleRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'mer-self-name',
        name: 'Self disclosure: name',
        description: 'Detect when user discloses their name',
        rule_type: 'self_disclosure',
        entity_type: null,
        pattern: "\\b(?:my name is|i\\'?m called|call me)\\s+([A-Z][a-z]+(?:\\s+[A-Z][a-z]+)?)",
        flags: 'i',
        facts_template: null,
        priority: 100,
        enabled: 1,
      },
      {
        id: 'mer-self-location',
        name: 'Self disclosure: location',
        description: 'Detect where user lives or is from',
        rule_type: 'self_disclosure',
        entity_type: null,
        pattern: "\\b(?:i live in|i\\'?m from|i am from|i reside in)\\s+([A-Z][a-zA-Z\\s]{2,25}?)(?:[,\\.!]|$)",
        flags: 'i',
        facts_template: null,
        priority: 95,
        enabled: 1,
      },
      {
        id: 'mer-self-work',
        name: 'Self disclosure: work',
        description: 'Detect organization where user works',
        rule_type: 'self_disclosure',
        entity_type: null,
        pattern: "\\b(?:i work (?:at|for)|i\\'?m employed (?:at|by)|i\\'?m at)\\s+([A-Z][a-zA-Z\\s]{2,25}?)(?:[,\\.!]|$)",
        flags: 'i',
        facts_template: null,
        priority: 90,
        enabled: 1,
      },
      {
        id: 'mer-entity-name',
        name: 'Entity extraction: person name',
        description: 'Extract a person entity from self name disclosure',
        rule_type: 'entity_extraction',
        entity_type: 'person',
        pattern: "\\b(?:my name is|i\\'?m called|call me)\\s+([A-Z][a-z]+(?:\\s+[A-Z][a-z]+)?)",
        flags: 'i',
        facts_template: '{"relationship":"self"}',
        priority: 100,
        enabled: 1,
      },
      {
        id: 'mer-entity-location',
        name: 'Entity extraction: location',
        description: 'Extract location entity from residence disclosure',
        rule_type: 'entity_extraction',
        entity_type: 'location',
        pattern: "\\b(?:i live in|i\\'?m from|i am from|i reside in)\\s+([A-Z][a-zA-Z\\s]{2,25}?)(?:[,\\.!]|$)",
        flags: 'i',
        facts_template: '{"relationship":"residence"}',
        priority: 95,
        enabled: 1,
      },
      {
        id: 'mer-entity-work',
        name: 'Entity extraction: organization',
        description: 'Extract organization entity from employer disclosure',
        rule_type: 'entity_extraction',
        entity_type: 'organization',
        pattern: "\\b(?:i work (?:at|for)|i\\'?m employed (?:at|by)|i\\'?m at)\\s+([A-Z][a-zA-Z\\s]{2,25}?)(?:[,\\.!]|$)",
        flags: 'i',
        facts_template: '{"relationship":"employer"}',
        priority: 90,
        enabled: 1,
      },
      {
        id: 'mer-entity-pref',
        name: 'Entity extraction: preference',
        description: 'Extract preference topic from likes/loves/enjoys statements',
        rule_type: 'entity_extraction',
        entity_type: 'preference',
        pattern: '\\bi (?:like|love|enjoy|prefer)\\s+([a-zA-Z][a-zA-Z\\s]{2,25}?)(?:[,\\.!]|$)',
        flags: 'gi',
        facts_template: '{"sentiment":"positive"}',
        priority: 80,
        enabled: 1,
      },
    ];
    for (const r of extractionRules) await this.createMemoryExtractionRule(r);
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
        platform: 'slack', api_key: '', api_secret: null, access_token: null, refresh_token: null, token_expires_at: null, oauth_state: null, status: 'disconnected', base_url: null,
        options: JSON.stringify({ default_channel: '#general' }), enabled: 0,
      },
      {
        id: 'sa-discord-default', name: 'Discord Server', description: 'Discord server bot integration',
        platform: 'discord', api_key: '', api_secret: null, access_token: null, refresh_token: null, token_expires_at: null, oauth_state: null, status: 'disconnected', base_url: null,
        options: JSON.stringify({ guild_id: '' }), enabled: 0,
      },
      {
        id: 'sa-github-default', name: 'GitHub', description: 'GitHub integration for repository and issue management',
        platform: 'github', api_key: '', api_secret: null, access_token: null, refresh_token: null, token_expires_at: null, oauth_state: null, status: 'disconnected', base_url: null,
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
        access_token: null, refresh_token: null, token_expires_at: null, oauth_state: null, status: 'disconnected',
        options: JSON.stringify({ default_project: '' }), enabled: 0,
      },
      {
        id: 'ec-confluence', name: 'Confluence', description: 'Atlassian Confluence for team documentation and knowledge base',
        connector_type: 'confluence', base_url: '', auth_type: 'basic',
        auth_config: JSON.stringify({ username: '', token: '' }),
        access_token: null, refresh_token: null, token_expires_at: null, oauth_state: null, status: 'disconnected',
        options: JSON.stringify({ default_space: '' }), enabled: 0,
      },
      {
        id: 'ec-salesforce', name: 'Salesforce', description: 'Salesforce CRM integration for customer data and opportunities',
        connector_type: 'salesforce', base_url: '', auth_type: 'oauth2',
        auth_config: JSON.stringify({ client_id: '', client_secret: '', token_url: '' }),
        access_token: null, refresh_token: null, token_expires_at: null, oauth_state: null, status: 'disconnected',
        options: null, enabled: 0,
      },
      {
        id: 'ec-notion', name: 'Notion', description: 'Notion workspace integration for docs and databases',
        connector_type: 'notion', base_url: null, auth_type: 'bearer',
        auth_config: JSON.stringify({ token: '' }),
        access_token: null, refresh_token: null, token_expires_at: null, oauth_state: null, status: 'disconnected',
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

    // Replay Scenarios
    if (cnt('replay_scenarios') === 0) {
    const replayScenarios: Omit<ReplayScenarioRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'rs-greeting', name: 'Greeting Test', description: 'Verify the assistant handles basic greetings correctly',
        golden_prompt: 'Hello! How are you?',
        golden_response: 'Hello! I\'m doing great, thanks for asking. How can I help you today?',
        model: 'gpt-4o-mini', provider: 'openai',
        tags: JSON.stringify(['basic', 'greeting', 'regression']),
        acceptance_criteria: JSON.stringify({ min_match_rate: 0.7, max_duration_ms: 5000 }),
        enabled: 1,
      },
      {
        id: 'rs-code-review', name: 'Code Review Scenario', description: 'Test code review accuracy against a golden response',
        golden_prompt: 'Review this JavaScript function for bugs:\\nfunction add(a, b) { return a - b; }',
        golden_response: 'Bug found: The function is named "add" but performs subtraction (a - b). It should be return a + b;',
        model: 'gpt-4o', provider: 'openai',
        tags: JSON.stringify(['code', 'review', 'regression']),
        acceptance_criteria: JSON.stringify({ min_match_rate: 0.6, required_step_matches: ['bug', 'subtraction'] }),
        enabled: 1,
      },
      {
        id: 'rs-summarization', name: 'Summarization Quality', description: 'Test document summarization quality and completeness',
        golden_prompt: 'Summarize: AI is transforming healthcare through diagnostics, drug discovery, and personalized medicine. Key challenges include data privacy, bias, and regulatory compliance.',
        golden_response: 'AI is revolutionizing healthcare in three areas: diagnostics, drug discovery, and personalized medicine. Main challenges are data privacy, algorithmic bias, and regulatory compliance.',
        model: null, provider: null,
        tags: JSON.stringify(['summarization', 'quality']),
        acceptance_criteria: JSON.stringify({ min_match_rate: 0.5 }),
        enabled: 1,
      },
    ];
    for (const s of replayScenarios) await this.createReplayScenario(s);
    }

    // Trigger Definitions
    if (cnt('trigger_definitions') === 0) {
    const triggerDefs: Omit<TriggerDefinitionRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'trig-daily-eval', name: 'Daily Eval Sweep', description: 'Run evaluation suite every day at 2 AM UTC',
        trigger_type: 'cron', expression: '0 2 * * *',
        config: JSON.stringify({ timezone: 'UTC', skipIfRunning: true }),
        target_workflow: 'wf-code-review', status: 'active', last_fired_at: null, fire_count: 0, enabled: 1,
      },
      {
        id: 'trig-webhook-deploy', name: 'Deploy Webhook', description: 'Trigger workflow on deployment webhook from CI/CD',
        trigger_type: 'webhook', expression: null,
        config: JSON.stringify({ path: '/hooks/deploy', method: 'POST', requiredHeaders: ['X-Deploy-Token'] }),
        target_workflow: 'wf-code-review', status: 'active', last_fired_at: null, fire_count: 0, enabled: 1,
      },
      {
        id: 'trig-queue-analysis', name: 'Queue Analysis Jobs', description: 'Process queued data analysis requests',
        trigger_type: 'queue', expression: null,
        config: JSON.stringify({ queueName: 'analysis-jobs', concurrency: 3, pollIntervalMs: 5000 }),
        target_workflow: null, status: 'active', last_fired_at: null, fire_count: 0, enabled: 1,
      },
      {
        id: 'trig-model-change', name: 'Model Config Change', description: 'Re-run golden tests when model configuration changes',
        trigger_type: 'change', expression: null,
        config: JSON.stringify({ resourceType: 'model-config', changeTypes: ['updated'], debounceMs: 10000 }),
        target_workflow: null, status: 'paused', last_fired_at: null, fire_count: 0, enabled: 0,
      },
    ];
    for (const t of triggerDefs) await this.createTriggerDefinition(t);
    }

    // Tenant Configs
    if (cnt('tenant_configs') === 0) {
    const tenantConfigs: Omit<TenantConfigRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'tc-default', name: 'Default Tenant', description: 'Default tenant configuration with standard limits',
        tenant_id: 'default', scope: 'global',
        allowed_models: JSON.stringify(['gpt-4o', 'gpt-4o-mini', 'claude-sonnet-4-20250514']),
        denied_models: null,
        allowed_tools: JSON.stringify(['web-search', 'file-reader', 'api-caller']),
        max_tokens_daily: 100000, max_cost_daily: 5.0,
        max_tokens_monthly: 2000000, max_cost_monthly: 100.0,
        features: JSON.stringify(['chat', 'agent', 'tools', 'eval']),
        config_overrides: null, enabled: 1,
      },
      {
        id: 'tc-enterprise', name: 'Enterprise Tenant', description: 'Enterprise tier with expanded limits and all features',
        tenant_id: 'enterprise', scope: 'organization',
        allowed_models: JSON.stringify(['gpt-4o', 'gpt-4o-mini', 'claude-sonnet-4-20250514', 'claude-opus-4-20250514']),
        denied_models: null,
        allowed_tools: JSON.stringify(['web-search', 'file-reader', 'api-caller', 'code-exec', 'db-query']),
        max_tokens_daily: 500000, max_cost_daily: 25.0,
        max_tokens_monthly: 10000000, max_cost_monthly: 500.0,
        features: JSON.stringify(['chat', 'agent', 'supervisor', 'tools', 'eval', 'workflows', 'replay']),
        config_overrides: JSON.stringify({ max_concurrent_runs: 10 }), enabled: 1,
      },
      {
        id: 'tc-trial', name: 'Trial Tenant', description: 'Free trial with limited access',
        tenant_id: 'trial', scope: 'tenant',
        allowed_models: JSON.stringify(['gpt-4o-mini']),
        denied_models: JSON.stringify(['claude-opus-4-20250514']),
        allowed_tools: JSON.stringify(['web-search']),
        max_tokens_daily: 10000, max_cost_daily: 0.5,
        max_tokens_monthly: 100000, max_cost_monthly: 5.0,
        features: JSON.stringify(['chat']),
        config_overrides: null, enabled: 1,
      },
    ];
    for (const c of tenantConfigs) await this.createTenantConfig(c);
    }

    // Sandbox Policies
    if (cnt('sandbox_policies') === 0) {
    const sandboxPolicies: Omit<SandboxPolicyRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'sbx-strict', name: 'Strict Sandbox', description: 'Highly restrictive sandbox for untrusted code execution',
        max_cpu_ms: 5000, max_memory_mb: 64, max_duration_ms: 10000, max_output_bytes: 65536,
        allowed_modules: JSON.stringify(['Math', 'Date', 'JSON']),
        denied_modules: JSON.stringify(['fs', 'net', 'child_process', 'http', 'https', 'crypto']),
        network_access: 0, filesystem_access: 'none', enabled: 1,
      },
      {
        id: 'sbx-moderate', name: 'Moderate Sandbox', description: 'Balanced sandbox allowing read-only filesystem and select modules',
        max_cpu_ms: 30000, max_memory_mb: 256, max_duration_ms: 60000, max_output_bytes: 1048576,
        allowed_modules: JSON.stringify(['Math', 'Date', 'JSON', 'crypto', 'path', 'url']),
        denied_modules: JSON.stringify(['child_process', 'net', 'cluster', 'worker_threads']),
        network_access: 0, filesystem_access: 'read-only', enabled: 1,
      },
      {
        id: 'sbx-permissive', name: 'Permissive Sandbox', description: 'Relaxed sandbox for trusted internal code with network access',
        max_cpu_ms: 120000, max_memory_mb: 512, max_duration_ms: 300000, max_output_bytes: 10485760,
        allowed_modules: null, denied_modules: JSON.stringify(['child_process', 'cluster']),
        network_access: 1, filesystem_access: 'read-write', enabled: 1,
      },
    ];
    for (const p of sandboxPolicies) await this.createSandboxPolicy(p);
    }

    // Extraction Pipelines
    if (cnt('extraction_pipelines') === 0) {
    const extractionPipelines: Omit<ExtractionPipelineRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'ext-full', name: 'Full Extraction', description: 'Runs all extraction stages: metadata, language, entities, tables, code, tasks, timeline',
        stages: JSON.stringify([
          { type: 'metadata', enabled: true, order: 1 },
          { type: 'language', enabled: true, order: 2 },
          { type: 'entities', enabled: true, order: 3 },
          { type: 'tables', enabled: true, order: 4 },
          { type: 'code', enabled: true, order: 5 },
          { type: 'tasks', enabled: true, order: 6 },
          { type: 'timeline', enabled: true, order: 7 },
        ]),
        input_mime_types: JSON.stringify(['text/plain', 'text/markdown', 'text/html', 'application/pdf']),
        max_input_size_bytes: 10485760, enabled: 1,
      },
      {
        id: 'ext-code-only', name: 'Code Extraction', description: 'Extracts code blocks and related entities from technical documents',
        stages: JSON.stringify([
          { type: 'metadata', enabled: true, order: 1 },
          { type: 'code', enabled: true, order: 2 },
          { type: 'entities', enabled: true, order: 3 },
        ]),
        input_mime_types: JSON.stringify(['text/plain', 'text/markdown']),
        max_input_size_bytes: 5242880, enabled: 1,
      },
      {
        id: 'ext-tasks-timeline', name: 'Tasks & Timeline', description: 'Extracts tasks, deadlines, and chronological events',
        stages: JSON.stringify([
          { type: 'metadata', enabled: true, order: 1 },
          { type: 'tasks', enabled: true, order: 2 },
          { type: 'timeline', enabled: true, order: 3 },
          { type: 'entities', enabled: true, order: 4 },
        ]),
        input_mime_types: JSON.stringify(['text/plain', 'text/markdown', 'text/html']),
        max_input_size_bytes: 5242880, enabled: 1,
      },
    ];
    for (const p of extractionPipelines) await this.createExtractionPipeline(p);
    }

    // Artifact Policies
    if (cnt('artifact_policies') === 0) {
    const artifactPolicies: Omit<ArtifactPolicyRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'artpol-default', name: 'Default Artifact Policy', description: 'Standard artifact policy with 100MB limit and 90-day retention',
        max_size_bytes: 104857600, allowed_types: JSON.stringify(['text', 'csv', 'json', 'html', 'markdown', 'image', 'code', 'report']),
        retention_days: 90, require_versioning: 1, enabled: 1,
      },
      {
        id: 'artpol-strict', name: 'Strict Artifact Policy', description: 'Restrictive policy for sensitive environments — small size limit, short retention',
        max_size_bytes: 10485760, allowed_types: JSON.stringify(['text', 'json', 'csv']),
        retention_days: 30, require_versioning: 1, enabled: 1,
      },
      {
        id: 'artpol-large', name: 'Large Artifact Policy', description: 'Policy for large outputs — PDFs, reports, diagrams — with extended retention',
        max_size_bytes: 1073741824, allowed_types: JSON.stringify(['text', 'csv', 'json', 'html', 'markdown', 'image', 'pdf', 'diagram', 'code', 'report', 'custom']),
        retention_days: 365, require_versioning: 1, enabled: 1,
      },
    ];
    for (const p of artifactPolicies) await this.createArtifactPolicy(p);
    }

    // Reliability Policies
    if (cnt('reliability_policies') === 0) {
    const reliabilityPolicies: Omit<ReliabilityPolicyRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'rel-retry-default', name: 'Default Retry', description: 'Standard exponential backoff retry for transient failures',
        policy_type: 'retry', max_retries: 3, initial_delay_ms: 1000, max_delay_ms: 30000, backoff_multiplier: 2.0,
        max_concurrent: null, queue_size: null, strategy: null, ttl_ms: null, enabled: 1,
      },
      {
        id: 'rel-retry-aggressive', name: 'Aggressive Retry', description: 'More retries with shorter delays for critical operations',
        policy_type: 'retry', max_retries: 5, initial_delay_ms: 500, max_delay_ms: 15000, backoff_multiplier: 1.5,
        max_concurrent: null, queue_size: null, strategy: null, ttl_ms: null, enabled: 1,
      },
      {
        id: 'rel-concurrency-std', name: 'Standard Concurrency', description: 'Limit concurrent executions with queuing for overflow',
        policy_type: 'concurrency', max_retries: null, initial_delay_ms: null, max_delay_ms: null, backoff_multiplier: null,
        max_concurrent: 10, queue_size: 50, strategy: 'queue', ttl_ms: 60000, enabled: 1,
      },
      {
        id: 'rel-idempotency', name: 'Idempotency Guard', description: 'Prevent duplicate processing within a 5-minute window',
        policy_type: 'idempotency', max_retries: null, initial_delay_ms: null, max_delay_ms: null, backoff_multiplier: null,
        max_concurrent: null, queue_size: null, strategy: null, ttl_ms: 300000, enabled: 1,
      },
    ];
    for (const p of reliabilityPolicies) await this.createReliabilityPolicy(p);
    }

    // Collaboration Sessions
    if (cnt('collaboration_sessions') === 0) {
    const collabSessions: Omit<CollaborationSessionRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'collab-pair', name: 'Pair Programming', description: 'Two-participant session for pair programming with real-time code sharing',
        session_type: 'pair', max_participants: 2, presence_ttl_ms: 30000, auto_close_idle_ms: 600000,
        handoff_enabled: 1, enabled: 1,
      },
      {
        id: 'collab-team', name: 'Team Collaboration', description: 'Multi-participant session for team brainstorming and collaborative problem solving',
        session_type: 'team', max_participants: 10, presence_ttl_ms: 60000, auto_close_idle_ms: 1800000,
        handoff_enabled: 1, enabled: 1,
      },
      {
        id: 'collab-broadcast', name: 'Broadcast Session', description: 'One-to-many session for presentations and demos with view-only participants',
        session_type: 'broadcast', max_participants: 50, presence_ttl_ms: 120000, auto_close_idle_ms: null,
        handoff_enabled: 0, enabled: 1,
      },
    ];
    for (const s of collabSessions) await this.createCollaborationSession(s);
    }

    // Compliance Rules
    if (cnt('compliance_rules') === 0) {
    const complianceRules: Omit<ComplianceRuleRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'comp-retention-90d', name: '90-Day Data Retention', description: 'Delete chat logs and metrics older than 90 days',
        rule_type: 'retention', target_resource: 'messages', retention_days: 90,
        region: null, consent_purpose: null, action: 'delete',
        config: JSON.stringify({ include_metadata: true }), enabled: 1,
      },
      {
        id: 'comp-gdpr-deletion', name: 'GDPR Right to Delete', description: 'Honor user deletion requests within 30 days per GDPR Article 17',
        rule_type: 'deletion', target_resource: '*', retention_days: null,
        region: 'EU', consent_purpose: null, action: 'delete',
        config: JSON.stringify({ cascade: true, notify_processors: true }), enabled: 1,
      },
      {
        id: 'comp-eu-residency', name: 'EU Data Residency', description: 'Ensure EU user data stays within EU regions only',
        rule_type: 'residency', target_resource: '*', retention_days: null,
        region: 'EU', consent_purpose: null, action: 'block',
        config: JSON.stringify({ allowed_regions: ['eu-west-1', 'eu-central-1', 'eu-north-1'] }), enabled: 1,
      },
      {
        id: 'comp-analytics-consent', name: 'Analytics Consent', description: 'Require explicit consent for analytics data collection',
        rule_type: 'consent', target_resource: 'metrics', retention_days: null,
        region: null, consent_purpose: 'analytics', action: 'notify',
        config: JSON.stringify({ consent_ttl_days: 365, re_consent_required: true }), enabled: 1,
      },
    ];
    for (const r of complianceRules) await this.createComplianceRule(r);
    }

    // Graph Configs
    if (cnt('graph_configs') === 0) {
    const graphConfigs: Omit<GraphConfigRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'graph-entity', name: 'Entity Knowledge Graph', description: 'General-purpose entity extraction and relationship mapping',
        graph_type: 'entity', max_depth: 3,
        entity_types: JSON.stringify(['person', 'organization', 'location', 'product', 'concept']),
        relationship_types: JSON.stringify(['works_at', 'located_in', 'related_to', 'depends_on', 'part_of']),
        auto_link: 1, scoring_weights: JSON.stringify({ relevance: 0.4, recency: 0.3, frequency: 0.3 }), enabled: 1,
      },
      {
        id: 'graph-timeline', name: 'Timeline Graph', description: 'Chronological event tracking with causal links between events',
        graph_type: 'timeline', max_depth: 5,
        entity_types: JSON.stringify(['event', 'milestone', 'decision']),
        relationship_types: JSON.stringify(['caused_by', 'preceded_by', 'concurrent_with']),
        auto_link: 1, scoring_weights: JSON.stringify({ temporal_proximity: 0.5, causal_strength: 0.5 }), enabled: 1,
      },
      {
        id: 'graph-knowledge', name: 'Knowledge Base', description: 'Long-term knowledge graph for RAG-augmented memory and retrieval',
        graph_type: 'knowledge', max_depth: 4,
        entity_types: JSON.stringify(['concept', 'definition', 'example', 'reference']),
        relationship_types: JSON.stringify(['defines', 'exemplifies', 'references', 'contradicts', 'supports']),
        auto_link: 0, scoring_weights: JSON.stringify({ semantic_similarity: 0.6, authority: 0.2, recency: 0.2 }), enabled: 1,
      },
    ];
    for (const g of graphConfigs) await this.createGraphConfig(g);
    }

    // Plugin Configs
    if (cnt('plugin_configs') === 0) {
    const pluginConfigs: Omit<PluginConfigRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'plug-code-exec', name: 'Code Execution Plugin', description: 'Sandboxed code execution for JavaScript and Python',
        plugin_type: 'official', package_name: '@weaveintel/sandbox', version: '1.0.0',
        capabilities: JSON.stringify(['code-execution', 'sandboxing']),
        trust_level: 'official', auto_update: 1,
        config: JSON.stringify({ defaultPolicy: 'sbx-moderate' }), enabled: 1,
      },
      {
        id: 'plug-web-search', name: 'Web Search Plugin', description: 'Integrate external search providers for web search capabilities',
        plugin_type: 'official', package_name: '@weaveintel/tools-search', version: '1.0.0',
        capabilities: JSON.stringify(['web-search', 'news-search']),
        trust_level: 'official', auto_update: 1,
        config: JSON.stringify({ defaultProvider: 'sp-brave' }), enabled: 1,
      },
      {
        id: 'plug-community-viz', name: 'Data Visualization', description: 'Community plugin for generating charts and data visualizations',
        plugin_type: 'community', package_name: 'weaveintel-plugin-viz', version: '0.3.2',
        capabilities: JSON.stringify(['visualization', 'chart-generation']),
        trust_level: 'community', auto_update: 0,
        config: null, enabled: 1,
      },
      {
        id: 'plug-enterprise-sso', name: 'Enterprise SSO', description: 'SAML/OIDC single sign-on integration for enterprise deployments',
        plugin_type: 'verified', package_name: 'weaveintel-plugin-sso', version: '2.1.0',
        capabilities: JSON.stringify(['authentication', 'sso', 'saml', 'oidc']),
        trust_level: 'verified', auto_update: 1,
        config: JSON.stringify({ provider: 'okta', domain: 'example.okta.com' }), enabled: 0,
      },
    ];
    for (const p of pluginConfigs) await this.createPluginConfig(p);
    }

    // Scaffold Templates (Phase 9)
    if (cnt('scaffold_templates') === 0) {
    const scaffoldTemplates: Omit<ScaffoldTemplateRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'scaf-basic-agent', name: 'Basic Agent', description: 'Minimal conversational agent with a single model',
        template_type: 'basic-agent',
        files: JSON.stringify({ 'src/index.ts': 'import { createAgent } from "@weaveintel/agents";\n\nconst agent = createAgent({ name: "{{name}}", model: "{{model}}" });\n' }),
        dependencies: JSON.stringify({ '@weaveintel/agents': '*', '@weaveintel/core': '*' }),
        dev_dependencies: JSON.stringify({ 'typescript': '^5.0.0' }),
        variables: JSON.stringify(['name', 'model']),
        post_install: null, enabled: 1,
      },
      {
        id: 'scaf-tool-agent', name: 'Tool-Calling Agent', description: 'Agent with tool registration and execution capabilities',
        template_type: 'tool-calling-agent',
        files: JSON.stringify({ 'src/index.ts': 'import { createAgent } from "@weaveintel/agents";\nimport { defineTool } from "@weaveintel/core";\n' }),
        dependencies: JSON.stringify({ '@weaveintel/agents': '*', '@weaveintel/core': '*' }),
        dev_dependencies: JSON.stringify({ 'typescript': '^5.0.0' }),
        variables: JSON.stringify(['name', 'model']),
        post_install: null, enabled: 1,
      },
      {
        id: 'scaf-rag-pipeline', name: 'RAG Pipeline', description: 'Retrieval-augmented generation pipeline with vector search',
        template_type: 'rag-pipeline',
        files: JSON.stringify({ 'src/index.ts': 'import { createAgent } from "@weaveintel/agents";\nimport { createRetriever } from "@weaveintel/retrieval";\n' }),
        dependencies: JSON.stringify({ '@weaveintel/agents': '*', '@weaveintel/core': '*', '@weaveintel/retrieval': '*' }),
        dev_dependencies: JSON.stringify({ 'typescript': '^5.0.0' }),
        variables: JSON.stringify(['name', 'model', 'collection']),
        post_install: null, enabled: 1,
      },
      {
        id: 'scaf-workflow', name: 'Workflow', description: 'Multi-step workflow with agent orchestration',
        template_type: 'workflow',
        files: JSON.stringify({ 'src/index.ts': 'import { createWorkflow } from "@weaveintel/workflows";\n' }),
        dependencies: JSON.stringify({ '@weaveintel/agents': '*', '@weaveintel/core': '*', '@weaveintel/workflows': '*' }),
        dev_dependencies: JSON.stringify({ 'typescript': '^5.0.0' }),
        variables: JSON.stringify(['name']),
        post_install: null, enabled: 1,
      },
      {
        id: 'scaf-multi-agent', name: 'Multi-Agent', description: 'Supervisor with multiple worker agents',
        template_type: 'multi-agent',
        files: JSON.stringify({ 'src/index.ts': 'import { createSupervisor } from "@weaveintel/agents";\n' }),
        dependencies: JSON.stringify({ '@weaveintel/agents': '*', '@weaveintel/core': '*' }),
        dev_dependencies: JSON.stringify({ 'typescript': '^5.0.0' }),
        variables: JSON.stringify(['name', 'workers']),
        post_install: null, enabled: 1,
      },
      {
        id: 'scaf-mcp-server', name: 'MCP Server', description: 'Model Context Protocol server exposing tools over stdio/SSE',
        template_type: 'mcp-server',
        files: JSON.stringify({ 'src/index.ts': 'import { createMcpServer } from "@weaveintel/mcp-server";\n' }),
        dependencies: JSON.stringify({ '@weaveintel/mcp-server': '*', '@weaveintel/core': '*' }),
        dev_dependencies: JSON.stringify({ 'typescript': '^5.0.0' }),
        variables: JSON.stringify(['name', 'transport']),
        post_install: null, enabled: 1,
      },
      {
        id: 'scaf-full-stack', name: 'Full-Stack App', description: 'Complete application with geneWeave UI, agents, tools, and observability',
        template_type: 'full-stack',
        files: JSON.stringify({ 'src/index.ts': 'import { startGeneWeave } from "@weaveintel/geneweave";\n' }),
        dependencies: JSON.stringify({ '@weaveintel/geneweave': '*', '@weaveintel/agents': '*', '@weaveintel/core': '*', '@weaveintel/observability': '*' }),
        dev_dependencies: JSON.stringify({ 'typescript': '^5.0.0', '@playwright/test': '^1.59.0' }),
        variables: JSON.stringify(['name', 'model', 'provider']),
        post_install: 'npx playwright install', enabled: 1,
      },
    ];
    for (const t of scaffoldTemplates) await this.createScaffoldTemplate(t);
    }

    // Recipe Configs (Phase 9)
    if (cnt('recipe_configs') === 0) {
    const recipeConfigs: Omit<RecipeConfigRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'rcp-workflow', name: 'Workflow Agent', description: 'Workflow-aware agent with step-by-step execution',
        recipe_type: 'workflow', model: 'gpt-4o', provider: 'openai',
        system_prompt: 'You are a workflow executor. Follow the steps precisely.',
        tools: JSON.stringify(['web-search', 'file-reader']),
        guardrails: JSON.stringify(['guard-token-limit']),
        max_steps: 10, options: null, enabled: 1,
      },
      {
        id: 'rcp-governed', name: 'Governed Assistant', description: 'Assistant with governance rules enforced in system prompt',
        recipe_type: 'governed', model: 'gpt-4o', provider: 'openai',
        system_prompt: 'You are a governed assistant. Follow all policies strictly.',
        tools: null,
        guardrails: JSON.stringify(['guard-pii-redact', 'guard-toxicity']),
        max_steps: 5, options: JSON.stringify({ governanceLevel: 'strict' }), enabled: 1,
      },
      {
        id: 'rcp-approval', name: 'Approval-Driven Agent', description: 'Agent that requires human approval for high-risk actions',
        recipe_type: 'approval', model: 'gpt-4o', provider: 'openai',
        system_prompt: null,
        tools: JSON.stringify(['code-exec', 'db-query']),
        guardrails: null,
        max_steps: 8, options: JSON.stringify({ approvalPolicy: 'htp-high-risk-tool' }), enabled: 1,
      },
      {
        id: 'rcp-acl-rag', name: 'ACL-Aware RAG', description: 'Retrieval agent with access-control-scoped collections',
        recipe_type: 'acl-rag', model: 'gpt-4o-mini', provider: 'openai',
        system_prompt: 'You answer questions using only the provided context.',
        tools: JSON.stringify(['web-search']),
        guardrails: JSON.stringify(['guard-hallucination']),
        max_steps: 5, options: JSON.stringify({ collection: 'default' }), enabled: 1,
      },
      {
        id: 'rcp-safe-exec', name: 'Safe Execution Agent', description: 'Agent with denied tools and defensive execution limits',
        recipe_type: 'safe-exec', model: 'gpt-4o-mini', provider: 'openai',
        system_prompt: 'You are a safe execution agent. Never execute dangerous operations.',
        tools: JSON.stringify(['file-reader', 'api-caller']),
        guardrails: JSON.stringify(['guard-pii-redact', 'guard-token-limit']),
        max_steps: 5, options: JSON.stringify({ maxExecutionTime: 30000, deniedTools: ['code-exec'] }), enabled: 1,
      },
    ];
    for (const r of recipeConfigs) await this.createRecipeConfig(r);
    }

    // Widget Configs (Phase 9)
    if (cnt('widget_configs') === 0) {
    const widgetConfigs: Omit<WidgetConfigRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'wgt-table', name: 'Data Table', description: 'Sortable, filterable data table for structured results',
        widget_type: 'table',
        default_options: JSON.stringify({ sortable: true, filterable: true, pageSize: 25 }),
        allowed_contexts: JSON.stringify(['chat', 'dashboard', 'admin']),
        max_data_points: 10000, refresh_interval_ms: null, enabled: 1,
      },
      {
        id: 'wgt-chart', name: 'Chart', description: 'Line, bar, or pie chart for data visualization',
        widget_type: 'chart',
        default_options: JSON.stringify({ chartType: 'line', showLegend: true, responsive: true }),
        allowed_contexts: JSON.stringify(['chat', 'dashboard']),
        max_data_points: 5000, refresh_interval_ms: 30000, enabled: 1,
      },
      {
        id: 'wgt-form', name: 'Dynamic Form', description: 'Interactive form widget for collecting structured input',
        widget_type: 'form',
        default_options: JSON.stringify({ submitLabel: 'Submit', resetLabel: 'Reset' }),
        allowed_contexts: JSON.stringify(['chat']),
        max_data_points: null, refresh_interval_ms: null, enabled: 1,
      },
      {
        id: 'wgt-code', name: 'Code Block', description: 'Syntax-highlighted code viewer with copy and download',
        widget_type: 'code',
        default_options: JSON.stringify({ lineNumbers: true, theme: 'dark', wordWrap: false }),
        allowed_contexts: JSON.stringify(['chat', 'dashboard', 'admin']),
        max_data_points: null, refresh_interval_ms: null, enabled: 1,
      },
      {
        id: 'wgt-timeline', name: 'Timeline', description: 'Chronological event timeline for workflow and trace visualisation',
        widget_type: 'timeline',
        default_options: JSON.stringify({ direction: 'vertical', showDuration: true }),
        allowed_contexts: JSON.stringify(['chat', 'dashboard']),
        max_data_points: 500, refresh_interval_ms: 10000, enabled: 1,
      },
      {
        id: 'wgt-image', name: 'Image', description: 'Image display widget with zoom and lightbox support',
        widget_type: 'image',
        default_options: JSON.stringify({ maxWidth: '100%', lightbox: true }),
        allowed_contexts: JSON.stringify(['chat']),
        max_data_points: null, refresh_interval_ms: null, enabled: 1,
      },
    ];
    for (const w of widgetConfigs) await this.createWidgetConfig(w);
    }

    // Validation Rules (Phase 9)
    if (cnt('validation_rules') === 0) {
    const validationRules: Omit<ValidationRuleRow, 'created_at' | 'updated_at'>[] = [
      {
        id: 'val-agent-name', name: 'Agent Name Required', description: 'Every agent config must have a non-empty name',
        rule_type: 'required', target: 'agent-config',
        condition: JSON.stringify({ field: 'name', operator: 'exists' }),
        severity: 'error', message: 'Agent name is required', enabled: 1,
      },
      {
        id: 'val-agent-steps', name: 'Agent Max Steps Range', description: 'Max steps must be between 1 and 100',
        rule_type: 'range', target: 'agent-config',
        condition: JSON.stringify({ field: 'maxSteps', min: 1, max: 100 }),
        severity: 'error', message: 'Max steps must be between 1 and 100', enabled: 1,
      },
      {
        id: 'val-workflow-entry', name: 'Workflow Entry Step', description: 'Workflow must define a valid entry step ID',
        rule_type: 'required', target: 'workflow-config',
        condition: JSON.stringify({ field: 'entry_step_id', operator: 'exists' }),
        severity: 'error', message: 'Workflow must have an entry step', enabled: 1,
      },
      {
        id: 'val-tool-risk', name: 'Tool Risk Level', description: 'High-risk tools should require approval',
        rule_type: 'custom', target: 'tool-config',
        condition: JSON.stringify({ if: { field: 'risk_level', equals: 'high' }, then: { field: 'requires_approval', equals: true } }),
        severity: 'warning', message: 'High-risk tools should require approval', enabled: 1,
      },
      {
        id: 'val-json-fields', name: 'Valid JSON Fields', description: 'Fields marked as JSON must contain valid JSON or be null',
        rule_type: 'custom', target: 'agent-config',
        condition: JSON.stringify({ fields: ['tools', 'guardrails', 'metadata'], validate: 'json' }),
        severity: 'error', message: 'JSON fields must contain valid JSON', enabled: 1,
      },
    ];
    for (const r of validationRules) await this.createValidationRule(r);
    }
  }
}

// ─── Factory ─────────────────────────────────────────────────


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
