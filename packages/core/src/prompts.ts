/**
 * @weaveintel/core — Prompt management contracts
 */

// ─── Prompt Definition ───────────────────────────────────────

export interface PromptDefinition {
  id: string;
  name: string;
  description?: string;
  category?: string;
  tags?: string[];
  currentVersion: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface PromptVersion {
  id: string;
  promptId: string;
  version: string;
  template: string;
  variables: PromptVariable[];
  changelog?: string;
  createdAt: string;
}

export interface PromptVariable {
  name: string;
  description?: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required: boolean;
  defaultValue?: unknown;
}

// ─── Template ────────────────────────────────────────────────

export interface PromptTemplate {
  id: string;
  name: string;
  template: string;
  variables: PromptVariable[];
  render(values: Record<string, unknown>): string;
}

// ─── Registry ────────────────────────────────────────────────

export interface PromptRegistry {
  register(prompt: PromptDefinition, version: PromptVersion): Promise<void>;
  get(promptId: string, version?: string): Promise<PromptVersion | null>;
  list(filter?: { category?: string; tags?: string[] }): Promise<PromptDefinition[]>;
  resolve(promptId: string, variables: Record<string, unknown>, scope?: string): Promise<string>;
  delete(promptId: string): Promise<void>;
}

// ─── Instructions ────────────────────────────────────────────

export interface InstructionBundle {
  id: string;
  name: string;
  system: string;
  task?: string;
  formatting?: string;
  guardrails?: string;
  examples?: string[];
}

// ─── Experiments ─────────────────────────────────────────────

export interface PromptVariant {
  id: string;
  promptId: string;
  versionId: string;
  weight: number;
  label: string;
}

export interface PromptExperiment {
  id: string;
  name: string;
  promptId: string;
  variants: PromptVariant[];
  status: 'draft' | 'active' | 'completed';
  startedAt?: string;
  endedAt?: string;
  results?: Record<string, { impressions: number; score: number }>;
}

// ─── Resolver ────────────────────────────────────────────────

export interface PromptResolver {
  resolve(promptId: string, context: { tenantId?: string; environment?: string; experimentId?: string }): Promise<PromptVersion>;
}
