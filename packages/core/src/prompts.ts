/**
 * @weaveintel/core — Prompt management contracts
 */

// ─── Shared enums & metadata ────────────────────────────────

export type PromptKind =
  | 'template'
  | 'structured'
  | 'fewShot'
  | 'chain'
  | 'router'
  | 'judge'
  | 'optimizer'
  | 'modalityPreset';

export type PromptStatus = 'draft' | 'published' | 'retired';

export type PromptVariableType = 'string' | 'number' | 'boolean' | 'array' | 'object';

export type PromptReasoningMode = 'default' | 'low' | 'medium' | 'high';

export type PromptExplanationStyle = 'concise' | 'standard' | 'detailed';

export type PromptDeliberationPolicy = 'default' | 'verify' | 'critique';

export interface PromptOwner {
  id?: string;
  name: string;
  type?: 'user' | 'team' | 'system';
}

export interface PromptModelCompatibility {
  providers?: string[];
  models?: string[];
  excludedProviders?: string[];
  excludedModels?: string[];
  modalities?: Array<'text' | 'image' | 'audio' | 'file'>;
}

export interface PromptExecutionDefaults {
  strategy?: string;
  temperature?: number;
  maxTokens?: number;
  reasoningMode?: PromptReasoningMode;
  selfReview?: boolean;
  explanationStyle?: PromptExplanationStyle;
  deliberationPolicy?: PromptDeliberationPolicy;
  outputContractId?: string;
}

export interface PromptFrameworkSection {
  key: string;
  label?: string;
  required?: boolean;
  renderOrder?: number;
  content?: string;
}

export interface PromptFrameworkRef {
  id?: string;
  name?: string;
  sections?: PromptFrameworkSection[];
}

export interface PromptOutputContractRef {
  id?: string;
  type?: 'jsonSchema' | 'typedSchema' | 'requiredSections' | 'markdown' | 'codegen';
}

export interface PromptExample {
  id?: string;
  input: string;
  expectedOutput: string;
  notes?: string;
  tags?: string[];
  modelCompatibility?: PromptModelCompatibility;
}

export interface PromptRoute {
  id: string;
  description: string;
  promptId: string;
  when?: string;
}

export interface PromptChainStep {
  id: string;
  promptId?: string;
  description: string;
  strategy?: string;
}

export interface StructuredPromptMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ─── Prompt Definition ───────────────────────────────────────

export interface PromptDefinition {
  id: string;
  key?: string;
  name: string;
  description?: string;
  category?: string;
  tags?: string[];
  owner?: PromptOwner;
  status?: PromptStatus;
  kind?: PromptKind;
  currentVersion: string;
  modelCompatibility?: PromptModelCompatibility;
  executionDefaults?: PromptExecutionDefaults;
  createdAt?: string;
  updatedAt?: string;
}

export interface PromptVersionBase {
  id: string;
  promptId: string;
  version: string;
  kind: PromptKind;
  status?: PromptStatus;
  description?: string;
  tags?: string[];
  framework?: PromptFrameworkRef;
  modelCompatibility?: PromptModelCompatibility;
  executionDefaults?: PromptExecutionDefaults;
  outputContract?: PromptOutputContractRef;
  changelog?: string;
  createdAt: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface PromptVariable {
  name: string;
  description?: string;
  type: PromptVariableType;
  required: boolean;
  defaultValue?: unknown;
}

export interface TemplatePromptVersion extends PromptVersionBase {
  kind: 'template';
  template: string;
  variables: PromptVariable[];
  examples?: PromptExample[];
}

export interface FewShotPromptVersion extends PromptVersionBase {
  kind: 'fewShot';
  template: string;
  variables: PromptVariable[];
  examples: PromptExample[];
  selectionStrategy?: 'static' | 'tag' | 'compatibility';
}

export interface StructuredPromptVersion extends PromptVersionBase {
  kind: 'structured';
  messages: StructuredPromptMessage[];
  variables: PromptVariable[];
  examples?: PromptExample[];
}

export interface ChainPromptVersion extends PromptVersionBase {
  kind: 'chain';
  steps: PromptChainStep[];
  variables: PromptVariable[];
}

export interface RouterPromptVersion extends PromptVersionBase {
  kind: 'router';
  routes: PromptRoute[];
  fallbackPromptId?: string;
  variables: PromptVariable[];
}

export interface JudgePromptVersion extends PromptVersionBase {
  kind: 'judge';
  template: string;
  rubric?: string;
  variables: PromptVariable[];
}

export interface OptimizerPromptVersion extends PromptVersionBase {
  kind: 'optimizer';
  template: string;
  optimizationGoal?: string;
  variables: PromptVariable[];
}

export interface ModalityPresetPromptVersion extends PromptVersionBase {
  kind: 'modalityPreset';
  template: string;
  variables: PromptVariable[];
  modality: 'text' | 'image' | 'audio' | 'file';
}

export type PromptVersion =
  | TemplatePromptVersion
  | FewShotPromptVersion
  | StructuredPromptVersion
  | ChainPromptVersion
  | RouterPromptVersion
  | JudgePromptVersion
  | OptimizerPromptVersion
  | ModalityPresetPromptVersion;

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
