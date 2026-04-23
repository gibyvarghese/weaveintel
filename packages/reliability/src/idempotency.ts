export interface IdempotencyPolicy {
  readonly ttlMs: number;
  readonly maxEntries?: number;
}

export interface IdempotencyCheckResult {
  readonly isDuplicate: boolean;
  readonly previousResult?: unknown;
}

interface StoredEntry {
  readonly result: unknown;
  readonly expiresAt: number;
}

export interface IdempotencyStore {
  check(key: string): IdempotencyCheckResult;
  record(key: string, result: unknown): void;
  clear(): void;
  getPolicy(): IdempotencyPolicy;
}

export interface AsyncIdempotencyStore {
  check(key: string): Promise<IdempotencyCheckResult>;
  record(key: string, result: unknown): Promise<void>;
  clear(): Promise<void>;
  getPolicy(): IdempotencyPolicy;
}

export interface DurableIdempotencyEntry {
  readonly result: unknown;
  readonly expiresAt: number;
}

export interface DurableIdempotencyRepository {
  get(key: string): Promise<DurableIdempotencyEntry | null>;
  set(key: string, entry: DurableIdempotencyEntry): Promise<void>;
  deleteExpired(nowMs: number): Promise<void>;
  trimOldest(maxEntries: number): Promise<void>;
  clear(): Promise<void>;
}

export function createIdempotencyStore(policy: IdempotencyPolicy): IdempotencyStore {
  const entries = new Map<string, StoredEntry>();

  function evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) {
        entries.delete(key);
      }
    }
  }

  function enforceMaxEntries(): void {
    if (policy.maxEntries !== undefined && entries.size > policy.maxEntries) {
      const keysToRemove = entries.size - policy.maxEntries;
      const iterator = entries.keys();
      for (let i = 0; i < keysToRemove; i++) {
        const next = iterator.next();
        if (!next.done) {
          entries.delete(next.value);
        }
      }
    }
  }

  return {
    check(key: string): IdempotencyCheckResult {
      evictExpired();
      const entry = entries.get(key);
      if (entry === undefined) {
        return { isDuplicate: false };
      }
      return { isDuplicate: true, previousResult: entry.result };
    },

    record(key: string, result: unknown): void {
      evictExpired();
      entries.set(key, {
        result,
        expiresAt: Date.now() + policy.ttlMs,
      });
      enforceMaxEntries();
    },

    clear(): void {
      entries.clear();
    },

    getPolicy(): IdempotencyPolicy {
      return policy;
    },
  };
}

export function createDurableIdempotencyStore(
  policy: IdempotencyPolicy,
  repository: DurableIdempotencyRepository,
): AsyncIdempotencyStore {
  return {
    async check(key: string): Promise<IdempotencyCheckResult> {
      await repository.deleteExpired(Date.now());
      const entry = await repository.get(key);
      if (entry === null) {
        return { isDuplicate: false };
      }
      return { isDuplicate: true, previousResult: entry.result };
    },

    async record(key: string, result: unknown): Promise<void> {
      const nowMs = Date.now();
      await repository.deleteExpired(nowMs);
      await repository.set(key, {
        result,
        expiresAt: nowMs + policy.ttlMs,
      });
      if (policy.maxEntries !== undefined) {
        await repository.trimOldest(policy.maxEntries);
      }
    },

    async clear(): Promise<void> {
      await repository.clear();
    },

    getPolicy(): IdempotencyPolicy {
      return policy;
    },
  };
}
