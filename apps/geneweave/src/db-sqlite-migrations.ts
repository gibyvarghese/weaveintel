import type BetterSqlite3 from 'better-sqlite3';

function safeExec(db: BetterSqlite3.Database, sql: string): void {
  try {
    db.exec(sql);
  } catch {
    // Ignore migration errors so existing databases can continue bootstrapping.
  }
  // ─── M16 — Phase K7b: Adversarial validation, finalizer, CV/LB gap ──────
  // Design doc: docs/KAGGLE_AGENT_DESIGN.md §8b.3 (Phase K7b).
  //
  // (1) ALTER kaggle_runs: add private_score, is_final_pick, finalized_at, cv_lb_gap
  // (2) Seed kaggle.local.adversarial_validation tool_catalog row (disabled)
  // (3) Seed kaggle_finalizer skill (enabled=1, priority 80)
  const k7bAlters = [
    `ALTER TABLE kaggle_runs ADD COLUMN private_score REAL`,
    `ALTER TABLE kaggle_runs ADD COLUMN is_final_pick INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE kaggle_runs ADD COLUMN finalized_at TEXT`,
    `ALTER TABLE kaggle_runs ADD COLUMN cv_lb_gap REAL`,
  ];
  for (const sql of k7bAlters) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }

  // ─── M17 — Phase K7c: kernel-based hyperparameter search, iterator ──────
  // Design doc: docs/KAGGLE_AGENT_DESIGN.md §8b.4 (Phase K7c).
  // (1) ALTER kaggle_runs: add kernel_ref, kernel_outputs, search_results
  // (2) Seed kaggle.kernel.optimize_hyperparams tool_catalog row (disabled)
  // (3) Seed kaggle_iterator skill (enabled=1, priority 60)
  const k7cAlters = [
    `ALTER TABLE kaggle_runs ADD COLUMN kernel_ref TEXT`,
    `ALTER TABLE kaggle_runs ADD COLUMN kernel_outputs TEXT`,
    `ALTER TABLE kaggle_runs ADD COLUMN search_results TEXT`,
  ];
  for (const sql of k7cAlters) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }

  try {
    db.prepare(
      `INSERT OR IGNORE INTO tool_catalog (
        id, name, description, category, risk_level, requires_approval,
        max_execution_ms, rate_limit_per_min, enabled,
        tool_key, version, side_effects, tags, source, credential_id,
        config, allocation_class, created_at, updated_at
      ) VALUES (?, ?, ?, 'kaggle', 'read-only', 0, ?, 5, 0, ?, '0.3.0', 0, ?, 'mcp', NULL, ?, 'data', datetime('now'), datetime('now'))`,
    ).run(
      'kgl00000-0000-4000-8000-000000000030',
      'Kaggle: Hyperparameter Search (kernel)',
      'Run hyperparameter search via Optuna in a Kaggle kernel. Pushes a notebook, polls for completion, and fetches best params and search history. Requires kaggle-runner image v0.3.0+.',
      600_000,
      'kaggle.kernel.optimize_hyperparams',
      JSON.stringify(['kaggle', 'mcp', 'kernel', 'optuna', 'search', 'hyperparam']),
      JSON.stringify({ endpoint: 'http://localhost:7421/mcp' }),
    );
  } catch { /* ignore */ }

  try {
    db.prepare(
      `INSERT OR IGNORE INTO skills (
        id, name, description, category, trigger_patterns, instructions,
        tool_names, examples, tags, priority, version, tool_policy_key,
        enabled, supervisor_agent_id, domain_sections, execution_contract,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'data', ?, ?, ?, NULL, ?, 60, '1.0', ?, 1, NULL, NULL, ?, datetime('now'), datetime('now'))`,
    ).run(
      'kgl00000-0000-4000-8002-000000000010',
      'kaggle_iterator',
      'Runs hyperparameter search using Optuna in a Kaggle kernel. Collaborates with implementer; spawns search jobs between approach generation and submission.',
      JSON.stringify(['hyperparameter search', 'optimize model', 'run optuna', 'search params', 'find best params']),
      [
        'When to use: after approach generation, before submission, when the user or strategist requests hyperparameter optimization.',
        'When NOT to use: if the approach is already optimized, or the user declines search.',
        'Reasoning: hyperparameter search can yield significant performance gains with minimal manual effort.',
      ].join('\n'),
      JSON.stringify(['kaggle.kernel.optimize_hyperparams']),
      JSON.stringify(['kaggle', 'data-science', 'iterator', 'search', 'optuna']),
      'kaggle_read_only',
      JSON.stringify({ requiredOutputSubstrings: ['bestParams', 'searchHistory', 'kernelRef'] }),
    );
  } catch { /* ignore */ }

  try {
    db.prepare(
      `INSERT OR IGNORE INTO tool_catalog (
        id, name, description, category, risk_level, requires_approval,
        max_execution_ms, rate_limit_per_min, enabled,
        tool_key, version, side_effects, tags, source, credential_id,
        config, allocation_class, created_at, updated_at
      ) VALUES (?, ?, ?, 'kaggle', 'read-only', 0, ?, NULL, 0, ?, '0.2.0', 0, ?, 'mcp', NULL, ?, 'data', datetime('now'), datetime('now'))`,
    ).run(
      'kgl00000-0000-4000-8000-000000000029',
      'Kaggle: Adversarial Validation (sandboxed)',
      'Detect train/test distribution shift by fitting a classifier to distinguish train/test rows. Returns AUC, logloss, and top features by importance. Runs in a sandboxed Python container. No network, no credentials. Requires kaggle-runner image v0.2.0+ in the host ImagePolicy.',
      120_000,
      'kaggle.local.adversarial_validation',
      JSON.stringify(['kaggle', 'mcp', 'local', 'sandbox', 'drift', 'adversarial']),
      JSON.stringify({ endpoint: 'http://localhost:7421/mcp' }),
    );
  } catch { /* ignore */ }

  try {
    db.prepare(
      `INSERT OR IGNORE INTO skills (
        id, name, description, category, trigger_patterns, instructions,
        tool_names, examples, tags, priority, version, tool_policy_key,
        enabled, supervisor_agent_id, domain_sections, execution_contract,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'data', ?, ?, ?, NULL, ?, 80, '1.0', ?, 1, NULL, NULL, ?, datetime('now'), datetime('now'))`,
    ).run(
      'kgl00000-0000-4000-8002-000000000009',
      'kaggle_finalizer',
      'Picks the final 2 submissions for a Kaggle competition based on CV/LB gap and diversity. Sets is_final_pick=1 on the chosen kaggle_runs rows. Read-only — does not submit; hand off to kaggle_submitter for actual submission.',
      JSON.stringify(['finalize kaggle', 'pick final submissions', 'select final', 'finalize competition', 'choose final runs']),
      [
        'When to use: 24h before competition deadline, at least one submitted run exists. The user has asked to finalize or pick the best submissions.',
        'When NOT to use: no runs exist, or the deadline is not near, or the user wants to submit (hand off to kaggle_submitter).',
        'Reasoning: picking the right final submissions is critical for maximizing private LB placement. The skill picks (a) the highest CV run with gap near the median, and (b) the most diverse high-CV ensemble.',
        'Execution: compute cv_lb_gap for each run (public_score - cv_score), pick two: (1) highest CV with |gap| < median(gaps), (2) most diverse high-CV ensemble. Set is_final_pick=1 and finalized_at=now on both.',
        'Completion: report the chosen run ids, their CV/LB scores, and the rationale for each pick. State explicitly which is the "trust your CV" and which is the "diverse swing" choice.',
      ].join('\n'),
      JSON.stringify(['kaggle.local.adversarial_validation']),
      JSON.stringify(['kaggle', 'data-science', 'finalizer', 'selection']),
      'kaggle_read_only',
      JSON.stringify({ requiredOutputSubstrings: ['is_final_pick', 'cv_lb_gap', 'finalized_at'] }),
    );
  } catch { /* ignore */ }
}

