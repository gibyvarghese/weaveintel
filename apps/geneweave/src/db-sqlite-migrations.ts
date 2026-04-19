import type BetterSqlite3 from 'better-sqlite3';

function safeExec(db: BetterSqlite3.Database, sql: string): void {
  try {
    db.exec(sql);
  } catch {
    // Ignore migration errors so existing databases can continue bootstrapping.
  }
}

export function applySQLiteBootstrapMigrations(db: BetterSqlite3.Database): void {
  safeExec(db, `CREATE TABLE IF NOT EXISTS user_preferences (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    default_mode TEXT NOT NULL DEFAULT 'agent',
    theme TEXT NOT NULL DEFAULT 'light',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  safeExec(db, `CREATE TABLE IF NOT EXISTS chat_settings (
    chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
    mode TEXT NOT NULL DEFAULT 'agent',
    system_prompt TEXT,
    timezone TEXT,
    enabled_tools TEXT,
    redaction_enabled INTEGER NOT NULL DEFAULT 1,
    redaction_patterns TEXT,
    workers TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  safeExec(db, 'ALTER TABLE chat_settings ADD COLUMN timezone TEXT');
  safeExec(db, "ALTER TABLE user_preferences ADD COLUMN theme TEXT NOT NULL DEFAULT 'light'");
  safeExec(db, "ALTER TABLE users ADD COLUMN persona TEXT NOT NULL DEFAULT 'tenant_user'");
  safeExec(db, 'ALTER TABLE users ADD COLUMN tenant_id TEXT');

  safeExec(db, 'ALTER TABLE prompts ADD COLUMN key TEXT');
  safeExec(db, "ALTER TABLE prompts ADD COLUMN prompt_type TEXT NOT NULL DEFAULT 'template'");
  safeExec(db, 'ALTER TABLE prompts ADD COLUMN owner TEXT');
  safeExec(db, "ALTER TABLE prompts ADD COLUMN status TEXT NOT NULL DEFAULT 'published'");
  safeExec(db, 'ALTER TABLE prompts ADD COLUMN tags TEXT');
  safeExec(db, 'ALTER TABLE prompts ADD COLUMN model_compatibility TEXT');
  safeExec(db, 'ALTER TABLE prompts ADD COLUMN execution_defaults TEXT');
  safeExec(db, 'ALTER TABLE prompts ADD COLUMN framework TEXT');
  safeExec(db, 'ALTER TABLE prompts ADD COLUMN metadata TEXT');

  safeExec(db, `CREATE TABLE IF NOT EXISTS prompt_strategies (
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
  )`);

  safeExec(db, `CREATE TABLE IF NOT EXISTS prompt_versions (
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
  )`);

  safeExec(db, `CREATE TABLE IF NOT EXISTS prompt_experiments (
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
  )`);

  safeExec(db, `CREATE TABLE IF NOT EXISTS prompt_eval_datasets (
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
  )`);

  safeExec(db, `CREATE TABLE IF NOT EXISTS prompt_eval_runs (
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
  )`);

  safeExec(db, `CREATE TABLE IF NOT EXISTS prompt_optimizers (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    implementation_kind TEXT NOT NULL DEFAULT 'rule',
    config TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  safeExec(db, `CREATE TABLE IF NOT EXISTS prompt_optimization_runs (
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
  )`);

  // Intentionally repeated to preserve existing bootstrap behavior/order.
  safeExec(db, `CREATE TABLE IF NOT EXISTS prompt_versions (
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
  )`);

  // Intentionally repeated to preserve existing bootstrap behavior/order.
  safeExec(db, `CREATE TABLE IF NOT EXISTS prompt_experiments (
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
  )`);

  safeExec(db, `CREATE TABLE IF NOT EXISTS semantic_memory (
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

  safeExec(db, `CREATE TABLE IF NOT EXISTS entity_memory (
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

  safeExec(db, 'ALTER TABLE entity_memory ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5');
  safeExec(db, "ALTER TABLE entity_memory ADD COLUMN source TEXT NOT NULL DEFAULT 'regex'");

  safeExec(db, `CREATE TABLE IF NOT EXISTS memory_extraction_events (
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

  safeExec(db, `CREATE TABLE IF NOT EXISTS website_credentials (
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

  safeExec(db, `CREATE TABLE IF NOT EXISTS sso_linked_accounts (
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

  safeExec(db, `CREATE TABLE IF NOT EXISTS oauth_linked_accounts (
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
}
