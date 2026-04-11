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
