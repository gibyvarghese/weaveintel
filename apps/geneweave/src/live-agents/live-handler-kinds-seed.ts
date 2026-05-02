/**
 * First-run seed for the live-agents runtime registries.
 *
 * Two tables, both DB-driven from operator perspective:
 *
 *  1. `live_handler_kinds`     — the catalog of handler shapes the runtime
 *                                knows how to execute (agentic ReAct,
 *                                deterministic template, human approval, …).
 *                                Plugins can append additional `source='plugin'`
 *                                rows; this seed only inserts the framework
 *                                builtins on first boot.
 *
 *  2. `live_attention_policies` — when an agent should be picked up for a
 *                                tick (heuristic inbox-first, cron rest-only,
 *                                model.adaptive). Personas reference these by
 *                                key so the runtime never bakes scheduling
 *                                logic into TypeScript.
 *
 * Idempotent: each row is gated on existence (`getLiveHandlerKindByKind`,
 * `getLiveAttentionPolicyByKey`). Operator edits to existing rows are never
 * overwritten on subsequent boots.
 */
import type { DatabaseAdapter } from '../db.js';
import { newUUIDv7 } from '../lib/uuid.js';

interface SeedHandlerKind {
  kind: string;
  description: string;
  config_schema_json: string;
}

interface SeedAttentionPolicy {
  key: string;
  kind: 'heuristic' | 'cron' | 'model';
  description: string;
  config_json: string;
}

const HANDLER_KINDS: SeedHandlerKind[] = [
  {
    kind: 'agentic.react',
    description: 'LLM-driven ReAct loop. The agent reasons over its tool catalog and decides when to act vs delegate.',
    config_schema_json: JSON.stringify({
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Optional model id; otherwise routing decides.' },
        max_steps: { type: 'integer', default: 8 },
      },
    }),
  },
  {
    kind: 'agentic.scripted',
    description: 'LLM follows a fixed sequence of declared steps; useful for known pipelines that still need natural-language handling.',
    config_schema_json: JSON.stringify({
      type: 'object',
      properties: {
        steps: { type: 'array', items: { type: 'string' } },
      },
      required: ['steps'],
    }),
  },
  {
    kind: 'deterministic.template',
    description: 'No LLM call. Renders a string template against the inbox context and emits the result as a contract.',
    config_schema_json: JSON.stringify({
      type: 'object',
      properties: {
        template: { type: 'string', description: 'Mustache-style template.' },
      },
      required: ['template'],
    }),
  },
  {
    kind: 'deterministic.forward',
    description: 'No LLM call. Forwards the inbox payload to another agent / mesh queue.',
    config_schema_json: JSON.stringify({
      type: 'object',
      properties: {
        target_role_key: { type: 'string' },
      },
      required: ['target_role_key'],
    }),
  },
  {
    kind: 'deterministic.observer',
    description: 'No LLM call. Records the inbox event in the runs ledger without acting on it. Useful for audit-only roles.',
    config_schema_json: JSON.stringify({ type: 'object', properties: {} }),
  },
  {
    kind: 'human.approval',
    description: 'Pauses the run and writes a tool_approval_requests row. Human grants/denies via admin UI.',
    config_schema_json: JSON.stringify({
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Message shown to the human reviewer.' },
      },
    }),
  },
  {
    kind: 'external.webhook',
    description: 'Posts the inbox payload to an external HTTPS endpoint and treats the response as the agent output.',
    config_schema_json: JSON.stringify({
      type: 'object',
      properties: {
        url: { type: 'string', format: 'uri' },
        headers: { type: 'object' },
      },
      required: ['url'],
    }),
  },
];

const ATTENTION_POLICIES: SeedAttentionPolicy[] = [
  {
    key: 'heuristic.inbox-first',
    kind: 'heuristic',
    description: 'Run whenever the agent has unread inbox items. Lowest latency, highest cost.',
    config_json: JSON.stringify({ trigger: 'inbox_nonempty' }),
  },
  {
    key: 'cron.rest-only',
    kind: 'cron',
    description: 'Run on a fixed cron schedule regardless of inbox. Good for periodic sweeps (e.g. discoverers).',
    config_json: JSON.stringify({ cron: '0 */1 * * *' }), // hourly
  },
  {
    key: 'model.adaptive',
    kind: 'model',
    description: 'Routing model decides when to wake the agent based on inbox semantics + recent run history.',
    config_json: JSON.stringify({ scorer: 'default', threshold: 0.5 }),
  },
];

/**
 * Seed framework builtin handler kinds. Per-row idempotent.
 */
export async function seedLiveHandlerKinds(db: DatabaseAdapter): Promise<void> {
  for (const k of HANDLER_KINDS) {
    const existing = await db.getLiveHandlerKindByKind(k.kind);
    if (existing) continue;
    await db.createLiveHandlerKind({
      id: newUUIDv7(),
      kind: k.kind,
      description: k.description,
      config_schema_json: k.config_schema_json,
      source: 'builtin',
      enabled: 1,
    });
  }
}

/**
 * Seed framework builtin attention policies. Per-row idempotent.
 */
export async function seedLiveAttentionPolicies(db: DatabaseAdapter): Promise<void> {
  for (const p of ATTENTION_POLICIES) {
    const existing = await db.getLiveAttentionPolicyByKey(p.key);
    if (existing) continue;
    await db.createLiveAttentionPolicy({
      id: newUUIDv7(),
      key: p.key,
      kind: p.kind,
      description: p.description,
      config_json: p.config_json,
      enabled: 1,
    });
  }
}
