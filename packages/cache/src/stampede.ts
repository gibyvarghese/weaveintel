/**
 * @weaveintel/cache — Stampede protection: SWR, XFetch, negative caching.
 *
 * Three composable pieces (G‑5 / G‑8):
 *   - `shouldServeStale` / `shouldEarlyRefresh` — pure decision helpers an app
 *     can layer over its own (shape-preserving) storage to get stale-while-
 *     revalidate + XFetch probabilistic early refresh without an envelope.
 *   - `createStampedeCache(store, …)` — a turnkey, reusable read-through cache
 *     that composes singleflight + SWR + XFetch + negative caching behind one
 *     `getOrCompute(key, compute, …)` call, storing its own metadata envelope.
 *
 * SWR (stale-while-revalidate): once an entry is older than `ttlMs` but still
 * within `ttlMs + swrMs`, serve the stale value immediately and refresh in the
 * background — callers never wait on a refresh. XFetch (Vattani et al.): refresh
 * *before* expiry with a probability that rises as expiry nears, scaled by how
 * expensive the value was to compute, smoothing the refresh spike. Negative
 * caching: remember a miss/error for a short TTL to shield the backend from a
 * retry storm, without poisoning the positive cache beyond that short TTL.
 */
import type { CacheStore } from '@weaveintel/core';
import { createSingleflight, type Singleflight } from './singleflight.js';

/** Freshness of an entry given its age. */
export type StaleState = 'fresh' | 'stale' | 'expired';

/**
 * Classify an entry by age:
 *   - `fresh`   age < ttlMs
 *   - `stale`   ttlMs ≤ age < ttlMs + swrMs   (serve + revalidate)
 *   - `expired` age ≥ ttlMs + swrMs           (treat as a miss)
 */
export function shouldServeStale(opts: { ageMs: number; ttlMs: number; swrMs?: number }): StaleState {
  const swr = opts.swrMs && opts.swrMs > 0 ? opts.swrMs : 0;
  if (opts.ageMs < opts.ttlMs) return 'fresh';
  if (opts.ageMs < opts.ttlMs + swr) return 'stale';
  return 'expired';
}

/**
 * XFetch probabilistic early refresh. Returns true when a still-fresh entry
 * should be refreshed early to avoid a synchronized expiry stampede. `beta` ≤ 0
 * disables it; higher `beta` refreshes more eagerly. `computeMs` is how long the
 * value took to produce (expensive entries refresh sooner).
 */
export function shouldEarlyRefresh(opts: {
  ageMs: number;
  ttlMs: number;
  computeMs: number;
  beta?: number;
  rand?: () => number;
}): boolean {
  const beta = opts.beta ?? 0;
  if (beta <= 0 || opts.computeMs <= 0) return false;
  const rand = opts.rand ?? Math.random;
  const r = Math.min(1, Math.max(1e-9, rand()));
  // Refresh when ageMs - computeMs*beta*ln(rand) ≥ ttlMs. ln(rand) ≤ 0, so the
  // gap (-computeMs*beta*ln(rand)) grows the window as we approach expiry.
  const gap = -opts.computeMs * beta * Math.log(r);
  return opts.ageMs + gap >= opts.ttlMs;
}

// ─── Turnkey read-through stampede cache (reusable primitive) ────────────────

interface StampedeEnvelope<T> {
  /** Envelope tag so a stampede entry is distinguishable from a raw value. */
  t: 'sf';
  v?: T;
  ts: number;     // stored-at (ms)
  ttl: number;    // soft TTL (ms)
  ct: number;     // compute duration (ms)
  neg?: boolean;  // negative entry (a remembered miss/error)
  err?: string;
}

export interface StampedeCacheOptions {
  singleflight?: Singleflight;
  now?: () => number;
  rand?: () => number;
  /** Default XFetch aggressiveness for `getOrCompute` calls. Default 1. */
  beta?: number;
}

export interface GetOrComputeOptions {
  ttlMs: number;
  swrMs?: number;
  negativeTtlMs?: number;
  beta?: number;
  /** Classify a successfully-computed value as a negative result (e.g. empty). */
  isNegative?: (value: unknown) => boolean;
}

export interface StampedeResult<T> {
  value: T | undefined;
  /** True when served from cache (fresh or stale). */
  hit: boolean;
  stale: boolean;
  /** True when this is a remembered miss/error (positive value absent). */
  negative: boolean;
  /** True when the compute was coalesced onto an in-flight leader. */
  coalesced: boolean;
  error?: unknown;
}

