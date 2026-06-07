/**
 * @weaveintel/routing — Model health tracker
 *
 * Records request outcomes (latency, errors) and maintains
 * real-time health metrics for each model+provider pair.
 */

import type { ModelHealth } from '@weaveintel/core';

// ─── Health entry (internal) ─────────────────────────────────

interface HealthEntry {
  modelId: string;
  providerId: string;
  available: boolean;
  samples: Array<{ latencyMs: number; success: boolean; ts: number }>;
  lastChecked: string;
}

// ─── Health tracker ──────────────────────────────────────────

export class ModelHealthTracker {
  private entries = new Map<string, HealthEntry>();
  private windowSize: number;
  private recentWindowMs: number;
  /** Provider-level blocks — any model from a blocked provider is unavailable. */
  private blockedProviders = new Map<string, number>(); // providerId → unblock-at timestamp

  constructor(opts?: { windowSize?: number; recentWindowMs?: number }) {
    this.windowSize = opts?.windowSize ?? 100;
    this.recentWindowMs = opts?.recentWindowMs ?? 10 * 60 * 1000;
  }

  private key(modelId: string, providerId: string): string {
    return `${providerId}:${modelId}`;
  }

  private getOrCreate(modelId: string, providerId: string): HealthEntry {
    const k = this.key(modelId, providerId);
    let e = this.entries.get(k);
    if (!e) {
      e = { modelId, providerId, available: true, samples: [], lastChecked: new Date().toISOString() };
      this.entries.set(k, e);
    }
    return e;
  }

  /** Seed tracker from a persisted health snapshot. */
  applySnapshot(health: ModelHealth): void {
    const e = this.getOrCreate(health.modelId, health.providerId);
    const now = Date.now();
    const estSamples = Math.max(1, Math.min(this.windowSize, health.requestsPerMinute ?? 10));
    const estErrors = Math.round(estSamples * health.errorRate);
    const estSuccesses = Math.max(0, estSamples - estErrors);

    const synthesized: Array<{ latencyMs: number; success: boolean; ts: number }> = [];
    for (let i = 0; i < estSuccesses; i++) {
      synthesized.push({ latencyMs: Math.max(1, health.avgLatencyMs), success: true, ts: now - (i * 1000) });
    }
    for (let i = 0; i < estErrors; i++) {
      synthesized.push({ latencyMs: Math.max(1, health.avgLatencyMs), success: false, ts: now - ((estSuccesses + i) * 1000) });
    }

    e.samples = synthesized.slice(0, this.windowSize);
    e.available = health.available;
    e.lastChecked = health.lastChecked || new Date(now).toISOString();
  }

  /** Record one request outcome. */
  record(modelId: string, providerId: string, outcome: { latencyMs: number; success: boolean }): void {
    const e = this.getOrCreate(modelId, providerId);
    e.samples.push({ latencyMs: outcome.latencyMs, success: outcome.success, ts: Date.now() });
    if (e.samples.length > this.windowSize) e.samples.shift();
    this.trimOldSamples(e);
    e.available = this.computeAvailable(e);
    e.lastChecked = new Date().toISOString();
  }

  /** Mark a model explicitly available / unavailable. */
  setAvailable(modelId: string, providerId: string, available: boolean): void {
    const e = this.getOrCreate(modelId, providerId);
    e.available = available;
    e.lastChecked = new Date().toISOString();
  }

  /**
   * Block an entire provider for a window (default 5 minutes).
   * Every model from this provider will be treated as unavailable regardless
   * of individual health entries. Used for account-level errors like rate limits.
   */
  blockProvider(providerId: string, durationMs = 5 * 60_000): void {
    this.blockedProviders.set(providerId, Date.now() + durationMs);
    // Also mark all currently-tracked models for this provider unavailable.
    for (const e of this.entries.values()) {
      if (e.providerId === providerId) e.available = false;
    }
  }

  /** Check whether a specific model is available (respects provider-level blocks). */
  isAvailable(modelId: string, providerId: string): boolean {
    const blockUntil = this.blockedProviders.get(providerId);
    if (blockUntil) {
      if (blockUntil > Date.now()) return false;
      this.blockedProviders.delete(providerId); // expired — clean up
    }
    const h = this.getHealth(modelId, providerId);
    return h ? h.available : true;
  }

  /** Get health snapshot for one model. */
  getHealth(modelId: string, providerId: string): ModelHealth | null {
    const e = this.entries.get(this.key(modelId, providerId));
    if (!e) return null;
    return this.toModelHealth(e);
  }

  /** Get health for all tracked models. Provider blocks are reflected in available=false. */
  listHealth(): ModelHealth[] {
    return [...this.entries.values()].map(e => this.toModelHealth(e));
  }

  /** Returns the set of currently active (not yet expired) provider-level blocks. */
  getBlockedProviders(): Set<string> {
    const now = Date.now();
    const active = new Set<string>();
    for (const [providerId, until] of this.blockedProviders) {
      if (until > now) active.add(providerId);
      else this.blockedProviders.delete(providerId);
    }
    return active;
  }

  // ── Internals ───────────────────────────────────────────────

  private trimOldSamples(e: HealthEntry): void {
    const cutoff = Date.now() - this.recentWindowMs;
    e.samples = e.samples.filter(s => s.ts >= cutoff);
  }

  private getRecentSamples(e: HealthEntry): Array<{ latencyMs: number; success: boolean; ts: number }> {
    this.trimOldSamples(e);
    if (e.samples.length <= this.windowSize) return e.samples;
    return e.samples.slice(-this.windowSize);
  }

  private computeAvailable(e: HealthEntry): boolean {
    const recent = this.getRecentSamples(e);
    const total = recent.length;
    if (total < 5) return true; // too few samples
    const errors = recent.filter(s => !s.success).length;
    return (errors / total) < 0.5; // unavailable if >=50% error rate in recent window
  }

  private toModelHealth(e: HealthEntry): ModelHealth {
    const recent = this.getRecentSamples(e);
    const sorted = recent.map(s => s.latencyMs).sort((a, b) => a - b);
    const avg = sorted.length ? sorted.reduce((s, v) => s + v, 0) / sorted.length : 0;
    const total = recent.length;
    const errors = recent.filter(s => !s.success).length;
    const oneMinuteAgo = Date.now() - 60_000;
    const rpm = recent.filter(s => s.ts >= oneMinuteAgo).length;
    // Propagate provider-level block into the per-model available flag so
    // that snapshots passed to SmartModelRouter also carry the blocked state.
    const providerBlockUntil = this.blockedProviders.get(e.providerId);
    const providerBlocked = !!providerBlockUntil && providerBlockUntil > Date.now();
    return {
      modelId: e.modelId,
      providerId: e.providerId,
      available: providerBlocked ? false : e.available,
      avgLatencyMs: Math.round(avg),
      errorRate: total > 0 ? errors / total : 0,
      lastChecked: e.lastChecked,
      p50LatencyMs: sorted.length ? sorted[Math.floor(sorted.length * 0.5)]! : 0,
      p99LatencyMs: sorted.length ? sorted[Math.floor(sorted.length * 0.99)]! : 0,
      requestsPerMinute: rpm,
    };
  }
}
