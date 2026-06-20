/**
 * Built-in handler kind: `a2a.inbound`.
 *
 * An A2A-aware variant of `agentic.react`. When an inbox message body is
 * valid JSON conforming to either:
 *   - A2A v1.0 A2ATaskSendParams shape (`{ message: { parts: [...] } }`)
 *   - A2A v0.3 legacy A2ATask shape (`{ id, input: { parts: [...] } }`)
 *
 * …the handler extracts text from the parts and passes it as the user goal to
 * the ReAct loop. Non-A2A messages fall through as plain `subject + body` text,
 * identical to `agentic.react` behaviour.
 *
 * --- When to use ---
 *
 * Register `a2a.inbound` on any agent that receives tasks dispatched from
 * another agent or from `POST /api/a2a/tasks` and needs LLM reasoning + tools.
 *
 * --- Config shape (live_agent_handler_bindings.config_json) ---
 *
 *   {
 *     "systemPromptSkillKey": "a2a.responder.system",   // optional
 *     "fallbackPrompt": "You are an A2A task processor.",// optional
 *     "maxSteps": 30                                     // optional
 *   }
 */

import { weaveLiveAgent, type TaskHandler } from '@weaveintel/live-agents';
import type { A2APart } from '@weaveintel/core';
import type { HandlerContext, HandlerKindRegistration } from '../handler-registry.js';

export interface A2AInboundConfig {
  systemPromptSkillKey?: string;
  fallbackPrompt?: string;
  maxSteps?: number;
}

const DEFAULT_FALLBACK = 'You are an A2A task processor. Analyse the inbound task and return a clear result.';

function readConfig(raw: Record<string, unknown>): A2AInboundConfig {
  const cfg: A2AInboundConfig = {};
  if (typeof raw['systemPromptSkillKey'] === 'string') cfg.systemPromptSkillKey = raw['systemPromptSkillKey'];
  if (typeof raw['fallbackPrompt'] === 'string') cfg.fallbackPrompt = raw['fallbackPrompt'];
  if (typeof raw['maxSteps'] === 'number') cfg.maxSteps = raw['maxSteps'];
  return cfg;
}

/** Extract text from v1.0 A2APart (field-presence, no `type` discriminator). */
function partText(p: A2APart): string {
  if (typeof p.text === 'string') return p.text;
  if (p.data !== undefined) return JSON.stringify(p.data);
  if (typeof p.url === 'string') return `[File: ${p.filename ?? p.url}]`;
  return '';
}

/** Extract user-visible text from A2APart array. */
function extractPartsGoal(parts: readonly A2APart[]): string {
  return parts.map(partText).filter(Boolean).join('\n').trim();
}

/**
 * Try to parse body as an A2A task — supports both v1.0 and v0.3 shapes.
 * Returns extracted text goal, or null if not a recognised A2A shape.
 */
function tryExtractA2AGoal(body: string): { goal: string; taskId: string } | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;

    // v1.0 A2ATaskSendParams: { message: { role, parts: [...] } }
    const msg = parsed['message'];
    if (
      msg &&
      typeof msg === 'object' &&
      Array.isArray((msg as Record<string, unknown>)['parts'])
    ) {
      const parts = (msg as Record<string, unknown>)['parts'] as A2APart[];
      const goal = extractPartsGoal(parts);
      const taskId = (parsed['metadata'] as Record<string, unknown> | undefined)?.['taskId'] as string ?? 'unknown';
      return goal ? { goal, taskId } : null;
    }

    // v0.3 legacy A2ATask: { id, input: { role, parts: [...] } }
    const input = parsed['input'];
    if (
      typeof parsed['id'] === 'string' &&
      input &&
      typeof input === 'object' &&
      Array.isArray((input as Record<string, unknown>)['parts'])
    ) {
      const parts = (input as Record<string, unknown>)['parts'] as A2APart[];
      const goal = extractPartsGoal(parts);
      const skill = parsed['skill'] as string | undefined;
      const taskId = parsed['id'] as string;
      return goal ? { goal: skill ? `[${skill}] ${goal}` : goal, taskId } : null;
    }
  } catch {
    // not JSON or wrong shape
  }
  return null;
}

function buildA2AInbound(ctx: HandlerContext): TaskHandler {
  const cfg = readConfig(ctx.binding.config);

  if (!ctx.model && !ctx.modelResolver) {
    throw new Error(
      `a2a.inbound: HandlerContext.model OR HandlerContext.modelResolver is required ` +
        `for agent ${ctx.agent.id} (binding ${ctx.binding.id}).`,
    );
  }

  const handlerOpts = {
    name: ctx.agent.name || ctx.agent.roleKey,
    ...(ctx.model ? { model: ctx.model } : {}),
    ...(ctx.modelResolver ? { modelResolver: ctx.modelResolver } : {}),
    ...(ctx.policy ? { policy: ctx.policy } : {}),
    role: ctx.agent.roleKey,
    maxSteps: cfg.maxSteps ?? 30,
    log: ctx.log,
    prepare: async ({ inbound }: { inbound: { subject: string; body: string } | null }) => {
      let systemPrompt = '';
      if (cfg.systemPromptSkillKey && ctx.resolveSystemPrompt) {
        const txt = await ctx.resolveSystemPrompt(cfg.systemPromptSkillKey);
        if (txt) systemPrompt = txt;
      }
      if (!systemPrompt) systemPrompt = cfg.fallbackPrompt ?? DEFAULT_FALLBACK;

      let userGoal: string;
      if (inbound) {
        const a2aGoal = tryExtractA2AGoal(inbound.body);
        if (a2aGoal) {
          userGoal = a2aGoal.goal;
          ctx.log(`a2a.inbound: parsed A2A task id=${a2aGoal.taskId}`);
        } else {
          userGoal = inbound.subject
            ? `Subject: ${inbound.subject}\n\n${inbound.body}`
            : inbound.body;
        }
      } else {
        userGoal = `No inbound task; perform a routine ${ctx.agent.roleKey} status check.`;
      }

      return ctx.tools
        ? { systemPrompt, userGoal, tools: ctx.tools }
        : { systemPrompt, userGoal };
    },
  };

  const { handler } = weaveLiveAgent(handlerOpts);
  return handler;
}

export const a2aInboundHandler: HandlerKindRegistration = {
  kind: 'a2a.inbound',
  description:
    'A2A-aware ReAct loop. Processes inbox messages formatted as A2A v1.0 Tasks ' +
    '(A2ATaskSendParams with message.parts) or v0.3 legacy tasks (id + input.parts). ' +
    'Falls through to plain text for non-A2A messages. ' +
    'Use for agents that receive A2A protocol tasks from remote agents.',
  configSchema: {
    type: 'object',
    properties: {
      systemPromptSkillKey: {
        type: 'string',
        description: 'Skill / prompt-fragment key for the system prompt.',
      },
      fallbackPrompt: {
        type: 'string',
        description: 'Inline system prompt used when no skill key resolves.',
      },
      maxSteps: { type: 'integer', minimum: 1, default: 30 },
    },
  },
  factory: buildA2AInbound,
};
