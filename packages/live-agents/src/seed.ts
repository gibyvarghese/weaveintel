/**
 * @weaveintel/live-agents — Default seed data
 *
 * Exports:
 *   DEFAULT_HANDLER_KINDS      — 15 live-agent handler kind rows (7 original + 8 Phase 3)
 *   DEFAULT_ATTENTION_POLICIES — 7 live-agent attention policy rows (3 original + 4 Phase 3)
 *
 * Row shapes match the DB types (LiveHandlerKindRow / LiveAttentionPolicyRow)
 * minus the `created_at` and `updated_at` columns — the seed orchestrator
 * supplies those.
 *
 * Phase 3 additions (mid-2026):
 *   Handler kinds:  agentic.computer-use, agentic.browser, agentic.code-interpreter,
 *                   agentic.voice-realtime, agentic.multimodal, deterministic.mapreduce,
 *                   multi-agent.swarm, external.mcp-tool
 *   Attention:      event.webhook-trigger, event.file-watcher, event.db-change,
 *                   model.llm-relevance
 *
 * @example
 * ```ts
 * import { DEFAULT_HANDLER_KINDS } from '@weaveintel/live-agents';
 * for (const k of DEFAULT_HANDLER_KINDS) {
 *   if (!await db.getLiveHandlerKindByKind(k.kind)) {
 *     await db.createLiveHandlerKind({ id: newUUIDv7(), ...k });
 *   }
 * }
 * ```
 */

// ── Handler Kinds ─────────────────────────────────────────────────────────────

export type HandlerKindSeedRow = {
  id: string;
  kind: string;
  description: string;
  config_schema_json: string;
  source: 'builtin' | 'plugin';
  enabled: 0 | 1;
};

