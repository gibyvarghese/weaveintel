/**
 * Built-in handler kind: `agentic.browser`.
 *
 * Programmatic browser automation using Playwright in an isolated container.
 * The agent navigates URLs, extracts page content, fills forms, and captures
 * screenshots. JavaScript-heavy SPAs are handled natively by Chromium.
 *
 * --- Deployment status (mid-2026) ---
 *
 * This handler is REGISTERED (visible in Agent Cards / admin UI) but DISABLED
 * by default (`enabled: 0` in seed). It will be enabled when a Playwright
 * container pool is provisioned and the `browser:execute` RBAC permission is
 * assigned to mesh agents.
 *
 * --- Config shape ---
 *
 *   {
 *     "model":            "claude-sonnet-4-6",
 *     "playwright_config": { "browser": "chromium", "headless": true },
 *     "max_pages":         5,
 *     "allowed_domains":  [],          // empty = unrestricted
 *     "systemPromptSkillKey": "browser-automation.system",
 *     "fallbackPrompt":   "You are a browser automation agent.",
 *     "max_steps":        30,
 *   }
 *
 * --- Required HandlerContext slots ---
 * - `model` OR `modelResolver` (LLM decides what to navigate/extract)
 * - `tools` must include Playwright tool bindings (playwright_navigate,
 *   playwright_click, playwright_fill, playwright_screenshot)
 */

import { weaveLiveAgent, type TaskHandler } from '@weaveintel/live-agents';
import type { HandlerContext, HandlerKindRegistration } from '../handler-registry.js';

export interface AgenticBrowserConfig {
  model?: string;
  playwright_config?: {
    browser?: 'chromium' | 'firefox' | 'webkit';
    headless?: boolean;
  };
  max_pages?: number;
  allowed_domains?: string[];
  systemPromptSkillKey?: string;
  fallbackPrompt?: string;
  maxSteps?: number;
}

const DEFAULT_MAX_STEPS = 30;

function readConfig(raw: Record<string, unknown>): AgenticBrowserConfig {
  const cfg: AgenticBrowserConfig = {};
  if (typeof raw['model'] === 'string') cfg.model = raw['model'];
  if (raw['playwright_config'] && typeof raw['playwright_config'] === 'object') {
    cfg.playwright_config = raw['playwright_config'] as AgenticBrowserConfig['playwright_config'];
  }
  if (typeof raw['max_pages'] === 'number') cfg.max_pages = raw['max_pages'];
  if (Array.isArray(raw['allowed_domains'])) cfg.allowed_domains = raw['allowed_domains'] as string[];
  if (typeof raw['systemPromptSkillKey'] === 'string') cfg.systemPromptSkillKey = raw['systemPromptSkillKey'];
  if (typeof raw['fallbackPrompt'] === 'string') cfg.fallbackPrompt = raw['fallbackPrompt'];
  if (typeof raw['maxSteps'] === 'number') cfg.maxSteps = raw['maxSteps'];
  if (typeof raw['max_steps'] === 'number') cfg.maxSteps = raw['max_steps'];
  return cfg;
}

async function resolveSystemPrompt(ctx: HandlerContext, cfg: AgenticBrowserConfig): Promise<string> {
  const browser = cfg.playwright_config?.browser ?? 'chromium';
  const maxPages = cfg.max_pages ?? 5;
  const domains = cfg.allowed_domains?.length
    ? `Allowed domains: ${cfg.allowed_domains.join(', ')}`
    : 'Allowed domains: unrestricted';

  const header = `Browser Agent | ${browser} | Max pages: ${maxPages} | ${domains}`;

  if (cfg.systemPromptSkillKey && ctx.resolveSystemPrompt) {
    const resolved = await ctx.resolveSystemPrompt(cfg.systemPromptSkillKey);
    if (resolved) return `${header}\n\n${resolved}`;
  }
  if (cfg.fallbackPrompt) return `${header}\n\n${cfg.fallbackPrompt}`;

  const domainRule = cfg.allowed_domains?.length
    ? `\nYou MUST NOT navigate to domains outside: ${cfg.allowed_domains.join(', ')}.`
    : '';

  return `${header}

You are ${ctx.agent.name}, a browser automation agent using Playwright (${browser}).${domainRule}

Available tools:
- playwright_navigate: Navigate to a URL
- playwright_click: Click an element by CSS selector or text
- playwright_fill: Fill an input field
- playwright_screenshot: Take a full-page screenshot
- playwright_extract: Extract text/HTML from a CSS selector

Workflow:
1. Navigate to the target URL.
2. Screenshot to understand the current page layout.
3. Interact with elements (click, fill, scroll) to complete the task.
4. Extract the required data and return it in the requested format.

Always verify navigation succeeded with a screenshot before proceeding. Handle cookie banners and login prompts gracefully.`;
}

function buildAgenticBrowser(ctx: HandlerContext): TaskHandler {
  if (!ctx.model && !ctx.modelResolver) {
    throw new Error(
      `agentic.browser: HandlerContext.model OR HandlerContext.modelResolver is required ` +
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
        : 'No inbound task; take a screenshot to show the current browser state.';
      return ctx.tools ? { systemPrompt, userGoal, tools: ctx.tools } : { systemPrompt, userGoal };
    },
  });

  return handler;
}

export const agenticBrowserHandler: HandlerKindRegistration = {
  kind:        'agentic.browser',
  description: 'Programmatic browser automation using Playwright. Navigates URLs, extracts content, fills forms, and captures screenshots in an isolated browser sandbox.',
  configSchema: {
    type: 'object',
    properties: {
      model:            { type: 'string' },
      playwright_config: {
        type: 'object',
        properties: {
          browser:  { type: 'string', enum: ['chromium', 'firefox', 'webkit'], default: 'chromium' },
          headless: { type: 'boolean', default: true },
        },
      },
      max_pages:       { type: 'integer', default: 5 },
      allowed_domains: { type: 'array', items: { type: 'string' } },
      systemPromptSkillKey: { type: 'string' },
      fallbackPrompt:  { type: 'string' },
      max_steps:       { type: 'integer', default: 30 },
    },
  },
  factory: buildAgenticBrowser,
};
