/**
 * @weaveintel/cache — Singleflight / request coalescing.
 *
 * When N concurrent callers ask for the SAME key, only the first ("leader")
 * actually computes; the rest ("followers") await the leader's result. This
 * collapses a thundering herd of identical cache-miss requests into a single
 * backend (LLM / tool / HTTP) call — the classic cache-stampede fix.
 *
 * Two APIs:
 *   - `run(key, fn)` — convenience: runs `fn` once per in-flight key, returns
 *     `{ value, coalesced }` (coalesced=true for followers). Best for a
 *     synchronous compute that returns a value (e.g. the non-streaming chat path).
 *   - `beginOrJoin(key)` — low-level leader/follower handshake for cases where
 *     the leader streams to its own sink and only has the final value at the end
 *     (e.g. the streaming chat path): the leader calls `resolve(value)` / `reject(err)`
 *     when done; followers `await join`.
 *
 * Storage-agnostic and process-local (coordinates in-flight promises in one
 * process — for cross-instance coalescing put a distributed lock behind it).
 */

export interface SingleflightStats {
  /** Distinct computations actually started (leaders). */
  flights: number;
  /** Followers that reused an in-flight leader's result instead of computing. */
  coalesced: number;
  /** Keys currently in flight. */
  inFlight: number;
}

export interface LeaderHandle<T> {
  leader: true;
  /** Resolve the in-flight promise so followers receive `value`. Idempotent. */
  resolve(value: T): void;
  /** Reject the in-flight promise so followers fall through to compute. Idempotent. */
  reject(err: unknown): void;
}
export interface FollowerHandle<T> {
  leader: false;
  /** Await the leader's value. Rejects if the leader rejects. */
  join: Promise<T>;
}
export type FlightHandle<T> = LeaderHandle<T> | FollowerHandle<T>;

export interface Singleflight {
  /** Run `fn` once per in-flight key; followers await the same result. */
  run<T>(key: string, fn: () => Promise<T>): Promise<{ value: T; coalesced: boolean }>;
  /** Leader/follower handshake for externally-resolved computations (streaming). */
  beginOrJoin<T>(key: string): FlightHandle<T>;
  /** Number of keys currently in flight. */
  inFlight(): number;
  /** Cumulative counters (since creation or last reset). */
  stats(): SingleflightStats;
  reset(): void;
}

interface Pending {
  promise: Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  settled: boolean;
}

export function createSingleflight(): Singleflight {
  const pending = new Map<string, Pending>();
  let flights = 0;
  let coalesced = 0;

  function newPending(): Pending {
    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => { resolve = res; reject = rej; });
    // Swallow unhandled-rejection noise; every consumer attaches its own handler.
    promise.catch(() => { /* handled by joiners */ });
    return { promise, resolve, reject, settled: false };
  }

  return {
    async run<T>(key: string, fn: () => Promise<T>): Promise<{ value: T; coalesced: boolean }> {
      const existing = pending.get(key);
      if (existing) {
        coalesced++;
        const value = (await existing.promise) as T;
        return { value, coalesced: true };
      }
      const p = newPending();
      pending.set(key, p);
      flights++;
      try {
        const value = await fn();
        p.settled = true;
        p.resolve(value);
        return { value, coalesced: false };
      } catch (err) {
        p.settled = true;
        p.reject(err);
        throw err;
      } finally {
        pending.delete(key);
      }
    },

    beginOrJoin<T>(key: string): FlightHandle<T> {
      const existing = pending.get(key);
      if (existing) {
        coalesced++;
        return { leader: false, join: existing.promise as Promise<T> };
      }
      const p = newPending();
      pending.set(key, p);
      flights++;
      const finish = () => { if (pending.get(key) === p) pending.delete(key); };
      return {
        leader: true,
        resolve(value: T) {
          if (p.settled) return;
          p.settled = true;
          p.resolve(value);
          finish();
        },
        reject(err: unknown) {
          if (p.settled) return;
          p.settled = true;
          p.reject(err);
          finish();
        },
      };
    },

    inFlight() { return pending.size; },
    stats() { return { flights, coalesced, inFlight: pending.size }; },
    reset() { flights = 0; coalesced = 0; },
  };
}
