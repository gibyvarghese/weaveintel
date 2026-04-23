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

  /** Get health snapshot for one model. */
  getHealth(modelId: string, providerId: string): ModelHealth | null {
    const e = this.entries.get(this.key(modelId, providerId));
    if (!e) return null;
    return this.toModelHealth(e);
  }

  /** Get health for all tracked models. */
  listHealth(): ModelHealth[] {
    return [...this.entries.values()].map(e => this.toModelHealth(e));
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
    return {
      modelId: e.modelId,
      providerId: e.providerId,
      available: e.available,
      avgLatencyMs: Math.round(avg),
      errorRate: total > 0 ? errors / total : 0,
      lastChecked: e.lastChecked,
      p50LatencyMs: sorted.length ? sorted[Math.floor(sorted.length * 0.5)]! : 0,
      p99LatencyMs: sorted.length ? sorted[Math.floor(sorted.length * 0.99)]! : 0,
      requestsPerMinute: rpm,
    };
  }
}
