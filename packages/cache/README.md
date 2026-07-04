# @weaveintel/cache

**Don't pay twice for the same answer — cache LLM and tool results by exact key or by how similar the question is.**

## Why it exists

LLM calls are the slow, expensive part of an app, and users ask the same things over and over — often in slightly different words. "What's your refund policy?" and "How do refunds work?" want the same answer, but a plain key-value cache treats them as strangers because the text doesn't match byte-for-byte. This package caches both ways: an exact-match store for identical inputs, and a *semantic* store that recognises "close enough" by comparing meaning (embedding similarity), so the second phrasing reuses the first answer.

## When to reach for it

Reach for it to cut latency and token spend on repeated or near-repeated work: LLM responses, tool-call results, retrieval outputs. Use the exact store for deterministic keys, the semantic store when paraphrases should hit, and the tiered store to layer a fast in-process L1 over a shared Redis L2. If you need the agent to *remember* facts across a session (not just avoid recomputation), reach for `@weaveintel/memory` instead.

## How to use it

```ts
import { weaveSemanticCache } from '@weaveintel/cache';

const cache = weaveSemanticCache({
  embed: async (text) => myEmbedder(text), // text → vector
  defaultThreshold: 0.92,
});

await cache.store('What is your refund policy?', 'Refunds within 30 days.');

const hit = await cache.find('How do refunds work?');
if (hit) console.log(hit.response, `(matched at ${hit.similarity.toFixed(2)})`);
```

## What's in the box

- **Stores** — `weaveInMemoryCacheStore` (LRU/LFU/TinyLFU/GDSF eviction), `weaveTieredCacheStore` (L1+L2), `weaveRedisCacheStore` (also at `@weaveintel/cache/redis`).
- **Semantic** — `weaveSemanticCache`, `createInMemoryVectorIndex`, `cosineSimilarity`.
- **Keys & policy** — `weaveCacheKeyBuilder`, `cacheScopeKey`, `createCachePolicy`, `shouldBypass`, `isCacheableTemperature`.
- **Prompt caching** — `planPromptCacheBreakpoints`, `estimatePromptTokens` (provider-native breakpoints).
- **Invalidation & metrics** — `createCacheInvalidator`, `applySemanticInvalidation`, `createCacheMetrics`, `estimatePromptCacheSavingsUsd`.
- **Tool results** — `withToolResultCache`, `buildToolCacheKey`.
- **Resilience** — `createSingleflight` (stampede protection), `createStampedeCache` (SWR / stale-while-revalidate).

## License

MIT.