export const DEFAULT_HANDLER_KINDS: HandlerKindSeedRow[] = [
  // ── Original 7 (Phase 0 baseline) ─────────────────────────────────────────
  {
    id:                 'hk0000000-0000-4000-8000-000000000001',
    kind:               'agentic.react',
    description:        'LLM-driven ReAct loop. The agent reasons over its tool catalog and decides when to act vs delegate.',
    config_schema_json: JSON.stringify({
      type: 'object',
      properties: {
        model:       { type: 'string', description: 'Optional model override; routing decides if omitted.' },
        max_steps:   { type: 'integer', default: 8 },
        systemPromptSkillKey: { type: 'string' },
        fallbackPrompt:       { type: 'string' },
      },
    }),
    source:  'builtin',
    enabled: 1,
  },
  {
    id:                 'hk0000000-0000-4000-8000-000000000002',
    kind:               'agentic.scripted',
    description:        'LLM follows a fixed sequence of declared steps; useful for known pipelines that still need natural-language handling.',
    config_schema_json: JSON.stringify({
      type: 'object',
      properties: { steps: { type: 'array', items: { type: 'string' } } },
      required: ['steps'],
    }),
    source:  'builtin',
    enabled: 1,
  },
  {
    id:                 'hk0000000-0000-4000-8000-000000000003',
    kind:               'deterministic.template',
    description:        'No LLM call. Renders a string template against the inbox context and emits the result as a contract.',
    config_schema_json: JSON.stringify({
      type: 'object',
      properties: { template: { type: 'string' } },
      required: ['template'],
    }),
    source:  'builtin',
    enabled: 1,
  },
  {
    id:                 'hk0000000-0000-4000-8000-000000000004',
    kind:               'deterministic.forward',
    description:        'No LLM call. Forwards the inbox payload to another agent / mesh queue.',
    config_schema_json: JSON.stringify({
      type: 'object',
      properties: { target_role_key: { type: 'string' } },
    }),
    source:  'builtin',
    enabled: 1,
  },
  {
    id:                 'hk0000000-0000-4000-8000-000000000005',
    kind:               'deterministic.observer',
    description:        'Reads mesh state and emits structured signals without executing any tool or LLM call.',
    config_schema_json: JSON.stringify({ type: 'object', properties: {} }),
    source:  'builtin',
    enabled: 1,
  },
  {
    id:                 'hk0000000-0000-4000-8000-000000000006',
    kind:               'human.approval',
    description:        'Pauses the live run and creates a human task. Resumes automatically once approved or rejected.',
    config_schema_json: JSON.stringify({
      type: 'object',
      properties: {
        task_policy:   { type: 'string' },
        timeout_hours: { type: 'number' },
      },
    }),
    source:  'builtin',
    enabled: 1,
  },
  {
    id:                 'hk0000000-0000-4000-8000-000000000007',
    kind:               'external.webhook',
    description:        'POSTs a JSON payload to a configured endpoint. Optionally waits for a callback to resume.',
    config_schema_json: JSON.stringify({
      type: 'object',
      properties: {
        url:               { type: 'string', format: 'uri' },
        headers:           { type: 'object' },
        wait_for_callback: { type: 'boolean', default: false },
      },
      required: ['url'],
    }),
    source:  'builtin',
    enabled: 1,
  },

  // ── Phase 3 — New execution loops (mid-2026) ─────────────────────────────
  {
    id:          'hk0000000-0000-4000-8000-000000000008',
    kind:        'agentic.computer-use',
    description: 'Autonomous computer control via screenshot→action loop (Anthropic CUA / claude-opus-4-8). Takes screenshots and performs clicks, typing, and scrolling to complete GUI tasks.',
    config_schema_json: JSON.stringify({
      type: 'object',
      properties: {
        model: {
          type: 'string',
          default: 'claude-opus-4-8',
          description: 'Model supporting computer_use tool. Must be claude-opus-4-8 or later.',
        },
        screenshot_interval_ms: { type: 'integer', default: 1000, description: 'Milliseconds between screenshots in action loop.' },
        max_steps:              { type: 'integer', default: 50 },
        allowed_actions: {
          type: 'array',
          items: { type: 'string', enum: ['screenshot', 'click', 'type', 'scroll', 'key', 'mouse_move'] },
          default: ['screenshot', 'click', 'type', 'scroll', 'key', 'mouse_move'],
        },
        systemPromptSkillKey: { type: 'string' },
        fallbackPrompt:       { type: 'string' },
      },
    }),
    source:  'builtin',
    enabled: 0, // enabled when CUA tool infra is wired
  },
  {
    id:          'hk0000000-0000-4000-8000-000000000009',
    kind:        'agentic.browser',
    description: 'Programmatic browser automation using Playwright. Navigates URLs, extracts content, fills forms, and captures screenshots in an isolated browser sandbox.',
    config_schema_json: JSON.stringify({
      type: 'object',
      properties: {
        model:           { type: 'string' },
        playwright_config: {
          type: 'object',
          properties: {
            browser:  { type: 'string', enum: ['chromium', 'firefox', 'webkit'], default: 'chromium' },
            headless: { type: 'boolean', default: true },
          },
        },
        max_pages:       { type: 'integer', default: 5 },
        allowed_domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Domain allowlist (empty = unrestricted).',
        },
        systemPromptSkillKey: { type: 'string' },
        fallbackPrompt:       { type: 'string' },
      },
    }),
    source:  'builtin',
    enabled: 0, // enabled when Playwright container is provisioned
  },
  {
    id:          'hk0000000-0000-4000-8000-000000000010',
    kind:        'agentic.code-interpreter',
    description: 'Python code execution in a sandboxed CSE environment. Supports data analysis, visualisation, file I/O, and auto-installing packages. Returns stdout, stderr, and generated files.',
    config_schema_json: JSON.stringify({
      type: 'object',
      properties: {
        model:             { type: 'string' },
        runtime:           { type: 'string', enum: ['python3.12', 'python3.11', 'python3.10'], default: 'python3.12' },
        max_cells:         { type: 'integer', default: 20 },
        auto_install_libs: { type: 'boolean', default: true },
        systemPromptSkillKey: { type: 'string' },
        fallbackPrompt:       { type: 'string' },
      },
    }),
    source:  'builtin',
    enabled: 1,
  },
  {
    id:          'hk0000000-0000-4000-8000-000000000011',
    kind:        'agentic.voice-realtime',
    description: 'Real-time speech-to-text and text-to-speech interaction over WebRTC/WebSocket. Supports 30+ languages, server VAD turn detection, and configurable voice personas.',
    config_schema_json: JSON.stringify({
      type: 'object',
      properties: {
        model: {
          type: 'string',
          description: 'Realtime-capable model (e.g. gpt-4o with realtime preview).',
        },
        voice: {
          type: 'string',
          enum: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'],
          default: 'alloy',
        },
        turn_detection: {
          type: 'object',
          properties: {
            type:      { type: 'string', enum: ['server_vad', 'none'], default: 'server_vad' },
            threshold: { type: 'number', default: 0.5 },
          },
        },
        max_duration_s:  { type: 'integer', default: 1800 },
        systemPromptSkillKey: { type: 'string' },
        fallbackPrompt:       { type: 'string' },
      },
    }),
    source:  'builtin',
    enabled: 1,
  },
  {
    id:          'hk0000000-0000-4000-8000-000000000012',
    kind:        'agentic.multimodal',
    description: 'Vision-first ReAct loop for tasks where images are the primary input. Controls image detail level and per-turn image count to manage token budget.',
    config_schema_json: JSON.stringify({
      type: 'object',
      properties: {
        model:               { type: 'string' },
        image_detail:        { type: 'string', enum: ['low', 'high', 'auto'], default: 'auto' },
        max_images_per_turn: { type: 'integer', default: 10 },
        max_steps:           { type: 'integer', default: 12 },
        systemPromptSkillKey: { type: 'string' },
        fallbackPrompt:       { type: 'string' },
      },
    }),
    source:  'builtin',
    enabled: 1,
  },
  {
    id:          'hk0000000-0000-4000-8000-000000000013',
    kind:        'deterministic.mapreduce',
    description: 'No LLM call in supervisor. Fans out one inbox item to N worker agents (by role key) and waits for all to complete before reducing results into a single contract.',
    config_schema_json: JSON.stringify({
      type: 'object',
      properties: {
        fan_out_role_key: { type: 'string', description: 'Role key of worker agents to fan-out to.' },
        reduce_fn: {
          type: 'string',
          enum: ['concat', 'vote', 'summarize', 'first'],
          default: 'concat',
          description: 'Strategy for combining N worker outputs into one.',
        },
        fan_out_count:    { type: 'integer', default: 3, description: 'Number of parallel worker instances to spawn.' },
      },
      required: ['fan_out_role_key'],
    }),
    source:  'builtin',
    enabled: 1,
  },
  {
    id:          'hk0000000-0000-4000-8000-000000000014',
    kind:        'multi-agent.swarm',
    description: 'Peer agents collaborate without a designated supervisor. Each peer processes the inbox and emits a response; consensus is reached when ≥ threshold fraction agree.',
    config_schema_json: JSON.stringify({
      type: 'object',
      properties: {
        peer_role_keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Role keys of peer agents participating in the swarm.',
        },
        consensus_threshold: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          default: 0.67,
          description: 'Fraction of peers that must agree for a decision to be final.',
        },
        max_rounds: { type: 'integer', default: 3 },
      },
      required: ['peer_role_keys'],
    }),
    source:  'builtin',
    enabled: 1,
  },
  {
    id:          'hk0000000-0000-4000-8000-000000000015',
    kind:        'external.mcp-tool',
    description: 'Invokes a single tool on an external MCP (Model Context Protocol) server via JSON-RPC. Returns the tool result as the agent output without any LLM call.',
    config_schema_json: JSON.stringify({
      type: 'object',
      properties: {
        mcp_server_url: { type: 'string', format: 'uri', description: 'MCP server endpoint URL.' },
        tool_name:      { type: 'string', description: 'Name of the tool to call.' },
        headers:        { type: 'object', description: 'Extra HTTP headers (e.g. Authorization: Bearer …).' },
        timeout_ms:     { type: 'integer', default: 30000 },
      },
      required: ['mcp_server_url', 'tool_name'],
    }),
    source:  'builtin',
    enabled: 1,
  },
];

