/**
 * The replay cache: a delivery (by the vendor's event id, else its signature) is accepted once within the window.
 * A host with several processes supplies a shared store with the same contract (a unique row per key, for example).
 */

/** The cache contract. */
export interface ReplayCache {
  /**
   * Record a key for `ttlMs`.
   * @returns true when the key was ALREADY there (a replay); false when it is new and is now recorded.
   */
  seenBefore(key: string, ttlMs: number): Promise<boolean>
}

/** An in-memory cache for one process (and for tests). */
export function createMemoryReplayCache(now: () => number = () => Date.now()): ReplayCache {
  const until = new Map<string, number>()
  return {
    async seenBefore(key, ttlMs) {
      const t = now()
      if (until.size > 10_000) for (const [k, u] of until) if (u <= t) until.delete(k)
      const prior = until.get(key)
      if (prior !== undefined && prior > t) return true
      until.set(key, t + ttlMs)
      return false
    },
  }
}
