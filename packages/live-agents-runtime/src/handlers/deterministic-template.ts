/**
 * Built-in handler kind: `deterministic.template`.
 *
 * Renders a DB-stored prompt fragment (or inline fallback) with
 * `{{subject}}`, `{{body}}`, and `{{from}}` substitutions sourced from the
 * latest inbound TASK, then emits a single outbound TASK to a configured
 * downstream agent. **No LLM call.**
 *
 * Use this for "code-gen" / "boilerplate" workers that turn a structured
 * inbound payload into a deterministic next message — for example a Kaggle
 * implementer that wraps an approved approach in a fixed Python solver
 * template before handing off to the validator.
 *
 * --- Config shape (`live_agent_handler_bindings.config_json`) ---
 *
 *   {
 *     "templateFragmentKey": "kaggle.solver.v1",   // optional DB lookup
 *     "fallbackTemplate":    "# {{subject}}\n{{body}}", // used if no key/text
 *     "outboundSubject":     "Solver draft",
 *     "to": { "type": "AGENT_BY_ROLE", "roleKey": "validator" }
 *   }
 *
 * Resolution order for the template body:
 *   1. If `templateFragmentKey` is set and `ctx.resolveSystemPrompt`
 *      returns text, that text is the template.
 *   2. Else `fallbackTemplate`.
 *   3. Else throw — no template, no behaviour.
 *
 * If the inbox is empty the handler short-circuits with a no-op (mirrors
 * `deterministic.forward`).
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
import type {
  DeterministicForwardTarget,
  DeterministicForwardContextExtras,
} from './deterministic-forward.js';
import { enqueueDownstreamTask } from './enqueue-downstream.js';

export interface DeterministicTemplateConfig {
  templateFragmentKey?: string;
  fallbackTemplate?: string;
  outboundSubject: string;
  to: DeterministicForwardTarget;
}

function readConfig(raw: Record<string, unknown>): DeterministicTemplateConfig {
  if (typeof raw['outboundSubject'] !== 'string' || raw['outboundSubject'].length === 0) {
    throw new Error('deterministic.template: config.outboundSubject is required.');
  }
  const to = raw['to'] as Record<string, unknown> | undefined;
  if (!to || typeof to !== 'object') {
    throw new Error('deterministic.template: config.to is required.');
  }
  let target: DeterministicForwardTarget;
  if (to['type'] === 'BROADCAST') target = { type: 'BROADCAST' };
  else if (to['type'] === 'AGENT' && typeof to['id'] === 'string') target = { type: 'AGENT', id: to['id'] };
  else if (to['type'] === 'AGENT_BY_ROLE' && typeof to['roleKey'] === 'string')
    target = { type: 'AGENT_BY_ROLE', roleKey: to['roleKey'] };
  else throw new Error('deterministic.template: invalid config.to shape.');
  const cfg: DeterministicTemplateConfig = {
    outboundSubject: raw['outboundSubject'],
    to: target,
  };
  if (typeof raw['templateFragmentKey'] === 'string') cfg.templateFragmentKey = raw['templateFragmentKey'];
  if (typeof raw['fallbackTemplate'] === 'string') cfg.fallbackTemplate = raw['fallbackTemplate'];
  if (!cfg.templateFragmentKey && !cfg.fallbackTemplate) {
    throw new Error('deterministic.template: must set templateFragmentKey or fallbackTemplate.');
  }
  return cfg;
}

function interpolate(tmpl: string, vars: Record<string, string>): string {
  return tmpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '');
}

function makeId(prefix: string, nowIso: string): string {
  return `${prefix}_${Date.parse(nowIso)}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildDeterministicTemplate(
  ctx: HandlerContext & DeterministicForwardContextExtras,
): TaskHandler {
  const cfg = readConfig(ctx.binding.config);
  if (cfg.to.type === 'AGENT_BY_ROLE' && !ctx.resolveAgentByRole) {
    throw new Error(
      `deterministic.template: binding ${ctx.binding.id} uses AGENT_BY_ROLE but ` +
        'HandlerContext.resolveAgentByRole is not set.',
    );
  }
  if (cfg.templateFragmentKey && !ctx.resolveSystemPrompt) {
    throw new Error(
      `deterministic.template: binding ${ctx.binding.id} sets templateFragmentKey but ` +
        'HandlerContext.resolveSystemPrompt is not set.',
    );
  }

  return async (
    _action: AttentionAction & { type: 'StartTask' | 'ContinueTask' },
    execCtx: ActionExecutionContext,
    _ctx: ExecutionContext,
  ): Promise<TaskHandlerResult> => {
    const inbound = await loadLatestInboundTask(execCtx);
    if (!inbound) {
      ctx.log(`deterministic.template: empty inbox for ${ctx.agent.id}, no-op.`);
      return { completed: true, summaryProse: 'no-op (empty inbox)' };
    }

    // Resolve template body — DB fragment first, fallback inline.
    let template = '';
    if (cfg.templateFragmentKey && ctx.resolveSystemPrompt) {
      const txt = await ctx.resolveSystemPrompt(cfg.templateFragmentKey);
      if (txt) template = txt;
    }
    if (!template && cfg.fallbackTemplate) template = cfg.fallbackTemplate;
    if (!template) throw new Error('deterministic.template: empty template at runtime.');

    const body = interpolate(template, {
      subject: inbound.subject,
      body: inbound.body,
      from: ctx.agent.roleKey,
    });

    // Resolve recipient.
    let toType: Message['toType'];
    let toId: string | null;
    if (cfg.to.type === 'BROADCAST') {
      toType = 'BROADCAST'; toId = null;
    } else if (cfg.to.type === 'AGENT') {
      toType = 'AGENT'; toId = cfg.to.id;
    } else {
      toType = 'AGENT';
      const resolved = await Promise.resolve(ctx.resolveAgentByRole!(cfg.to.roleKey));
      if (!resolved) throw new Error(`deterministic.template: no agent for role "${cfg.to.roleKey}".`);
      toId = resolved;
    }

    const outbound: Message = {
      id: makeId('msg', execCtx.nowIso),
      meshId: ctx.agent.meshId,
      fromType: 'AGENT', fromId: ctx.agent.id, fromMeshId: ctx.agent.meshId,
      toType, toId,
      topic: null, kind: 'TASK',
      replyToMessageId: null, threadId: makeId('thr', execCtx.nowIso),
      contextRefs: [], contextPacketRef: null, expiresAt: null,
      priority: 'NORMAL', status: 'DELIVERED',
      deliveredAt: execCtx.nowIso, readAt: null, processedAt: null, createdAt: execCtx.nowIso,
      subject: cfg.outboundSubject, body,
    };
    await enqueueDownstreamTask({ execCtx, message: outbound });
    ctx.log(`deterministic.template: emitted "${cfg.outboundSubject}" → ${toType}${toId ? `:${toId}` : ''}`);
    return {
      completed: true,
      summaryProse: `Templated "${inbound.subject}" → ${cfg.outboundSubject}`,
      createdMessageIds: [outbound.id],
    };
  };
}

export const deterministicTemplateHandler: HandlerKindRegistration = {
  kind: 'deterministic.template',
  description:
    'Render a DB prompt-fragment (or inline fallback) with inbound vars and emit ' +
    'a single outbound TASK. No LLM call. Use for code-gen / fixed-template workers.',
  configSchema: {
    type: 'object',
    required: ['outboundSubject', 'to'],
    properties: {
      templateFragmentKey: { type: 'string' },
      fallbackTemplate: { type: 'string' },
      outboundSubject: { type: 'string' },
      to: { type: 'object' },
    },
  },
  factory: buildDeterministicTemplate,
};
