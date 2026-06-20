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
import type { LiveAgentCheckpointStore } from '../checkpoint-store.js';
import { dbPrepareFromConfig } from '../db-prepare-resolver.js';

export interface AgenticReactConfig {
  systemPromptSkillKey?: string;
  fallbackPrompt?: string;
  maxSteps?: number;
  /** Optional template for the user goal. Supports `{{subject}}` and
   *  `{{body}}` substitutions. Defaults to `"Subject: {{subject}}\n\n{{body}}"`. */
  userGoalTemplate?: string;
  /**
   * Phase 7 — enable durable checkpointing for this handler. When `true` and
   * `ctx.checkpoint` is supplied, state is saved after each tick and the step
   * index is logged at the start of the next one. Opt-in per binding.
   */
  checkpoint?: boolean;
}

const DEFAULT_USER_GOAL_TEMPLATE = 'Subject: {{subject}}\n\n{{body}}';
const DEFAULT_FALLBACK_PROMPT_TEMPLATE = 'You are {{name}}. Process the inbound task and respond with the result.';

function readConfig(raw: Record<string, unknown>): AgenticReactConfig {
  const cfg: AgenticReactConfig = {};
  if (typeof raw['systemPromptSkillKey'] === 'string') cfg.systemPromptSkillKey = raw['systemPromptSkillKey'];
  if (typeof raw['fallbackPrompt'] === 'string') cfg.fallbackPrompt = raw['fallbackPrompt'];
  if (typeof raw['maxSteps'] === 'number') cfg.maxSteps = raw['maxSteps'];
  if (typeof raw['userGoalTemplate'] === 'string') cfg.userGoalTemplate = raw['userGoalTemplate'];
  if (raw['checkpoint'] === true) cfg.checkpoint = true;
  return cfg;
}

function hasMultiModalMarkers(text: string): boolean {
  return (
    text.includes('data:image/') ||
    text.includes('data:audio/') ||
    text.includes('[IMAGE]') ||
    text.includes('[AUDIO]') ||
    text.includes('[FILE]')
  );
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
    prepare: ctx.prepareConfig
      ? // Phase 2 — DB-driven declarative recipe takes precedence over the
        //         inline binding-config prepare. Caller-supplied prepare on
        //         weaveLiveAgent ALWAYS wins, but we are inside the recipe
        //         path so neither layer is bypassed.
        dbPrepareFromConfig(ctx.prepareConfig, {
          ...(ctx.tools ? { tools: ctx.tools } : {}),
          ...(ctx.prepareDeps ?? {}),
          defaultSystemPrompt:
            ctx.prepareDeps?.defaultSystemPrompt ??
            cfg.fallbackPrompt ??
            interpolate(DEFAULT_FALLBACK_PROMPT_TEMPLATE, {
              name: ctx.agent.name || ctx.agent.roleKey,
            }),
        }).prepare
      : async ({ inbound }: { inbound: { subject: string; body: string } | null }) => {
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

  const { handler: innerHandler } = weaveLiveAgent(handlerOpts);

  const checkpointStore: LiveAgentCheckpointStore | undefined =
    cfg.checkpoint ? ctx.checkpoint : undefined;
  const agentId = ctx.agent.id;
  const log = ctx.log;

  if (!checkpointStore) {
    // No checkpointing requested — return the inner handler as-is.
    // Multi-modal detection still runs per tick to log routing hints.
    return async (action, context, execCtx) => {
      const supportsMultiModal = execCtx.runtime?.routing?.supportsMultiModal?.() ?? false;
      if (supportsMultiModal) {
        // Best-effort: check if the action carries multi-modal markers.
        // The attention action subject/bodySeed is text-only; richer
        // ContentPart arrays appear in the agent's inbox messages which
        // `loadLatestInboundTask` reads internally. We check what we can.
        const body = 'bodySeed' in action ? String(action['bodySeed'] ?? '') : '';
        const subject = 'subject' in action ? String(action['subject'] ?? '') : '';
        if (hasMultiModalMarkers(body) || hasMultiModalMarkers(subject)) {
          log(`[agentic.react] multi-modal content detected (agent=${agentId}); routing slot supports multi-modal`);
        }
      }
      return innerHandler(action, context, execCtx);
    };
  }

  // Checkpointing wrapper: load → run → save.
  return async (action, context, execCtx) => {
    // Announce resume point so operators can trace tick continuity.
    const prior = await checkpointStore.load(agentId).catch(() => null);
    if (prior) {
      log(`[agentic.react] resuming from checkpoint step=${prior.stepIndex} savedAt=${new Date(prior.savedAt).toISOString()} (agent=${agentId})`);
    }

    const supportsMultiModal = execCtx.runtime?.routing?.supportsMultiModal?.() ?? false;
    if (supportsMultiModal) {
      const body = 'bodySeed' in action ? String(action['bodySeed'] ?? '') : '';
      const subject = 'subject' in action ? String(action['subject'] ?? '') : '';
      if (hasMultiModalMarkers(body) || hasMultiModalMarkers(subject)) {
        log(`[agentic.react] multi-modal content detected (agent=${agentId}); routing slot supports multi-modal`);
      }
    }

    const result = await innerHandler(action, context, execCtx);

    const nextStep = (prior?.stepIndex ?? 0) + 1;
    await checkpointStore.save(agentId, nextStep, {
      lastActionType: action.type,
      completedAt: Date.now(),
    }).catch((err: unknown) => {
      log(`[agentic.react] checkpoint save failed (agent=${agentId}): ${String(err)}`);
    });

    return result;
  };
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
      checkpoint: {
        type: 'boolean',
        description: 'Phase 7: enable durable checkpointing. Requires ctx.checkpoint to be wired in the supervisor.',
      },
    },
  },
  factory: buildAgenticReact,
};
