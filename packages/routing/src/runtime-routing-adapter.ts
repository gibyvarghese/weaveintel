/**
 * @weaveintel/routing — RuntimeRoutingSlot adapter
 *
 * Bridges a `ModelHealthTracker` to the `RuntimeRoutingSlot` interface
 * defined in `@weaveintel/core`, allowing the runtime DI container to carry
 * a shared health-tracking instance that both the chat path and the live-agent
 * supervisor consume without importing the concrete tracker class.
 *
 * Usage (in geneWeave boot):
 *   const tracker = new ModelHealthTracker();
 *   const routingAdapter = createRuntimeRoutingAdapter(tracker);
 *   const runtime = weaveRuntime({ ..., routing: routingAdapter });
 */

import type { RuntimeRoutingSlot } from '@weaveintel/core';
import { ModelHealthTracker } from './health.js';

/**
 * Create a `RuntimeRoutingSlot` backed by the supplied `ModelHealthTracker`.
 * The tracker is the single source of truth for model-health state; this
 * adapter is a thin pass-through that maps the slot API to tracker methods.
 */
export function createRuntimeRoutingAdapter(tracker: ModelHealthTracker): RuntimeRoutingSlot {
  return {
    recordOutcome(modelId, providerId, latencyMs, success) {
      tracker.record(modelId, providerId, { latencyMs, success });
    },
    blockProvider(providerId, durationMs) {
      tracker.blockProvider(providerId, durationMs);
    },
    listHealth() {
      return tracker.listHealth();
    },
    getBlockedProviders() {
      return tracker.getBlockedProviders();
    },
  };
}
