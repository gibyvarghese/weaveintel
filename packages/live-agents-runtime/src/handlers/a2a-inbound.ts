/**
 * Built-in handler kind: `a2a.inbound`.
 *
 * An A2A-aware variant of `agentic.react`. When an inbox message body is
 * valid JSON that conforms to the A2A `A2ATask` shape (has `id`, `input`,
 * and `input.parts` fields), the handler extracts the task text from the
 * parts array and passes it as the user goal to the ReAct loop. Non-A2A
 * messages fall through as plain `subject + body` text, identical to
 * `agentic.react` behaviour.
 *
 * --- When to use ---
 *
 * Register `a2a.inbound` on any agent that receives tasks dispatched from
 * another agent or from `POST /api/a2a/tasks` and needs to execute them
 * with LLM reasoning + tool calling. The binding config mirrors
 * `agentic.react`.
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
import type { A2ATask } from '@weaveintel/core';
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

/** Extract user-visible text from an A2A task. */
function extractA2AGoal(task: A2ATask): string {
  const textParts = task.input.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text);
  return textParts.join('\n').trim() || `A2A task id=${task.id}`;
}

/** Try to parse body as A2ATask. Returns null on any failure. */
function tryParseA2ATask(body: string): A2ATask | null {
  try {
    const parsed = JSON.parse(body);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed['id'] === 'string' &&
      parsed['input'] &&
      typeof parsed['input'] === 'object' &&
      Array.isArray(parsed['input']['parts'])
    ) {
      return parsed as A2ATask;
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
        const a2aTask = tryParseA2ATask(inbound.body);
        if (a2aTask) {
          userGoal = extractA2AGoal(a2aTask);
          ctx.log(`a2a.inbound: parsed A2ATask id=${a2aTask.id} skill=${a2aTask.skill ?? '(none)'}`);
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
    'A2A-aware ReAct loop. Processes inbox messages formatted as A2A Tasks ' +
    '(JSON with id + input.parts) as well as plain text messages. ' +
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
