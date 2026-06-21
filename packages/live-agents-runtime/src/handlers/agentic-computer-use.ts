/**
 * Built-in handler kind: `agentic.computer-use`.
 *
 * Autonomous computer control via the Anthropic Computer Use API (CUA).
 * The agent executes a screenshot→action loop using claude-opus-4-8's
 * built-in computer_use tool set: `computer`, `bash`, and `text_editor`.
 *
 * --- Deployment status (mid-2026) ---
 *
 * This handler kind is REGISTERED in the registry (so it appears in Agent
 * Cards and the admin UI) but is DISABLED by default (`enabled: 0` in the
 * seed). It will be enabled when the CUA sandboxed execution environment is
 * provisioned and the required operator permission (`computer_use:execute`)
 * is assigned to the relevant mesh agents.
 *
 * --- Config shape ---
 *
 *   {
 *     "model":                 "claude-opus-4-8",           // required for CUA
 *     "screenshot_interval_ms": 1000,
 *     "max_steps":              50,
 *     "allowed_actions":        ["screenshot","click","type","scroll","key","mouse_move"],
 *     "systemPromptSkillKey":   "computer-use.system",
 *     "fallbackPrompt":         "You are a computer use agent.",
 *   }
 *
 * --- Required HandlerContext slots ---
 * - `model` OR `modelResolver` pointing to a CUA-capable model (claude-opus-4-8)
 * - `tools` must include 'computer', 'bash', 'text_editor'
 */

import { weaveLiveAgent, type TaskHandler } from '@weaveintel/live-agents';
import type { HandlerContext, HandlerKindRegistration } from '../handler-registry.js';

export interface AgenticComputerUseConfig {
  model?: string;
  screenshot_interval_ms?: number;
  max_steps?: number;
  allowed_actions?: string[];
  systemPromptSkillKey?: string;
  fallbackPrompt?: string;
}

const DEFAULT_MAX_STEPS = 50;
const CUA_MODEL = 'claude-opus-4-8';

function readConfig(raw: Record<string, unknown>): AgenticComputerUseConfig {
  const cfg: AgenticComputerUseConfig = {};
  if (typeof raw['model'] === 'string') cfg.model = raw['model'];
  if (typeof raw['screenshot_interval_ms'] === 'number') cfg.screenshot_interval_ms = raw['screenshot_interval_ms'];
  if (typeof raw['max_steps'] === 'number') cfg.max_steps = raw['max_steps'];
  if (Array.isArray(raw['allowed_actions'])) cfg.allowed_actions = raw['allowed_actions'] as string[];
  if (typeof raw['systemPromptSkillKey'] === 'string') cfg.systemPromptSkillKey = raw['systemPromptSkillKey'];
  if (typeof raw['fallbackPrompt'] === 'string') cfg.fallbackPrompt = raw['fallbackPrompt'];
  return cfg;
}

async function resolveSystemPrompt(ctx: HandlerContext, cfg: AgenticComputerUseConfig): Promise<string> {
  const allowed = cfg.allowed_actions ?? ['screenshot', 'click', 'type', 'scroll', 'key', 'mouse_move'];
  const modelId = cfg.model ?? CUA_MODEL;
  const header = `Computer Use Agent | Model: ${modelId} | Allowed actions: ${allowed.join(', ')}`;

  if (cfg.systemPromptSkillKey && ctx.resolveSystemPrompt) {
    const resolved = await ctx.resolveSystemPrompt(cfg.systemPromptSkillKey);
    if (resolved) return `${header}\n\n${resolved}`;
  }
  if (cfg.fallbackPrompt) return `${header}\n\n${cfg.fallbackPrompt}`;

  return `${header}

You are ${ctx.agent.name}, an autonomous computer use agent. You control the computer using screenshot observation and action execution.

Workflow:
1. Take a screenshot to observe the current screen state.
2. Decide the next action (click, type, scroll, key press) to progress toward the goal.
3. Execute the action and take another screenshot to verify the result.
4. Repeat until the task is complete.

Rules:
- Always take a screenshot before acting to confirm screen state.
- Prefer keyboard shortcuts over mouse navigation where possible.
- If you encounter an unexpected dialog or error, screenshot and assess before proceeding.
- Only use actions in the allowed list: ${allowed.join(', ')}.`;
}

function buildAgenticComputerUse(ctx: HandlerContext): TaskHandler {
  if (!ctx.model && !ctx.modelResolver) {
    throw new Error(
      `agentic.computer-use: HandlerContext.model OR HandlerContext.modelResolver is required ` +
        `for agent ${ctx.agent.id} (binding ${ctx.binding.id}). CUA requires a model.`,
    );
  }

  const cfg = readConfig(ctx.binding.config);
  const maxSteps = cfg.max_steps ?? DEFAULT_MAX_STEPS;

  const { handler } = weaveLiveAgent({
    name: ctx.agent.name || ctx.agent.roleKey,
    role: ctx.agent.roleKey,
    ...(ctx.model ? { model: ctx.model } : {}),
    ...(ctx.modelResolver ? { modelResolver: ctx.modelResolver } : {}),
    ...(ctx.tools ? { tools: ctx.tools } : {}),
    ...(ctx.policy ? { policy: ctx.policy } : {}),
    maxSteps,
    log: ctx.log,
    prepare: async ({ inbound }) => {
      const systemPrompt = await resolveSystemPrompt(ctx, cfg);
      const userGoal = inbound
        ? `Subject: ${inbound.subject}\n\n${inbound.body}`
        : 'No inbound task; take a screenshot to observe the current screen state.';
      return ctx.tools ? { systemPrompt, userGoal, tools: ctx.tools } : { systemPrompt, userGoal };
    },
  });

  return handler;
}

export const agenticComputerUseHandler: HandlerKindRegistration = {
  kind:        'agentic.computer-use',
  description: 'Autonomous computer control via screenshot→action loop (Anthropic CUA / claude-opus-4-8). Takes screenshots and performs clicks, typing, and scrolling to complete GUI tasks.',
  configSchema: {
    type: 'object',
    properties: {
      model:                  { type: 'string', default: 'claude-opus-4-8' },
      screenshot_interval_ms: { type: 'integer', default: 1000 },
      max_steps:              { type: 'integer', default: 50 },
      allowed_actions: {
        type: 'array',
        items: { type: 'string', enum: ['screenshot', 'click', 'type', 'scroll', 'key', 'mouse_move'] },
      },
      systemPromptSkillKey: { type: 'string' },
      fallbackPrompt:       { type: 'string' },
    },
  },
  factory: buildAgenticComputerUse,
};
