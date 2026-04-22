/**
 * @weaveintel/recipes — SGAP Social Growth Recipe
 *
 * Provides a reusable SGAP-oriented agent factory that can be used by any app,
 * instead of keeping SGAP behavior only inside app-local code.
 */

import type { Agent, Model, ToolRegistry } from '@weaveintel/core';
import { weaveAgent } from '@weaveintel/agents';

export interface WeaveSocialGrowthRecipeOptions {
  model: Model;
  tools?: ToolRegistry;
  name?: string;
  brandName: string;
  brandVoice?: string;
  campaignObjective?: string;
  channels?: string[];
  contentPillars?: string[];
  kpis?: string[];
  cadence?: string;
  systemPrompt?: string;
  maxSteps?: number;
}

export function weaveSocialGrowthRecipe(opts: WeaveSocialGrowthRecipeOptions): Agent {
  const channels = (opts.channels ?? ['linkedin']).join(', ');
  const pillars = (opts.contentPillars ?? ['educational', 'product-proof']).join(', ');
  const kpis = (opts.kpis ?? ['engagement_rate', 'qualified_leads']).join(', ');

  const sgapLoop = [
    'SGAP loop:',
    '1) Plan weekly campaign priorities and content queue items.',
    '2) Produce channel-ready post drafts with clear CTA and asset needs.',
    '3) Adapt copy per channel constraints while preserving brand voice.',
    '4) Measure outcomes and propose the next growth experiment.',
  ].join('\n');

  const systemPrompt = [
    `You are the SGAP growth operator for ${opts.brandName}.`,
    `Brand voice: ${opts.brandVoice ?? 'clear, practical, and audience-focused'}.`,
    `Campaign objective: ${opts.campaignObjective ?? 'increase qualified audience growth'}.`,
    `Primary channels: ${channels}.`,
    `Primary content pillars: ${pillars}.`,
    `Success KPIs: ${kpis}.`,
    `Publishing cadence: ${opts.cadence ?? 'weekly planning with daily channel execution'}.`,
    sgapLoop,
    'Always return output in sections: Plan, Drafts, Distribution Notes, KPI Measurement, Next Experiment.',
    'Depth requirements:',
    '- Plan must include at least 3 concrete priorities with rationale and expected KPI impact.',
    '- Drafts must include complete post-ready copy, not placeholders or single-line summaries.',
    '- Distribution Notes must include timing, format adaptation, and a repost/iteration rule.',
    '- KPI Measurement must include explicit targets and one experiment with a decision threshold.',
    '- Avoid one-liners unless explicitly requested by the user.',
    opts.systemPrompt ?? '',
  ].join('\n\n');

  return weaveAgent({
    name: opts.name ?? 'sgap-social-growth-operator',
    model: opts.model,
    tools: opts.tools,
    systemPrompt,
    maxSteps: opts.maxSteps ?? 20,
  });
}
