/**
 * @weaveintel/prompts — Prompt experiments (A/B testing)
 *
 * Manages prompt experiments with weighted variant selection.
 * Each experiment references multiple PromptVariants with weights
 * that determine selection probability.
 */

import type { PromptExperiment, PromptVariant } from '@weaveintel/core';

// ─── Experiment store ────────────────────────────────────────

export interface PromptExperimentStore {
  getExperiment(experimentId: string): Promise<PromptExperiment | null>;
  pickVariant(experimentId: string): Promise<PromptVariant | null>;
  recordImpression(experimentId: string, variantId: string): Promise<void>;
  recordScore(experimentId: string, variantId: string, score: number): Promise<void>;
}

// ─── In-memory experiment store ──────────────────────────────

export class InMemoryExperimentStore implements PromptExperimentStore {
  private experiments = new Map<string, PromptExperiment>();

  addExperiment(experiment: PromptExperiment): void {
    this.experiments.set(experiment.id, experiment);
  }

  async getExperiment(experimentId: string): Promise<PromptExperiment | null> {
    return this.experiments.get(experimentId) ?? null;
  }

  /** Weighted random selection among active experiment variants. */
  async pickVariant(experimentId: string): Promise<PromptVariant | null> {
    const exp = this.experiments.get(experimentId);
    if (!exp || exp.status !== 'active' || exp.variants.length === 0) return null;
    return weightedSelect(exp.variants);
  }

  async recordImpression(experimentId: string, variantId: string): Promise<void> {
    const exp = this.experiments.get(experimentId);
    if (!exp) return;
    if (!exp.results) exp.results = {};
    const r = exp.results[variantId] ?? { impressions: 0, score: 0 };
    r.impressions += 1;
    exp.results[variantId] = r;
  }

  async recordScore(experimentId: string, variantId: string, score: number): Promise<void> {
    const exp = this.experiments.get(experimentId);
    if (!exp) return;
    if (!exp.results) exp.results = {};
    const r = exp.results[variantId] ?? { impressions: 0, score: 0 };
    // Running average
    r.score = r.impressions > 0
      ? (r.score * r.impressions + score) / (r.impressions + 1)
      : score;
    r.impressions += 1;
    exp.results[variantId] = r;
  }
}

// ─── Weighted selection ──────────────────────────────────────

export function weightedSelect(variants: PromptVariant[]): PromptVariant {
  const total = variants.reduce((s, v) => s + v.weight, 0);
  let rand = Math.random() * total;
  for (const v of variants) {
    rand -= v.weight;
    if (rand <= 0) return v;
  }
  return variants[variants.length - 1]!;
}
