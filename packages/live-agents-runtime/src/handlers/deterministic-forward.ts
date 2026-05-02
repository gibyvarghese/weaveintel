/**
 * Built-in handler kind: `deterministic.forward`.
 *
 * Reads the most-recent inbound TASK from the agent's inbox, optionally
 * extracts a sub-payload from the body, and forwards a new TASK message to
 * a downstream agent (resolved by id, role key, or broadcast). No LLM call.
 *
 * Use this for "router" / "fan-out" agents whose job is purely to relay or
 * reshape a payload — e.g. an inbox observer that hands off every new email
 * to a triage agent, or a webhook intake that dispatches to multiple workers.
 *
 * --- Config shape (`live_agent_handler_bindings.config_json`) ---
 *
 *   {
 *     "outboundSubject": "Triage this lead",          // required
 *     "to": { "type": "AGENT", "id": "agent-uuid" },  // OR
 *     "to": { "type": "AGENT_BY_ROLE", "roleKey": "triager" },
 *     "to": { "type": "BROADCAST" },
 *     "bodyTemplate": "Forwarded from {{from}}:\n\n{{body}}",  // optional
 *     "passthroughBody": true                          // default true
 *   }
 *
 * The handler emits exactly one outbound message per tick when there is an
 * inbound TASK. If the inbox is empty, it returns without doing anything
 * and lets the action executor mark the backlog item COMPLETED (no-op tick).
 *
 * --- Resolution ---
 *
 * `to.type === 'AGENT_BY_ROLE'` is resolved at handler-build time via
 * `ctx.resolveAgentByRole?.(roleKey)`. If that hook is not provided, a
 * binding using `AGENT_BY_ROLE` will throw a clear error during build so
 * misconfiguration is caught at boot, not at first tick.
 */

import type {
  ActionExecutionContext,
  AttentionAction,
  Message,
  TaskHandler,
  TaskHandlerResult,
} from '@weaveintel/live-agents';
import { loadLatestInboundTask } from '@weaveintel/live-agents';
import type { ExecutionContext } from '@weaveintel/core';
import type { HandlerContext, HandlerKindRegistration } from '../handler-registry.js';

/** Routing target for a forwarded message. */
export type DeterministicForwardTarget =
  | { type: 'AGENT'; id: string }
  | { type: 'AGENT_BY_ROLE'; roleKey: string }
  | { type: 'BROADCAST' };

export interface DeterministicForwardConfig {
  outboundSubject: string;
  to: DeterministicForwardTarget;
  /** Optional handlebars-lite template. Supports `{{subject}}`, `{{body}}`,
   *  `{{from}}` (the source agent role/id). Defaults to passthrough body. */
  bodyTemplate?: string;
  /** When true (default), the inbound body is appended verbatim if no template. */
  passthroughBody?: boolean;
}

/**
 * Optional extension to `HandlerContext` for `deterministic.forward`. This
 * lives here (not in the registry) because only this kind needs role lookup.
 */
export interface DeterministicForwardContextExtras {
  resolveAgentByRole?: (roleKey: string) => Promise<string | null> | string | null;
}

function readConfig(raw: Record<string, unknown>): DeterministicForwardConfig {
  if (typeof raw['outboundSubject'] !== 'string' || raw['outboundSubject'].length === 0) {
    throw new Error('deterministic.forward: config.outboundSubject is required (non-empty string).');
  }
  const to = raw['to'];
  if (!to || typeof to !== 'object') {
    throw new Error('deterministic.forward: config.to is required (object).');
  }
  const t = to as Record<string, unknown>;
  let target: DeterministicForwardTarget;
  if (t['type'] === 'BROADCAST') {
    target = { type: 'BROADCAST' };
  } else if (t['type'] === 'AGENT' && typeof t['id'] === 'string') {
    target = { type: 'AGENT', id: t['id'] };
  } else if (t['type'] === 'AGENT_BY_ROLE' && typeof t['roleKey'] === 'string') {
    target = { type: 'AGENT_BY_ROLE', roleKey: t['roleKey'] };
  } else {
    throw new Error(
      'deterministic.forward: config.to must be one of ' +
        "{ type: 'AGENT', id }, { type: 'AGENT_BY_ROLE', roleKey }, { type: 'BROADCAST' }",
    );
  }
  const cfg: DeterministicForwardConfig = {
    outboundSubject: raw['outboundSubject'],
    to: target,
    passthroughBody: raw['passthroughBody'] === false ? false : true,
  };
  if (typeof raw['bodyTemplate'] === 'string') cfg.bodyTemplate = raw['bodyTemplate'];
  return cfg;
}

function interpolate(tmpl: string, vars: Record<string, string>): string {
  return tmpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '');
}

