/**
 * @weaveintel/workflows — bulkhead.ts
 *
 * Phase W2 — Per-handler-kind bulkhead (concurrency limiter).
 *
 * The bulkhead limits the number of simultaneous in-flight handler calls
 * for a given resolver kind. When `maxConcurrency` is reached, additional
 * calls queue locally and execute as capacity frees. This prevents one
 * handler kind (e.g. a slow external API) from consuming all engine threads.
 *
 * `BulkheadRegistry` maps handler kind strings to Bulkhead instances.
 * The engine wraps resolver-based handlers with bulkhead protection at
 * run-start time, identical to how circuit breakers are applied.
 */

export interface BulkheadStats {
  maxConcurrency: number;
  inFlight: number;
  queued: number;
  name?: string;
}

export class Bulkhead {
  private inFlight = 0;
  private readonly queue: Array<() => void> = [];
  readonly name?: string;

  constructor(
    private readonly maxConcurrency: number,
    name?: string,
  ) {
    if (maxConcurrency < 1) throw new RangeError('Bulkhead maxConcurrency must be ≥ 1');
    this.name = name;
  }

  /**
   * Execute `fn` under bulkhead protection. Queues if `maxConcurrency` is
   * already reached. Returns the result of `fn` or re-throws its error.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  getStats(): BulkheadStats {
    return {
      maxConcurrency: this.maxConcurrency,
      inFlight: this.inFlight,
      queued: this.queue.length,
      name: this.name,
    };
  }

  private acquire(): Promise<void> {
    if (this.inFlight < this.maxConcurrency) {
      this.inFlight++;
      return Promise.resolve();
    }
    return new Promise<void>(resolve => {
      this.queue.push(() => { this.inFlight++; resolve(); });
    });
  }

  private release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const next = this.queue.shift();
    if (next) next();
  }
}

export class BulkheadRegistry {
  private readonly bulkheads = new Map<string, Bulkhead>();

  /** Register a bulkhead for a handler kind. Returns `this` for chaining. */
  register(handlerKind: string, maxConcurrency: number, name?: string): this {
    this.bulkheads.set(handlerKind, new Bulkhead(maxConcurrency, name ?? handlerKind));
    return this;
  }

  /** Look up by handler kind. Returns `undefined` if no bulkhead is configured. */
  get(handlerKind: string): Bulkhead | undefined {
    return this.bulkheads.get(handlerKind);
  }

  /** All registered bulkheads with their current stats. */
  list(): Array<{ kind: string; stats: BulkheadStats }> {
    return [...this.bulkheads.entries()].map(([kind, bh]) => ({ kind, stats: bh.getStats() }));
  }
}
