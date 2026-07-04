/**
 * @weaveintel/routing — RuntimeRoutingSlot adapter
 *
 * Bridges a `ModelHealthTracker` to the `RuntimeRoutingSlot` interface
 * defined in `@weaveintel/core`, allowing the runtime DI container to carry
 * a shared health-tracking instance that both the chat path and the live-agent
 * supervisor consume without importing the concrete tracker class.
 *
 * Usage (in host application boot):
 *   const tracker = new ModelHealthTracker();
 *   const routingAdapter = createRuntimeRoutingAdapter(tracker);
 *   const runtime = weaveRuntime({ ..., routing: routingAdapter });
 */

import type { RuntimeRoutingSlot } from '@weaveintel/core';
import { ModelHealthTracker } from './health.js';

export interface RuntimeRoutingAdapterOptions {
  /**
   * Phase 7 — whether the routing layer can route inbound messages to
   * multi-modal (vision / audio / file) capable models. Set to `true`
   * when the model pool contains at least one vision-capable model (e.g.
   * GPT-4o, Claude 3 Opus). Handlers check this before logging or
   * adjusting routing hints for image/audio payloads.
   */
  multiModal?: boolean;
}

/**
 * Create a `RuntimeRoutingSlot` backed by the supplied `ModelHealthTracker`.
 * The tracker is the single source of truth for model-health state; this
 * adapter is a thin pass-through that maps the slot API to tracker methods.
 */
export function createRuntimeRoutingAdapter(
  tracker: ModelHealthTracker,
  opts: RuntimeRoutingAdapterOptions = {},
): RuntimeRoutingSlot {
  const multiModal = opts.multiModal ?? false;
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
    supportsMultiModal() {
      return multiModal;
    },
  };
}
