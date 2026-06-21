/**
 * Built-in handler kind: `agentic.code-interpreter`.
 *
 * Executes Python code in a sandboxed Code Sandbox Environment (CSE) via the
 * same `weaveLiveAgent` loop as `agentic.react`, configured for code-first
 * tasks:
 *   - System prompt focuses the agent on writing, executing, and iterating code
 *   - `max_steps` defaults to 20 (code tasks rarely need more)
 *   - `runtime` and `max_cells` are surfaced in the system prompt header so the
 *     model knows which Python version is available
 *   - `auto_install_libs` informs the model whether it may call pip
 *
 * --- Config shape (`live_agent_handler_bindings.config_json`) ---
 *
 *   {
 *     "model":              "claude-sonnet-4-6",      // optional
 *     "runtime":            "python3.12",             // optional, default python3.12
 *     "max_cells":          20,                       // optional, default 20
 *     "auto_install_libs":  true,                     // optional, default true
 *     "systemPromptSkillKey": "code-interpreter.system", // optional
 *     "fallbackPrompt":    "You are a code interpreter agent.", // optional
 *     "max_steps":         20,                        // optional, default 20
 *   }
 *
 * --- Required HandlerContext slots ---
 * - `model` OR `modelResolver` (LLM-driven)
 *
 * --- Optional HandlerContext slots ---
 * - `tools`               — should include cse_run_code, cse_run_data_analysis
 * - `resolveSystemPrompt` — used when systemPromptSkillKey is set
 */

import { weaveLiveAgent, type TaskHandler } from '@weaveintel/live-agents';
import type { HandlerContext, HandlerKindRegistration } from '../handler-registry.js';

export interface AgenticCodeInterpreterConfig {
  model?: string;
  runtime?: string;
  max_cells?: number;
  auto_install_libs?: boolean;
  systemPromptSkillKey?: string;
  fallbackPrompt?: string;
  maxSteps?: number;
}

const DEFAULT_RUNTIME = 'python3.12';
const DEFAULT_MAX_CELLS = 20;
const DEFAULT_MAX_STEPS = 20;

function readConfig(raw: Record<string, unknown>): AgenticCodeInterpreterConfig {
  const cfg: AgenticCodeInterpreterConfig = {};
  if (typeof raw['model'] === 'string') cfg.model = raw['model'];
  if (typeof raw['runtime'] === 'string') cfg.runtime = raw['runtime'];
  if (typeof raw['max_cells'] === 'number') cfg.max_cells = raw['max_cells'];
  if (typeof raw['auto_install_libs'] === 'boolean') cfg.auto_install_libs = raw['auto_install_libs'];
  if (typeof raw['systemPromptSkillKey'] === 'string') cfg.systemPromptSkillKey = raw['systemPromptSkillKey'];
  if (typeof raw['fallbackPrompt'] === 'string') cfg.fallbackPrompt = raw['fallbackPrompt'];
  if (typeof raw['maxSteps'] === 'number') cfg.maxSteps = raw['maxSteps'];
  if (typeof raw['max_steps'] === 'number') cfg.maxSteps = raw['max_steps'];
  return cfg;
}

async function resolveSystemPrompt(ctx: HandlerContext, cfg: AgenticCodeInterpreterConfig): Promise<string> {
  const runtime = cfg.runtime ?? DEFAULT_RUNTIME;
  const maxCells = cfg.max_cells ?? DEFAULT_MAX_CELLS;
  const autoInstall = cfg.auto_install_libs ?? true;

  const header = `Runtime: ${runtime}  |  Max cells: ${maxCells}  |  Auto-install: ${autoInstall ? 'yes (use pip install <pkg>)' : 'no'}`;

  if (cfg.systemPromptSkillKey && ctx.resolveSystemPrompt) {
    const resolved = await ctx.resolveSystemPrompt(cfg.systemPromptSkillKey);
    if (resolved) return `${header}\n\n${resolved}`;
  }
  if (cfg.fallbackPrompt) return `${header}\n\n${cfg.fallbackPrompt}`;

  return `${header}\n\nYou are ${ctx.agent.name}, a code interpreter agent. Write, execute, and iterate Python code to complete the user's request. Use cse_run_code for general scripts and cse_run_data_analysis for CSV/DataFrame tasks. Iterate until the result is correct.`;
}

function buildAgenticCodeInterpreter(ctx: HandlerContext): TaskHandler {
  if (!ctx.model && !ctx.modelResolver) {
    throw new Error(
      `agentic.code-interpreter: HandlerContext.model OR HandlerContext.modelResolver is required ` +
        `for agent ${ctx.agent.id} (binding ${ctx.binding.id}).`,
    );
  }

  const cfg = readConfig(ctx.binding.config);
  const maxSteps = cfg.maxSteps ?? DEFAULT_MAX_STEPS;

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
        : 'No inbound task; run a health check of available code execution tools.';
      return ctx.tools ? { systemPrompt, userGoal, tools: ctx.tools } : { systemPrompt, userGoal };
    },
  });

  return handler;
}

export const agenticCodeInterpreterHandler: HandlerKindRegistration = {
  kind:        'agentic.code-interpreter',
  description: 'Python code execution in a sandboxed CSE environment. Supports data analysis, visualisation, file I/O, and auto-installing packages. Returns stdout, stderr, and generated files.',
  configSchema: {
    type: 'object',
    properties: {
      model:                { type: 'string', description: 'Optional model override.' },
      runtime:              { type: 'string', enum: ['python3.12', 'python3.11', 'python3.10'], default: 'python3.12' },
      max_cells:            { type: 'integer', default: 20 },
      auto_install_libs:    { type: 'boolean', default: true },
      systemPromptSkillKey: { type: 'string' },
      fallbackPrompt:       { type: 'string' },
      max_steps:            { type: 'integer', default: 20 },
    },
  },
  factory: buildAgenticCodeInterpreter,
};
