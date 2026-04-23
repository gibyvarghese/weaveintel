/**
 * Example 25 — Semantic Cache
 *
 * Demonstrates the @weaveintel/cache package: embedding-based semantic caching,
 * key builder, policy evaluation, and TTL/scope-based invalidation.
 *
 * WeaveIntel packages used:
 *   @weaveintel/cache — Full caching layer for AI pipelines:
 *     • weaveInMemoryCacheStore  — Fast in-memory key/value store with optional TTL.
 *                                  Suitable for single-process deployments; swap for Redis
 *                                  or DynamoDB by implementing the CacheStore interface.
 *     • weaveSemanticCache       — Embedding-based similarity cache. Stores (query, embedding,
 *                                  response) triples. On lookup, computes cosine similarity
 *                                  between the incoming query embedding and all cached entries;
 *                                  returns the closest match above the similarity threshold.
 *                                  Prevents redundant LLM calls for semantically equivalent
 *                                  questions (e.g. "What is Paris?" ≈ "Tell me about Paris").
 *     • createCachePolicy        — Creates a CachePolicy record with TTL, scope, bypass patterns,
 *                                  and event-driven invalidation config. Policies are evaluated
 *                                  at request time to decide if caching is allowed for a given
 *                                  user/session/tenant scope.
 *     • shouldBypass             — Evaluates a policy's bypassPatterns against a query string.
 *                                  Use to skip caching for sensitive/real-time queries.
 *     • resolvePolicy            — Given multiple policies and a request scope, returns the most
 *                                  specific applicable policy (user > session > tenant > global).
 *     • weaveCacheKeyBuilder     — Generates deterministic, collision-resistant cache keys from
 *                                  structured key-value parts (model, userId, prompt hash, etc.).
 *                                  Supports namespacing and round-trip parsing.
 *     • evaluateInvalidationRules— Rule engine for event-driven cache invalidation. Each rule
 *                                  specifies which event types trigger invalidation and which
 *                                  cache scopes/keys to clear.
 *     • applySemanticInvalidation— Removes all semantic cache entries whose embeddings are
 *                                  highly similar to a given invalidation query (threshold 0.95).
 *   @weaveintel/testing — weaveFakeEmbedding() for deterministic embedding vectors
 *
 * No API keys needed — uses in-memory fake embeddings.
 *
 * Run: npx tsx examples/25-semantic-cache.ts
 */

import {
  weaveInMemoryCacheStore,
  weaveSemanticCache,
  createCachePolicy,
  shouldBypass,
  resolvePolicy,
  weaveCacheKeyBuilder,
  evaluateInvalidationRules,
  type InvalidationEvent,
} from '@weaveintel/cache';
import { weaveFakeEmbedding } from '@weaveintel/testing';
import { weaveContext, type CacheInvalidationRule } from '@weaveintel/core';

