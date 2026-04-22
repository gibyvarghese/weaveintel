/**
 * Example 36 — SGAP Social Growth Recipe
 *
 * Demonstrates the SGAP reusable recipe exported from @weaveintel/recipes.
 * Uses a mock model so no API key is required.
 *
 * Run: npx tsx examples/36-sgap-social-growth-recipe.ts
 */

import { weaveSocialGrowthRecipe } from '@weaveintel/recipes';
import { createMockModel } from '@weaveintel/devtools';
import { weaveContext } from '@weaveintel/core';

async function main() {
  const model = createMockModel({
    responses: [
      [
        'Plan: Focus this week on founder-led narrative + practical checklists.',
        'Drafts: 1 LinkedIn carousel concept, 1 short video script, 1 CTA post.',
        'Distribution Notes: Schedule morning slots and pin the CTA thread.',
        'KPI Measurement: Track saves, profile visits, and qualified inbound leads.',
        'Next Experiment: Test short hook variants in first two lines of the post.',
      ].join('\n'),
    ],
  });

  const sgapAgent = weaveSocialGrowthRecipe({
    model,
    brandName: 'Tech Lunch',
    brandVoice: 'friendly, practical, and technical',
    campaignObjective: 'grow qualified founder audience',
    channels: ['linkedin', 'x'],
    contentPillars: ['founder lessons', 'applied AI playbooks'],
    kpis: ['engagement_rate', 'profile_clicks', 'qualified_inbound_messages'],
    cadence: 'weekly planning with 4 posts per week',
  });

  const result = await sgapAgent.run(weaveContext({ userId: 'example-user' }), {
    messages: [
      {
        role: 'user',
        content: 'Create next week SGAP plan and drafts for Tech Lunch.',
      },
    ],
  });

  console.log('\nSGAP Recipe Output\n');
  console.log(result.output);
}

main().catch((err) => {
  console.error('Example failed:', err);
  process.exit(1);
});