export interface StampedeCache {
  getOrCompute<T>(key: string, compute: () => Promise<T>, opts: GetOrComputeOptions): Promise<StampedeResult<T>>;
  singleflight: Singleflight;
}

function isEnvelope(v: unknown): v is StampedeEnvelope<unknown> {
  return !!v && typeof v === 'object' && (v as { t?: unknown }).t === 'sf';
}

export function createStampedeCache(store: CacheStore, opts: StampedeCacheOptions = {}): StampedeCache {
  const sf = opts.singleflight ?? createSingleflight();
  const now = opts.now ?? Date.now;
  const rand = opts.rand ?? Math.random;
  const defaultBeta = opts.beta ?? 1;

  async function storePositive<T>(key: string, value: T, ttlMs: number, swrMs: number, computeMs: number): Promise<void> {
    const env: StampedeEnvelope<T> = { t: 'sf', v: value, ts: now(), ttl: ttlMs, ct: Math.max(0, computeMs) };
    // Keep the entry alive through the SWR window so a stale read can serve it.
    await store.set(key, env, ttlMs + Math.max(0, swrMs)).catch(() => { /* best-effort */ });
  }
  async function storeNegative(key: string, negativeTtlMs: number, err?: unknown): Promise<void> {
    const env: StampedeEnvelope<never> = { t: 'sf', neg: true, ts: now(), ttl: negativeTtlMs, ct: 0, err: err ? String(err) : undefined };
    await store.set(key, env, negativeTtlMs).catch(() => { /* best-effort */ });
  }

  function backgroundRefresh<T>(key: string, compute: () => Promise<T>, o: GetOrComputeOptions): void {
    // Coalesced via singleflight so concurrent refreshes collapse to one.
    void sf.run(key + '::refresh', async () => {
      const started = now();
      try {
        const value = await compute();
        if (o.isNegative?.(value) && (o.negativeTtlMs ?? 0) > 0) await storeNegative(key, o.negativeTtlMs!, 'negative');
        else await storePositive(key, value, o.ttlMs, o.swrMs ?? 0, now() - started);
      } catch (err) {
        if ((o.negativeTtlMs ?? 0) > 0) await storeNegative(key, o.negativeTtlMs!, err);
        // else leave the stale entry in place until it hard-expires
      }
      return null;
    }).catch(() => { /* background — never throws to caller */ });
  }

  return {
    singleflight: sf,
    async getOrCompute<T>(key: string, compute: () => Promise<T>, o: GetOrComputeOptions): Promise<StampedeResult<T>> {
      const raw = await store.get(key).catch(() => null);
      if (raw != null && isEnvelope(raw)) {
        const env = raw as StampedeEnvelope<T>;
        const age = now() - env.ts;
        if (env.neg) {
          if (age < env.ttl) return { value: undefined, hit: true, stale: false, negative: true, coalesced: false, error: env.err };
          // expired negative → fall through to recompute
        } else {
          const state = shouldServeStale({ ageMs: age, ttlMs: env.ttl, swrMs: o.swrMs });
          if (state === 'fresh') {
            if (shouldEarlyRefresh({ ageMs: age, ttlMs: env.ttl, computeMs: env.ct, beta: o.beta ?? defaultBeta, rand })) {
              backgroundRefresh(key, compute, o);
            }
            return { value: env.v, hit: true, stale: false, negative: false, coalesced: false };
          }
          if (state === 'stale') {
            backgroundRefresh(key, compute, o);
            return { value: env.v, hit: true, stale: true, negative: false, coalesced: false };
          }
          // expired → recompute
        }
      } else if (raw != null) {
        // A raw (non-envelope) value written by another path — serve as a hit.
        return { value: raw as T, hit: true, stale: false, negative: false, coalesced: false };
      }

      // Miss → single-flighted compute.
      try {
        const started = now();
        const { value, coalesced } = await sf.run(key, async () => {
          const v = await compute();
          if (o.isNegative?.(v) && (o.negativeTtlMs ?? 0) > 0) await storeNegative(key, o.negativeTtlMs!, 'negative');
          else await storePositive(key, v, o.ttlMs, o.swrMs ?? 0, now() - started);
          return v;
        });
        const negative = !!o.isNegative?.(value);
        return { value, hit: false, stale: false, negative, coalesced };
      } catch (err) {
        if ((o.negativeTtlMs ?? 0) > 0) {
          await storeNegative(key, o.negativeTtlMs!, err);
          return { value: undefined, hit: false, stale: false, negative: true, coalesced: false, error: err };
        }
        throw err;
      }
    },
  };
}