async function main() {
  // --- 1. In-Memory Cache Store ---
  // weaveInMemoryCacheStore() is a basic TTL-aware key/value store.
  // In production replace with a Redis or Memcached adapter that implements
  // the CacheStore interface (get/set/delete/clear).
  console.log('=== 1. In-Memory Cache Store ===');

  const store = weaveInMemoryCacheStore();

  await store.set('greeting:en', 'Hello, World!');
  await store.set('greeting:fr', 'Bonjour, le Monde!', 5000);

  const en = await store.get('greeting:en');
  const fr = await store.get('greeting:fr');
  console.log(`greeting:en → ${en}`);
  console.log(`greeting:fr → ${fr}`);

  // delete() supports single-key removal
  await store.delete('greeting:en');
  const gone = await store.get('greeting:en');
  console.log(`After delete, greeting:en → ${gone ?? '(not found)'}`);

  // --- 2. Cache Key Builder ---
  // weaveCacheKeyBuilder() generates sorted, deterministic keys from structured parts.
  // This prevents cache collisions when the same query is sent by different users
  // or with different model configurations.
  console.log('\n=== 2. Cache Key Builder ===');

  const keyBuilder = weaveCacheKeyBuilder({ namespace: 'chat', separator: ':' });

  const key1 = keyBuilder.build({ model: 'gpt-4o-mini', userId: 'u1', promptHash: 'abc123' });
  const key2 = keyBuilder.build({ promptHash: 'abc123', model: 'gpt-4o-mini', userId: 'u1' }); // same parts, different order
  console.log(`key1: ${key1}`);
  console.log(`key2: ${key2}`);
  console.log(`Deterministic (key1 === key2): ${key1 === key2}`);

  const parsed = keyBuilder.parse(key1);
  console.log(`Parsed back: ${JSON.stringify(parsed)}`);

  // --- 3. Cache Policy ---
  // createCachePolicy() defines the rules for when to use / bypass / invalidate a cache.
  // Policies are tenant/scope aware: user-scoped policies override global ones.
  console.log('\n=== 3. Cache Policy ===');

  const globalPolicy = createCachePolicy({
    id: 'global-default',
    name: 'Global Cache Policy',
    scope: 'global',
    ttlMs: 5 * 60 * 1000, // 5 minutes
    maxEntries: 10_000,
    // Skip cache for anything real-time or PII-related
    bypassPatterns: ['what time is it', 'current price', 'my password'],
    invalidateOnEvents: ['user.logout', 'model.updated'],
  });

  const userPolicy = createCachePolicy({
    id: 'user-premium',
    name: 'Premium User Cache Policy',
    scope: 'user',
    ttlMs: 30 * 60 * 1000, // 30 minutes for premium users
    maxEntries: 500,
    bypassPatterns: ['real-time', 'live'],
  });

  // shouldBypass() checks if a query matches any bypass pattern
  const queries = [
    'What is the capital of France?',
    'what time is it right now?',
    'Explain quantum computing',
    'current price of Bitcoin',
  ];
  console.log('Bypass evaluation (global policy):');
  for (const q of queries) {
    console.log(`  "${q.slice(0, 45)}" → bypass=${shouldBypass(globalPolicy, q)}`);
  }

  // resolvePolicy() picks the most specific applicable policy for a given scope.
  const policies = [globalPolicy, userPolicy];
  const resolvedForUser = resolvePolicy(policies, { scope: 'user' });
  const resolvedForTenant = resolvePolicy(policies, { scope: 'tenant' });
  console.log(`\nresolved for user scope: ${resolvedForUser?.name ?? '(none)'}`);
  console.log(`resolved for tenant scope: ${resolvedForTenant?.name ?? '(none)'}`);

  // --- 4. Semantic Cache ---
  // weaveSemanticCache() stores responses alongside their query embeddings.
  // On lookup it finds the most similar cached entry above the threshold.
  // This means "What is Paris?" and "Tell me about the city of Paris" can
  // both be served from the same cache entry — no need to re-call the LLM.
  console.log('\n=== 4. Semantic Cache ===');

  // weaveFakeEmbedding() returns deterministic vectors from @weaveintel/testing.
  // In production use your actual embedding model (e.g. text-embedding-3-small).
  const embedding = weaveFakeEmbedding({ dimensions: 1536 });

  const semanticCache = weaveSemanticCache({
    defaultThreshold: 0.92, // cosine similarity threshold
    maxEntries: 200,
    embed: async (text: string): Promise<readonly number[]> => {
      const out = await embedding.embed(weaveContext({ userId: 'cache-demo' }), { input: [text] });
      return out.embeddings[0] ?? [];
    },
  });

  // Seed the cache with some question/answer pairs
  await semanticCache.store(
    'What is the capital of France?',
    { answer: 'The capital of France is Paris.', model: 'gpt-4o-mini', tokens: 42 },
    { category: 'geography', cachedBy: 'demo' },
  );
  await semanticCache.store(
    'How does photosynthesis work?',
    { answer: 'Photosynthesis is the process by which plants convert light to energy.', tokens: 87 },
  );
  await semanticCache.store(
    'What are the benefits of TypeScript?',
    { answer: 'TypeScript adds static typing, better tooling, and IDE support to JavaScript.', tokens: 64 },
  );

  // Simulate an incoming query — semantically similar to a cached entry
  const incomingQuery = 'Tell me about the capital city of France';
  const hit = await semanticCache.find(incomingQuery, 0.85); // lower threshold for demo

  if (hit) {
    console.log(`Cache HIT for: "${incomingQuery}"`);
    console.log(`  Matched: "${hit.query}"`);
    console.log(`  Similarity: ${hit.similarity.toFixed(4)}`);
    console.log(`  Cached at: ${hit.cachedAt}`);
    console.log(`  Response: ${JSON.stringify(hit.response)}`);
  } else {
    console.log(`Cache MISS for: "${incomingQuery}" (similarity below threshold)`);
    console.log('  → Would call LLM here, then store the response in cache');
    // In real code:
    // const response = await model.generate(incomingQuery);
    // await semanticCache.store(incomingQuery, response);
  }

  // Test a clearly different query (expect miss)
  const missQuery = 'What is the weather like today in Auckland?';
  const miss = await semanticCache.find(missQuery, 0.92);
  console.log(`\nCache ${miss ? 'HIT' : 'MISS'} for: "${missQuery}" (expected: MISS)`);

  // --- 5. Event-driven invalidation ---
  // evaluateInvalidationRules() checks whether an event should trigger cache clearing.
  // applySemanticInvalidation() removes entries similar to the invalidation subject.
  console.log('\n=== 5. Event-Driven Invalidation ===');

  const invalidationRules: CacheInvalidationRule[] = [
    {
      id: 'user-logout-rule',
      name: 'User Logout Rule',
      trigger: 'event',
      pattern: 'u123',
      enabled: true,
    },
    {
      id: 'model-update-rule',
      name: 'Model Update Rule',
      trigger: 'event',
      enabled: true,
    },
  ];

  const logoutEvent: InvalidationEvent = {
    type: 'user.logout',
    payload: { userId: 'u123', sessionId: 's456' },
    timestamp: Date.now(),
  };

  const triggered = evaluateInvalidationRules(invalidationRules, logoutEvent);
  console.log(`Event "${logoutEvent.type}" triggered ${triggered.length} invalidation rule(s):`);
  for (const rule of triggered) {
    console.log(`  Rule "${rule.id}": trigger=${rule.trigger} pattern="${rule.pattern ?? '(none)'}"`);
  }

  // applySemanticInvalidation() clears entries near a given subject
  // (useful after a document update — clears cached responses derived from that doc)
  await semanticCache.store(
    'France geography overview',
    { answer: 'France is a country in Western Europe.', tokens: 55 },
  );

  console.log('\nBefore invalidation — looking up "French geography":');
  const beforeInvalidate = await semanticCache.find('French geography', 0.75);
  console.log(`  Cache hit: ${beforeInvalidate ? 'YES' : 'NO'}`);

  await semanticCache.invalidate('France geography');

  console.log('After invalidate("France geography") — looking up "French geography":');
  const afterInvalidate = await semanticCache.find('French geography', 0.75);
  console.log(`  Cache hit: ${afterInvalidate ? 'YES' : 'NO (invalidated)'}`);

  // --- Summary ---
  console.log('\n=== Summary ===');
  console.log('weaveInMemoryCacheStore: key/value store with TTL, drop-in replaceable with Redis');
  console.log('weaveCacheKeyBuilder:    deterministic keys from structured parts (model, user, hash)');
  console.log('createCachePolicy:       TTL, scope, bypass patterns, event-based invalidation config');
  console.log('weaveSemanticCache:      cosine similarity lookup — serves equivalent questions from cache');
  console.log('evaluateInvalidationRules: event → rule matching for automated cache clearing');
  console.log('semanticCache.invalidate: removes entries similar to an updated subject embedding');
}

main().catch(console.error);
