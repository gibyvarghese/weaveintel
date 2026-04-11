/**
 * @weaveintel/prompts — Prompt resolver
 *
 * Resolves the effective PromptVersion for a given promptId by considering
 * scope, tenant overrides, environment overrides, and active experiments.
 * Designed to be backed by any data source (in-memory, DB, remote API).
 */

import type { PromptVersion, PromptResolver as IPromptResolver } from '@weaveintel/core';
import type { PromptExperimentStore } from './experiment.js';

// ─── Version store ───────────────────────────────────────────

/** Pluggable store that supplies prompt versions. */
export interface PromptVersionStore {
  getVersion(promptId: string, version?: string): Promise<PromptVersion | null>;
  getVersionByScope?(promptId: string, scope: { tenantId?: string; environment?: string }): Promise<PromptVersion | null>;
}

// ─── Resolver ────────────────────────────────────────────────

export class PromptResolver implements IPromptResolver {
  constructor(
    private readonly store: PromptVersionStore,
    private readonly experiments?: PromptExperimentStore,
  ) {}

  /**
   * Resolution order:
   * 1. Active experiment → weighted variant selection
   * 2. Tenant + environment override
   * 3. Default latest version
   */
  async resolve(
    promptId: string,
    context: { tenantId?: string; environment?: string; experimentId?: string },
  ): Promise<PromptVersion> {
    // 1. Experiment
    if (context.experimentId && this.experiments) {
      const variant = await this.experiments.pickVariant(context.experimentId);
      if (variant) {
        const ver = await this.store.getVersion(variant.promptId, variant.versionId);
        if (ver) return ver;
      }
    }

    // 2. Scoped override
    if (this.store.getVersionByScope && (context.tenantId || context.environment)) {
      const scoped = await this.store.getVersionByScope(promptId, {
        tenantId: context.tenantId,
        environment: context.environment,
      });
      if (scoped) return scoped;
    }

    // 3. Default
    const ver = await this.store.getVersion(promptId);
    if (!ver) throw new Error(`Prompt "${promptId}" not found`);
    return ver;
  }
}
