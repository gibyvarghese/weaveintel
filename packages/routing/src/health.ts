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
  latencies: number[];       // sliding window
  errors: number;
  successes: number;
  lastChecked: string;
}

// ─── Health tracker ──────────────────────────────────────────

export class ModelHealthTracker {
  private entries = new Map<string, HealthEntry>();
  private windowSize: number;

  constructor(opts?: { windowSize?: number }) {
    this.windowSize = opts?.windowSize ?? 100;
  }

  private key(modelId: string, providerId: string): string {
    return `${providerId}:${modelId}`;
  }

  private getOrCreate(modelId: string, providerId: string): HealthEntry {
    const k = this.key(modelId, providerId);
    let e = this.entries.get(k);
    if (!e) {
      e = { modelId, providerId, available: true, latencies: [], errors: 0, successes: 0, lastChecked: new Date().toISOString() };
      this.entries.set(k, e);
    }
    return e;
  }

  /** Record one request outcome. */
  record(modelId: string, providerId: string, outcome: { latencyMs: number; success: boolean }): void {
    const e = this.getOrCreate(modelId, providerId);
    e.latencies.push(outcome.latencyMs);
    if (e.latencies.length > this.windowSize) e.latencies.shift();
    if (outcome.success) e.successes++; else e.errors++;
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

  private computeAvailable(e: HealthEntry): boolean {
    const total = e.successes + e.errors;
    if (total < 5) return true; // too few samples
    return (e.errors / total) < 0.5; // unavailable if >50% error rate
  }

  private toModelHealth(e: HealthEntry): ModelHealth {
    const sorted = [...e.latencies].sort((a, b) => a - b);
    const avg = sorted.length ? sorted.reduce((s, v) => s + v, 0) / sorted.length : 0;
    const total = e.successes + e.errors;
    return {
      modelId: e.modelId,
      providerId: e.providerId,
      available: e.available,
      avgLatencyMs: Math.round(avg),
      errorRate: total > 0 ? e.errors / total : 0,
      lastChecked: e.lastChecked,
      p50LatencyMs: sorted.length ? sorted[Math.floor(sorted.length * 0.5)]! : 0,
      p99LatencyMs: sorted.length ? sorted[Math.floor(sorted.length * 0.99)]! : 0,
      requestsPerMinute: undefined, // would need time window tracking
    };
  }
}
