/**
 * @weaveintel/resilience — Signal bus
 *
 * Tiny typed event emitter for `ResilienceSignal`. No external deps; not a
 * full pub/sub broker. In-process composition only.
 */

import type { ResilienceSignal, SignalKind } from './types.js';

export type SignalListener = (signal: ResilienceSignal) => void;

export interface ResilienceSignalBus {
  emit(signal: ResilienceSignal): void;
  on(listener: SignalListener): () => void;
  onKind<K extends SignalKind>(
    kind: K,
    listener: (signal: Extract<ResilienceSignal, { kind: K }>) => void,
  ): () => void;
  /** Remove every listener — primarily for tests. */
  clear(): void;
}

export function createResilienceSignalBus(): ResilienceSignalBus {
  const all = new Set<SignalListener>();
  const byKind = new Map<SignalKind, Set<SignalListener>>();

  return {
    emit(signal) {
      // listeners must not throw out — isolate each one
      for (const l of all) {
        try {
          l(signal);
        } catch {
          // ignore listener failure
        }
      }
      const k = byKind.get(signal.kind);
      if (k) {
        for (const l of k) {
          try {
            l(signal);
          } catch {
            // ignore listener failure
          }
        }
      }
    },
    on(listener) {
      all.add(listener);
      return () => {
        all.delete(listener);
      };
    },
    onKind(kind, listener) {
      let bucket = byKind.get(kind);
      if (!bucket) {
        bucket = new Set();
        byKind.set(kind, bucket);
      }
      const wrapped: SignalListener = (s) => {
        if (s.kind === kind) listener(s as Extract<ResilienceSignal, { kind: typeof kind }>);
      };
      bucket.add(wrapped);
      return () => {
        bucket?.delete(wrapped);
      };
    },
    clear() {
      all.clear();
      byKind.clear();
    },
  };
}

let defaultBus: ResilienceSignalBus | null = null;

/** Process-wide signal bus. Pipelines emit here when no explicit `bus` is set. */
export function getDefaultSignalBus(): ResilienceSignalBus {
  if (!defaultBus) defaultBus = createResilienceSignalBus();
  return defaultBus;
}

/** Replace the process-wide bus. Primarily for tests / app boot wiring. */
export function setDefaultSignalBus(bus: ResilienceSignalBus): void {
  defaultBus = bus;
}
