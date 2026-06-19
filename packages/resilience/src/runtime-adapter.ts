/**
 * @weaveintel/resilience — RuntimeResilienceSlot adapter (Phase 0)
 *
 * Bridges a `ResilienceSignalBus` + the process-wide endpoint registry +
 * the global latency tracker onto the `RuntimeResilienceSlot` structural
 * interface from `@weaveintel/core`, so the runtime can carry live circuit-
 * breaker state and latency percentiles without taking a direct dep on
 * `@weaveintel/resilience` in core.
 *
 * Usage in app boot:
 *
 *   import { createResilienceSignalBus, setDefaultSignalBus,
 *            createRuntimeResilienceAdapter } from '@weaveintel/resilience';
 *
 *   const signalBus = createResilienceSignalBus();
 *   setDefaultSignalBus(signalBus);          // pipelines emit here
 *   const resilienceAdapter = createRuntimeResilienceAdapter(signalBus);
 *   const runtime = weaveRuntime({ ..., resilience: resilienceAdapter });
 *
 *   // Pass the same bus to the DB observer:
 *   applyDbResilienceObserver(db, signalBus);
 */

import type { RuntimeResilienceSlot } from '@weaveintel/core';
import type { ResilienceSignalBus } from './signal-bus.js';
import { getEndpointState } from './endpoint-registry.js';
import { getLatencySnapshot } from './latency-tracker.js';

/** Extended slot that also exposes bus subscription methods, so consumers
 *  (e.g. the DB resilience observer) can subscribe without reaching for the
 *  process-global `getDefaultSignalBus()`. */
export interface RuntimeResilienceAdapter extends RuntimeResilienceSlot {
  on: ResilienceSignalBus['on'];
  onKind: ResilienceSignalBus['onKind'];
  clear: ResilienceSignalBus['clear'];
}

/**
 * Wrap a `ResilienceSignalBus` as a `RuntimeResilienceSlot`. The adapter:
 *
 * - Delegates `emit()` to the bus (widened to accept the structural slot
 *   event shape — the bus ignores unknown `kind` values gracefully).
 * - Implements `getState(endpoint)` via the process-wide endpoint registry.
 * - Implements `getLatencyP50/P95(endpoint)` via the global latency tracker.
 * - Exposes `on` / `onKind` / `clear` so subscribers can attach without
 *   holding a direct bus reference.
 */
export function createRuntimeResilienceAdapter(bus: ResilienceSignalBus): RuntimeResilienceAdapter {
  return {
    emit(event) {
      // The bus expects a full ResilienceSignal; the slot uses a structural
      // subset. Cast is safe — the bus ignores extra/missing fields gracefully.
      bus.emit(event as Parameters<ResilienceSignalBus['emit']>[0]);
    },

    getState(endpoint: string): 'closed' | 'open' | 'half_open' | 'unknown' {
      const state = getEndpointState(endpoint)?.circuit?.state();
      if (!state) return 'unknown';
      return state;
    },

    getLatencyP50(endpoint: string): number | null {
      return getLatencySnapshot(endpoint)?.p50 ?? null;
    },

    getLatencyP95(endpoint: string): number | null {
      return getLatencySnapshot(endpoint)?.p95 ?? null;
    },

    on: bus.on.bind(bus),
    onKind: bus.onKind.bind(bus),
    clear: bus.clear.bind(bus),
  };
}
