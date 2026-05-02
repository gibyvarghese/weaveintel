/** Kaggle Discoverer — agentic seed + deterministic top-N forwarder. */
import type { TaskHandler } from '@weaveintel/live-agents';
import type { KaggleCompetition } from '@weaveintel/tools-kaggle';
import { emitToNextAgent, resolveCreds, type SharedHandlerContext } from './_shared.js';

/** Agentic mode: pick top-N (or pinned) competitions and seed the strategist. */
export function createDiscovererAgentic(ctx: SharedHandlerContext): TaskHandler {
  return async (_action, context) => {
    const { adapter, log, getOpDefaults, opts } = ctx;
    log('Discoverer (agentic mode): seeding strategist with top competitions.');
    const creds = resolveCreds(opts);
    const opDefaults = await getOpDefaults();
    const pinnedSlug = process.env['KAGGLE_COMPETITION_SLUG']?.trim();
    let top: KaggleCompetition[];
    if (pinnedSlug) {
      log(`Discoverer: pinned to competition slug=${pinnedSlug}`);
      const comp = await adapter.getCompetition(creds, pinnedSlug);
      top = [comp];
    } else {
      const comps = await adapter.listCompetitions(creds, { page: 1 });
      top = comps.slice(0, opDefaults.topNAgentic);
    }
    const summary = top
      .map((c) => `- ${c.id} | ${c.title} | metric=${c.evaluationMetric ?? 'n/a'} | deadline=${c.deadline ?? 'n/a'}`)
      .join('\n');
    const body = [
      'Active competitions you may choose from (pick the most tractable one):',
      summary,
      '',
      'Proceed with the workflow described in your system prompt.',
    ].join('\n');
    await emitToNextAgent(
      context,
      'strategist',
      `Seed: ${top.length} candidate competitions`,
      body,
      'kaggle.discovery.seed',
    );
    return {
      completed: true,
      summaryProse: `Seeded strategist with ${top.length} candidate competitions.`,
    };
  };
}

/** Deterministic mode: forward top-N as a JSON envelope to the strategist. */
export function createDiscovererDeterministic(ctx: SharedHandlerContext): TaskHandler {
  return async (_action, context) => {
    const { adapter, log, getOpDefaults, opts } = ctx;
    const creds = resolveCreds(opts);
    log('Discoverer fetching competitions...');
    const opDefaults = await getOpDefaults();
    const comps = await adapter.listCompetitions(creds, { page: 1 });
    const top = comps.slice(0, opDefaults.topNDeterministic);
    log(`Discoverer found ${comps.length} competitions; forwarding top ${top.length} to strategist`);
    const summary = top
      .map((c) => `- ${c.id} | ${c.title} | metric=${c.evaluationMetric ?? 'n/a'} | deadline=${c.deadline ?? 'n/a'}`)
      .join('\n');
    const body = JSON.stringify({ competitions: top }, null, 2);
    await emitToNextAgent(
      context,
      'strategist',
      `Discovered ${top.length} candidate competitions`,
      body,
      'kaggle.discovery.candidates',
    );
    return {
      completed: true,
      summaryProse: `Discovered ${comps.length} competitions; forwarded ${top.length} to strategist:\n${summary}`,
    };
  };
}