// ── Attention Policies ────────────────────────────────────────────────────────

export type AttentionPolicySeedRow = {
  id: string;
  key: string;
  kind: 'heuristic' | 'cron' | 'model';
  description: string;
  config_json: string;
  enabled: 0 | 1;
};

export const DEFAULT_ATTENTION_POLICIES: AttentionPolicySeedRow[] = [
  // ── Original 3 (Phase 0 baseline) ─────────────────────────────────────────
  {
    id:          'ap0000000-0000-4000-8000-000000000001',
    key:         'heuristic.inbox-first',
    kind:        'heuristic',
    description: 'Process the oldest unread message first. Simple FIFO — no LLM needed.',
    config_json: JSON.stringify({ strategy: 'fifo', maxBatchSize: 5 }),
    enabled:     1,
  },
  {
    id:          'ap0000000-0000-4000-8000-000000000002',
    key:         'cron.rest-only',
    kind:        'cron',
    description: 'Agent wakes on a schedule but skips if it already has active work. Prevents pile-ups in slow meshes.',
    config_json: JSON.stringify({ strategy: 'cron', skipIfActive: true }),
    enabled:     1,
  },
  {
    id:          'ap0000000-0000-4000-8000-000000000003',
    key:         'model.adaptive',
    kind:        'model',
    description: 'Asks the LLM to decide which pending signal to handle next based on mesh context and urgency scores.',
    config_json: JSON.stringify({ strategy: 'model', maxCandidates: 10, urgencyWeights: { age: 0.4, priority: 0.6 } }),
    enabled:     1,
  },

  // ── Phase 3 — Event-driven and model-gated attention (mid-2026) ───────────
  {
    id:          'ap0000000-0000-4000-8000-000000000004',
    key:         'event.webhook-trigger',
    kind:        'heuristic',
    description: 'Wake the agent immediately when an authenticated webhook POST arrives on its dedicated path. Zero latency for external-event-driven agents.',
    config_json: JSON.stringify({
      trigger:     'webhook',
      secret:      '',
      path_filter: '/api/webhooks/agent/*',
    }),
    enabled: 1,
  },
  {
    id:          'ap0000000-0000-4000-8000-000000000005',
    key:         'event.file-watcher',
    kind:        'heuristic',
    description: 'Wake the agent when a file system change matching the pattern is detected. Requires a FS-watcher daemon (inotify / FSEvents) attached to the deployment.',
    config_json: JSON.stringify({
      trigger:      'file_change',
      path_pattern: '/data/**',
      events:       ['created', 'modified'],
    }),
    enabled: 0, // enabled when FS-watcher daemon is provisioned
  },
  {
    id:          'ap0000000-0000-4000-8000-000000000006',
    key:         'event.db-change',
    kind:        'heuristic',
    description: 'Wake the agent when a row matching the filter is inserted/updated/deleted in the configured table. Requires DB change-data-capture (CDC) integration.',
    config_json: JSON.stringify({
      trigger:   'db_change',
      table:     '',
      operation: ['insert', 'update'],
      filter:    {},
    }),
    enabled: 0, // enabled when CDC pipeline is configured
  },
  {
    id:          'ap0000000-0000-4000-8000-000000000007',
    key:         'model.llm-relevance',
    kind:        'model',
    description: 'Calls a lightweight LLM to decide whether the pending inbox item warrants agent attention. Avoids waking agents for noise while ensuring relevant events are acted on.',
    config_json: JSON.stringify({
      strategy:  'llm_relevance',
      model:     'claude-haiku-4-5-20251001',
      threshold: 0.7,
      prompt:    'Does this inbox item require immediate agent attention? Reply YES or NO with a confidence score.',
    }),
    enabled: 1,
  },
];
