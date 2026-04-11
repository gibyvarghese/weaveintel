/**
 * @weaveintel/prompts — In-memory prompt registry
 *
 * Stores prompt definitions and versions. Provides CRUD, filtering,
 * and resolution with variable substitution.
 */

import type {
  PromptDefinition,
  PromptVersion,
  PromptRegistry,
  PromptVariable,
} from '@weaveintel/core';
import { createTemplate } from './template.js';

// ─── In-memory registry ──────────────────────────────────────

export class InMemoryPromptRegistry implements PromptRegistry {
  private defs = new Map<string, PromptDefinition>();
  private versions = new Map<string, PromptVersion[]>(); // keyed by promptId

  async register(prompt: PromptDefinition, version: PromptVersion): Promise<void> {
    this.defs.set(prompt.id, prompt);
    const list = this.versions.get(prompt.id) ?? [];
    // Replace existing version if same id, otherwise push
    const idx = list.findIndex(v => v.id === version.id);
    if (idx >= 0) list[idx] = version; else list.push(version);
    this.versions.set(prompt.id, list);
  }

  async get(promptId: string, version?: string): Promise<PromptVersion | null> {
    const list = this.versions.get(promptId);
    if (!list || list.length === 0) return null;
    if (version) return list.find(v => v.version === version) ?? null;
    // Return latest (last registered)
    return list[list.length - 1]!;
  }

  async list(filter?: { category?: string; tags?: string[] }): Promise<PromptDefinition[]> {
    let result = [...this.defs.values()];
    if (filter?.category) result = result.filter(d => d.category === filter.category);
    if (filter?.tags && filter.tags.length > 0) {
      result = result.filter(d => d.tags && filter.tags!.some(t => d.tags!.includes(t)));
    }
    return result;
  }

  async resolve(promptId: string, variables: Record<string, unknown>, _scope?: string): Promise<string> {
    const ver = await this.get(promptId);
    if (!ver) throw new Error(`Prompt "${promptId}" not found`);
    const tpl = createTemplate({ id: ver.id, name: promptId, template: ver.template, variables: ver.variables });
    return tpl.render(variables);
  }

  async delete(promptId: string): Promise<void> {
    this.defs.delete(promptId);
    this.versions.delete(promptId);
  }
}