export function applySQLiteBootstrapMigrations(db: BetterSqlite3.Database): void {
  safeExec(db, `CREATE TABLE IF NOT EXISTS user_preferences (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    default_mode TEXT NOT NULL DEFAULT 'agent',
    theme TEXT NOT NULL DEFAULT 'light',
    show_process_card INTEGER NOT NULL DEFAULT 1,
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
  safeExec(db, 'ALTER TABLE user_preferences ADD COLUMN show_process_card INTEGER NOT NULL DEFAULT 1');
  safeExec(db, "ALTER TABLE users ADD COLUMN persona TEXT NOT NULL DEFAULT 'tenant_user'");
  safeExec(db, 'ALTER TABLE users ADD COLUMN tenant_id TEXT');

  safeExec(db, `CREATE TABLE IF NOT EXISTS idempotency_records (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    result_json TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_idempotency_expires_at ON idempotency_records(expires_at)');

  safeExec(db, `CREATE TABLE IF NOT EXISTS oauth_flow_states (
    id TEXT PRIMARY KEY,
    state_key TEXT NOT NULL UNIQUE,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_oauth_flow_states_expires_at ON oauth_flow_states(expires_at)');

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

  // Migrate seed record IDs from human-readable slugs to stable UUIDs
  // prompts
  safeExec(db, `UPDATE prompts SET id = 'e92e7672-3009-4040-8b05-a411dc825f90' WHERE id = 'prompt-general-assistant'`);
  safeExec(db, `UPDATE prompts SET id = 'e7c21e36-c558-40e0-9b99-2433c0466bc3' WHERE id = 'prompt-code-reviewer'`);
  safeExec(db, `UPDATE prompts SET id = '14b189df-1307-4041-ab1b-2a784df9d304' WHERE id = 'prompt-summarizer'`);
  safeExec(db, `UPDATE prompts SET id = '906cdfa7-35f4-4d39-a0ea-d099207570dc' WHERE id = 'prompt-sql-expert'`);
  safeExec(db, `UPDATE prompts SET id = 'f68c3785-469c-4d2b-a2c2-366c5bc3b4d2' WHERE id = 'prompt-runtime-supervisor-code-execution'`);
  safeExec(db, `UPDATE prompts SET id = '4aecf467-a350-42f9-aeca-550fcc4383a2' WHERE id = 'prompt-runtime-response-card-format'`);
  safeExec(db, `UPDATE prompts SET id = 'b3722c76-fc46-4392-ab8e-3f39b0fce3dc' WHERE id = 'prompt-runtime-supervisor-temporal'`);
  safeExec(db, `UPDATE prompts SET id = '338ee839-adee-43cb-9dd4-34e53333b997' WHERE id = 'prompt-runtime-multi-worker-pipeline'`);
  safeExec(db, `UPDATE prompts SET id = '044e122c-67cf-4bb3-9ad3-090bd937b6c8' WHERE id = 'prompt-runtime-force-worker-data-analysis'`);
  safeExec(db, `UPDATE prompts SET id = '5f58d48f-931f-4b1f-a418-e9b43d545dc8' WHERE id = 'prompt-runtime-hard-execution-guard'`);
  safeExec(db, `UPDATE prompts SET id = 'dc61ee37-5268-4e8b-af36-22d6124d99b6' WHERE id = 'prompt-runtime-enterprise-worker-system'`);
  // prompt_frameworks
  safeExec(db, `UPDATE prompt_frameworks SET id = '21f6a792-9267-4444-bdbc-ff7c2d4298f9' WHERE id = 'framework-rtce'`);
  safeExec(db, `UPDATE prompt_frameworks SET id = '7b55952c-4f80-40ca-81ea-461bab97c672' WHERE id = 'framework-full'`);
  safeExec(db, `UPDATE prompt_frameworks SET id = 'eadfbd4d-039b-4993-a89e-82e1a9175b70' WHERE id = 'framework-critique'`);
  safeExec(db, `UPDATE prompt_frameworks SET id = 'df2c712c-6fcb-4048-a1ff-aee1026571fa' WHERE id = 'framework-judge'`);
  // prompt_fragments
  safeExec(db, `UPDATE prompt_fragments SET id = '34959c97-a4a1-48bd-ac09-9ac176a887fb' WHERE id = 'fragment-safety-notice'`);
  safeExec(db, `UPDATE prompt_fragments SET id = '6d71697a-1132-4fa6-908b-3afbd7016e9c' WHERE id = 'fragment-json-output-contract'`);
  safeExec(db, `UPDATE prompt_fragments SET id = '7c0fcd6a-90e6-4ee2-9380-62153157428c' WHERE id = 'fragment-cot-instruction'`);
  safeExec(db, `UPDATE prompt_fragments SET id = 'a0999e98-3dc6-4c9b-95ea-4e62c1abd53b' WHERE id = 'fragment-language-notice'`);
  safeExec(db, `UPDATE prompt_fragments SET id = '6caa8594-41c4-4664-b91d-40ec8513ccc6' WHERE id = 'fragment-persona-analyst'`);
  safeExec(db, `UPDATE prompt_fragments SET id = 'de14761d-5c2f-46a5-a837-dc2760b0d90c' WHERE id = 'fragment-persona-assistant'`);
  // prompt_strategies
  safeExec(db, `UPDATE prompt_strategies SET id = '1006723f-a866-4762-ad8b-b572a7e71f4c' WHERE id = 'strategy-single-pass'`);
  safeExec(db, `UPDATE prompt_strategies SET id = '1ae56ebf-7e13-4459-bee4-c3e2f9e75299' WHERE id = 'strategy-deliberate'`);
  safeExec(db, `UPDATE prompt_strategies SET id = 'cc57decf-8262-43f1-acfa-d65bdbaa720d' WHERE id = 'strategy-critique-revise'`);
  // prompt_optimizers
  safeExec(db, `UPDATE prompt_optimizers SET id = 'a057bba1-7e06-438e-9c31-1e5489810447' WHERE id = 'optimizer-constraint-appender'`);
  safeExec(db, `UPDATE prompt_optimizers SET id = '5c0497a0-1165-4947-b678-5f01bd900db7' WHERE id = 'optimizer-llm-judge-refine'`);
  // guardrails
  safeExec(db, `UPDATE guardrails SET id = '0370fa22-5fc8-49a4-bd4c-3e39863da61d' WHERE id = 'guard-pii-redact'`);
  safeExec(db, `UPDATE guardrails SET id = '51586988-83b7-4780-a006-b3b86b76713f' WHERE id = 'guard-toxicity'`);
  safeExec(db, `UPDATE guardrails SET id = '1a6b5225-07c6-41cc-878f-c0d08930c1de' WHERE id = 'guard-token-limit'`);
  safeExec(db, `UPDATE guardrails SET id = '8ae24528-463a-4dfa-9348-a2be5214de9f' WHERE id = 'guard-hallucination'`);
  safeExec(db, `UPDATE guardrails SET id = '58897b64-39ca-457c-8e8b-8ce4ffc33aa5' WHERE id = 'guard-cog-pre-sycophancy'`);
  safeExec(db, `UPDATE guardrails SET id = '70469180-6265-47d8-82c6-ee3cec180bc6' WHERE id = 'guard-cog-pre-confidence'`);
  safeExec(db, `UPDATE guardrails SET id = 'e6f04e4f-29bb-4081-a9e8-ef66dba939bf' WHERE id = 'guard-cog-post-grounding'`);
  safeExec(db, `UPDATE guardrails SET id = 'f9e2ec15-8243-4884-9056-a5cf79af9800' WHERE id = 'guard-cog-post-sycophancy'`);
  safeExec(db, `UPDATE guardrails SET id = 'af3ed9ac-b3ca-4d10-bf80-678e4a750389' WHERE id = 'guard-cog-post-devils-advocate'`);
  safeExec(db, `UPDATE guardrails SET id = '4ace09e3-5aa8-4761-8d7c-e56f81ae84dd' WHERE id = 'guard-cog-post-confidence'`);
  safeExec(db, `UPDATE guardrails SET id = '7c8988ba-b7c9-4e52-8139-732e5c922a25' WHERE id = 'guard-injection-directive-override'`);
  safeExec(db, `UPDATE guardrails SET id = '0eb8ae21-e411-4dae-921f-3f91651619d9' WHERE id = 'guard-injection-prompt-exfil'`);
  // routing_rules
  safeExec(db, `UPDATE routing_rules SET id = 'a2cdb3b9-cd89-48d8-884d-ce617a9ca328' WHERE id = 'route-cost-optimized'`);
  safeExec(db, `UPDATE routing_rules SET id = 'eea58ad8-5c94-4aba-98ce-850c4a567e31' WHERE id = 'route-quality-first'`);
  safeExec(db, `UPDATE routing_rules SET id = 'b6bcb4e8-16e2-4c40-b5a6-50bc15912c23' WHERE id = 'route-balanced'`);
  // model_providers
  safeExec(db, `UPDATE model_providers SET id = '24c261e4-3cd0-48da-aba5-ad65cdc4ba84' WHERE id = 'mp-claude-sonnet-4'`);
  safeExec(db, `UPDATE model_providers SET id = '3a01332c-7062-46f4-ac27-23718d0b7e11' WHERE id = 'mp-claude-opus-4'`);
  safeExec(db, `UPDATE model_providers SET id = '7a159bca-cd4a-4008-9adf-537d3f9087a5' WHERE id = 'mp-claude-haiku-4'`);
  safeExec(db, `UPDATE model_providers SET id = 'd544e807-dd8b-45fc-8d7c-4c35b00fe34c' WHERE id = 'mp-gpt-4o'`);
  safeExec(db, `UPDATE model_providers SET id = '453e9a1e-b374-436b-bbed-58ba0a0db737' WHERE id = 'mp-gpt-4o-mini'`);
  safeExec(db, `UPDATE model_providers SET id = '5a851707-9a6f-434f-9c8f-e6bc02647e90' WHERE id = 'mp-gpt-4.1'`);
  safeExec(db, `UPDATE model_providers SET id = 'b2c6d495-f58e-40f1-aff2-d58050aabedb' WHERE id = 'mp-gpt-4.1-mini'`);
  safeExec(db, `UPDATE model_providers SET id = 'bf5734a5-3552-4068-a80d-457c25f927ab' WHERE id = 'mp-gpt-4.1-nano'`);
  safeExec(db, `UPDATE model_providers SET id = '5190bfc2-0601-4153-8563-a6f5811bdcae' WHERE id = 'mp-o3'`);
  safeExec(db, `UPDATE model_providers SET id = 'f7c3f6b4-f3de-4070-a547-f37359aa0ca4' WHERE id = 'mp-o4-mini'`);
  // workflow_defs
  safeExec(db, `UPDATE workflow_defs SET id = '3aedac32-ef1a-429f-89d7-23d481ccd8ad' WHERE id = 'wf-code-review'`);
  safeExec(db, `UPDATE workflow_defs SET id = 'f47a3a38-a090-4956-8998-3e2bf6327304' WHERE id = 'wf-content-pipeline'`);
  safeExec(db, `UPDATE workflow_defs SET id = '2cb3d0de-9ce7-4b90-a7cd-7c41f762a988' WHERE id = 'wf-nz-stats-lookup'`);
  // workflow_runs FK
  safeExec(db, `UPDATE workflow_runs SET workflow_id = '3aedac32-ef1a-429f-89d7-23d481ccd8ad' WHERE workflow_id = 'wf-code-review'`);
  safeExec(db, `UPDATE workflow_runs SET workflow_id = 'f47a3a38-a090-4956-8998-3e2bf6327304' WHERE workflow_id = 'wf-content-pipeline'`);
  // tools
  safeExec(db, `UPDATE tools SET id = 'a7bd3e9f-9b1b-4aa6-9520-8f5fb194a5e3' WHERE id = 'tool-web-search'`);
  safeExec(db, `UPDATE tools SET id = '8e6c2528-f5a0-4d5a-a719-b60cc660f353' WHERE id = 'tool-code-exec'`);
  safeExec(db, `UPDATE tools SET id = 'bca36e31-bf3b-4761-89ba-0f1edecf22cf' WHERE id = 'tool-file-read'`);
  safeExec(db, `UPDATE tools SET id = '9bbd1c34-35a1-442f-b2bb-d5d6f568f57a' WHERE id = 'tool-db-query'`);
  safeExec(db, `UPDATE tools SET id = '31755606-4e34-44be-a101-cee78d49f6e1' WHERE id = 'tool-api-call'`);
  safeExec(db, `UPDATE tools SET id = '220dd56e-5c1c-4dad-93c8-befa5d7588f5' WHERE id = 'tool-statsnz'`);
  // task_contracts
  safeExec(db, `UPDATE task_contracts SET id = 'fbb4e3aa-a78b-452f-90b9-30ec0a1da2ea' WHERE id = 'tc-code-review'`);
  safeExec(db, `UPDATE task_contracts SET id = 'e5f03434-6aba-4e7f-93c5-838344d25d9b' WHERE id = 'tc-content-gen'`);
  safeExec(db, `UPDATE task_contracts SET id = '2e9ac54f-a9b4-4ecd-88a0-1113d8c32a34' WHERE id = 'tc-data-analysis'`);
  safeExec(db, `UPDATE task_contracts SET id = 'eb6561e5-46a8-446d-8056-0d1a6fac751e' WHERE id = 'tc-nz-statistics'`);
  // worker_agents and FK
  safeExec(db, `UPDATE worker_agents SET id = '8d2598f8-775d-4e67-841d-1cb5fb16713e' WHERE id = 'wa-code-executor'`);
  safeExec(db, `UPDATE worker_agents SET id = 'aebc3dc5-cc5b-4ad2-a10c-dedf8a9a5c3e' WHERE id = 'wa-statsnz-specialist'`);
  safeExec(db, `UPDATE worker_agents SET id = 'bf3c7feb-5471-4e17-a46c-f2c84efbf613' WHERE id = 'wa-researcher'`);
  safeExec(db, `UPDATE worker_agents SET id = '63566924-9e94-41e5-8e55-6e9ddee168c5' WHERE id = 'wa-analyst'`);
  safeExec(db, `UPDATE worker_agents SET id = '1111d2e3-2828-4570-9bf2-91320b536a2e' WHERE id = 'wa-writer'`);
  safeExec(db, `UPDATE worker_agents SET task_contract_id = 'eb6561e5-46a8-446d-8056-0d1a6fac751e' WHERE task_contract_id = 'tc-nz-statistics'`);
  // agent_runs
  safeExec(db, `UPDATE agent_runs SET id = '38e1d25e-75e8-470c-ae80-f8464c666026' WHERE id = 'run-001'`);
  safeExec(db, `UPDATE agent_runs SET id = 'b718e2c0-6049-4d67-8d87-3706d13ea97c' WHERE id = 'run-002'`);
  // guardrail_evals
  safeExec(db, `UPDATE guardrail_evals SET id = 'bdb005ec-c192-4404-ab44-bf4e23ab7aee' WHERE id = 'geval-001'`);
  safeExec(db, `UPDATE guardrail_evals SET id = '25f7e39a-5990-467c-8ae2-6114c3511190' WHERE id = 'geval-002'`);
  // human_task_policies
  safeExec(db, `UPDATE human_task_policies SET id = 'cc83adb8-bf49-4fb0-83c4-fa27da65dc56' WHERE id = 'htp-high-risk-tool'`);
  safeExec(db, `UPDATE human_task_policies SET id = '50cb4891-c1b7-4562-9bbb-75d0e552c07d' WHERE id = 'htp-sensitive-data'`);
  safeExec(db, `UPDATE human_task_policies SET id = '33664f9c-7e81-4bae-b536-6bdf17ea2352' WHERE id = 'htp-cost-threshold'`);
  safeExec(db, `UPDATE human_task_policies SET id = '659ed861-c3da-432d-a954-94393eb628de' WHERE id = 'htp-workflow-gate'`);
  // cache_policies
  safeExec(db, `UPDATE cache_policies SET id = 'a747b721-8eff-46b2-a916-864ec0ac67cf' WHERE id = 'cp-global-default'`);
  safeExec(db, `UPDATE cache_policies SET id = '5820734a-3bea-4558-90ad-d382b7b76bb2' WHERE id = 'cp-session-short'`);
  safeExec(db, `UPDATE cache_policies SET id = 'bd5cbbb5-c407-4016-9c43-5525f2789017' WHERE id = 'cp-semantic-lookup'`);
  safeExec(db, `UPDATE cache_policies SET id = '50dd439b-1fec-4293-8ee2-ed24ae07c387' WHERE id = 'cp-user-personalised'`);
  // identity_policies
  safeExec(db, `UPDATE identity_policies SET id = '71d997aa-fb08-446d-8123-1b774f3c7de5' WHERE id = 'ident-admin-all'`);
  safeExec(db, `UPDATE identity_policies SET id = '280a5cfc-548c-4714-aabb-5e6a5dcaaf44' WHERE id = 'ident-user-chat'`);
  safeExec(db, `UPDATE identity_policies SET id = '89eee70b-407a-4a89-a5e8-17b69330da8a' WHERE id = 'ident-agent-tools'`);
  safeExec(db, `UPDATE identity_policies SET id = '7ef01416-07ec-496b-be00-67926157a29e' WHERE id = 'ident-deny-admin-panel'`);
  safeExec(db, `UPDATE identity_policies SET id = '29a67ad5-7424-4e81-887b-14b0b9d951bc' WHERE id = 'ident-sensitive-challenge'`);
  // memory_governance_policies
  safeExec(db, `UPDATE memory_governance_policies SET id = 'b15e183e-66e3-4bd2-9b63-7dd540ca65ec' WHERE id = 'mgov-pii-block'`);
  safeExec(db, `UPDATE memory_governance_policies SET id = '9dbbe38c-a0a4-4f42-a1bc-a688d5b67103' WHERE id = 'mgov-conversation-retention'`);
  safeExec(db, `UPDATE memory_governance_policies SET id = '2a97b95b-6f01-4637-bc69-020d0597c02d' WHERE id = 'mgov-semantic-retention'`);
  safeExec(db, `UPDATE memory_governance_policies SET id = 'e6488668-f28f-4574-a7b0-49e45fc8aff2' WHERE id = 'mgov-entity-no-secrets'`);
  // memory_extraction_rules
  safeExec(db, `UPDATE memory_extraction_rules SET id = '64e1189c-3e5a-41f3-ad5d-da4b1e962093' WHERE id = 'mer-self-name'`);
  safeExec(db, `UPDATE memory_extraction_rules SET id = '729662dd-644c-4a42-8984-24ed5623bd4c' WHERE id = 'mer-self-location'`);
  safeExec(db, `UPDATE memory_extraction_rules SET id = '464f8582-2df1-4b39-9749-a43f7eb21438' WHERE id = 'mer-self-work'`);
  safeExec(db, `UPDATE memory_extraction_rules SET id = '16d483a4-c2b9-4fea-9082-6a9bcb43befb' WHERE id = 'mer-entity-name'`);
  safeExec(db, `UPDATE memory_extraction_rules SET id = 'e3354de1-15e6-4ecf-ad8e-e4d02127ee26' WHERE id = 'mer-entity-location'`);
  safeExec(db, `UPDATE memory_extraction_rules SET id = 'b7f3045d-6428-4f43-bda1-dd3a879f5951' WHERE id = 'mer-entity-work'`);
  safeExec(db, `UPDATE memory_extraction_rules SET id = 'dea53647-9c8a-4c29-9e02-5dd297fe9762' WHERE id = 'mer-entity-pref'`);
  // search_providers
  safeExec(db, `UPDATE search_providers SET id = '6fce6815-171b-4d75-8502-65b720b829d3' WHERE id = 'sp-duckduckgo'`);
  safeExec(db, `UPDATE search_providers SET id = '897b8e52-dc64-4854-ac39-65b92e00ccd8' WHERE id = 'sp-brave'`);
  safeExec(db, `UPDATE search_providers SET id = 'f64e9011-5b20-41b0-bea3-6a86359e4f47' WHERE id = 'sp-tavily'`);
  safeExec(db, `UPDATE search_providers SET id = 'e770810c-7033-4fa5-b525-1befa69000dd' WHERE id = 'sp-google-pse'`);
  safeExec(db, `UPDATE search_providers SET id = 'e2f358c3-89c4-48c4-aad2-3fb7153022ad' WHERE id = 'sp-serper'`);
  // http_endpoints
  safeExec(db, `UPDATE http_endpoints SET id = '49f5b2f0-cff1-4446-b318-5598a6b2eab5' WHERE id = 'he-jsonplaceholder'`);
  safeExec(db, `UPDATE http_endpoints SET id = 'ff913bd9-717d-412a-b67f-7b176faad8f3' WHERE id = 'he-weather'`);
  safeExec(db, `UPDATE http_endpoints SET id = 'fca3c3cd-d8a0-46ec-b448-3e12fd466d2f' WHERE id = 'he-ip-info'`);
  // social_accounts
  safeExec(db, `UPDATE social_accounts SET id = '82e7b3d3-7794-4cab-878f-9dfc73ed94dc' WHERE id = 'sa-slack-default'`);
  safeExec(db, `UPDATE social_accounts SET id = 'd1f54eaa-fdf8-4039-aacc-1cfb84e0fe8b' WHERE id = 'sa-discord-default'`);
  safeExec(db, `UPDATE social_accounts SET id = '81de7d85-e393-475b-aee9-c67363eaeda8' WHERE id = 'sa-github-default'`);
  // enterprise_connections
  safeExec(db, `UPDATE enterprise_connections SET id = '43c533a0-3f2e-40ec-bacb-9a9f8a3815ba' WHERE id = 'ec-jira'`);
  safeExec(db, `UPDATE enterprise_connections SET id = '1f9f0fcd-f190-4e0e-8b84-4dc4142554f0' WHERE id = 'ec-confluence'`);
  safeExec(db, `UPDATE enterprise_connections SET id = '3ed738ad-f493-49e7-835f-a2fb4cf159a8' WHERE id = 'ec-salesforce'`);
  safeExec(db, `UPDATE enterprise_connections SET id = '04833867-7e14-43e5-a64a-188f5b004382' WHERE id = 'ec-notion'`);
  // tool_registry
  safeExec(db, `UPDATE tool_registry SET id = '66c73c20-622c-47a3-a21d-210bd8a2eb91' WHERE id = 'tr-search'`);
  safeExec(db, `UPDATE tool_registry SET id = '2891e86c-a4d0-4fbc-8a6c-ede1c717ba89' WHERE id = 'tr-http'`);
  safeExec(db, `UPDATE tool_registry SET id = 'f27606f3-534b-4760-aa95-77dc4e52da3e' WHERE id = 'tr-browser'`);
  safeExec(db, `UPDATE tool_registry SET id = '212ad0f7-2ad2-43e1-94d0-49be0a73d2bf' WHERE id = 'tr-social'`);
  safeExec(db, `UPDATE tool_registry SET id = '0566e9f3-00c5-4ef2-9ac9-7012c477d5fd' WHERE id = 'tr-enterprise'`);
  // response_schemas
  safeExec(db, `UPDATE response_schemas SET id = 'c6c1387d-1cdd-4c7d-8c2a-0964d3481c51' WHERE id = 'rs-greeting'`);
  safeExec(db, `UPDATE response_schemas SET id = '1eef00ae-efa6-49ee-94ee-5c9a9e301e86' WHERE id = 'rs-code-review'`);
  safeExec(db, `UPDATE response_schemas SET id = '6d68edbb-4641-42b3-8de6-26b61faecf17' WHERE id = 'rs-summarization'`);
  // trigger_definitions and FK
  safeExec(db, `UPDATE trigger_definitions SET id = 'b97f561c-b948-447c-8d52-2d1d681a232e' WHERE id = 'trig-daily-eval'`);
  safeExec(db, `UPDATE trigger_definitions SET id = '6e5be73b-49a5-461a-8cfe-4ff5c758955f' WHERE id = 'trig-webhook-deploy'`);
  safeExec(db, `UPDATE trigger_definitions SET id = '43de3406-4ee5-4ea6-b3ef-0ca283afe1a7' WHERE id = 'trig-queue-analysis'`);
  safeExec(db, `UPDATE trigger_definitions SET id = '1ca7843f-9aa0-4298-8bb5-752ad4c263c6' WHERE id = 'trig-model-change'`);
  safeExec(db, `UPDATE trigger_definitions SET target_workflow = '3aedac32-ef1a-429f-89d7-23d481ccd8ad' WHERE target_workflow = 'wf-code-review'`);
  // tenant_configs
  safeExec(db, `UPDATE tenant_configs SET id = '9ce41ecd-202f-49bf-8042-1ff7a296e537' WHERE id = 'tc-default'`);
  safeExec(db, `UPDATE tenant_configs SET id = '0291280f-f15f-44dc-ac95-bc2a61e88cbd' WHERE id = 'tc-enterprise'`);
  safeExec(db, `UPDATE tenant_configs SET id = 'b061bbe6-2ded-4c77-afad-33473b4cb4fa' WHERE id = 'tc-trial'`);
  // sandbox_profiles
  safeExec(db, `UPDATE sandbox_profiles SET id = 'f694e2d8-172c-4ed2-bab7-35720a28149f' WHERE id = 'sbx-strict'`);
  safeExec(db, `UPDATE sandbox_profiles SET id = '1b9b4d0e-5307-439d-9608-cac2695ac07f' WHERE id = 'sbx-moderate'`);
  safeExec(db, `UPDATE sandbox_profiles SET id = 'f7054708-cbbf-48cd-b3db-16271a4adb10' WHERE id = 'sbx-permissive'`);
  // export_configs
  safeExec(db, `UPDATE export_configs SET id = 'dd32d2f8-ccd6-4f93-8aa8-e8859ca9456b' WHERE id = 'ext-full'`);
  safeExec(db, `UPDATE export_configs SET id = '28e7b976-5201-4170-9c7a-ee813e9b2ff5' WHERE id = 'ext-code-only'`);
  safeExec(db, `UPDATE export_configs SET id = 'b3f4b90f-7094-4ae5-bbda-bf3f106b4c7c' WHERE id = 'ext-tasks-timeline'`);
  // artifact_policies
  safeExec(db, `UPDATE artifact_policies SET id = '5cb95d9c-1bfe-4eb3-b1c4-0a2bab12988f' WHERE id = 'artpol-default'`);
  safeExec(db, `UPDATE artifact_policies SET id = 'fb9ad62b-b0ec-4a89-af1c-9cea0e4b9c9a' WHERE id = 'artpol-strict'`);
  safeExec(db, `UPDATE artifact_policies SET id = 'eda3f580-8b10-4d88-b0bc-2f1f5bf1a9a9' WHERE id = 'artpol-large'`);
  // reliability_policies
  safeExec(db, `UPDATE reliability_policies SET id = '7558015a-aacd-4b89-acf1-6f11e6cb4d74' WHERE id = 'rel-retry-default'`);
  safeExec(db, `UPDATE reliability_policies SET id = 'fe035101-0621-43ce-a133-ca8a74022859' WHERE id = 'rel-retry-aggressive'`);
  safeExec(db, `UPDATE reliability_policies SET id = 'eb4778d5-c048-4c54-892a-bcfeb245e95b' WHERE id = 'rel-concurrency-std'`);
  safeExec(db, `UPDATE reliability_policies SET id = 'fbd7d3d6-4e70-47ff-9e2a-4e1e2bb62ef7' WHERE id = 'rel-idempotency'`);
  // collaboration_sessions
  safeExec(db, `UPDATE collaboration_sessions SET id = '24bfff3d-7f7b-4ca2-9711-5be4488215ea' WHERE id = 'collab-pair'`);
  safeExec(db, `UPDATE collaboration_sessions SET id = '4a79d9c8-5959-4839-a653-7caf09583aae' WHERE id = 'collab-team'`);
  safeExec(db, `UPDATE collaboration_sessions SET id = '3893f5a8-d061-43d7-920f-6d82167e54f6' WHERE id = 'collab-broadcast'`);
  // compliance_rules
  safeExec(db, `UPDATE compliance_rules SET id = '726c5bfc-cdb2-47f0-9d08-177f656f6821' WHERE id = 'comp-retention-90d'`);
  safeExec(db, `UPDATE compliance_rules SET id = 'f56c10ea-07b4-4e8e-8824-8a5a50d1ced7' WHERE id = 'comp-gdpr-deletion'`);
  safeExec(db, `UPDATE compliance_rules SET id = 'a8ef9ac5-977a-4a8c-a473-9cae50d0f132' WHERE id = 'comp-eu-residency'`);
  safeExec(db, `UPDATE compliance_rules SET id = '93e3d7d5-80ac-4924-9916-018e44122ad3' WHERE id = 'comp-analytics-consent'`);
  // graph_configs
  safeExec(db, `UPDATE graph_configs SET id = '19d8bf98-fe69-4bfb-84c7-31181f171f28' WHERE id = 'graph-entity'`);
  safeExec(db, `UPDATE graph_configs SET id = '0abab6b4-93cc-4664-a99d-200bd9378dee' WHERE id = 'graph-timeline'`);
  safeExec(db, `UPDATE graph_configs SET id = '27efa1f1-bec8-4c09-a7a3-c2e472b1125d' WHERE id = 'graph-knowledge'`);
  // plugins
  safeExec(db, `UPDATE plugins SET id = '1a4cac30-57a8-4853-b2d9-e8048ade5fc5' WHERE id = 'plug-code-exec'`);
  safeExec(db, `UPDATE plugins SET id = '0146baef-15d0-40ec-98f0-40c88f34b9b3' WHERE id = 'plug-web-search'`);
  safeExec(db, `UPDATE plugins SET id = 'ad0e5e5b-4af3-4bd9-84e3-5fc2b84bb465' WHERE id = 'plug-community-viz'`);
  safeExec(db, `UPDATE plugins SET id = 'b9550588-d6e3-4d8f-961f-93ed1d841671' WHERE id = 'plug-enterprise-sso'`);
  // scaffolds
  safeExec(db, `UPDATE scaffolds SET id = 'd2d4c9c7-4f26-4de8-b8b9-21c1caadf3d1' WHERE id = 'scaf-basic-agent'`);
  safeExec(db, `UPDATE scaffolds SET id = '238db0e5-0a97-408a-87ea-411b7bb90556' WHERE id = 'scaf-tool-agent'`);
  safeExec(db, `UPDATE scaffolds SET id = '955d8720-fb97-41e2-8e21-f6f5ed8bd944' WHERE id = 'scaf-rag-pipeline'`);
  safeExec(db, `UPDATE scaffolds SET id = 'b65b2a2d-6173-49bf-af09-5fbaf48d1b92' WHERE id = 'scaf-workflow'`);
  safeExec(db, `UPDATE scaffolds SET id = 'b1d3f948-420e-4798-8c16-99c8b0cc46a3' WHERE id = 'scaf-multi-agent'`);
  safeExec(db, `UPDATE scaffolds SET id = 'b61ad2bf-cce5-4989-8800-d51e092fc309' WHERE id = 'scaf-mcp-server'`);
  safeExec(db, `UPDATE scaffolds SET id = 'e27a18c3-7718-46e0-9f71-425ec51802b0' WHERE id = 'scaf-full-stack'`);
  // recipe_configs
  safeExec(db, `UPDATE recipe_configs SET id = '762dba63-d819-4f85-a86f-5f6788c42c99' WHERE id = 'rcp-workflow'`);
  safeExec(db, `UPDATE recipe_configs SET id = '5a5b3951-4ca6-49b8-9ab4-b09a679e5275' WHERE id = 'rcp-governed'`);
  safeExec(db, `UPDATE recipe_configs SET id = 'b046bcff-9950-46bf-b107-ab6baf097240' WHERE id = 'rcp-approval'`);
  safeExec(db, `UPDATE recipe_configs SET id = '58bea5c2-662b-4c41-9f8e-203c59885931' WHERE id = 'rcp-acl-rag'`);
  safeExec(db, `UPDATE recipe_configs SET id = 'ddfd4301-7bf5-459c-a458-59785c6d6995' WHERE id = 'rcp-safe-exec'`);
  // widgets
  safeExec(db, `UPDATE widgets SET id = 'd309940a-bd09-4899-ace5-a0acd53f2325' WHERE id = 'wgt-table'`);
  safeExec(db, `UPDATE widgets SET id = '7fe15c63-2ffd-413f-93e8-1681d5dc5c5b' WHERE id = 'wgt-chart'`);
  safeExec(db, `UPDATE widgets SET id = 'a3b5a4a7-6cd7-45b6-9715-3221ede6e2f0' WHERE id = 'wgt-form'`);
  safeExec(db, `UPDATE widgets SET id = '4d57f558-6068-44ff-9f45-354696fcdb59' WHERE id = 'wgt-code'`);
  safeExec(db, `UPDATE widgets SET id = '464ec787-112f-413f-a376-ce534a3c505c' WHERE id = 'wgt-timeline'`);
  safeExec(db, `UPDATE widgets SET id = '337c379d-22df-44af-980c-04c453398169' WHERE id = 'wgt-image'`);
  // validation_rules
  safeExec(db, `UPDATE validation_rules SET id = '940eb416-6e60-47bc-9d7d-3fca55c7b98d' WHERE id = 'val-agent-name'`);
  safeExec(db, `UPDATE validation_rules SET id = '014b4186-c36f-4f61-b8c3-bf2545023199' WHERE id = 'val-agent-steps'`);
  safeExec(db, `UPDATE validation_rules SET id = 'c5985869-b721-40a2-b4ef-529bb975c84c' WHERE id = 'val-workflow-entry'`);
  safeExec(db, `UPDATE validation_rules SET id = 'b6490a1a-2ddf-41ad-9a7b-6d406808cf86' WHERE id = 'val-tool-risk'`);
  safeExec(db, `UPDATE validation_rules SET id = '892adcec-808b-4c17-bc2c-c5c45cfe47fb' WHERE id = 'val-json-fields'`);

  // Phase 1: tool_configs → tool_catalog migration
  // Copy existing tool_configs data into tool_catalog (for existing databases upgrading from pre-Phase-1).
  // safeExec swallows the error on fresh installs where tool_configs does not exist.
  safeExec(db, `
    INSERT OR IGNORE INTO tool_catalog (id, name, description, category, risk_level, requires_approval, max_execution_ms, rate_limit_per_min, enabled, created_at, updated_at)
    SELECT id, name, description, category, risk_level, requires_approval, max_execution_ms, rate_limit_per_min, enabled, created_at, updated_at
    FROM tool_configs
  `);
  // Add new Phase 1 columns to tool_catalog (no-op if already present).
  safeExec(db, `ALTER TABLE tool_catalog ADD COLUMN tool_key TEXT`);
  safeExec(db, `ALTER TABLE tool_catalog ADD COLUMN version TEXT NOT NULL DEFAULT '1.0'`);
  safeExec(db, `ALTER TABLE tool_catalog ADD COLUMN side_effects INTEGER NOT NULL DEFAULT 0`);
  safeExec(db, `ALTER TABLE tool_catalog ADD COLUMN tags TEXT`);
  safeExec(db, `ALTER TABLE tool_catalog ADD COLUMN source TEXT NOT NULL DEFAULT 'builtin'`);
  safeExec(db, `ALTER TABLE tool_catalog ADD COLUMN credential_id TEXT`);
  // Backfill tool_key for the 6 builtin seed records.
  safeExec(db, `UPDATE tool_catalog SET tool_key = 'web_search' WHERE id = 'a7bd3e9f-9b1b-4aa6-9520-8f5fb194a5e3' AND tool_key IS NULL`);
  safeExec(db, `UPDATE tool_catalog SET tool_key = 'cse_run_code' WHERE id = '8e6c2528-f5a0-4d5a-a719-b60cc660f353' AND tool_key IS NULL`);
  safeExec(db, `UPDATE tool_catalog SET tool_key = 'file_reader' WHERE id = 'bca36e31-bf3b-4761-89ba-0f1edecf22cf' AND tool_key IS NULL`);
  safeExec(db, `UPDATE tool_catalog SET tool_key = 'database_query' WHERE id = '9bbd1c34-35a1-442f-b2bb-d5d6f568f57a' AND tool_key IS NULL`);
  safeExec(db, `UPDATE tool_catalog SET tool_key = 'api_caller' WHERE id = '31755606-4e34-44be-a101-cee78d49f6e1' AND tool_key IS NULL`);
  safeExec(db, `UPDATE tool_catalog SET tool_key = 'statsnz_get_data' WHERE id = '220dd56e-5c1c-4dad-93c8-befa5d7588f5' AND tool_key IS NULL`);

  // Phase 2: Create tool_policies and tool_rate_limit_buckets tables (no-op on fresh installs).
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS tool_policies (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      applies_to TEXT,
      applies_to_risk_levels TEXT,
      approval_required INTEGER NOT NULL DEFAULT 0,
      allowed_risk_levels TEXT,
      max_execution_ms INTEGER,
      rate_limit_per_minute INTEGER,
      max_concurrent INTEGER,
      require_dry_run INTEGER NOT NULL DEFAULT 0,
      log_input_output INTEGER NOT NULL DEFAULT 1,
      persona_scope TEXT,
      active_hours_utc TEXT,
      expires_at TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS tool_rate_limit_buckets (
      id TEXT PRIMARY KEY,
      tool_name TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      window_start TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(tool_name, scope_key, window_start)
    )
  `);

  // Phase 2: Seed 4 default tool policies (idempotent via INSERT OR IGNORE).
  safeExec(db, `
    INSERT OR IGNORE INTO tool_policies
      (id, key, name, description, applies_to, applies_to_risk_levels, approval_required, allowed_risk_levels, max_execution_ms, rate_limit_per_minute, max_concurrent, require_dry_run, log_input_output, persona_scope, enabled)
    VALUES
      ('e1a2b3c4-d5e6-47f8-a9b0-c1d2e3f4a5b6', 'default', 'Default Policy',
       'Baseline policy applied to all tools. Logs I/O, 60 req/min, all risk levels allowed. Override with a more specific policy per tool or skill.',
       NULL, NULL, 0,
       '["read-only","write","destructive","privileged","financial","external-side-effect"]',
       NULL, 60, NULL, 0, 1, NULL, 1)
  `);
  safeExec(db, `
    INSERT OR IGNORE INTO tool_policies
      (id, key, name, description, applies_to, applies_to_risk_levels, approval_required, allowed_risk_levels, max_execution_ms, rate_limit_per_minute, max_concurrent, require_dry_run, log_input_output, persona_scope, enabled)
    VALUES
      ('f2b3c4d5-e6f7-48a9-b0c1-d2e3f4a5b6c7', 'strict_external', 'Strict External Policy',
       'Applied to tools that make outbound web or API calls. Limits to 20 req/min and enforces full I/O logging for compliance and cost visibility.',
       '["web_search","api_caller","browser_screenshot","browser_navigate"]', NULL, 0,
       '["read-only","external-side-effect"]',
       15000, 20, NULL, 0, 1, NULL, 1)
  `);
  safeExec(db, `
    INSERT OR IGNORE INTO tool_policies
      (id, key, name, description, applies_to, applies_to_risk_levels, approval_required, allowed_risk_levels, max_execution_ms, rate_limit_per_minute, max_concurrent, require_dry_run, log_input_output, persona_scope, enabled)
    VALUES
      ('a3c4d5e6-f7a8-49b0-c1d2-e3f4a5b6c7d8', 'destructive_gate', 'Destructive Gate Policy',
       'Requires human approval before any tool invocation classified as destructive, privileged, or financial risk. Attach to skills or agent personas handling sensitive operations.',
       NULL, '["destructive","privileged","financial"]', 1,
       '["destructive","privileged","financial"]',
       NULL, NULL, 1, 1, 1, NULL, 1)
  `);
  safeExec(db, `
    INSERT OR IGNORE INTO tool_policies
      (id, key, name, description, applies_to, applies_to_risk_levels, approval_required, allowed_risk_levels, max_execution_ms, rate_limit_per_minute, max_concurrent, require_dry_run, log_input_output, persona_scope, enabled)
    VALUES
      ('b4d5e6f7-a8b9-40c1-d2e3-f4a5b6c7d8e9', 'read_only', 'Read-Only Policy',
       'Restricts tool usage to read-only risk level only. Use with agent personas that must not have side effects — research agents, summarizers, and audit bots.',
       NULL, NULL, 0,
       '["read-only"]',
       10000, 120, NULL, 0, 0, NULL, 1)
  `);

  // Phase 3: Audit Trail + Health Persistence
  // Immutable append-only log of every tool invocation.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS tool_audit_events (
      id TEXT PRIMARY KEY,
      tool_name TEXT NOT NULL,
      chat_id TEXT,
      user_id TEXT,
      agent_persona TEXT,
      skill_key TEXT,
      policy_id TEXT,
      outcome TEXT NOT NULL,
      violation_reason TEXT,
      duration_ms INTEGER,
      input_preview TEXT,
      output_preview TEXT,
      error_message TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_tool_audit_tool_name ON tool_audit_events(tool_name)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_tool_audit_chat_id ON tool_audit_events(chat_id)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_tool_audit_outcome ON tool_audit_events(outcome)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_tool_audit_created_at ON tool_audit_events(created_at)`);

  // Persisted health aggregates written every 15 minutes by the background health job.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS tool_health_snapshots (
      id TEXT PRIMARY KEY,
      tool_name TEXT NOT NULL,
      snapshot_at TEXT NOT NULL,
      invocation_count INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      denied_count INTEGER NOT NULL DEFAULT 0,
      avg_duration_ms REAL,
      p95_duration_ms REAL,
      error_rate REAL NOT NULL DEFAULT 0,
      availability REAL NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_tool_health_name_time ON tool_health_snapshots(tool_name, snapshot_at)`);

  // ─── Phase 4: Tool Credentials ────────────────────────────
  // Stores external API credentials bound to tools. The credential secret
  // lives in the referenced environment variable (env_var_name) so no plaintext
  // secrets are persisted. The config JSON carries transport metadata such as
  // header name and value prefix.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS tool_credentials (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      credential_type TEXT NOT NULL DEFAULT 'api_key',
      tool_names TEXT,
      env_var_name TEXT,
      config TEXT,
      rotation_due_at TEXT,
      validation_status TEXT NOT NULL DEFAULT 'unknown',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_tool_credentials_enabled ON tool_credentials(enabled)`);

  // Add config column to tool_catalog for MCP endpoint / A2A agent URL storage.
  safeExec(db, `ALTER TABLE tool_catalog ADD COLUMN config TEXT`);

  // ─── Phase 6: Skill → Tool Policy Closure ────────────────
  // Adds tool_policy_key to skills so each skill can declare which tool policy
  // governs tool calls made during its activation window.
  safeExec(db, `ALTER TABLE skills ADD COLUMN tool_policy_key TEXT`);

  // Creates the tool_approval_requests table used by DbToolApprovalGate to
  // persist pending/approved/denied approval decisions for tools that require
  // operator approval before execution.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS tool_approval_requests (
      id TEXT PRIMARY KEY,
      tool_name TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      user_id TEXT,
      input_json TEXT NOT NULL DEFAULT '{}',
      policy_key TEXT,
      skill_key TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      resolved_by TEXT,
      resolution_note TEXT
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_tool_approval_chat ON tool_approval_requests(chat_id, status)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_tool_approval_tool ON tool_approval_requests(tool_name, status)`);

  // ── Hypothesis Validation — Phase 2 bootstrap migrations ──
  // Canonical tables are hv_*. Existing sv_* deployments are backfilled.

  safeExec(db, `
    CREATE TABLE IF NOT EXISTS hv_budget_envelope (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      max_llm_cents INTEGER NOT NULL,
      max_sandbox_cents INTEGER NOT NULL,
      max_wall_seconds INTEGER NOT NULL,
      max_rounds INTEGER NOT NULL,
      diminishing_returns_epsilon REAL NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  safeExec(db, `
    CREATE TABLE IF NOT EXISTS hv_hypothesis (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      submitted_by TEXT NOT NULL,
      title TEXT NOT NULL,
      statement TEXT NOT NULL,
      domain_tags TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','running','verdict','abandoned')),
      budget_envelope_id TEXT NOT NULL REFERENCES hv_budget_envelope(id),
      workflow_run_id TEXT,
      trace_id TEXT,
      contract_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_hv_hypothesis_tenant ON hv_hypothesis(tenant_id, created_at DESC)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_hv_hypothesis_status ON hv_hypothesis(tenant_id, status)`);

  safeExec(db, `
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
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_hv_sub_claim_hypothesis ON hv_sub_claim(hypothesis_id)`);

  safeExec(db, `
    CREATE TABLE IF NOT EXISTS hv_verdict (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      hypothesis_id TEXT NOT NULL UNIQUE REFERENCES hv_hypothesis(id) ON DELETE CASCADE,
      verdict TEXT NOT NULL
        CHECK (verdict IN ('supported','refuted','inconclusive','ill_posed','out_of_scope')),
      confidence_lo REAL NOT NULL CHECK (confidence_lo BETWEEN 0 AND 1),
      confidence_hi REAL NOT NULL CHECK (confidence_hi BETWEEN 0 AND 1),
      key_evidence_ids TEXT NOT NULL,
      falsifiers TEXT NOT NULL,
      limitations TEXT NOT NULL,
      contract_id TEXT NOT NULL,
      replay_trace_id TEXT NOT NULL,
      emitted_by TEXT NOT NULL DEFAULT 'supervisor',
      created_at TEXT NOT NULL,
      CHECK (confidence_lo <= confidence_hi)
    )
  `);

  // ── worker_agents: add category column ──────────────────────────────────────
  // Existing DBs need the column added. New DBs get it from CREATE TABLE.
  safeExec(db, `ALTER TABLE worker_agents ADD COLUMN category TEXT NOT NULL DEFAULT 'general'`);
  safeExec(db, `ALTER TABLE worker_agents ADD COLUMN display_name TEXT`);
  safeExec(db, `ALTER TABLE worker_agents ADD COLUMN job_profile TEXT`);
  safeExec(db, `
    UPDATE worker_agents
    SET display_name = CASE name
      WHEN 'code_executor' THEN 'Casey'
      WHEN 'statsnz_specialist' THEN 'Nia'
      WHEN 'researcher' THEN 'Riley'
      WHEN 'analyst' THEN 'Avery'
      WHEN 'writer' THEN 'Wren'
      WHEN 'sv-supervisor' THEN 'geneWeave'
      WHEN 'sv-decomposer' THEN 'Dylan'
      WHEN 'sv-literature' THEN 'Larry'
      WHEN 'sv-statistical' THEN 'Stella'
      WHEN 'sv-mathematical' THEN 'Max'
      WHEN 'sv-simulation' THEN 'Sima'
      WHEN 'sv-adversarial' THEN 'Ada'
      ELSE name
    END
    WHERE COALESCE(display_name, '') = ''
  `);
  safeExec(db, `
    UPDATE worker_agents
    SET job_profile = CASE name
      WHEN 'code_executor' THEN 'Code Execution Specialist'
      WHEN 'statsnz_specialist' THEN 'NZ Data Specialist'
      WHEN 'researcher' THEN 'Research Specialist'
      WHEN 'analyst' THEN 'Data Analyst'
      WHEN 'writer' THEN 'Writing Specialist'
      WHEN 'sv-supervisor' THEN 'Hypothesis Validation Supervisor'
      WHEN 'sv-decomposer' THEN 'Claim Decomposition Specialist'
      WHEN 'sv-literature' THEN 'Literator validator'
      WHEN 'sv-statistical' THEN 'Statistical Validator'
      WHEN 'sv-mathematical' THEN 'Mathematical Validator'
      WHEN 'sv-simulation' THEN 'Simulation Validator'
      WHEN 'sv-adversarial' THEN 'Adversarial Validator'
      ELSE 'Worker Agent'
    END
    WHERE COALESCE(job_profile, '') = ''
  `);

  // ── hv_evidence_event and hv_agent_turn ─────────────────────────────────────
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS hv_evidence_event (
      id TEXT PRIMARY KEY,
      hypothesis_id TEXT NOT NULL REFERENCES hv_hypothesis(id) ON DELETE CASCADE,
      step_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      source_type TEXT NOT NULL DEFAULT 'model_inference',
      tool_key TEXT,
      reproducibility_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_hv_evidence_hypothesis ON hv_evidence_event(hypothesis_id, created_at ASC)`);

  safeExec(db, `
    CREATE TABLE IF NOT EXISTS hv_agent_turn (
      id TEXT PRIMARY KEY,
      hypothesis_id TEXT NOT NULL REFERENCES hv_hypothesis(id) ON DELETE CASCADE,
      round_index INTEGER NOT NULL DEFAULT 0,
      from_agent TEXT NOT NULL,
      to_agent TEXT,
      message TEXT NOT NULL,
      cites_evidence_ids TEXT NOT NULL DEFAULT '[]',
      dissent INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_hv_agent_turn_hypothesis ON hv_agent_turn(hypothesis_id, created_at ASC)`);

  // Backfill from legacy sv_* tables for existing installations.
  safeExec(db, `
    INSERT OR IGNORE INTO hv_budget_envelope
    (id, tenant_id, name, max_llm_cents, max_sandbox_cents, max_wall_seconds, max_rounds, diminishing_returns_epsilon, created_at)
    SELECT id, tenant_id, name, max_llm_cents, max_sandbox_cents, max_wall_seconds, max_rounds, diminishing_returns_epsilon, created_at
    FROM sv_budget_envelope
  `);
  safeExec(db, `
    INSERT OR IGNORE INTO hv_hypothesis
    (id, tenant_id, submitted_by, title, statement, domain_tags, status, budget_envelope_id, workflow_run_id, trace_id, contract_id, created_at, updated_at)
    SELECT id, tenant_id, submitted_by, title, statement, domain_tags, status, budget_envelope_id, workflow_run_id, trace_id, contract_id, created_at, updated_at
    FROM sv_hypothesis
  `);
  safeExec(db, `
    INSERT OR IGNORE INTO hv_sub_claim
    (id, tenant_id, hypothesis_id, parent_sub_claim_id, statement, claim_type, testability_score, created_at)
    SELECT id, tenant_id, hypothesis_id, parent_sub_claim_id, statement, claim_type, testability_score, created_at
    FROM sv_sub_claim
  `);
  safeExec(db, `
    INSERT OR IGNORE INTO hv_verdict
    (id, tenant_id, hypothesis_id, verdict, confidence_lo, confidence_hi, key_evidence_ids, falsifiers, limitations, contract_id, replay_trace_id, emitted_by, created_at)
    SELECT id, tenant_id, hypothesis_id, verdict, confidence_lo, confidence_hi, key_evidence_ids, falsifiers, limitations, contract_id, replay_trace_id, emitted_by, created_at
    FROM sv_verdict
  `);
  safeExec(db, `
    INSERT OR IGNORE INTO hv_evidence_event
    (id, hypothesis_id, step_id, agent_id, evidence_id, kind, summary, source_type, tool_key, reproducibility_hash, created_at)
    SELECT id, hypothesis_id, step_id, agent_id, evidence_id, kind, summary, source_type, tool_key, reproducibility_hash, created_at
    FROM sv_evidence_event
  `);
  safeExec(db, `
    INSERT OR IGNORE INTO hv_agent_turn
    (id, hypothesis_id, round_index, from_agent, to_agent, message, cites_evidence_ids, dissent, created_at)
    SELECT id, hypothesis_id, round_index, from_agent, to_agent, message, cites_evidence_ids, dissent, created_at
    FROM sv_agent_turn
  `);

  // ── Hypothesis Validation tool policy ────────────────────────────────────────
  // A dedicated policy for the hypothesis-validation tools so operators can tune rate limits,
  // execution timeouts, and logging without touching the default policy.
  // All SV tools are external-side-effect (container compute or external HTTP).
  safeExec(db, `
    INSERT OR IGNORE INTO tool_policies
      (id, key, name, description, applies_to, applies_to_risk_levels, approval_required, allowed_risk_levels, max_execution_ms, rate_limit_per_minute, max_concurrent, require_dry_run, log_input_output, persona_scope, enabled)
    VALUES
      ('c5e6f7a8-b9c0-41d2-e3f4-a5b6c7d8e9f0', 'hypothesis_validation', 'Hypothesis Validation Policy',
       'Governs sandboxed and evidence tools used by hypothesis-validation workflows. Allows external-side-effect and read-only risk levels. 60 s max execution for container tools. 30 req/min per scope. Full I/O logging for reproducibility audits.',
       '["sympy.simplify","sympy.solve","sympy.integrate","wolfram.query","scipy.stats","scipy.meta","scipy.power","pymc.sample","r.meta","rdkit.describe","rdkit.similarity","biopython.align","networkx.analyse","arxiv.search","pubmed.search","semanticscholar.search","openalex.search","crossref.resolve","europepmc.search"]',
       NULL, 0,
       '["read-only","external-side-effect"]',
       60000, 30, NULL, 0, 1, NULL, 1)
  `);

  // Backward-compatible alias key for existing skill configurations.
  safeExec(db, `
    INSERT OR IGNORE INTO tool_policies
      (id, key, name, description, applies_to, applies_to_risk_levels, approval_required, allowed_risk_levels, max_execution_ms, rate_limit_per_minute, max_concurrent, require_dry_run, log_input_output, persona_scope, enabled)
    SELECT
      'd6f7a8b9-c0d1-42e3-f4a5-b6c7d8e9f011',
      'scientific_validation',
      'Scientific Validation Policy (Alias)',
      description,
      applies_to,
      applies_to_risk_levels,
      approval_required,
      allowed_risk_levels,
      max_execution_ms,
      rate_limit_per_minute,
      max_concurrent,
      require_dry_run,
      log_input_output,
      persona_scope,
      enabled
    FROM tool_policies
    WHERE key = 'hypothesis_validation'
  `);

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 1B — DB-driven supervisor agents
  //
  // The `agents` table is the operator-managed registry of supervisor (and
  // future specialist) agent definitions. Tool allocation is decoupled into
  // `agent_tools` so a single agent row can claim a curated bundle without
  // string-encoded JSON. Resolution at runtime is layered:
  //   skill.supervisor_agent_id -> tenant_id+category -> global+category -> is_default=1
  //
  // This phase is additive; chat.ts continues to honour package defaults when
  // no row resolves, and worker_agents/skills tables are untouched apart from
  // an optional `supervisor_agent_id` column on `skills`.
  // ─────────────────────────────────────────────────────────────────────────
  safeExec(db, `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    tenant_id TEXT,
    category TEXT NOT NULL DEFAULT 'general',
    name TEXT NOT NULL,
    display_name TEXT,
    description TEXT,
    system_prompt TEXT,
    include_utility_tools INTEGER NOT NULL DEFAULT 1,
    default_timezone TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_agents_tenant_category ON agents(tenant_id, category, enabled)');
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_agents_default ON agents(is_default, enabled)');

  safeExec(db, `CREATE TABLE IF NOT EXISTS agent_tools (
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    tool_name TEXT NOT NULL,
    allocation TEXT NOT NULL DEFAULT 'default',
    PRIMARY KEY(agent_id, tool_name)
  )`);
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_agent_tools_agent ON agent_tools(agent_id)');

  // Skills may pin a specific supervisor agent (highest precedence at resolve time).
  safeExec(db, 'ALTER TABLE skills ADD COLUMN supervisor_agent_id TEXT');

  // Tool catalog gains an allocation_class hint so operators can flag which
  // tools are appropriate for supervisor-level vs worker-level binding.
  // Values: 'supervisor' | 'worker' | 'shared' | NULL (unspecified).
  safeExec(db, 'ALTER TABLE tool_catalog ADD COLUMN allocation_class TEXT');

  // ─── Phase 5: Per-client MCP gateway tokens ───────────────
  // Stores SHA-256 hashes of per-client bearer tokens so external MCP
  // callers can be individually attributed in audit events and scoped to a
  // subset of allocation classes. The plaintext token is never stored —
  // only the digest. token_lookup is the same digest used as a fast index
  // on bearer-token presentation. allowed_classes is a JSON array; when
  // null the client inherits the gateway-wide exposed_classes set.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS mcp_gateway_clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      token_hash TEXT NOT NULL UNIQUE,
      allowed_classes TEXT,
      audit_chat_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_used_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_mcp_gateway_clients_hash ON mcp_gateway_clients(token_hash)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_mcp_gateway_clients_enabled ON mcp_gateway_clients(enabled)`);

  // Phase 7: per-client rate limit. Nullable column = no per-client cap.
  // safeExec swallows the duplicate-column error so this is idempotent on
  // existing databases.
  safeExec(db, `ALTER TABLE mcp_gateway_clients ADD COLUMN rate_limit_per_minute INTEGER`);

  // Phase 9: token expiry + rotation tracking. expires_at NULL = no expiry.
  // rotated_at NULL = never rotated since creation. Both idempotent via
  // safeExec.
  safeExec(db, `ALTER TABLE mcp_gateway_clients ADD COLUMN expires_at TEXT`);
  safeExec(db, `ALTER TABLE mcp_gateway_clients ADD COLUMN rotated_at TEXT`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_mcp_gateway_clients_expires ON mcp_gateway_clients(expires_at)`);

  // Phase 7: tumbling 1-minute buckets for per-client rate limiting. Mirrors
  // the tool_rate_limit_buckets pattern but scoped to gateway clients only.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS mcp_gateway_rate_buckets (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      window_start TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(client_id, window_start)
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_mcp_gateway_rate_buckets_client ON mcp_gateway_rate_buckets(client_id, window_start)`);

  // Phase 8: gateway request log. Captures every terminal outcome
  // (ok / rate_limited / unauthorized / error) so operators can audit
  // traffic per client without having to reconstruct it from
  // tool_audit_events (which only fires for tool invocations and not
  // for tools/list, denied auth, or 429 rate-limited responses).
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS mcp_gateway_request_log (
      id TEXT PRIMARY KEY,
      client_id TEXT,
      client_name TEXT,
      method TEXT,
      tool_name TEXT,
      outcome TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      duration_ms INTEGER,
      error_message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_mcp_gw_req_log_created ON mcp_gateway_request_log(created_at DESC)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_mcp_gw_req_log_client ON mcp_gateway_request_log(client_id, created_at DESC)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_mcp_gw_req_log_outcome ON mcp_gateway_request_log(outcome, created_at DESC)`);

  // Domain-scoped sub-playbooks: JSON array of {key,label?,content,tags?}.
  // Each section becomes an optional, query-scorable PromptSection at render
  // time so a sales-only query keeps only the sales subsection in the
  // supervisor system prompt instead of the full multi-domain playbook.
  safeExec(db, 'ALTER TABLE skills ADD COLUMN domain_sections TEXT');

  // Machine-enforced execution contract: JSON object with optional
  // minDelegations / requiredOutputSubstrings / requiredOutputPatterns.
  // The chat runtime extracts this via extractSkillExecutionContractsFromPrompt
  // and validates the agent result, reporting concrete deltas on failure
  // instead of an opaque "skill plan was selected but not followed" error.
  safeExec(db, 'ALTER TABLE skills ADD COLUMN execution_contract TEXT');

  // ─── anyWeave Task-Aware Routing — Phase 1 ────────────────
  // Design doc: docs/ANYWEAVE_TASK_AWARE_ROUTING.md
  // All tables use UUID PKs (TEXT). Idempotent: CREATE IF NOT EXISTS / safeExec ALTERs.

  // M1 — Task type taxonomy. 16 seed rows live in seedDefaultData().
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS task_type_definitions (
      id              TEXT PRIMARY KEY,
      task_key        TEXT NOT NULL UNIQUE,
      display_name    TEXT NOT NULL,
      category        TEXT NOT NULL,
      description     TEXT NOT NULL DEFAULT '',
      output_modality TEXT NOT NULL,
      default_strategy TEXT NOT NULL,
      default_weights TEXT NOT NULL DEFAULT '{"cost":0.25,"speed":0.25,"quality":0.25,"capability":0.25}',
      inference_hints TEXT NOT NULL DEFAULT '{}',
      enabled         INTEGER NOT NULL DEFAULT 1,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_task_types_category ON task_type_definitions(category, enabled)');

  // M2 — Per-(tenant?, model, provider, task_key) quality + capability flags.
  // tenant_id NULL = global default. Absence of a row = model excluded from candidate pool for that task.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS model_capability_scores (
      id                  TEXT PRIMARY KEY,
      tenant_id           TEXT,
      model_id            TEXT NOT NULL,
      provider            TEXT NOT NULL,
      task_key            TEXT NOT NULL,
      quality_score       REAL NOT NULL,
      supports_tools      INTEGER NOT NULL DEFAULT 1,
      supports_streaming  INTEGER NOT NULL DEFAULT 1,
      supports_thinking   INTEGER NOT NULL DEFAULT 0,
      supports_json_mode  INTEGER NOT NULL DEFAULT 0,
      supports_vision     INTEGER NOT NULL DEFAULT 0,
      max_output_tokens   INTEGER,
      benchmark_source    TEXT,
      raw_benchmark_score REAL,
      is_active           INTEGER NOT NULL DEFAULT 1,
      last_evaluated_at   TEXT,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, model_id, provider, task_key)
    )
  `);
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_capability_lookup ON model_capability_scores(task_key, is_active, tenant_id)');
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_capability_model ON model_capability_scores(model_id, provider)');

  // M3 — Per-tenant task-type overrides (weights, preferred model, cost ceiling).
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS task_type_tenant_overrides (
      id                    TEXT PRIMARY KEY,
      tenant_id             TEXT NOT NULL,
      task_key              TEXT NOT NULL,
      weights               TEXT,
      preferred_model_id    TEXT,
      preferred_provider    TEXT,
      preferred_boost_pct   REAL NOT NULL DEFAULT 20,
      cost_ceiling_per_call REAL,
      optimisation_strategy TEXT,
      enabled               INTEGER NOT NULL DEFAULT 1,
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, task_key)
    )
  `);

  // M4 — Provider tool-format adapter configuration. Replaces hardcoded
  // buildAnthropicTools / buildOpenAITools logic with DB-driven mapping rules
  // consumed by @weaveintel/tool-schema (Phase 3).
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS provider_tool_adapters (
      id                        TEXT PRIMARY KEY,
      provider                  TEXT NOT NULL UNIQUE,
      display_name              TEXT NOT NULL,
      adapter_module            TEXT NOT NULL,
      tool_format               TEXT NOT NULL,
      tool_call_response_format TEXT NOT NULL,
      tool_result_format        TEXT NOT NULL,
      system_prompt_location    TEXT NOT NULL DEFAULT 'system_message',
      name_validation_regex     TEXT NOT NULL DEFAULT '^[a-zA-Z0-9_-]{1,64}$',
      max_tool_count            INTEGER NOT NULL DEFAULT 128,
      enabled                   INTEGER NOT NULL DEFAULT 1,
      created_at                TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // M6 — Persistent routing decision trace (replaces in-memory DecisionStore for prod use).
  // UUID v7 PK keeps inserts naturally sortable by time.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS routing_decision_traces (
      id                        TEXT PRIMARY KEY,
      tenant_id                 TEXT,
      agent_id                  TEXT,
      workflow_step_id          TEXT,
      task_key                  TEXT,
      inference_source          TEXT,
      selected_model_id         TEXT NOT NULL,
      selected_provider         TEXT NOT NULL,
      selected_capability_score REAL,
      weights_used              TEXT NOT NULL,
      candidate_breakdown       TEXT NOT NULL,
      tool_translation_applied  INTEGER NOT NULL DEFAULT 0,
      source_provider           TEXT,
      estimated_cost_usd        REAL,
      decided_at                TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_decision_task ON routing_decision_traces(task_key, decided_at)');
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_decision_tenant ON routing_decision_traces(tenant_id, decided_at)');
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_decision_agent ON routing_decision_traces(agent_id, decided_at)');

  // M7 — Agent routing fields.
  safeExec(db, 'ALTER TABLE agents ADD COLUMN default_task_type TEXT');
  safeExec(db, 'ALTER TABLE agents ADD COLUMN allowed_task_types TEXT');     // JSON string[]
  safeExec(db, 'ALTER TABLE agents ADD COLUMN preferred_models TEXT');       // JSON {[taskKey]: {modelId, provider}}
  safeExec(db, 'ALTER TABLE agents ADD COLUMN cost_ceiling_per_call REAL');

  // M8 — Output modality on the existing model_pricing table so the routing
  // filter can exclude text-only LLMs from image/audio/embedding tasks.
  safeExec(db, "ALTER TABLE model_pricing ADD COLUMN output_modality TEXT NOT NULL DEFAULT 'text'");

  // Multi-hop fallback chain (JSON [{modelId, provider, priority}]).
  // The single fallback_model/fallback_provider columns remain for
  // backward compatibility — Phase 2 router prefers the chain when present.
  safeExec(db, 'ALTER TABLE routing_policies ADD COLUMN fallback_chain TEXT');

  // ─── anyWeave Task-Aware Routing — Phase 5: Feedback loop ──
  // Design doc: docs/ANYWEAVE_TASK_AWARE_ROUTING.md §13 Phase 5
  //
  // Four signal channels feed quality_score in model_capability_scores:
  //   1. eval        — eval engine results
  //   2. chat        — 👍/👎/regenerate/copy from chat UI
  //   3. cache       — cache admission quality scores
  //   4. production  — tool-call validity / json compliance / completion
  //
  // routing_capability_signals is the append-only ledger; recompute jobs
  // produce rolling averages and write back to model_capability_scores.

  // Append-only signal log. UUID v7 PK keeps inserts naturally sortable.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS routing_capability_signals (
      id            TEXT PRIMARY KEY,
      tenant_id     TEXT,
      model_id      TEXT NOT NULL,
      provider      TEXT NOT NULL,
      task_key      TEXT NOT NULL,
      source        TEXT NOT NULL,
      signal_type   TEXT NOT NULL,
      value         REAL NOT NULL,
      weight        REAL NOT NULL DEFAULT 1.0,
      evidence_id   TEXT,
      message_id    TEXT,
      trace_id      TEXT,
      metadata      TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_signals_lookup ON routing_capability_signals(model_id, provider, task_key, created_at)');
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_signals_source ON routing_capability_signals(source, created_at)');
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_signals_tenant ON routing_capability_signals(tenant_id, created_at)');

  // Per-message user feedback. signal ∈ {thumbs_up, thumbs_down, regenerate, copy}.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS message_feedback (
      id          TEXT PRIMARY KEY,
      message_id  TEXT NOT NULL,
      chat_id     TEXT,
      user_id     TEXT,
      signal      TEXT NOT NULL,
      comment     TEXT,
      model_id    TEXT,
      provider    TEXT,
      task_key    TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_feedback_message ON message_feedback(message_id)');
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_feedback_signal ON message_feedback(signal, created_at)');

  // Regression / surface-item alerts emitted by the regression detection job.
  // status ∈ {open, acknowledged, resolved}.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS routing_surface_items (
      id              TEXT PRIMARY KEY,
      kind            TEXT NOT NULL,
      severity        TEXT NOT NULL,
      model_id        TEXT NOT NULL,
      provider        TEXT NOT NULL,
      task_key        TEXT NOT NULL,
      tenant_id       TEXT,
      message         TEXT NOT NULL,
      metric_7d       REAL,
      metric_30d      REAL,
      drop_pct        REAL,
      sample_count_7d INTEGER,
      sample_count_30d INTEGER,
      auto_disabled   INTEGER NOT NULL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'open',
      resolution_note TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at     TEXT
    )
  `);
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_surface_status ON routing_surface_items(status, created_at)');
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_surface_model ON routing_surface_items(model_id, provider, task_key)');

  // Production signal score (separate from benchmark quality_score).
  // Updated by the production telemetry channel; surfaced in the simulator
  // for operators to compare benchmark vs lived-experience quality.
  safeExec(db, 'ALTER TABLE model_capability_scores ADD COLUMN production_signal_score REAL');
  safeExec(db, 'ALTER TABLE model_capability_scores ADD COLUMN signal_sample_count INTEGER NOT NULL DEFAULT 0');

  // ─── anyWeave Task-Aware Routing — Phase 6: Production hardening ──
  // Design doc: docs/ANYWEAVE_TASK_AWARE_ROUTING.md §13 Phase 6
  // A/B routing experiments — route a percentage of traffic for a given
  // (task_key, tenant_id) tuple from a baseline model to a candidate model.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS routing_experiments (
      id                    TEXT PRIMARY KEY,
      name                  TEXT NOT NULL,
      description           TEXT,
      tenant_id             TEXT,
      task_key              TEXT,
      baseline_provider     TEXT NOT NULL,
      baseline_model_id     TEXT NOT NULL,
      candidate_provider    TEXT NOT NULL,
      candidate_model_id    TEXT NOT NULL,
      traffic_pct           REAL NOT NULL DEFAULT 10,
      status                TEXT NOT NULL DEFAULT 'active',
      metadata              TEXT,
      started_at            TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at              TEXT,
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_experiments_lookup ON routing_experiments(status, task_key, tenant_id)');

  // ─── M9 — Backfill model_pricing for new providers (Gemini / Ollama / llama.cpp) ──
  // Existing databases skipped these rows in seedDefaultData() because the table
  // was non-empty. Insert any missing rows idempotently with INSERT OR IGNORE so
  // routing/admin surfaces immediately know about the new providers.
  const PRICING_BACKFILL: Array<[string, string, string, string, number, number, number]> = [
    // [id, model_id, provider, display_name, input/1M, output/1M, quality]
    ['a1b2c3d4-0001-4000-8000-000000000001', 'gemini-2.5-pro',        'google',   'Gemini 2.5 Pro',        1.25,   10.00, 0.92],
    ['a1b2c3d4-0001-4000-8000-000000000002', 'gemini-2.5-flash',      'google',   'Gemini 2.5 Flash',      0.30,   2.50,  0.82],
    ['a1b2c3d4-0001-4000-8000-000000000003', 'gemini-2.5-flash-lite', 'google',   'Gemini 2.5 Flash Lite', 0.10,   0.40,  0.72],
    ['a1b2c3d4-0001-4000-8000-000000000004', 'gemini-1.5-pro',        'google',   'Gemini 1.5 Pro',        1.25,   5.00,  0.85],
    ['a1b2c3d4-0001-4000-8000-000000000005', 'gemini-1.5-flash',      'google',   'Gemini 1.5 Flash',      0.075,  0.30,  0.72],
    ['a1b2c3d4-0002-4000-8000-000000000001', 'llama3.1',              'ollama',   'Llama 3.1 (local)',     0,      0,     0.72],
    ['a1b2c3d4-0002-4000-8000-000000000002', 'llama3',                'ollama',   'Llama 3 (local)',       0,      0,     0.70],
    ['a1b2c3d4-0002-4000-8000-000000000003', 'qwen2.5',               'ollama',   'Qwen 2.5 (local)',      0,      0,     0.74],
    ['a1b2c3d4-0002-4000-8000-000000000004', 'mistral',               'ollama',   'Mistral (local)',       0,      0,     0.68],
    ['a1b2c3d4-0002-4000-8000-000000000005', 'phi3',                  'ollama',   'Phi 3 (local)',         0,      0,     0.65],
    ['a1b2c3d4-0002-4000-8000-000000000006', 'gemma2',                'ollama',   'Gemma 2 (local)',       0,      0,     0.66],
    ['a1b2c3d4-0002-4000-8000-000000000007', 'deepseek-r1',           'ollama',   'DeepSeek R1 (local)',   0,      0,     0.80],
    ['a1b2c3d4-0003-4000-8000-000000000001', 'local',                 'llamacpp', 'llama.cpp local model', 0,      0,     0.70],
  ];
  const insertPricing = db.prepare(
    `INSERT OR IGNORE INTO model_pricing
       (id, model_id, provider, display_name, input_cost_per_1m, output_cost_per_1m, quality_score, source, last_synced_at, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'seed', NULL, 1)`,
  );
  for (const row of PRICING_BACKFILL) {
    try { insertPricing.run(...row); } catch { /* ignore */ }
  }

  // ─── M10 — Kaggle MCP tool catalog + credential seed (Phase K1) ──
  // Design doc: docs/KAGGLE_AGENT_DESIGN.md §4.1 + §8 (Phase K1).
  // Seeds one credential row pointing at KAGGLE_USERNAME/KAGGLE_KEY env vars
  // and 13 read-only Kaggle MCP tools backed by the @weaveintel/tools-kaggle
  // server. Rows are disabled by default — the operator must:
  //   (a) provision KAGGLE_USERNAME + KAGGLE_KEY in the runtime environment,
  //   (b) start the Kaggle MCP server (see examples/38-kaggle-mcp-readonly.ts),
  //   (c) flip enabled=1 in the Tool Catalog admin tab.
  // Fixed deterministic UUIDs so re-runs are idempotent via INSERT OR IGNORE.
  safeExec(db, `INSERT OR IGNORE INTO tool_credentials (
      id, name, description, credential_type, tool_names, env_var_name, config,
      rotation_due_at, validation_status, enabled, created_at, updated_at
    ) VALUES (
      'kgl00000-0000-4000-8000-000000000001',
      'Kaggle Default',
      'Default Kaggle API token (HTTP Basic). Set KAGGLE_USERNAME and KAGGLE_KEY env vars; the MCP server reads them per request.',
      'basic_auth',
      '["kaggle.competitions.list","kaggle.competitions.get","kaggle.competitions.files.list","kaggle.competitions.leaderboard.get","kaggle.competitions.submissions.list","kaggle.datasets.list","kaggle.datasets.get","kaggle.datasets.files.list","kaggle.kernels.list","kaggle.kernels.get","kaggle.kernels.pull","kaggle.kernels.status","kaggle.kernels.output"]',
      'KAGGLE_KEY',
      '{"usernameEnvVar":"KAGGLE_USERNAME","mcpEndpoint":"http://localhost:7421/mcp","note":"Auth is supplied by the local Kaggle MCP server reading both env vars; this row pins the names so admins know what to provision."}',
      NULL,
      'unknown',
      0,
      datetime('now'),
      datetime('now')
    )`);

  const KAGGLE_TOOLS: Array<[string, string, string, string]> = [
    // [uuid suffix, tool_key, name, description]
    ['10', 'kaggle.competitions.list',              'Kaggle: List Competitions',           'List Kaggle competitions with optional category/search/sortBy filters.'],
    ['11', 'kaggle.competitions.get',               'Kaggle: Get Competition',             'Get a single Kaggle competition by ref/slug.'],
    ['12', 'kaggle.competitions.files.list',        'Kaggle: List Competition Files',      'List the data files attached to a Kaggle competition.'],
    ['13', 'kaggle.competitions.leaderboard.get',   'Kaggle: Get Leaderboard',             'Fetch the public leaderboard for a Kaggle competition.'],
    ['14', 'kaggle.competitions.submissions.list',  'Kaggle: List Submissions',            "List the caller's prior submissions for a Kaggle competition."],
    ['15', 'kaggle.datasets.list',                  'Kaggle: List Datasets',               'Search the Kaggle dataset catalog with optional filters.'],
    ['16', 'kaggle.datasets.get',                   'Kaggle: Get Dataset',                 'Get a single Kaggle dataset by owner/slug ref.'],
    ['17', 'kaggle.datasets.files.list',            'Kaggle: List Dataset Files',          'List files inside a Kaggle dataset.'],
    ['18', 'kaggle.kernels.list',                   'Kaggle: List Kernels',                'List Kaggle kernels (notebooks/scripts) with optional filters.'],
    ['19', 'kaggle.kernels.get',                    'Kaggle: Get Kernel',                  'Get a single Kaggle kernel by owner/slug ref.'],
    ['20', 'kaggle.kernels.pull',                   'Kaggle: Pull Kernel',                 "Pull a Kaggle kernel's source and metadata."],
    ['21', 'kaggle.kernels.status',                 'Kaggle: Get Kernel Status',           'Get the latest run status of a Kaggle kernel.'],
    ['22', 'kaggle.kernels.output',                 'Kaggle: Get Kernel Output',           'List the output files (and log) from the latest kernel run.'],
  ];
  const insertKaggleTool = db.prepare(
    `INSERT OR IGNORE INTO tool_catalog (
      id, name, description, category, risk_level, requires_approval,
      max_execution_ms, rate_limit_per_min, enabled,
      tool_key, version, side_effects, tags, source, credential_id,
      config, allocation_class, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'read-only', 0, NULL, NULL, 0, ?, '0.1.0', 0, ?, 'mcp', 'kgl00000-0000-4000-8000-000000000001', ?, 'data', datetime('now'), datetime('now'))`,
  );
  const KAGGLE_CONFIG = JSON.stringify({ endpoint: 'http://localhost:7421/mcp' });
  const KAGGLE_TAGS = JSON.stringify(['kaggle', 'mcp', 'data-science']);
  for (const [suffix, toolKey, name, description] of KAGGLE_TOOLS) {
    try {
      insertKaggleTool.run(
        `kgl00000-0000-4000-8000-0000000000${suffix}`,
        name,
        description,
        'kaggle',
        toolKey,
        KAGGLE_TAGS,
        KAGGLE_CONFIG,
      );
    } catch { /* ignore */ }
  }

  // ─── M10b — Phase K2: Kaggle write tools + local sandboxed tools ──
  // Design doc: docs/KAGGLE_AGENT_DESIGN.md §4.1 + §6 + §7 (Phase K2).
  // Write tools (submit, push) carry the 'external-side-effect' risk and
  // require approval by default. Local tools (validate_submission, score_cv)
  // are pure compute — no network, no credentials needed.
  const insertKaggleWriteTool = db.prepare(
    `INSERT OR IGNORE INTO tool_catalog (
      id, name, description, category, risk_level, requires_approval,
      max_execution_ms, rate_limit_per_min, enabled,
      tool_key, version, side_effects, tags, source, credential_id,
      config, allocation_class, created_at, updated_at
    ) VALUES (?, ?, ?, 'kaggle', 'external-side-effect', 1, ?, ?, 0, ?, '0.1.0', 1, ?, 'mcp', 'kgl00000-0000-4000-8000-000000000001', ?, 'data', datetime('now'), datetime('now'))`,
  );
  // Kaggle competition submissions are commonly capped at 5/day. Set a
  // conservative per-minute limit; the daily cap is enforced at the policy
  // layer (Phase K3 ships kaggle_submit_gate).
  try {
    insertKaggleWriteTool.run(
      'kgl00000-0000-4000-8000-000000000023',
      'Kaggle: Submit to Competition',
      'EXTERNAL SIDE EFFECT — submit a file to a Kaggle competition. Counts against the daily submission cap (typically 5/day). Requires approval; callers must pre-validate the CSV via kaggle.local.validate_submission first.',
      300_000,
      1,
      'kaggle.competitions.submit',
      KAGGLE_TAGS,
      KAGGLE_CONFIG,
    );
  } catch { /* ignore */ }
  try {
    insertKaggleWriteTool.run(
      'kgl00000-0000-4000-8000-000000000024',
      'Kaggle: Push Kernel',
      'EXTERNAL SIDE EFFECT — create or version a Kaggle kernel (notebook/script). Defaults to private with no internet and no GPU. Requires approval.',
      300_000,
      2,
      'kaggle.kernels.push',
      KAGGLE_TAGS,
      KAGGLE_CONFIG,
    );
  } catch { /* ignore */ }

  // Local (pure compute) tools — no credentials, no network, no approval.
  const insertKaggleLocalTool = db.prepare(
    `INSERT OR IGNORE INTO tool_catalog (
      id, name, description, category, risk_level, requires_approval,
      max_execution_ms, rate_limit_per_min, enabled,
      tool_key, version, side_effects, tags, source, credential_id,
      config, allocation_class, created_at, updated_at
    ) VALUES (?, ?, ?, 'kaggle', 'read-only', 0, ?, NULL, 0, ?, '0.1.0', 0, ?, 'mcp', NULL, ?, 'data', datetime('now'), datetime('now'))`,
  );
  const KAGGLE_LOCAL_TAGS = JSON.stringify(['kaggle', 'mcp', 'local', 'sandbox']);
  try {
    insertKaggleLocalTool.run(
      'kgl00000-0000-4000-8000-000000000025',
      'Kaggle: Validate Submission (local)',
      'In-process pre-checks for a submission CSV (header order, row count, ID uniqueness/coverage). Pure TypeScript — no network, no credentials, runs in milliseconds. Use this BEFORE kaggle.competitions.submit.',
      30_000,
      'kaggle.local.validate_submission',
      KAGGLE_LOCAL_TAGS,
      KAGGLE_CONFIG,
    );
  } catch { /* ignore */ }
  try {
    insertKaggleLocalTool.run(
      'kgl00000-0000-4000-8000-000000000026',
      'Kaggle: Score CV (sandboxed)',
      'Run k-fold cross-validation in a sandboxed container (Python + sklearn). No network, no credentials. Requires the kaggle-runner image to be registered in the host @weaveintel/sandbox ImagePolicy.',
      300_000,
      'kaggle.local.score_cv',
      KAGGLE_LOCAL_TAGS,
      KAGGLE_CONFIG,
    );
  } catch { /* ignore */ }

  // ─── M11 — Phase K3: Kaggle tool policies, skills, and projection tables ──
  // Design doc: docs/KAGGLE_AGENT_DESIGN.md §4.1, §4.2, §6, §7, §8 (Phase K3).
  //
  // Seeds 4 tool policies (read-only, kernel push gate, submit gate, discussion
  // post gate), 6 skills (discoverer, ideator, implementer, validator, submitter,
  // observer), and creates 3 projection tables (kaggle_competitions_tracked,
  // kaggle_approaches, kaggle_runs). All inserts use INSERT OR IGNORE for
  // idempotency. Skills ship enabled=1 (operators can disable per-skill in
  // admin); the policies they reference are seeded enabled=1 too.
  //
  // Submission cap: kaggle_submit_gate uses rate_limit_per_minute=NULL and
  // applies the daily cap via max_concurrent=4 hint + admin discipline. The
  // tool already carries rate_limit_per_min=1 in M10b, and Kaggle's hard cap
  // (~5/day/competition) is the absolute ceiling. We document 4/day in the
  // policy description so operators see it; the per-minute approval gate plus
  // the audit trail make accidental over-spend visible immediately.

  // 1. Tool policies (4 rows)
  safeExec(db, `
    INSERT OR IGNORE INTO tool_policies
      (id, key, name, description, applies_to, applies_to_risk_levels, approval_required, allowed_risk_levels, max_execution_ms, rate_limit_per_minute, max_concurrent, require_dry_run, log_input_output, persona_scope, enabled)
    VALUES
      ('kgl00000-0000-4000-8001-000000000001', 'kaggle_read_only', 'Kaggle Read-Only',
       'Read-only access to Kaggle (list/get competitions, kernels, leaderboards, submissions). No writes, no approval, generous 60 req/min budget.',
       '["kaggle.competitions.list","kaggle.competitions.get","kaggle.competitions.files.list","kaggle.competitions.leaderboard.get","kaggle.competitions.submissions.list","kaggle.kernels.list","kaggle.kernels.pull","kaggle.kernels.status","kaggle.kernels.output","kaggle.local.validate_submission","kaggle.local.score_cv"]',
       '["read-only"]', 0,
       '["read-only"]',
       60000, 60, NULL, 0, 1, NULL, 1)
  `);

  safeExec(db, `
    INSERT OR IGNORE INTO tool_policies
      (id, key, name, description, applies_to, applies_to_risk_levels, approval_required, allowed_risk_levels, max_execution_ms, rate_limit_per_minute, max_concurrent, require_dry_run, log_input_output, persona_scope, enabled)
    VALUES
      ('kgl00000-0000-4000-8001-000000000002', 'kaggle_kernel_push_gate', 'Kaggle Kernel Push Gate',
       'Gate for kaggle.kernels.push. Requires human approval. Rate-limited to ~10/hour to discourage runaway notebook spam. Defaults already enforce is_private=true and enable_internet=false at the tool layer.',
       '["kaggle.kernels.push"]',
       '["external-side-effect"]', 1,
       '["read-only","external-side-effect"]',
       300000, 10, 1, 0, 1, NULL, 1)
  `);

  safeExec(db, `
    INSERT OR IGNORE INTO tool_policies
      (id, key, name, description, applies_to, applies_to_risk_levels, approval_required, allowed_risk_levels, max_execution_ms, rate_limit_per_minute, max_concurrent, require_dry_run, log_input_output, persona_scope, enabled)
    VALUES
      ('kgl00000-0000-4000-8001-000000000003', 'kaggle_submit_gate', 'Kaggle Submission Gate',
       'Gate for kaggle.competitions.submit. Requires human approval for every submission. Operator policy: cap at 4/day per competition (Kaggle hard-caps ~5/day; we leave one slot for human override). Per-minute rate limit is 1 — a hard pacing guarantee.',
       '["kaggle.competitions.submit"]',
       '["external-side-effect"]', 1,
       '["read-only","external-side-effect"]',
       300000, 1, 1, 1, 1, NULL, 1)
  `);

  safeExec(db, `
    INSERT OR IGNORE INTO tool_policies
      (id, key, name, description, applies_to, applies_to_risk_levels, approval_required, allowed_risk_levels, max_execution_ms, rate_limit_per_minute, max_concurrent, require_dry_run, log_input_output, persona_scope, enabled)
    VALUES
      ('kgl00000-0000-4000-8001-000000000004', 'kaggle_discussion_post_gate', 'Kaggle Discussion Post Gate (deferred)',
       'Reserved for the (deferred) kaggle.discussions.create tool. Requires approval; pacing is enforced via 1/week-per-competition admin discipline. Disabled by default; opt-in only when discussion posting ships.',
       '["kaggle.discussions.create"]',
       '["privileged"]', 1,
       '["privileged"]',
       60000, 1, 1, 1, 1, NULL, 0)
  `);

  // 2. Skills (6 rows). Seeded enabled=1 so the chat MVP examples work
  // out-of-the-box; operators can disable individual skills in admin if
  // they want narrower coverage.
  const insertKaggleSkill = db.prepare(
    `INSERT OR IGNORE INTO skills (
      id, name, description, category, trigger_patterns, instructions,
      tool_names, examples, tags, priority, version, tool_policy_key,
      enabled, supervisor_agent_id, domain_sections, execution_contract,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'data', ?, ?, ?, NULL, ?, ?, '1.0', ?, 1, NULL, NULL, ?, datetime('now'), datetime('now'))`,
  );
  const KAGGLE_SKILL_TAGS = JSON.stringify(['kaggle', 'data-science', 'competition']);

  type KaggleSkillSeed = {
    id: string;
    name: string;
    description: string;
    triggers: string[];
    instructions: string;
    tools: string[];
    policy: string;
    priority: number;
    requiredEvidence: string[];
  };

  const KAGGLE_SKILLS: KaggleSkillSeed[] = [
    {
      id: 'kgl00000-0000-4000-8002-000000000001',
      name: 'kaggle_discoverer',
      description: 'Surfaces relevant active Kaggle competitions for the user. Use when the user wants to find, browse, or pick a competition. Calls the Kaggle list/get APIs only — never submits or pushes.',
      triggers: ['find kaggle', 'browse kaggle', 'kaggle competitions', 'pick a competition', 'what kaggle', 'discover kaggle', 'active competitions'],
      instructions: [
        'When to use: the user wants to find, browse, or pick a Kaggle competition.',
        'When NOT to use: the user already has a competition picked (then use kaggle_ideator).',
        'Reasoning: list active competitions, then optionally fetch details for the most promising 1-3.',
        'Execution: call kaggle.competitions.list with a small page size (e.g. 10). For any competition the user expresses interest in, follow up with kaggle.competitions.get.',
        'Completion: present the top results in a compact list including ref, title, deadline, and reward. Confirm which competition the user wants to pursue.',
      ].join('\n'),
      tools: ['kaggle.competitions.list', 'kaggle.competitions.get'],
      policy: 'kaggle_read_only',
      priority: 100,
      requiredEvidence: ['competition', 'deadline'],
    },
    {
      id: 'kgl00000-0000-4000-8002-000000000002',
      name: 'kaggle_ideator',
      description: 'Drafts candidate modeling approaches for a chosen Kaggle competition by reading public kernels and dataset metadata. Read-only; does not push kernels or submit.',
      triggers: ['kaggle approach', 'ideate kaggle', 'how should i tackle', 'kaggle strategy', 'what model', 'kaggle plan'],
      instructions: [
        'When to use: the user has a competition in mind and wants modeling approaches.',
        'When NOT to use: there is no competition ref in scope (then trigger kaggle_discoverer first).',
        'Reasoning: scan a few top public kernels via kaggle.kernels.list, optionally pull the most relevant via kaggle.kernels.pull, and inspect competition files via kaggle.competitions.files.list.',
        'Execution: produce 2-3 approaches; each must specify a model family, key features, and an expected metric value.',
        'Completion: emit a short numbered list of approaches with explicit "expected metric" values so downstream skills can validate them.',
      ].join('\n'),
      tools: ['kaggle.kernels.list', 'kaggle.kernels.pull', 'kaggle.competitions.files.list'],
      policy: 'kaggle_read_only',
      priority: 80,
      requiredEvidence: ['approach', 'expected metric'],
    },
    {
      id: 'kgl00000-0000-4000-8002-000000000003',
      name: 'kaggle_implementer',
      description: 'Materializes a chosen approach as a Kaggle kernel (notebook/script) and pushes it via kaggle.kernels.push. WRITE — requires human approval per kaggle_kernel_push_gate.',
      triggers: ['push kernel', 'create kaggle kernel', 'submit kernel', 'implement kaggle approach', 'run on kaggle'],
      instructions: [
        'When to use: a specific approach has been chosen AND the user has explicitly asked to materialize it as a kernel.',
        'When NOT to use: no approach is chosen, OR the user only wants a local validation (use kaggle_validator instead).',
        'Reasoning: prepare clean notebook/script source. Default to is_private=true, enable_internet=false, enable_gpu=false. Treat the kernel push as expensive — operator approval will be requested.',
        'Execution: push via kaggle.kernels.push, then poll kaggle.kernels.status until "complete". Pull final output via kaggle.kernels.output.',
        'Completion: report the kernel ref, the final status, and the output URL or summary so kaggle_validator can take over.',
      ].join('\n'),
      tools: ['kaggle.kernels.push', 'kaggle.kernels.status', 'kaggle.kernels.output'],
      policy: 'kaggle_kernel_push_gate',
      priority: 80,
      requiredEvidence: ['kernel ref', 'status: complete'],
    },
    {
      id: 'kgl00000-0000-4000-8002-000000000004',
      name: 'kaggle_validator',
      description: 'Pre-flight checks a Kaggle submission CSV (header, row count, ID coverage) and optionally runs cross-validation in a sandboxed container. Read-only and side-effect-free.',
      triggers: ['validate submission', 'check submission', 'pre-flight kaggle', 'score cv', 'cross validate kaggle'],
      instructions: [
        'When to use: before any kaggle.competitions.submit call, or when the user wants to score an approach offline.',
        'When NOT to use: the user has not produced a submission CSV yet.',
        'Reasoning: cheap fail-fast first (validate_submission), then optionally cross-validate (score_cv) only if the user asked for it. score_cv runs in a sandboxed container; it requires the kaggle-runner image to be registered in the host ImagePolicy.',
        'Execution: call kaggle.local.validate_submission first; report any errors verbatim. If the user asked for CV, call kaggle.local.score_cv with the requested model and folds.',
        'Completion: state explicitly whether the submission is valid (use the phrase "valid submission") and report the row count (use "rows=").',
      ].join('\n'),
      tools: ['kaggle.local.validate_submission', 'kaggle.local.score_cv'],
      policy: 'kaggle_read_only',
      priority: 80,
      requiredEvidence: ['valid submission', 'rows='],
    },
    {
      id: 'kgl00000-0000-4000-8002-000000000005',
      name: 'kaggle_submitter',
      description: 'Submits a validated CSV to a Kaggle competition. WRITE — requires human approval per kaggle_submit_gate. Counts against the daily submission cap.',
      triggers: ['submit kaggle', 'submit to competition', 'send submission', 'final submission'],
      instructions: [
        'When to use: a CSV has been validated AND the user has explicitly asked to submit it.',
        'When NOT to use: the CSV has not been validated by kaggle_validator (refuse and request validation first).',
        'Reasoning: every call counts against the daily cap. Confirm the competition ref and the file before invoking. Approval will be requested by policy — wait for it.',
        'Execution: call kaggle.competitions.submit with the validated file content and a clear description. Report the submission id and public score (when ready).',
        'Completion: report "submission id" and the "public score" (or pending state) so observability traces capture both.',
      ].join('\n'),
      tools: ['kaggle.competitions.submit'],
      policy: 'kaggle_submit_gate',
      priority: 80,
      requiredEvidence: ['submission id', 'public score'],
    },
    {
      id: 'kgl00000-0000-4000-8002-000000000006',
      name: 'kaggle_observer',
      description: 'Reads the Kaggle leaderboard and submission history for a competition. Read-only; used to track standings and decide when to iterate.',
      triggers: ['kaggle leaderboard', 'check rank', 'kaggle standings', 'my submissions kaggle', 'how am i doing kaggle'],
      instructions: [
        'When to use: the user wants the current rank/score or a history of submissions for a competition.',
        'When NOT to use: the user wants to submit (use kaggle_submitter) or to find a new competition (use kaggle_discoverer).',
        'Reasoning: leaderboard reads are cheap. Combine leaderboard.get with submissions.list for a complete picture.',
        'Execution: call kaggle.competitions.leaderboard.get and kaggle.competitions.submissions.list; summarize.',
        'Completion: report the user rank and best score explicitly using the words "rank" and "score".',
      ].join('\n'),
      tools: ['kaggle.competitions.leaderboard.get', 'kaggle.competitions.submissions.list'],
      policy: 'kaggle_read_only',
      priority: 80,
      requiredEvidence: ['rank', 'score'],
    },
  ];

  for (const skill of KAGGLE_SKILLS) {
    try {
      insertKaggleSkill.run(
        skill.id,
        skill.name,
        skill.description,
        JSON.stringify(skill.triggers),
        skill.instructions,
        JSON.stringify(skill.tools),
        KAGGLE_SKILL_TAGS,
        skill.priority,
        skill.policy,
        JSON.stringify({ requiredOutputSubstrings: skill.requiredEvidence }),
      );
    } catch { /* ignore */ }
  }

  // 3. Projection tables (3 tables, all UUID PKs, all using INSERT OR IGNORE
  //    for idempotency on later upserts).
  //
  // These are app-level projections. Source of truth for evidence + traces
  // remains @weaveintel/contracts and the live-agents StateStore (Phase K5).
  // Dropping all three tables and rebuilding from contracts is loss-free.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS kaggle_competitions_tracked (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      competition_ref TEXT NOT NULL,
      title TEXT,
      category TEXT,
      deadline TEXT,
      reward TEXT,
      url TEXT,
      status TEXT NOT NULL DEFAULT 'watching',
      notes TEXT,
      last_synced_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, competition_ref)
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_kaggle_tracked_competition ON kaggle_competitions_tracked(competition_ref)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_kaggle_tracked_status ON kaggle_competitions_tracked(status)`);

  safeExec(db, `
    CREATE TABLE IF NOT EXISTS kaggle_approaches (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      competition_ref TEXT NOT NULL,
      summary TEXT NOT NULL,
      expected_metric TEXT,
      model TEXT,
      source_kernel_refs TEXT,
      embedding BLOB,
      status TEXT NOT NULL DEFAULT 'draft',
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_kaggle_approaches_competition ON kaggle_approaches(competition_ref)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_kaggle_approaches_status ON kaggle_approaches(status)`);

  safeExec(db, `
    CREATE TABLE IF NOT EXISTS kaggle_runs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      competition_ref TEXT NOT NULL,
      approach_id TEXT,
      contract_id TEXT,
      replay_trace_id TEXT,
      mesh_id TEXT,
      agent_id TEXT,
      kernel_ref TEXT,
      submission_id TEXT,
      public_score REAL,
      validator_report TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_kaggle_runs_competition ON kaggle_runs(competition_ref)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_kaggle_runs_status ON kaggle_runs(status)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_kaggle_runs_approach ON kaggle_runs(approach_id)`);

  // ─── M12 — Phase K4: Kaggle run artifacts (contract + replay storage) ──
  // Each materialized Kaggle run gets ONE artifact row that stores:
  //   - the @weaveintel/contracts CompletionReport (evidence bundle)
  //   - the @weaveintel/replay RunLog (deterministic re-execution input)
  // Source-of-truth invariants from KAGGLE_AGENT_DESIGN §3:
  //   - kaggle_runs is a derived view; this artifact table holds the actual
  //     contract + trace JSON so admin UI + replay endpoint can reconstruct.
  //   - One row per (run_id) — UNIQUE — but materializeKaggleRun replaces on
  //     re-materialize (UPSERT) so chat retries don't fragment the ledger.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS kaggle_run_artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE REFERENCES kaggle_runs(id) ON DELETE CASCADE,
      contract_id TEXT NOT NULL,
      replay_trace_id TEXT NOT NULL,
      contract_report_json TEXT NOT NULL,
      replay_run_log_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_kaggle_run_artifacts_contract ON kaggle_run_artifacts(contract_id)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_kaggle_run_artifacts_trace ON kaggle_run_artifacts(replay_trace_id)`);

  // Seed: one demo Kaggle run + matching artifact so the admin UI renders a
  // non-empty Run Artifacts tab on a fresh database. Deterministic IDs make
  // the seed idempotent across re-boots and replay-friendly in tests.
  const seedRunId = 'kgl-run-seed-001';
  const seedContractId = '00000000-0000-4000-8000-000000000kgl';
  const seedTraceId = 'kgl-trace-seed-001';
  // Companion demo competition row so the kaggle-runs detail join finds a
  // competition record on a fresh DB.
  safeExec(db,
    `INSERT OR IGNORE INTO kaggle_competitions_tracked (id, tenant_id, competition_ref, title, category, deadline, reward, url, status, notes)
     VALUES ('kgl-comp-seed-001', NULL, 'demo-comp-1', 'Demo Competition', 'tabular', NULL, NULL, NULL, 'watching', 'Seeded by Phase K4 to demo replay round-trip.')`,
  );
  const seedRunLog = JSON.stringify({
    executionId: seedTraceId,
    startTime: 1700000000000,
    endTime: 1700000001000,
    status: 'completed',
    steps: [
      { index: 0, type: 'tool', name: 'kaggle.kernels_push', startTime: 1700000000000, endTime: 1700000000400, input: { kernelRef: 'demo-user/demo-kernel' }, output: { ok: true } },
      { index: 1, type: 'tool', name: 'kaggle.competitions_submit', startTime: 1700000000400, endTime: 1700000001000, input: { competitionRef: 'demo-comp-1' }, output: { submissionId: 'sub-1', publicScore: 0.812 } },
    ],
    totalTokens: 0,
  });
  const seedReport = JSON.stringify({
    taskContractId: seedContractId,
    status: 'fulfilled',
    results: [
      { criteriaId: 'kernel-ref-present', passed: true, score: 1 },
      { criteriaId: 'submission-id-present', passed: true, score: 1 },
    ],
    evidence: { items: [
      { type: 'text', label: 'kernel_ref', value: 'demo-user/demo-kernel' },
      { type: 'metric', label: 'public_score', value: 0.812 },
    ] },
    confidence: 1,
    completedAt: '2023-11-14T22:13:21.000Z',
  });
  safeExec(db,
    `INSERT OR IGNORE INTO kaggle_runs (id, tenant_id, competition_ref, approach_id, contract_id, replay_trace_id, mesh_id, agent_id, kernel_ref, submission_id, public_score, validator_report, status, started_at, completed_at)
     VALUES ('${seedRunId}', NULL, 'demo-comp-1', NULL, '${seedContractId}', '${seedTraceId}', NULL, NULL, 'demo-user/demo-kernel', 'sub-1', 0.812, NULL, 'submitted', '2023-11-14T22:13:20.000Z', '2023-11-14T22:13:21.000Z')`,
  );
  const safeReport = seedReport.replace(/'/g, "''");
  const safeLog = seedRunLog.replace(/'/g, "''");
  safeExec(db,
    `INSERT OR IGNORE INTO kaggle_run_artifacts (id, run_id, contract_id, replay_trace_id, contract_report_json, replay_run_log_json)
     VALUES ('kgl-art-seed-001', '${seedRunId}', '${seedContractId}', '${seedTraceId}', '${safeReport}', '${safeLog}')`,
  );

  // ─── M13 — Phase K5: Kaggle live-agents mesh index ─────────────────
  // The live-agents StateStore (la_entities, separate SQLite file) does NOT
  // expose listMeshes() without a tenantId. To let admin GET routes enumerate
  // every Kaggle mesh that has ever been provisioned, we record (tenant_id,
  // mesh_id) pairs in geneweave.db on every bootKaggleMesh() call. This is a
  // pure pointer index — no domain state lives here.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS kaggle_live_mesh_index (
      mesh_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      kaggle_username TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_kaggle_live_mesh_index_tenant ON kaggle_live_mesh_index(tenant_id)`);

  // ─── M14 — Phase K6: Kaggle discussion bot (deferred, opt-in) ──────
  // Design doc: docs/KAGGLE_AGENT_DESIGN.md §4.1 + §8 (Phase K6).
  // Adds the privileged kaggle.discussions.create write tool and the
  // matching kaggle_communicator skill. BOTH ship disabled (enabled=0). To
  // turn the bot on for a tenant the operator must:
  //   (1) flip enabled=1 on the kaggle.discussions.create tool_catalog row,
  //   (2) flip enabled=1 on the kaggle_discussion_post_gate tool policy
  //       (seeded disabled in M11),
  //   (3) flip enabled=1 on the kaggle_communicator skill,
  //   (4) set discussion_enabled=1 on the kaggle_discussion_settings row
  //       for the target tenant_id (kill switch).
  // The runtime checks (4) before invoking the tool and silently no-ops if
  // the kill switch is off.
  try {
    db.prepare(
      `INSERT OR IGNORE INTO tool_catalog (
        id, name, description, category, risk_level, requires_approval,
        max_execution_ms, rate_limit_per_min, enabled,
        tool_key, version, side_effects, tags, source, credential_id,
        config, allocation_class, created_at, updated_at
      ) VALUES (?, ?, ?, 'kaggle', 'privileged', 1, ?, ?, 0, ?, '0.1.0', 1, ?, 'mcp', 'kgl00000-0000-4000-8000-000000000001', ?, 'data', datetime('now'), datetime('now'))`,
    ).run(
      'kgl00000-0000-4000-8000-000000000027',
      'Kaggle: Create Discussion Post',
      'PRIVILEGED + PUBLIC + IRREVOCABLE — post a topic or reply on a Kaggle competition discussion forum. Every call is human-attributable to the bound Kaggle account. Disabled by default; requires kaggle_discussion_post_gate (approval + 1/week pacing) and the per-tenant kill switch in kaggle_discussion_settings.',
      60_000,
      1,
      'kaggle.discussions.create',
      JSON.stringify(['kaggle', 'mcp', 'communications']),
      JSON.stringify({ endpoint: 'http://localhost:7421/mcp' }),
    );
  } catch { /* ignore */ }

  // Per-tenant kill switch + light-weight post log. Both rows use UUID PKs
  // (TEXT in SQLite). The settings table is upserted per-tenant; the posts
  // table is append-only and readable from the admin UI.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS kaggle_discussion_settings (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL UNIQUE,
      discussion_enabled INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS kaggle_discussion_posts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      competition_ref TEXT NOT NULL,
      topic_id TEXT NOT NULL,
      parent_topic_id TEXT,
      title TEXT,
      body_preview TEXT,
      url TEXT,
      status TEXT NOT NULL DEFAULT 'posted',
      contract_id TEXT,
      replay_trace_id TEXT,
      posted_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_kaggle_discussion_posts_tenant ON kaggle_discussion_posts(tenant_id)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_kaggle_discussion_posts_competition ON kaggle_discussion_posts(competition_ref)`);

  // Skill: kaggle_communicator. Reuses the kaggle_discussion_post_gate
  // policy seeded in M11 (currently disabled). Ships enabled=0 so it does
  // not get auto-activated by chat triggers until the operator opts in.
  try {
    db.prepare(
      `INSERT OR IGNORE INTO skills (
        id, name, description, category, trigger_patterns, instructions,
        tool_names, examples, tags, priority, version, tool_policy_key,
        enabled, supervisor_agent_id, domain_sections, execution_contract,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'data', ?, ?, ?, NULL, ?, 60, '1.0', ?, 0, NULL, NULL, ?, datetime('now'), datetime('now'))`,
    ).run(
      'kgl00000-0000-4000-8002-000000000007',
      'kaggle_communicator',
      'Drafts and posts to a Kaggle competition discussion forum. PRIVILEGED — every post is public and irrevocable, attributed to the bound Kaggle account. Requires human approval per kaggle_discussion_post_gate AND a tenant-level kill switch ON. Hard cap: 1 post per competition per week (operator discipline + policy rate limit).',
      JSON.stringify(['post discussion', 'kaggle forum', 'reply on kaggle', 'announce on kaggle', 'thank kaggle']),
      [
        'When to use: the user has explicitly asked to post a topic or reply on a Kaggle competition discussion forum.',
        'When NOT to use: anything else. This is the only skill in the Kaggle pack that creates public, irrevocable, human-attributable artifacts.',
        'Reasoning: drafting is cheap; posting is expensive. Always present the full draft to the human first and obtain explicit "post it" confirmation before invoking the tool.',
        'Execution: call kaggle.discussions.create with competitionRef + title + body (or parentTopicId for a reply). Approval will be requested by policy — wait for it. The platform will reject silently if the per-tenant kill switch is off.',
        'Completion: report the posted topic id, the URL, and a one-line summary of the body. Use the words "topic id" and "url" in the final reply so observability captures both.',
      ].join('\n'),
      JSON.stringify(['kaggle.discussions.create']),
      JSON.stringify(['kaggle', 'data-science', 'communications']),
      'kaggle_discussion_post_gate',
      JSON.stringify({ requiredOutputSubstrings: ['topic id', 'url'] }),
    );
  } catch { /* ignore */ }

  // ─── M15 — Phase K7a: Ensembling + OOF tracking + blend tool ────────
  // Design doc: docs/KAGGLE_AGENT_DESIGN.md §8b (Phase K7).
  //
  // Three additive changes:
  //   (1) ALTER kaggle_runs    — add cv_score / cv_metric / oof_path /
  //       is_ensemble / ensemble_member_run_ids so we can ensemble later runs.
  //   (2) ALTER kaggle_approaches — add ensemble_member_of, blend_weights,
  //       expected_metric_value to record blend hypotheses.
  //   (3) Seed the kaggle.local.blend tool_catalog row (sandboxed, read-only,
  //       enabled=0 — operator opt-in) and the kaggle_ensembler skill
  //       (enabled=1 — only fires when ≥2 validated runs already exist).
  //
  // All ALTERs use try/catch because SQLite errors if the column already
  // exists; the migration must be re-runnable.
  const k7aAlters = [
    `ALTER TABLE kaggle_runs ADD COLUMN cv_score REAL`,
    `ALTER TABLE kaggle_runs ADD COLUMN cv_metric TEXT`,
    `ALTER TABLE kaggle_runs ADD COLUMN oof_path TEXT`,
    `ALTER TABLE kaggle_runs ADD COLUMN is_ensemble INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE kaggle_runs ADD COLUMN ensemble_member_run_ids TEXT`,
    `ALTER TABLE kaggle_approaches ADD COLUMN ensemble_member_of TEXT`,
    `ALTER TABLE kaggle_approaches ADD COLUMN blend_weights TEXT`,
    `ALTER TABLE kaggle_approaches ADD COLUMN expected_metric_value REAL`,
  ];
  for (const sql of k7aAlters) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }

  try {
    db.prepare(
      `INSERT OR IGNORE INTO tool_catalog (
        id, name, description, category, risk_level, requires_approval,
        max_execution_ms, rate_limit_per_min, enabled,
        tool_key, version, side_effects, tags, source, credential_id,
        config, allocation_class, created_at, updated_at
      ) VALUES (?, ?, ?, 'kaggle', 'read-only', 0, ?, NULL, 0, ?, '0.2.0', 0, ?, 'mcp', NULL, ?, 'data', datetime('now'), datetime('now'))`,
    ).run(
      'kgl00000-0000-4000-8000-000000000028',
      'Kaggle: Blend OOF Predictions (sandboxed)',
      'Find optimal weighted blend of N OOF prediction vectors via SLSQP optimization on the simplex (weights ≥ 0, sum = 1). Runs in a sandboxed Python container with scipy. No network, no credentials. Requires kaggle-runner image v0.2.0+ in the host ImagePolicy.',
      120_000,
      'kaggle.local.blend',
      JSON.stringify(['kaggle', 'mcp', 'local', 'sandbox', 'ensemble']),
      JSON.stringify({ endpoint: 'http://localhost:7421/mcp' }),
    );
  } catch { /* ignore */ }

  try {
    db.prepare(
      `INSERT OR IGNORE INTO skills (
        id, name, description, category, trigger_patterns, instructions,
        tool_names, examples, tags, priority, version, tool_policy_key,
        enabled, supervisor_agent_id, domain_sections, execution_contract,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'data', ?, ?, ?, NULL, ?, 70, '1.0', ?, 1, NULL, NULL, ?, datetime('now'), datetime('now'))`,
    ).run(
      'kgl00000-0000-4000-8002-000000000008',
      'kaggle_ensembler',
      'Combines two or more previously validated Kaggle runs on the same competition into an optimal weighted blend. Read-only — produces a new candidate submission CSV but does not submit it; kaggle_submitter must be invoked separately if the user wants to submit.',
      JSON.stringify(['ensemble kaggle', 'blend submissions', 'combine submissions', 'stack models', 'weighted blend kaggle', 'ensemble approaches']),
      [
        'When to use: the same competition already has ≥2 completed kaggle_runs rows with non-null oof_path values (i.e. validated CV runs whose out-of-fold predictions were captured). The user has asked to combine them, blend them, or build an ensemble.',
        'When NOT to use: only one validated run exists (run kaggle_validator on a different model first), or the user wants to submit (hand off to kaggle_submitter), or oof predictions were never captured (re-run kaggle_validator with captureOof=true).',
        'Reasoning: a convex blend of diverse, well-calibrated OOF vectors almost always beats the single best model on tabular Kaggle competitions. The optimizer (SLSQP on the simplex) is cheap; the expensive part is having captured OOF in the first place. Always report the blendedScore vs baselineBestSoloScore so the human can see whether the blend is worth submitting.',
        'Execution: load OOF arrays from each candidate run (oof_path), assemble oofMatrix (rows=models, cols=samples), call kaggle.local.blend with the metric matching the competition. Persist a new kaggle_approaches row with ensemble_member_of=<comma-separated run ids>, blend_weights=<JSON array>, expected_metric_value=<blendedScore>.',
        'Completion: report the optimal "weights" array, the "blendedScore", and the "baselineBestSoloScore" so observability captures all three. State explicitly whether the blend beat the best solo model.',
      ].join('\n'),
      JSON.stringify(['kaggle.local.blend']),
      JSON.stringify(['kaggle', 'data-science', 'ensemble', 'blending']),
      'kaggle_read_only',
      JSON.stringify({ requiredOutputSubstrings: ['weights', 'blendedScore', 'baselineBestSoloScore'] }),
    );
  } catch { /* ignore */ }

  // ─── M18 — Phase K7d: Competition-agnostic submission validation ────────
  // New tables backing the validator + leaderboard observer roles.
  // - kaggle_competition_rubric: per-competition acceptance criteria. Auto-
  //   inferred from Kaggle metadata (evaluationMetric, sample submission
  //   shape) on first contact, then editable by operators.
  // - kaggle_validation_results: append-only ledger of validator passes
  //   (schema/distribution/baseline checks + verdict). One row per kernel run
  //   the validator reviews.
  // - kaggle_leaderboard_scores: append-only ledger of leaderboard readbacks
  //   from kaggle.competitions.submissions/list after the submitter pushes.
  safeExec(db, `CREATE TABLE IF NOT EXISTS kaggle_competition_rubric (
    id TEXT PRIMARY KEY,
    tenant_id TEXT,
    competition_ref TEXT NOT NULL,
    metric_name TEXT,
    metric_direction TEXT CHECK(metric_direction IN ('maximize','minimize')),
    baseline_score REAL,
    target_score REAL,
    expected_row_count INTEGER,
    id_column TEXT,
    id_range_min INTEGER,
    id_range_max INTEGER,
    target_column TEXT,
    target_type TEXT,
    expected_distribution_json TEXT,
    sample_submission_sha256 TEXT,
    inference_source TEXT,
    auto_generated INTEGER NOT NULL DEFAULT 1,
    inferred_at TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tenant_id, competition_ref)
  )`);
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_kaggle_rubric_competition_ref ON kaggle_competition_rubric(competition_ref)');

  safeExec(db, `CREATE TABLE IF NOT EXISTS kaggle_validation_results (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    competition_ref TEXT NOT NULL,
    rubric_id TEXT,
    kernel_ref TEXT,
    schema_check_passed INTEGER,
    distribution_check_passed INTEGER,
    baseline_check_passed INTEGER,
    cv_score REAL,
    cv_std REAL,
    cv_metric TEXT,
    n_folds INTEGER,
    predicted_distribution_json TEXT,
    violations_json TEXT,
    verdict TEXT CHECK(verdict IN ('pass','warn','fail')),
    summary TEXT,
    validated_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_kaggle_validation_run_id ON kaggle_validation_results(run_id)');
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_kaggle_validation_rubric_id ON kaggle_validation_results(rubric_id)');
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_kaggle_validation_verdict ON kaggle_validation_results(verdict)');
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_kaggle_validation_competition_ref ON kaggle_validation_results(competition_ref)');

  safeExec(db, `CREATE TABLE IF NOT EXISTS kaggle_leaderboard_scores (
    id TEXT PRIMARY KEY,
    run_id TEXT,
    competition_ref TEXT NOT NULL,
    submission_id TEXT,
    public_score REAL,
    private_score REAL,
    cv_lb_delta REAL,
    percentile_estimate REAL,
    rank_estimate INTEGER,
    leaderboard_size INTEGER,
    raw_status TEXT,
    observed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_kaggle_lb_run_id ON kaggle_leaderboard_scores(run_id)');
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_kaggle_lb_competition_ref ON kaggle_leaderboard_scores(competition_ref)');
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_kaggle_lb_submission_id ON kaggle_leaderboard_scores(submission_id)');

  // ─── M19 — Live-agents StateStore mirror (la_entities) ──────────────────
  // The @weaveintel/live-agents SqliteStateStore persists meshes, agents,
  // contracts, account bindings, ticks, messages, etc. as JSON payloads keyed
  // by (entity_type, id). Historically this lived in a separate SQLite file
  // (`./live-agents.db`); consolidating it into geneweave.db means everything
  // is documented in one place and the Kaggle live-agents admin tabs read
  // from the same DB the rest of the app uses.
  //
  // Schema MUST match `MIGRATIONS_SQL` in `packages/live-agents/src/sqlite-state-store.ts`
  // exactly so the StateStore can attach to this file without re-creating the
  // table.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS la_entities (
      entity_type TEXT NOT NULL,
      id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (entity_type, id)
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_la_entities_type_updated ON la_entities(entity_type, updated_at)`);

  // ─── M20 — Kaggle competition runs ledger (per-run UUIDv7 isolation) ────
  // Each "Start Competition" click creates a fresh run row keyed by UUIDv7.
  // All steps and events the agents emit during the run are scoped to that
  // run id, so subsequent runs of the same competition produce a brand new
  // step/flow timeline rather than appending to or mutating a previous one.
  //
  // - kgl_competition_run    — one row per run (status, mesh_id, totals)
  // - kgl_run_step           — ordered, named units of work in the flow
  // - kgl_run_event          — fine-grained events (tool calls, dialogue,
  //                            evidence, log lines) optionally attached to
  //                            a step
  //
  // All PKs are UUIDv7 (TEXT), so they sort naturally by creation time.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS kgl_competition_run (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      submitted_by TEXT NOT NULL,
      competition_ref TEXT NOT NULL,
      title TEXT,
      objective TEXT,
      mesh_id TEXT,
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','running','completed','abandoned','failed')),
      step_count INTEGER NOT NULL DEFAULT 0,
      event_count INTEGER NOT NULL DEFAULT 0,
      summary TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_kgl_run_tenant ON kgl_competition_run(tenant_id, created_at DESC)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_kgl_run_competition ON kgl_competition_run(competition_ref)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_kgl_run_status ON kgl_competition_run(status)`);

  safeExec(db, `
    CREATE TABLE IF NOT EXISTS kgl_run_step (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES kgl_competition_run(id) ON DELETE CASCADE,
      step_index INTEGER NOT NULL,
      role TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      agent_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','running','completed','failed','skipped')),
      started_at TEXT,
      completed_at TEXT,
      summary TEXT,
      input_preview TEXT,
      output_preview TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_kgl_step_run ON kgl_run_step(run_id, step_index)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_kgl_step_status ON kgl_run_step(status)`);

  safeExec(db, `
    CREATE TABLE IF NOT EXISTS kgl_run_event (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES kgl_competition_run(id) ON DELETE CASCADE,
      step_id TEXT REFERENCES kgl_run_step(id) ON DELETE SET NULL,
      kind TEXT NOT NULL,
      agent_id TEXT,
      tool_key TEXT,
      summary TEXT NOT NULL,
      payload_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_kgl_event_run ON kgl_run_event(run_id, id)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_kgl_event_step ON kgl_run_event(step_id)`);

  // ─── M21 — Live mesh/agent definitions (DB-driven mesh blueprints) ──────
  // Move mesh + agent + delegation-edge templates out of code and into the
  // database. Each `live_mesh_definitions` row defines a reusable mesh
  // blueprint (e.g. "kaggle"); its `live_agent_definitions` rows describe
  // each role-bound agent (persona / objectives / success indicators); and
  // `live_mesh_delegation_edges` describes the directed graph between roles.
  // Operators edit personas + pipeline shape from the admin UI — runtime
  // boot loads the snapshot at provision time. Playbook overlays still apply
  // on top, scoped per competition slug.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS live_mesh_definitions (
      id TEXT PRIMARY KEY,
      mesh_key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      charter_prose TEXT NOT NULL,
      dual_control_required_for TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_live_mesh_def_enabled ON live_mesh_definitions(enabled)`);

  safeExec(db, `
    CREATE TABLE IF NOT EXISTS live_agent_definitions (
      id TEXT PRIMARY KEY,
      mesh_def_id TEXT NOT NULL REFERENCES live_mesh_definitions(id) ON DELETE CASCADE,
      role_key TEXT NOT NULL,
      name TEXT NOT NULL,
      role_label TEXT NOT NULL,
      persona TEXT NOT NULL,
      objectives TEXT NOT NULL,
      success_indicators TEXT NOT NULL,
      ordering INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(mesh_def_id, role_key)
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_live_agent_def_mesh ON live_agent_definitions(mesh_def_id, ordering)`);

  safeExec(db, `
    CREATE TABLE IF NOT EXISTS live_mesh_delegation_edges (
      id TEXT PRIMARY KEY,
      mesh_def_id TEXT NOT NULL REFERENCES live_mesh_definitions(id) ON DELETE CASCADE,
      from_role_key TEXT NOT NULL,
      to_role_key TEXT NOT NULL,
      relationship TEXT NOT NULL,
      prose TEXT NOT NULL,
      ordering INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(mesh_def_id, from_role_key, to_role_key)
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_live_edge_mesh ON live_mesh_delegation_edges(mesh_def_id, ordering)`);

  // ─── M22 — DB-driven Live-Agents Runtime (Phase 1) ──────────────────────
  // Design doc: docs/live-agents/DB_DRIVEN_RUNTIME_PLAN.md §3.
  //
  // Splits the live-agents framework into:
  //   • blueprint  (live_mesh_definitions, live_agent_definitions — M21)
  //   • runtime    (live_meshes, live_agents — provisioned per tenant, M22)
  //   • bindings   (handler_bindings, tool_bindings — what each agent does)
  //   • registries (live_handler_kinds, live_attention_policies — DB-managed)
  //   • ledger     (live_runs, live_run_steps, live_run_events — generic
  //                 replacement for kgl_run_step / kgl_run_event)
  //
  // Every table uses a TEXT UUIDv7 primary key. All ALTERs are wrapped in
  // try/catch to remain idempotent on existing databases.

  // (a) Extend live_mesh_definitions with optional Phase-1 columns. Each
  //     ALTER is wrapped because SQLite has no `ADD COLUMN IF NOT EXISTS`.
  const m22DefAlters = [
    `ALTER TABLE live_mesh_definitions ADD COLUMN domain TEXT`,
    `ALTER TABLE live_mesh_definitions ADD COLUMN bridge_topics_default TEXT`,
    `ALTER TABLE live_mesh_definitions ADD COLUMN bridge_rate_limit_default INTEGER`,
    `ALTER TABLE live_mesh_definitions ADD COLUMN provisioner_config_json TEXT`,
    `ALTER TABLE live_agent_definitions ADD COLUMN default_handler_kind TEXT`,
    `ALTER TABLE live_agent_definitions ADD COLUMN default_handler_config_json TEXT`,
    `ALTER TABLE live_agent_definitions ADD COLUMN default_tool_catalog_keys TEXT`,
    `ALTER TABLE live_agent_definitions ADD COLUMN default_attention_policy_key TEXT`,
    `ALTER TABLE live_agent_definitions ADD COLUMN model_capability_json TEXT`,
    `ALTER TABLE live_agent_definitions ADD COLUMN model_routing_policy_key TEXT`,
    `ALTER TABLE live_agent_definitions ADD COLUMN model_pinned_id TEXT`,
    `ALTER TABLE tool_catalog ADD COLUMN domain_tags TEXT`,
  ];
  for (const sql of m22DefAlters) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }

  // (b) Framework registry — the set of handler kinds the runtime knows
  //     about. Implementations live in code (Phase 2 plugins); this table
  //     exists so admins can introspect / select kinds in the UI and so
  //     handler bindings can FK-validate against a known kind.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS live_handler_kinds (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      config_schema_json TEXT NOT NULL DEFAULT '{}',
      source TEXT NOT NULL DEFAULT 'builtin',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // (c) Attention policies — selectable behaviour profiles for "when should
  //     this agent take a tick?". Three built-in `kind`s ship in seeds:
  //     'heuristic', 'cron', 'model'. Tunables live in `config_json`.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS live_attention_policies (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      description TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // (d) live_meshes — a *provisioned* runtime mesh (one per tenant per
  //     blueprint). Distinct from `live_mesh_definitions` (the blueprint).
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS live_meshes (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      mesh_def_id TEXT NOT NULL REFERENCES live_mesh_definitions(id) ON DELETE RESTRICT,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      domain TEXT,
      dual_control_required_for TEXT NOT NULL DEFAULT '[]',
      owner_human_id TEXT,
      mcp_server_ref TEXT,
      account_id TEXT,
      context_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_live_meshes_tenant ON live_meshes(tenant_id, status)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_live_meshes_def ON live_meshes(mesh_def_id)`);

  // (e) live_agents — a provisioned agent inside a runtime mesh. Persona /
  //     objectives are denormalised at provision time so blueprint edits
  //     never silently mutate live agents.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS live_agents (
      id TEXT PRIMARY KEY,
      mesh_id TEXT NOT NULL REFERENCES live_meshes(id) ON DELETE CASCADE,
      agent_def_id TEXT REFERENCES live_agent_definitions(id) ON DELETE SET NULL,
      role_key TEXT NOT NULL,
      name TEXT NOT NULL,
      role_label TEXT NOT NULL,
      persona TEXT NOT NULL,
      objectives TEXT NOT NULL,
      success_indicators TEXT NOT NULL,
      attention_policy_key TEXT,
      contract_version_id TEXT,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      ordering INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(mesh_id, role_key)
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_live_agents_mesh ON live_agents(mesh_id, status)`);

  // (f) live_agent_handler_bindings — one row per live_agents row says
  //     which handler kind dispatches its ticks plus opaque config.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS live_agent_handler_bindings (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES live_agents(id) ON DELETE CASCADE,
      handler_kind TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(agent_id, handler_kind)
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_live_handler_bind_agent ON live_agent_handler_bindings(agent_id, enabled)`);

  // (g) live_agent_tool_bindings — M2M from live_agents to either
  //     `tool_catalog` rows or external MCP server endpoints. Replaces the
  //     in-code KAGGLE_CAPABILITY_MATRIX. Either tool_catalog_id OR
  //     mcp_server_url must be non-null.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS live_agent_tool_bindings (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES live_agents(id) ON DELETE CASCADE,
      tool_catalog_id TEXT REFERENCES tool_catalog(id) ON DELETE CASCADE,
      mcp_server_url TEXT,
      capability_keys TEXT NOT NULL DEFAULT '[]',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_live_tool_bind_agent ON live_agent_tool_bindings(agent_id, enabled)`);

  // (h) live_runs — a "campaign" inside a mesh. Generic enough to cover a
  //     Kaggle competition run, an inbox triage pass, a code-review queue.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS live_runs (
      id TEXT PRIMARY KEY,
      mesh_id TEXT NOT NULL REFERENCES live_meshes(id) ON DELETE CASCADE,
      tenant_id TEXT,
      run_key TEXT NOT NULL,
      label TEXT,
      status TEXT NOT NULL DEFAULT 'RUNNING',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      summary TEXT,
      context_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(mesh_id, run_key)
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_live_runs_mesh ON live_runs(mesh_id, status, started_at)`);

  // (i) live_run_steps — per-agent progress ledger inside a run. Generic
  //     replacement for kgl_run_step.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS live_run_steps (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES live_runs(id) ON DELETE CASCADE,
      mesh_id TEXT NOT NULL REFERENCES live_meshes(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES live_agents(id) ON DELETE SET NULL,
      role_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      started_at TEXT,
      completed_at TEXT,
      summary TEXT,
      payload_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_live_run_steps_run ON live_run_steps(run_id, role_key)`);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_live_run_steps_mesh ON live_run_steps(mesh_id, status)`);

  // (j) live_run_events — append-only event log. Generic replacement for
  //     kgl_run_event. Tail this for SSE/observability.
  safeExec(db, `
    CREATE TABLE IF NOT EXISTS live_run_events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES live_runs(id) ON DELETE CASCADE,
      step_id TEXT REFERENCES live_run_steps(id) ON DELETE SET NULL,
      kind TEXT NOT NULL,
      agent_id TEXT REFERENCES live_agents(id) ON DELETE SET NULL,
      tool_key TEXT,
      summary TEXT,
      payload_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  safeExec(db, `CREATE INDEX IF NOT EXISTS idx_live_run_events_run ON live_run_events(run_id, created_at, id)`);
}