function makeMessageId(prefix: string, nowIso: string): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.parse(nowIso)}_${suffix}`;
}

/** Build a `Message` for the dispatched handoff. */
function buildOutboundMessage(
  ctx: HandlerContext,
  target: { toType: Message['toType']; toId: string | null },
  subject: string,
  body: string,
  execCtx: ActionExecutionContext,
): Message {
  return {
    id: makeMessageId('msg', execCtx.nowIso),
    meshId: ctx.agent.meshId,
    fromType: 'AGENT',
    fromId: ctx.agent.id,
    fromMeshId: ctx.agent.meshId,
    toType: target.toType,
    toId: target.toId,
    topic: null,
    kind: 'TASK',
    replyToMessageId: null,
    threadId: makeMessageId('thr', execCtx.nowIso),
    contextRefs: [],
    contextPacketRef: null,
    expiresAt: null,
    priority: 'NORMAL',
    status: 'DELIVERED',
    deliveredAt: execCtx.nowIso,
    readAt: null,
    processedAt: null,
    createdAt: execCtx.nowIso,
    subject,
    body,
  };
}

function buildDeterministicForward(
  ctx: HandlerContext & DeterministicForwardContextExtras,
): TaskHandler {
  const cfg = readConfig(ctx.binding.config);

  // Validate role resolver presence at build time, not first tick.
  if (cfg.to.type === 'AGENT_BY_ROLE' && !ctx.resolveAgentByRole) {
    throw new Error(
      `deterministic.forward: binding ${ctx.binding.id} uses AGENT_BY_ROLE ` +
        '("' + cfg.to.roleKey + '") but HandlerContext.resolveAgentByRole is not set. ' +
        'Geneweave must supply this resolver when wiring this handler kind.',
    );
  }

  return async (
    _action: AttentionAction & { type: 'StartTask' | 'ContinueTask' },
    execCtx: ActionExecutionContext,
    _ctx: ExecutionContext,
  ): Promise<TaskHandlerResult> => {
    const inbound = await loadLatestInboundTask(execCtx);
    if (!inbound) {
      ctx.log(`deterministic.forward: no inbound TASK for agent ${ctx.agent.id}, skipping.`);
      return { completed: true, summaryProse: 'no-op (empty inbox)' };
    }

    // Resolve the recipient.
    let toType: Message['toType'];
    let toId: string | null;
    if (cfg.to.type === 'BROADCAST') {
      toType = 'BROADCAST';
      toId = null;
    } else if (cfg.to.type === 'AGENT') {
      toType = 'AGENT';
      toId = cfg.to.id;
    } else {
      toType = 'AGENT';
      const resolved = await Promise.resolve(ctx.resolveAgentByRole!(cfg.to.roleKey));
      if (!resolved) {
        throw new Error(
          `deterministic.forward: could not resolve agent for role "${cfg.to.roleKey}" ` +
            `in mesh ${ctx.agent.meshId}.`,
        );
      }
      toId = resolved;
    }

    // Build the body — template overrides passthrough.
    let body: string;
    if (cfg.bodyTemplate) {
      body = interpolate(cfg.bodyTemplate, {
        subject: inbound.subject,
        body: inbound.body,
        from: ctx.agent.roleKey,
      });
    } else if (cfg.passthroughBody !== false) {
      body = inbound.body;
    } else {
      body = '';
    }

    const outbound = buildOutboundMessage(ctx, { toType, toId }, cfg.outboundSubject, body, execCtx);
    await execCtx.stateStore.saveMessage(outbound);
    ctx.log(
      `deterministic.forward: emitted "${cfg.outboundSubject}" → ` +
        `${toType}${toId ? `:${toId}` : ''} (msg=${outbound.id})`,
    );

    return {
      completed: true,
      summaryProse: `Forwarded "${inbound.subject}" → ${cfg.outboundSubject} (${toType}${toId ? `:${toId}` : ''})`,
      createdMessageIds: [outbound.id],
    };
  };
}

export const deterministicForwardHandler: HandlerKindRegistration = {
  kind: 'deterministic.forward',
  description:
    'Read inbound TASK and emit a single outbound TASK to a target agent / role / broadcast. ' +
    'No LLM call. Use for routers, fan-out, and inbox observers.',
  configSchema: {
    type: 'object',
    required: ['outboundSubject', 'to'],
    properties: {
      outboundSubject: { type: 'string', description: 'Subject of the forwarded message.' },
      to: {
        oneOf: [
          { type: 'object', required: ['type', 'id'], properties: { type: { const: 'AGENT' }, id: { type: 'string' } } },
          { type: 'object', required: ['type', 'roleKey'], properties: { type: { const: 'AGENT_BY_ROLE' }, roleKey: { type: 'string' } } },
          { type: 'object', required: ['type'], properties: { type: { const: 'BROADCAST' } } },
        ],
      },
      bodyTemplate: { type: 'string', description: 'Template with {{subject}}, {{body}}, {{from}} substitutions.' },
      passthroughBody: { type: 'boolean', default: true },
    },
  },
  factory: (ctx) => buildDeterministicForward(ctx as HandlerContext & DeterministicForwardContextExtras),
};
