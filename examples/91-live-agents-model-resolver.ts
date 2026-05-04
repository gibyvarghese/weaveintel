/**
 * Example 91 — Live-agents Phase 1: `ModelResolver` as a first-class capability.
 *
 * Demonstrates the per-tick model rotation pattern that distinguishes
 * `@weaveintel/live-agents` from `weaveAgent`:
 *
 *   - `weaveAgent`: pinned `model: Model` for a one-shot request.
 *   - `weaveLiveAgent` / `createAgenticTaskHandler`: optional pinned `model`
 *     PLUS optional `modelResolver: ModelResolver` that runs *fresh per tick*.
 *
 * Run:
 *   npx tsx examples/91-live-agents-model-resolver.ts
 *
 * Expected output:
 *   - Three resolver patterns, each printing the model id picked per tick.
 *   - The fallback chain demo shows the resolver throwing → pinned model wins.
 *   - No external services required (uses fake in-memory models).
 */

import {
  weaveModelResolver,
  weaveModelResolverFromFn,
  composeModelResolvers,
  resolveModelForTick,
  type ModelResolver,
  type ModelResolverContext,
} from '@weaveintel/live-agents';
import type { Model } from '@weaveintel/core';

// --- Fake model factory (no API key needed) ---------------------------------
function fakeModel(id: string): Model {
  return {
    info: { provider: 'fake', modelId: id, capabilities: new Set() },
    capabilities: new Set(),
    hasCapability: () => false,
    async generate() {
      return {
        id: 'r',
        model: id,
        content: `output from ${id}`,
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    },
  } as unknown as Model;
}

const ROLE_HEADER = (label: string) => console.log(`\n=== ${label} ===`);

async function demoPinned() {
  ROLE_HEADER('1) weaveModelResolver — pinned wrapper');
  const resolver = weaveModelResolver({ model: fakeModel('gpt-4o-mini') });
  for (const tick of [1, 2, 3]) {
    const out = await resolveModelForTick(resolver, undefined, {
      role: 'strategist',
      stepId: tick,
    });
    console.log(`  tick=${tick} → ${(out.model.info as { modelId: string }).modelId} [source=${out.source}]`);
  }
}

async function demoRotating() {
  ROLE_HEADER('2) weaveModelResolverFromFn — round-robin per tick');
  const pool = [fakeModel('claude-3-5-sonnet'), fakeModel('gpt-4o'), fakeModel('llama-3.1-70b')];
  let i = 0;
  const resolver = weaveModelResolverFromFn(async (ctx: ModelResolverContext) => {
    const pick = pool[i % pool.length]!;
    i += 1;
    return pick;
  });
  for (const tick of [1, 2, 3, 4, 5]) {
    const out = await resolveModelForTick(resolver, undefined, {
      role: 'strategist',
      stepId: tick,
    });
    console.log(`  tick=${tick} → ${(out.model.info as { modelId: string }).modelId} [source=${out.source}]`);
  }
}

async function demoComposeWithFallback() {
  ROLE_HEADER('3) composeModelResolvers — primary fails over to secondary');
  const flaky: ModelResolver = {
    resolve(ctx) {
      // Simulate provider rate-limit on every other tick.
      if (Number(ctx.stepId) % 2 === 0) {
        throw new Error('429 rate limited');
      }
      return fakeModel('flaky-primary');
    },
  };
  const stable = weaveModelResolver({ model: fakeModel('stable-secondary') });
  const composed = composeModelResolvers([flaky, stable], {
    log: (m) => console.log(`  [compose] ${m}`),
  });
  for (const tick of [1, 2, 3, 4]) {
    const out = await resolveModelForTick(composed, undefined, {
      role: 'strategist',
      stepId: tick,
    });
    console.log(`  tick=${tick} → ${(out.model.info as { modelId: string }).modelId}`);
  }
}

async function demoResolverPlusPinnedFallback() {
  ROLE_HEADER('4) resolver throws → pinned `model` is the safety net');
  const broken: ModelResolver = {
    resolve() {
      throw new Error('routing service down');
    },
  };
  const pinned = fakeModel('pinned-fallback');
  const out = await resolveModelForTick(broken, pinned, { role: 'strategist' });
  console.log(`  source=${out.source} model=${(out.model.info as { modelId: string }).modelId} error=${out.error}`);
}

async function main() {
  console.log('Live-agents Phase 1 — ModelResolver capability slot demo');
  await demoPinned();
  await demoRotating();
  await demoComposeWithFallback();
  await demoResolverPlusPinnedFallback();
  console.log('\nDone. See packages/live-agents/src/model-resolver.ts for the API.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
