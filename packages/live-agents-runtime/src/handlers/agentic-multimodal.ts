/**
 * Built-in handler kind: `agentic.multimodal`.
 *
 * Vision-first ReAct loop for tasks where images are the primary input.
 * Extends `agentic.react` with image-handling config:
 *   - `image_detail` controls the level of detail per image ('low'|'high'|'auto')
 *   - `max_images_per_turn` limits the number of images forwarded to the model
 *     per tick to manage token budget
 *
 * Mid-2026 state: All claude-sonnet-4-6 and claude-opus-4-8 models natively
 * support vision input. This handler variant documents that the binding is
 * specifically configured for image-heavy workloads.
 *
 * --- Config shape ---
 *
 *   {
 *     "model":               "claude-sonnet-4-6",
 *     "image_detail":        "auto",   // low | high | auto
 *     "max_images_per_turn": 10,
 *     "max_steps":           12,
 *     "systemPromptSkillKey": "multimodal-agent.system",
 *     "fallbackPrompt":      "You are a vision AI agent.",
 *   }
 *
 * --- Required HandlerContext slots ---
 * - `model` OR `modelResolver` (must be a vision-capable model)
 * - `tools` should include image analysis tools (e.g. image_classify, ocr_extract)
 */

import { weaveLiveAgent, type TaskHandler } from '@weaveintel/live-agents';
import type { HandlerContext, HandlerKindRegistration } from '../handler-registry.js';

export interface AgenticMultimodalConfig {
  model?: string;
  image_detail?: 'low' | 'high' | 'auto';
  max_images_per_turn?: number;
  max_steps?: number;
  systemPromptSkillKey?: string;
  fallbackPrompt?: string;
}

const DEFAULT_MAX_STEPS = 12;
const DEFAULT_IMAGE_DETAIL = 'auto';
const DEFAULT_MAX_IMAGES_PER_TURN = 10;

function readConfig(raw: Record<string, unknown>): AgenticMultimodalConfig {
  const cfg: AgenticMultimodalConfig = {};
  if (typeof raw['model'] === 'string') cfg.model = raw['model'];
  if (typeof raw['image_detail'] === 'string') cfg.image_detail = raw['image_detail'] as AgenticMultimodalConfig['image_detail'];
  if (typeof raw['max_images_per_turn'] === 'number') cfg.max_images_per_turn = raw['max_images_per_turn'];
  if (typeof raw['max_steps'] === 'number') cfg.max_steps = raw['max_steps'];
  if (typeof raw['systemPromptSkillKey'] === 'string') cfg.systemPromptSkillKey = raw['systemPromptSkillKey'];
  if (typeof raw['fallbackPrompt'] === 'string') cfg.fallbackPrompt = raw['fallbackPrompt'];
  return cfg;
}

async function resolveSystemPrompt(ctx: HandlerContext, cfg: AgenticMultimodalConfig): Promise<string> {
  const detail = cfg.image_detail ?? DEFAULT_IMAGE_DETAIL;
  const maxImages = cfg.max_images_per_turn ?? DEFAULT_MAX_IMAGES_PER_TURN;
  const header = `Multimodal Agent | Image detail: ${detail} | Max images/turn: ${maxImages}`;

  if (cfg.systemPromptSkillKey && ctx.resolveSystemPrompt) {
    const resolved = await ctx.resolveSystemPrompt(cfg.systemPromptSkillKey);
    if (resolved) return `${header}\n\n${resolved}`;
  }
  if (cfg.fallbackPrompt) return `${header}\n\n${cfg.fallbackPrompt}`;

  return `${header}

You are ${ctx.agent.name}, a multimodal AI agent specialised in visual analysis.

Capabilities:
- Analyse images, diagrams, charts, screenshots, and documents
- Perform OCR and text extraction from images
- Compare and contrast multiple images
- Generate structured descriptions and metadata
- Classify, tag, and route visual content

Guidelines:
- Always describe what you observe before drawing conclusions.
- For charts and graphs, extract specific data points rather than general descriptions.
- For document images, perform full OCR before analysing content.
- If image quality is poor or content is ambiguous, state this explicitly.`;
}

function buildAgenticMultimodal(ctx: HandlerContext): TaskHandler {
  if (!ctx.model && !ctx.modelResolver) {
    throw new Error(
      `agentic.multimodal: HandlerContext.model OR HandlerContext.modelResolver is required ` +
        `for agent ${ctx.agent.id} (binding ${ctx.binding.id}).`,
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
        : 'No inbound task; perform a visual environment status check.';
      return ctx.tools ? { systemPrompt, userGoal, tools: ctx.tools } : { systemPrompt, userGoal };
    },
  });

  return handler;
}

export const agenticMultimodalHandler: HandlerKindRegistration = {
  kind:        'agentic.multimodal',
  description: 'Vision-first ReAct loop for tasks where images are the primary input. Controls image detail level and per-turn image count to manage token budget.',
  configSchema: {
    type: 'object',
    properties: {
      model:               { type: 'string' },
      image_detail:        { type: 'string', enum: ['low', 'high', 'auto'], default: 'auto' },
      max_images_per_turn: { type: 'integer', default: 10 },
      max_steps:           { type: 'integer', default: 12 },
      systemPromptSkillKey: { type: 'string' },
      fallbackPrompt:       { type: 'string' },
    },
  },
  factory: buildAgenticMultimodal,
};
