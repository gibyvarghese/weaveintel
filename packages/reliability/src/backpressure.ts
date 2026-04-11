export type BackpressureSignal = 'ok' | 'warning' | 'critical' | 'overloaded';

export interface BackpressureOptions {
  readonly maxQueueDepth: number;
  readonly warningThreshold?: number;
  readonly criticalThreshold?: number;
}

export interface BackpressureMonitor {
  record(queueDepth: number): void;
  signal(): BackpressureSignal;
  shouldAccept(): boolean;
  reset(): void;
}

export function createBackpressureMonitor(opts: BackpressureOptions): BackpressureMonitor {
  const warningThreshold = opts.warningThreshold ?? 0.7;
  const criticalThreshold = opts.criticalThreshold ?? 0.9;
  let currentDepth = 0;

  return {
    record(queueDepth: number): void {
      currentDepth = queueDepth;
    },

    signal(): BackpressureSignal {
      if (currentDepth >= opts.maxQueueDepth) {
        return 'overloaded';
      }
      const ratio = currentDepth / opts.maxQueueDepth;
      if (ratio >= criticalThreshold) {
        return 'critical';
      }
      if (ratio >= warningThreshold) {
        return 'warning';
      }
      return 'ok';
    },

    shouldAccept(): boolean {
      return currentDepth < opts.maxQueueDepth;
    },

    reset(): void {
      currentDepth = 0;
    },
  };
}
