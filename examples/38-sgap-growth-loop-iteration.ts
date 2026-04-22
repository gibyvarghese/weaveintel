/**
 * Example 38 — SGAP Growth Loop Iteration
 *
 * Demonstrates an SGAP iteration loop using the reusable recipe:
 *  1) Generate a weekly plan and draft set
 *  2) Generate an optimization follow-up based on KPI signals
 *
 * No API key required (mock model).
 *
 * Run: npx tsx examples/38-sgap-growth-loop-iteration.ts
 */

import { weaveSocialGrowthRecipe } from '@weaveintel/recipes';
import { createMockModel } from '@weaveintel/devtools';
import { weaveContext } from '@weaveintel/core';

async function main() {
  const model = createMockModel({
    responses: [
      [
        'Plan: Publish three implementation-first posts focused on activation tactics.',
        'Drafts: (1) checklist carousel, (2) short founder story, (3) comparison post.',
        'Distribution Notes: Prioritize LinkedIn mornings and X afternoons.',
        'KPI Measurement: Track saves, comments, profile clicks, and qualified replies.',
        'Next Experiment: Compare hook format (question vs contrarian statement).',
      ].join('\n'),
      [
        'Plan: Shift one post toward case-study evidence to improve credibility.',
        'Drafts: Add one quantified outcome in each post body and CTA.',
        'Distribution Notes: Repost top performer after 48 hours with new opener.',
        'KPI Measurement: Add CTA click-through and conversion rate to baseline set.',
        'Next Experiment: Test CTA position (mid-post vs final line).',
      ].join('\n'),
    ],
  });

  const sgapAgent = weaveSocialGrowthRecipe({
    model,
    brandName: 'Tech Lunch',
    brandVoice: 'practical, concise, and founder-oriented',
    campaignObjective: 'increase qualified inbound leads from social channels',
    channels: ['linkedin', 'x'],
    contentPillars: ['activation playbooks', 'founder operations'],
    kpis: ['engagement_rate', 'profile_clicks', 'qualified_inbound_messages'],
    cadence: 'weekly planning with daily execution',
  });

  const ctx = weaveContext({ userId: 'example-user' });

  const weekly = await sgapAgent.run(ctx, {
    messages: [
      { role: 'user', content: 'Generate this week SGAP plan and channel drafts.' },
    ],
  });

  console.log('\nIteration 1: Weekly SGAP Plan\n');
  console.log(weekly.output);

  const followUp = await sgapAgent.run(ctx, {
    messages: [
      {
        role: 'user',
        content: [
          'Optimize next iteration using these KPI signals:',
          '- Saves increased 14% week-over-week',
          '- Profile clicks flat',
          '- Qualified inbound messages down 8%',
        ].join('\n'),
      },
    ],
  });

  console.log('\nIteration 2: KPI-Informed Optimization\n');
  console.log(followUp.output);
}

main().catch((err) => {
  console.error('Example failed:', err);
  process.exit(1);
});
