/**
 * Built-in handler kind: `agentic.react`.
 *
 * Wraps `createAgenticTaskHandler` from `@weaveintel/live-agents` so any
 * agent that just needs an LLM ReAct loop over its inbox can be configured
 * purely from a `live_agent_handler_bindings` row.
 *
 * --- Config shape (`live_agent_handler_bindings.config_json`) ---
 *
 *   {
 *     "systemPromptSkillKey": "kaggle.strategist.system",   // optional
 *     "fallbackPrompt": "You are a helpful triage agent.",  // optional
 *     "maxSteps": 30,                                       // optional, default 60
 *     "userGoalTemplate": "Subject: {{subject}}\n\n{{body}}" // optional
 *   }
 *
 * Resolution order for the system prompt:
 *   1. If `systemPromptSkillKey` is present and `ctx.resolveSystemPrompt`
 *      returns text, that text is used.
 *   2. Else `fallbackPrompt` if set.
 *   3. Else a generic `"You are <name>. Process the inbound task..."` string.
 *
 * --- Required HandlerContext slots ---
 * - `model`  (this is an LLM-driven kind — geneweave must supply a Model)
 *
 * --- Optional HandlerContext slots ---
 * - `tools`                — passed through to the ReAct loop if present.
 * - `resolveSystemPrompt`  — required only when `systemPromptSkillKey` is set.
 */

import { weaveLiveAgent, type TaskHandler } from '@weaveintel/live-agents';
import type { HandlerContext, HandlerKindRegistration } from '../handler-registry.js';

export interface AgenticReactConfig {
  systemPromptSkillKey?: string;
  fallbackPrompt?: string;
  maxSteps?: number;
  /** Optional template for the user goal. Supports `{{subject}}` and
   *  `{{body}}` substitutions. Defaults to `"Subject: {{subject}}\n\n{{body}}"`. */
  userGoalTemplate?: string;
}

const DEFAULT_USER_GOAL_TEMPLATE = 'Subject: {{subject}}\n\n{{body}}';
const DEFAULT_FALLBACK_PROMPT_TEMPLATE = 'You are {{name}}. Process the inbound task and respond with the result.';

function readConfig(raw: Record<string, unknown>): AgenticReactConfig {
  const cfg: AgenticReactConfig = {};
  if (typeof raw['systemPromptSkillKey'] === 'string') cfg.systemPromptSkillKey = raw['systemPromptSkillKey'];
  if (typeof raw['fallbackPrompt'] === 'string') cfg.fallbackPrompt = raw['fallbackPrompt'];
  if (typeof raw['maxSteps'] === 'number') cfg.maxSteps = raw['maxSteps'];
  if (typeof raw['userGoalTemplate'] === 'string') cfg.userGoalTemplate = raw['userGoalTemplate'];
  return cfg;
}

function interpolate(tmpl: string, vars: Record<string, string>): string {
  return tmpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => vars[k] ?? '');
}

/** Pure factory used by the registry. Not exported — call via the registration. */
function buildAgenticReact(ctx: HandlerContext): TaskHandler {
  const cfg = readConfig(ctx.binding.config);

  if (!ctx.model && !ctx.modelResolver) {
    throw new Error(
      `agentic.react: HandlerContext.model OR HandlerContext.modelResolver is required ` +
        `for agent ${ctx.agent.id} (binding ${ctx.binding.id}). Geneweave must resolve a ` +
        `Model (pinned) or supply a ModelResolver (per-tick) before binding this kind.`,
    );
  }

  const handlerOpts = {
    name: ctx.agent.name || ctx.agent.roleKey,
    ...(ctx.model ? { model: ctx.model } : {}),
    ...(ctx.modelResolver ? { modelResolver: ctx.modelResolver } : {}),
    ...(ctx.policy ? { policy: ctx.policy } : {}),
    role: ctx.agent.roleKey,
    maxSteps: cfg.maxSteps ?? 60,
    log: ctx.log,
    prepare: async ({ inbound }: { inbound: { subject: string; body: string } | null }) => {
      // 1. Resolve the system prompt — DB-driven first, fallback to config text.
      let systemPrompt = '';
      if (cfg.systemPromptSkillKey && ctx.resolveSystemPrompt) {
        const txt = await ctx.resolveSystemPrompt(cfg.systemPromptSkillKey);
        if (txt) systemPrompt = txt;
      }
      if (!systemPrompt && cfg.fallbackPrompt) systemPrompt = cfg.fallbackPrompt;
      if (!systemPrompt) {
        systemPrompt = interpolate(DEFAULT_FALLBACK_PROMPT_TEMPLATE, {
          name: ctx.agent.name || ctx.agent.roleKey,
        });
      }

      // 2. Render the user goal — either templated from inbound or a no-op cycle.
      const userGoal = inbound
        ? interpolate(cfg.userGoalTemplate ?? DEFAULT_USER_GOAL_TEMPLATE, {
            subject: inbound.subject,
            body: inbound.body,
          })
        : `No inbound task; perform a routine ${ctx.agent.roleKey} status check.`;

      // 3. Pass through tools if the runtime resolved any.
      return ctx.tools
        ? { systemPrompt, userGoal, tools: ctx.tools }
        : { systemPrompt, userGoal };
    },
  };

  const { handler } = weaveLiveAgent(handlerOpts);
  return handler;
}

/** Registry entry. Pass to `HandlerRegistry.register(...)`. */
export const agenticReactHandler: HandlerKindRegistration = {
  kind: 'agentic.react',
  description:
    'Generic ReAct / tool-calling LLM loop over the agent inbox via @weaveintel/agents. ' +
    'Use for roles that need open-ended reasoning + tool use per tick.',
  configSchema: {
    type: 'object',
    properties: {
      systemPromptSkillKey: {
        type: 'string',
        description: 'Optional skill / prompt-fragment key to resolve the system prompt at runtime.',
      },
      fallbackPrompt: {
        type: 'string',
        description: 'Inline system prompt used when no skill key is set or the resolver returns null.',
      },
      maxSteps: { type: 'integer', minimum: 1, default: 60 },
      userGoalTemplate: {
        type: 'string',
        description: 'Template for the user-turn goal. Supports {{subject}} and {{body}} substitutions.',
      },
    },
  },
  factory: buildAgenticReact,
};
