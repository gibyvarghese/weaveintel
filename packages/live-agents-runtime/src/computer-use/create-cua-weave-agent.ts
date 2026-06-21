/**
 * `createCuaWeaveAgent` — bridge the `agentic.computer-use` handler kind
 * into a `weaveAgent`-based Agent (the standard `@weaveintel/agents` path).
 *
 * This lets callers use the same CUA config and system-prompt logic as the
 * live-agents handler, but through the synchronous `agent.run(goal)` API
 * instead of the tick-based live-agents mesh.
 *
 * @example
 * ```ts
 * import { weaveAnthropic } from '@weaveintel/provider-anthropic';
 * import { createCuaWeaveAgent } from '@weaveintel/live-agents-runtime';
 *
 * const model = weaveAnthropic('claude-opus-4-8');
 * const agent = createCuaWeaveAgent({ model, config: { max_steps: 10 } });
 * const result = await agent.run('Open a terminal and list the current directory.');
 * console.log(result.text);
 * ```
 */

import { weaveAgent } from '@weaveintel/agents';
import type { Agent, Model } from '@weaveintel/core';
import { wrapModelForCua, type WrapModelForCuaOptions } from './wrap-model-for-cua.js';
import { createCuaToolRegistry, type CuaToolRegistryOptions } from './cua-tool-registry.js';

export interface CuaWeaveAgentConfig {
  /** Model to use (must support tool calls; CUA requires claude-opus-4-8+). */
  model: Model;
  /** Display size — forwarded to `wrapModelForCua` and the tool registry. */
  display?: WrapModelForCuaOptions;
  /** Bash/file tool options forwarded to the tool registry. */
  tools?: CuaToolRegistryOptions;
  /**
   * Per-handler config shape (mirrors `AgenticComputerUseConfig`).
   * Supported keys: `max_steps`, `allowed_actions`, `fallbackPrompt`.
   */
  config?: {
    max_steps?: number;
    allowed_actions?: string[];
    fallbackPrompt?: string;
    systemPrompt?: string;
  };
  /** Agent display name. Default: 'cua-agent'. */
  name?: string;
}

function buildSystemPrompt(cfg: CuaWeaveAgentConfig['config'] = {}): string {
  if (cfg.systemPrompt) return cfg.systemPrompt;

  const allowed = cfg.allowed_actions ?? ['screenshot', 'left_click', 'right_click', 'double_click', 'type', 'key', 'scroll', 'mouse_move'];

  const header = `Computer Use Agent | Allowed actions: ${allowed.join(', ')}`;

  if (cfg.fallbackPrompt) return `${header}\n\n${cfg.fallbackPrompt}`;

  return `${header}

You are an autonomous computer use agent. You control the computer using screenshot observation and action execution.

Workflow:
1. Call the \`computer\` tool with action="screenshot" to observe the current screen state.
2. Decide the next action (left_click, type, key, scroll) to progress toward the goal.
3. Execute the action and call screenshot again to verify the result.
4. Use the \`bash\` tool for any shell operations (run commands, install packages, query files).
5. Use \`str_replace_editor\` to view or edit files precisely.
6. Repeat until the task is complete, then summarise what you did.

Rules:
- Always screenshot before acting on a GUI element to confirm it's visible.
- Prefer keyboard shortcuts over mouse navigation where possible.
- If you encounter an unexpected dialog or error, screenshot and assess.
- Only use actions in the allowed list: ${allowed.join(', ')}.
- Confirm completion by taking a final screenshot and describing the outcome.`;
}

/**
 * Build a `weaveAgent` (standard `@weaveintel/agents` Agent) configured for
 * computer use, using the same config shape as the `agentic.computer-use`
 * live-agents handler.
 */
export function createCuaWeaveAgent(opts: CuaWeaveAgentConfig): Agent {
  const cuaModel   = wrapModelForCua(opts.model, opts.display ?? {});
  const toolRegistry = createCuaToolRegistry({
    ...opts.tools,
    cwd:           opts.tools?.cwd ?? process.cwd(),
    displayWidth:  opts.display?.displayWidth ?? 1280,
    displayHeight: opts.display?.displayHeight ?? 800,
    displayNumber: opts.display?.displayNumber,
  });

  const systemPrompt = buildSystemPrompt(opts.config);
  const maxSteps     = opts.config?.max_steps ?? 50;

  return weaveAgent({
    name:        opts.name ?? 'cua-agent',
    model:       cuaModel,
    tools:       toolRegistry,
    systemPrompt,
    maxSteps,
    visionLoop:  true,     // auto-inject screenshots as image content
    parallelDelegation: false, // CUA steps are inherently sequential
  });
}
