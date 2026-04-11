export interface ConcurrencyPolicy {
  readonly maxConcurrent: number;
  readonly maxQueued?: number;
  readonly strategy?: 'queue' | 'reject';
}

export interface ConcurrencyStatus {
  readonly active: number;
  readonly queued: number;
  readonly available: number;
}

export interface ConcurrencyLimiter {
  acquire(): Promise<void>;
  release(): void;
  getStatus(): ConcurrencyStatus;
  execute<T>(fn: () => Promise<T>): Promise<T>;
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

export function createConcurrencyLimiter(policy: ConcurrencyPolicy): ConcurrencyLimiter {
  let active = 0;
  const queue: Waiter[] = [];
  const strategy = policy.strategy ?? 'queue';

  return {
    acquire(): Promise<void> {
      if (active < policy.maxConcurrent) {
        active++;
        return Promise.resolve();
      }

      if (strategy === 'reject') {
        return Promise.reject(new Error('Concurrency limit reached'));
      }

      if (policy.maxQueued !== undefined && queue.length >= policy.maxQueued) {
        return Promise.reject(new Error('Queue limit reached'));
      }

      return new Promise<void>((resolve, reject) => {
        queue.push({ resolve, reject });
      });
    },

    release(): void {
      if (queue.length > 0) {
        const next = queue.shift();
        if (next !== undefined) {
          next.resolve();
        }
      } else if (active > 0) {
        active--;
      }
    },

    getStatus(): ConcurrencyStatus {
      return {
        active,
        queued: queue.length,
        available: Math.max(0, policy.maxConcurrent - active),
      };
    },

    async execute<T>(fn: () => Promise<T>): Promise<T> {
      await this.acquire();
      try {
        return await fn();
      } finally {
        this.release();
      }
    },
  };
}
