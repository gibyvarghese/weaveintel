/**
 * @weaveintel/live-agents — Default seed data
 *
 * Exports:
 *   DEFAULT_HANDLER_KINDS      — 7 live-agent handler kind rows
 *   DEFAULT_ATTENTION_POLICIES — 3 live-agent attention policy rows
 *
 * Row shapes match the DB types (LiveHandlerKindRow / LiveAttentionPolicyRow)
 * minus the `id`, `created_at`, and `updated_at` columns — supply these
 * in your seed orchestrator.
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
  {
    id:                 'hk0000000-0000-4000-8000-000000000001',
    kind:               'agentic.react',
    description:        'LLM-driven ReAct loop. The agent reasons over its tool catalog and decides when to act vs delegate.',
    config_schema_json: JSON.stringify({ type: 'object', properties: { model: { type: 'string' }, max_steps: { type: 'integer', default: 8 } } }),
    source:             'builtin',
    enabled:            1,
  },
  {
    id:                 'hk0000000-0000-4000-8000-000000000002',
    kind:               'agentic.scripted',
    description:        'LLM follows a fixed sequence of declared steps; useful for known pipelines that still need natural-language handling.',
    config_schema_json: JSON.stringify({ type: 'object', properties: { steps: { type: 'array', items: { type: 'string' } } }, required: ['steps'] }),
    source:             'builtin',
    enabled:            1,
  },
  {
    id:                 'hk0000000-0000-4000-8000-000000000003',
    kind:               'deterministic.template',
    description:        'No LLM call. Renders a string template against the inbox context and emits the result as a contract.',
    config_schema_json: JSON.stringify({ type: 'object', properties: { template: { type: 'string' } }, required: ['template'] }),
    source:             'builtin',
    enabled:            1,
  },
  {
    id:                 'hk0000000-0000-4000-8000-000000000004',
    kind:               'deterministic.forward',
    description:        'No LLM call. Forwards the inbox payload to another agent / mesh queue.',
    config_schema_json: JSON.stringify({ type: 'object', properties: { target_role_key: { type: 'string' } } }),
    source:             'builtin',
    enabled:            1,
  },
  {
    id:                 'hk0000000-0000-4000-8000-000000000005',
    kind:               'deterministic.observer',
    description:        'Reads mesh state and emits structured signals without executing any tool or LLM call.',
    config_schema_json: JSON.stringify({ type: 'object', properties: {} }),
    source:             'builtin',
    enabled:            1,
  },
  {
    id:                 'hk0000000-0000-4000-8000-000000000006',
    kind:               'human.approval',
    description:        'Pauses the live run and creates a human task. Resumes automatically once approved or rejected.',
    config_schema_json: JSON.stringify({ type: 'object', properties: { task_policy: { type: 'string' }, timeout_hours: { type: 'number' } } }),
    source:             'builtin',
    enabled:            1,
  },
  {
    id:                 'hk0000000-0000-4000-8000-000000000007',
    kind:               'external.webhook',
    description:        'POSTs a JSON payload to a configured endpoint. Optionally waits for a callback to resume.',
    config_schema_json: JSON.stringify({ type: 'object', properties: { url: { type: 'string' }, headers: { type: 'object' }, wait_for_callback: { type: 'boolean' } } }),
    source:             'builtin',
    enabled:            1,
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
];
