/**
 * Example 147 — Phase 7: Cache Slot + Durable Checkpointing + Multi-modal routing
 *
 * Demonstrates the three Phase 7 features:
 *
 *   1. **Cache slot** — a shared `RuntimeCacheSlot` injected via `weaveRuntime`.
 *      All subsystems (chat path, live-agents, tools) share one warm in-process
 *      cache instead of each holding a private `weaveInMemoryCacheStore()`.
 *
 *   2. **Durable checkpointing** — `LiveAgentCheckpointStore` tracks the last
 *      completed tick index for each live agent. When `config_json.checkpoint: true`
 *      is set on an `agentic.react` binding, state is saved after each tick and
 *      the resume point is logged at the start of the next one.
 *
 *   3. **Multi-modal routing** — `RuntimeRoutingSlot.supportsMultiModal()` signals
 *      that the model pool contains vision/audio-capable models. The `agentic.react`
 *      handler checks this per tick and logs a routing hint when the inbound payload
 *      carries image/audio markers.
 *
 * Run:
 *   npx tsx examples/147-cache-checkpoint-multimodal.ts
 */

import { weaveRuntime } from '@weaveintel/core';
import { weaveInMemoryCacheStore, createRuntimeCacheAdapter } from '@weaveintel/cache';
import {
  createInMemoryLiveAgentCheckpointStore,
  createDurableLiveAgentCheckpointStore,
} from '@weaveintel/live-agents-runtime';

// ── 1. Cache Slot ─────────────────────────────────────────────────────────────

const sharedStore = weaveInMemoryCacheStore();
const cacheAdapter = createRuntimeCacheAdapter(sharedStore);

const runtime = weaveRuntime({
  installDefaultTracer: false,
  cache: cacheAdapter,
});

console.log('Cache capability:', runtime.has(/* RuntimeCapabilities.Cache */ 'runtime.cache' as any));
// → true

// Chat path sets a cache entry:
await runtime.cache!.set('response:msg-abc', { text: 'Hello from LLM', tokens: 120 });

// Live-agent handler reads the same entry without its own import:
const cached = await runtime.cache!.get('response:msg-abc');
console.log('Cached response via shared slot:', cached);
// → { text: 'Hello from LLM', tokens: 120 }

// Raw CacheStore is accessible when full API is needed:
const storeSize = sharedStore.size();
console.log('Store size:', storeSize);
// → 1

await runtime.cache!.invalidate('response:msg-abc');
console.log('After invalidation:', await runtime.cache!.get('response:msg-abc'));
// → undefined

// ── 2. Durable Checkpointing ──────────────────────────────────────────────────

// In-memory store (tests / edge deployments without KV):
const inMemoryCheckpoints = createInMemoryLiveAgentCheckpointStore();

await inMemoryCheckpoints.save('agent-kaggle-strategist', 0, { lastInbound: 'comp-123' });
const cp1 = await inMemoryCheckpoints.load('agent-kaggle-strategist');
console.log('Checkpoint after tick 0:', cp1);
// → { stepIndex: 0, state: { lastInbound: 'comp-123' }, savedAt: <epoch> }

await inMemoryCheckpoints.save('agent-kaggle-strategist', 1, { lastInbound: 'comp-456' });
const cp2 = await inMemoryCheckpoints.load('agent-kaggle-strategist');
console.log('Checkpoint after tick 1:', cp2);
// → { stepIndex: 1, state: { lastInbound: 'comp-456' }, savedAt: <epoch> }

await inMemoryCheckpoints.clear('agent-kaggle-strategist');
console.log('After clear:', await inMemoryCheckpoints.load('agent-kaggle-strategist'));
// → null

// Durable store (backed by RuntimeKvStore — in-process KV shim for demo):
const kvShim = (() => {
  const map = new Map<string, string>();
  return {
    async get(key: string) { return map.get(key); },
    async set(key: string, value: string) { map.set(key, value); },
    async delete(key: string) { return map.delete(key); },
    async list(prefix: string) {
      return [...map.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, v]) => ({ key: k, value: v }));
    },
  };
})();

const durableCheckpoints = createDurableLiveAgentCheckpointStore(kvShim);
await durableCheckpoints.save('agent-inbox-triage', 5, { processedIds: ['m1', 'm2'] });
const dcp = await durableCheckpoints.load('agent-inbox-triage');
console.log('Durable checkpoint:', dcp);
// → { stepIndex: 5, state: { processedIds: ['m1', 'm2'] }, savedAt: <epoch> }

// ── 3. Multi-modal Routing ────────────────────────────────────────────────────

// When createRuntimeRoutingAdapter is called with { multiModal: true }, the
// routing slot signals that the model pool includes vision-capable models.
//
// In the live-agents supervisor, this is wired via:
//   createRuntimeRoutingAdapter(sharedHealthTracker, { multiModal: true })
//
// The agentic.react handler checks this per tick:
//
//   if (execCtx.runtime?.routing?.supportsMultiModal?.()) {
//     if (hasMultiModalMarkers(action.bodySeed ?? '')) {
//       log('[agentic.react] multi-modal content detected; routing slot supports it');
//     }
//   }
//
// A minimal routing slot stub for demonstration:
const multiModalRoutingSlot = {
  recordOutcome(_modelId: string, _providerId: string, _latencyMs: number, _success: boolean) {},
  blockProvider(_providerId: string, _durationMs: number) {},
  listHealth() { return []; },
  getBlockedProviders() { return new Set<string>(); },
  supportsMultiModal() { return true; },
};

const runtimeWithMultiModal = weaveRuntime({
  installDefaultTracer: false,
  routing: multiModalRoutingSlot,
});

console.log('Multi-modal supported:', runtimeWithMultiModal.routing?.supportsMultiModal?.());
// → true

// Inline detection helper (mirrors what agentic-react.ts does internally):
function hasMultiModalMarkers(text: string): boolean {
  return (
    text.includes('data:image/') ||
    text.includes('data:audio/') ||
    text.includes('[IMAGE]') ||
    text.includes('[AUDIO]')
  );
}

const inboundBody = 'Please analyse this chart: [IMAGE] data:image/png;base64,iVBOR...';
if (runtimeWithMultiModal.routing?.supportsMultiModal?.() && hasMultiModalMarkers(inboundBody)) {
  console.log('→ multi-modal content detected; routing slot supports it');
  // In production: the agentic.react handler logs this and the model resolver
  // can choose a vision-capable model based on the capability hint.
}

console.log('\nPhase 7 example complete.');
