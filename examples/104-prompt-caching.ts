/**
 * Example 104 — Prompt Caching (Cost Governor Phase 3)
 *
 * Demonstrates the prompt-caching lever end-to-end with stub Models for
 * OpenAI and Anthropic — no DB, no real LLM, no external services.
 *
 * Shows:
 *   1. weavePromptCachingShaper key strategies (static / role / role+phase)
 *   2. wrapModelWithCacheHints OpenAI behaviour — stamps
 *      `metadata.promptCacheKey`; messages array untouched
 *   3. wrapModelWithCacheHints Anthropic behaviour — rewrites the system
 *      message into a content-block array with `cache_control`, drops
 *      system from messages, sets `metadata.systemPrompt`
 *   4. Tier presets (balanced/performance/max all enable caching) and
 *      bundle resolution via `weaveCostGovernor`
 *
 * Run: `npx tsx examples/104-prompt-caching.ts`
 */

import type {
  ExecutionContext,
  Message,
  Model,
  ModelInfo,
  ModelRequest,
  ModelResponse,
} from '@weaveintel/core';
import {
  noopCacheShaper,
  weaveCostGovernor,
  weavePromptCachingShaper,
  wrapModelWithCacheHints,
  type CacheShapeContext,
} from '@weaveintel/cost-governor';

// ── 1. Shaper key strategies ────────────────────────────────

console.log('── Section 1: shaper key strategies ──');

const baseCtx: CacheShapeContext = {
  provider: 'openai',
  role: 'strategist',
  phase: 'discovery',
  version: '7',
};

console.log('  static     :', weavePromptCachingShaper({ enabled: true, keyStrategy: 'static' }).compute(baseCtx));
console.log('  role       :', weavePromptCachingShaper({ enabled: true, keyStrategy: 'role' }).compute(baseCtx));
console.log('  role+phase :', weavePromptCachingShaper({ enabled: true, keyStrategy: 'role+phase' }).compute(baseCtx));
console.log('  disabled   :', weavePromptCachingShaper({ enabled: false }).compute(baseCtx));
console.log('  noop       :', noopCacheShaper.compute(baseCtx));

// ── 2. Stub model factory ───────────────────────────────────

function makeStubModel(provider: string, label: string): Model {
  const info: ModelInfo = {
    provider,
    modelId: `${provider}-stub`,
    capabilities: new Set(),
  };
  return {
    info,
    capabilities: info.capabilities,
    async generate(_ctx: ExecutionContext, req: ModelRequest): Promise<ModelResponse> {
      console.log(`  [${label}] outgoing metadata     :`, JSON.stringify(req.metadata ?? {}));
      console.log(
        `  [${label}] outgoing message roles :`,
        req.messages.map((m) => m.role).join(', '),
      );
      return {
        message: { role: 'assistant', content: 'ok' },
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        finishReason: 'stop',
      };
    },
  };
}

const stubCtx: ExecutionContext = {
  runId: 'run-1',
  stepId: 'step-1',
  bus: { emit: () => {}, on: () => () => {}, onAll: () => () => {}, onMatch: () => () => {} } as any,
  tracer: { startSpan: () => ({ end: () => {}, setAttribute: () => {}, setStatus: () => {}, recordException: () => {} }) } as any,
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
};

const messages: Message[] = [
  { role: 'system', content: 'You are a careful, precise strategist.' },
  { role: 'user', content: 'What should we try next?' },
];

// ── 3. OpenAI mode ──────────────────────────────────────────

console.log('\n── Section 2: OpenAI mode (metadata.promptCacheKey only) ──');
const openaiInner = makeStubModel('openai', 'openai');
const openaiShaper = weavePromptCachingShaper({ enabled: true, keyStrategy: 'role' });
const openaiWrapped = wrapModelWithCacheHints(openaiInner, openaiShaper, {
  resolveContext: () => ({ provider: 'openai', role: 'strategist', version: '7' }),
});
await openaiWrapped.generate(stubCtx, { messages });

// ── 4. Anthropic mode ───────────────────────────────────────

console.log('\n── Section 3: Anthropic mode (system → content-block + cache_control) ──');
const anthInner = makeStubModel('anthropic', 'anthropic');
const anthShaper = weavePromptCachingShaper({ enabled: true, keyStrategy: 'role+phase' });
const anthWrapped = wrapModelWithCacheHints(anthInner, anthShaper, {
  resolveContext: () => ({ provider: 'anthropic', role: 'strategist', phase: 'discovery', version: '7' }),
});
await anthWrapped.generate(stubCtx, { messages });

// ── 5. Bundle from tier preset ──────────────────────────────

console.log('\n── Section 4: bundle from tier preset (balanced) ──');
const bundle = weaveCostGovernor({ tier: 'balanced' });
console.log('  policy.tier               :', bundle.policy.tier);
console.log('  promptCaching.enabled     :', bundle.policy.promptCaching.enabled);
console.log('  promptCaching.keyStrategy :', bundle.policy.promptCaching.keyStrategy);
const tierHints = bundle.cacheShaper.compute({ provider: 'openai', role: 'strategist', version: '7' });
console.log('  shaper hints              :', tierHints);

console.log('\n✓ Example complete.');
