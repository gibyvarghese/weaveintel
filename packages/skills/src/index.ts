/**
 * @weaveintel/skills — Text-first Skills runtime
 *
 * Skills are reusable semantic capability packages, not keyword maps.
 * A skill describes when/why/how to execute, completion expectations,
 * governance constraints, and optional tool guidance.
 */

import type { CapabilityTelemetrySummary } from '@weaveintel/core';

export type SkillCategory =
  | 'research'
  | 'analysis'
  | 'planning'
  | 'extraction'
  | 'synthesis'
  | 'compliance'
  | 'coding'
  | 'general'
  | string;

export type SkillInvocationMode =
  | 'advisory'
  | 'reasoning_support'
  | 'extraction'
  | 'structured_output'
  | 'tool_assisted'
  | 'side_effect_eligible';

export type SkillCompletionState =
  | 'complete'
  | 'complete_with_warnings'
  | 'incomplete'
  | 'ambiguous'
  | 'blocked_by_policy'
  | 'blocked_by_missing_context';

export interface SkillExample {
  readonly input: string;
  readonly output: string;
  readonly notes?: string;
}

export interface SkillCompletionContract {
  readonly narrative: string;
  readonly requiredEvidence?: readonly string[];
  readonly confidenceBehavior?: string;
  readonly ambiguityBehavior?: string;
  readonly humanReviewWhen?: string;
}

export interface SkillPolicyControls {
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly sideEffectsAllowed?: boolean;
  readonly requiresApproval?: boolean;
  readonly sensitivityHandling?: string;
  readonly runtimeBudgetMs?: number;
  readonly tenantBoundary?: 'tenant' | 'global' | 'application';
}

export interface SkillOutputContract {
  readonly narrative: string;
  readonly schemaJson?: string;
}

export interface SkillDefinition {
  readonly id: string;
  readonly name: string;
  readonly version?: string;
  readonly enabled?: boolean;
  readonly category?: SkillCategory;

  readonly summary: string;
  readonly purpose?: string;
  readonly whenToUse?: string;
  readonly whenNotToUse?: string;
  readonly requiredContext?: string;
  readonly helpfulContext?: string;
  readonly reasoningGuidance?: string;
  readonly executionGuidance?: string;
  readonly outputGuidance?: string;
  readonly completionGuidance?: string;
  readonly ambiguityGuidance?: string;
  readonly failureGuidance?: string;
  readonly notes?: string;
  readonly extensionNotes?: string;

  readonly examples?: readonly SkillExample[];
  readonly completionContract?: SkillCompletionContract;
  readonly policy?: SkillPolicyControls;
  readonly outputContract?: SkillOutputContract;

  readonly tags?: readonly string[];
  readonly description?: string;
  readonly instructions?: string;
  readonly triggerPatterns?: readonly string[];
  readonly toolNames?: readonly string[];
  readonly priority?: number;
}

export interface SkillExtensionOverlay {
  readonly skillId: string;
  readonly source: string;
  readonly summaryAppend?: string;
  readonly purposeAppend?: string;
  readonly whenToUseAppend?: string;
  readonly whenNotToUseAppend?: string;
  readonly requiredContextAppend?: string;
  readonly helpfulContextAppend?: string;
  readonly reasoningGuidanceAppend?: string;
  readonly executionGuidanceAppend?: string;
  readonly outputGuidanceAppend?: string;
  readonly completionGuidanceAppend?: string;
  readonly ambiguityGuidanceAppend?: string;
  readonly failureGuidanceAppend?: string;
  readonly notesAppend?: string;
  readonly examplesAppend?: readonly SkillExample[];
  readonly stricterPolicy?: SkillPolicyControls;
  readonly enabled?: boolean;
}

export interface SkillMatch {
  readonly skill: SkillDefinition;
  readonly score: number;
  readonly matchedPatterns: readonly string[];
  readonly rationale: string;
  readonly source: 'semantic' | 'reasoning';
}

export interface SkillDiscoveryOptions {
  maxSkills?: number;
  minScore?: number;
  categories?: SkillCategory[];
}

export interface SkillReasoningDecision {
  readonly selectedSkillIds: readonly string[];
  readonly rejectedSkillIds?: readonly string[];
  readonly rationale?: string;
  readonly confidence?: number;
  readonly useNoSkillPath?: boolean;
}

export type SkillReasoningSelector = (args: {
  query: string;
  mode: SkillInvocationMode;
  candidates: readonly SkillMatch[];
  context?: Record<string, unknown>;
}) => Promise<SkillReasoningDecision>;

export type SkillPolicyEvaluator = (args: {
  skill: SkillDefinition;
  mode: SkillInvocationMode;
  query: string;
  context?: Record<string, unknown>;
}) => {
  allowed: boolean;
  reason?: string;
  enforcedAllowedTools?: readonly string[];
};

export interface SkillActivationOptions {
  maxCandidates?: number;
  maxSelected?: number;
  minScore?: number;
  categories?: SkillCategory[];
  mode?: SkillInvocationMode;
  context?: Record<string, unknown>;
  overlays?: readonly SkillExtensionOverlay[];
  selector?: SkillReasoningSelector;
  policyEvaluator?: SkillPolicyEvaluator;
  hooks?: SkillLifecycleHooks;
}

export interface SkillActivationResult {
  readonly considered: readonly SkillMatch[];
  readonly selected: readonly SkillMatch[];
  readonly rejected: ReadonlyArray<{ skillId: string; reason: string }>;
  readonly noSkillReason?: string;
  readonly mode: SkillInvocationMode;
}

export interface SkillCompletionEvaluation {
  readonly state: SkillCompletionState;
  readonly reasons: readonly string[];
  readonly missingEvidence: readonly string[];
  readonly needsHumanReview: boolean;
}

export interface SkillLifecycleHooks {
  onActivation?(args: {
    query: string;
    activation: SkillActivationResult;
  }): void;
  onCompletion?(args: {
    skill: SkillDefinition;
    result: SkillCompletionEvaluation;
  }): void;
  onTelemetry?(args: {
    stage: 'activation' | 'completion';
    telemetry: CapabilityTelemetrySummary;
  }): void;
}

export interface SkillRegistry {
  register(skill: SkillDefinition): void;
  unregister(skillId: string): void;
  get(skillId: string): SkillDefinition | undefined;
  list(): SkillDefinition[];
  discover(query: string, opts?: SkillDiscoveryOptions): SkillMatch[];
  activate(query: string, opts?: SkillActivationOptions): Promise<SkillActivationResult>;
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have', 'if', 'in', 'into', 'is', 'it',
  'of', 'on', 'or', 'such', 'that', 'the', 'their', 'then', 'there', 'these', 'this', 'to', 'was', 'will', 'with',
]);

function normalizeText(raw: string | undefined): string {
  return (raw ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenize(raw: string | undefined): string[] {
  const text = normalizeText(raw);
  if (!text) return [];
  return text
    .split(' ')
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

function termFrequency(tokens: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const token of tokens) {
    out.set(token, (out.get(token) ?? 0) + 1);
  }
  return out;
}

function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const val of a.values()) normA += val * val;
  for (const val of b.values()) normB += val * val;

  if (normA === 0 || normB === 0) return 0;

  for (const [term, aval] of a.entries()) {
    dot += aval * (b.get(term) ?? 0);
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function appendSection(base: string | undefined, extra: string | undefined): string | undefined {
  const left = base?.trim();
  const right = extra?.trim();
  if (!left && !right) return undefined;
  if (!left) return right;
  if (!right) return left;
  return `${left}\n\n${right}`;
}

function applyStricterPolicy(base: SkillPolicyControls | undefined, overlay: SkillPolicyControls | undefined): SkillPolicyControls | undefined {
  if (!base && !overlay) return undefined;
  if (!base) return overlay;
  if (!overlay) return base;

  const allowedTools = overlay.allowedTools ?? base.allowedTools;
  const disallowedTools = [...new Set([...(base.disallowedTools ?? []), ...(overlay.disallowedTools ?? [])])];

  const runtimeBudgetMs = Math.min(
    base.runtimeBudgetMs ?? Number.POSITIVE_INFINITY,
    overlay.runtimeBudgetMs ?? Number.POSITIVE_INFINITY,
  );

  return {
    allowedTools,
    disallowedTools: disallowedTools.length ? disallowedTools : undefined,
    sideEffectsAllowed: base.sideEffectsAllowed === false || overlay.sideEffectsAllowed === false ? false : (overlay.sideEffectsAllowed ?? base.sideEffectsAllowed),
    requiresApproval: base.requiresApproval || overlay.requiresApproval,
    sensitivityHandling: overlay.sensitivityHandling ?? base.sensitivityHandling,
    runtimeBudgetMs: Number.isFinite(runtimeBudgetMs) ? runtimeBudgetMs : undefined,
    tenantBoundary: overlay.tenantBoundary ?? base.tenantBoundary,
  };
}

export function defineSkill(def: SkillDefinition): SkillDefinition {
  const summary = def.summary?.trim() || def.description?.trim() || '';
  const executionGuidance = def.executionGuidance ?? def.instructions;
  return {
    enabled: true,
    version: '1.0',
    category: 'general',
    priority: 0,
    triggerPatterns: [],
    toolNames: [],
    ...def,
    summary,
    executionGuidance,
  };
}

export function withSkillOverlay(base: SkillDefinition, overlay: SkillExtensionOverlay): SkillDefinition {
  if (base.id !== overlay.skillId) return base;

  const mergedPolicy = applyStricterPolicy(base.policy, overlay.stricterPolicy);
  const mergedExamples = [...(base.examples ?? []), ...(overlay.examplesAppend ?? [])];

  return {
    ...base,
    enabled: overlay.enabled ?? base.enabled,
    summary: appendSection(base.summary, overlay.summaryAppend) ?? base.summary,
    purpose: appendSection(base.purpose, overlay.purposeAppend),
    whenToUse: appendSection(base.whenToUse, overlay.whenToUseAppend),
    whenNotToUse: appendSection(base.whenNotToUse, overlay.whenNotToUseAppend),
    requiredContext: appendSection(base.requiredContext, overlay.requiredContextAppend),
    helpfulContext: appendSection(base.helpfulContext, overlay.helpfulContextAppend),
    reasoningGuidance: appendSection(base.reasoningGuidance, overlay.reasoningGuidanceAppend),
    executionGuidance: appendSection(base.executionGuidance, overlay.executionGuidanceAppend),
    outputGuidance: appendSection(base.outputGuidance, overlay.outputGuidanceAppend),
    completionGuidance: appendSection(base.completionGuidance, overlay.completionGuidanceAppend),
    ambiguityGuidance: appendSection(base.ambiguityGuidance, overlay.ambiguityGuidanceAppend),
    failureGuidance: appendSection(base.failureGuidance, overlay.failureGuidanceAppend),
    notes: appendSection(base.notes, overlay.notesAppend),
    examples: mergedExamples.length ? mergedExamples : undefined,
    policy: mergedPolicy,
    extensionNotes: appendSection(base.extensionNotes, `Overlay source: ${overlay.source}`),
  };
}

export function applySkillOverlays(
  skills: readonly SkillDefinition[],
  overlays: readonly SkillExtensionOverlay[] = [],
): SkillDefinition[] {
  if (!overlays.length) return [...skills];
  const overlayBySkill = new Map<string, SkillExtensionOverlay[]>();
  for (const overlay of overlays) {
    const existing = overlayBySkill.get(overlay.skillId) ?? [];
    existing.push(overlay);
    overlayBySkill.set(overlay.skillId, existing);
  }

  return skills.map((skill) => {
    const skillOverlays = overlayBySkill.get(skill.id) ?? [];
    return skillOverlays.reduce((acc, item) => withSkillOverlay(acc, item), skill);
  });
}

function skillSemanticDocument(skill: SkillDefinition): string {
  const parts = [
    skill.name,
    skill.summary,
    skill.purpose,
    skill.whenToUse,
    skill.whenNotToUse,
    skill.requiredContext,
    skill.helpfulContext,
    skill.reasoningGuidance,
    skill.executionGuidance,
    skill.outputGuidance,
    skill.completionGuidance,
    skill.ambiguityGuidance,
    skill.failureGuidance,
    skill.notes,
    skill.description,
    skill.instructions,
    (skill.tags ?? []).join(' '),
  ];
  return parts.filter(Boolean).join('\n');
}

function semanticScore(query: string, skill: SkillDefinition): number {
  const queryTf = termFrequency(tokenize(query));
  const docTf = termFrequency(tokenize(skillSemanticDocument(skill)));
  const base = cosineSimilarity(queryTf, docTf);
  const priorityBoost = Math.min(0.15, (skill.priority ?? 0) * 0.01);
  return Math.min(1, base + priorityBoost);
}

function semanticRationale(skill: SkillDefinition, query: string): string {
  const queryTokens = new Set(tokenize(query));
  const docTokens = tokenize(skillSemanticDocument(skill));
  const shared = Array.from(new Set(docTokens.filter((token) => queryTokens.has(token)))).slice(0, 6);
  if (!shared.length) return 'Semantic similarity across narrative sections.';
  return `Semantic overlap on: ${shared.join(', ')}`;
}

function sectionLabel(title: string, value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  return `### ${title}\n${text}`;
}

export function buildSkillInvocationPrompt(
  activation: SkillActivationResult,
  mode: SkillInvocationMode,
): string {
  if (!activation.selected.length) return '';

  const parts: string[] = ['## Active Skills'];

  for (const match of activation.selected) {
    const skill = match.skill;
    const sections: Array<string | undefined> = [
      `### ${skill.name}`,
      sectionLabel('Summary', skill.summary),
      sectionLabel('Purpose', skill.purpose),
      sectionLabel('When To Use', skill.whenToUse),
      sectionLabel('When Not To Use', skill.whenNotToUse),
    ];

    if (mode === 'advisory' || mode === 'reasoning_support') {
      sections.push(sectionLabel('Reasoning Guidance', skill.reasoningGuidance));
      sections.push(sectionLabel('Execution Guidance', skill.executionGuidance));
    }

    if (mode === 'extraction' || mode === 'structured_output' || mode === 'tool_assisted' || mode === 'side_effect_eligible') {
      sections.push(sectionLabel('Required Context', skill.requiredContext));
      sections.push(sectionLabel('Output Guidance', skill.outputGuidance));
      sections.push(sectionLabel('Completion Guidance', skill.completionGuidance));
      sections.push(sectionLabel('Ambiguity Guidance', skill.ambiguityGuidance));
      sections.push(sectionLabel('Failure Guidance', skill.failureGuidance));
      if (skill.completionContract) {
        sections.push(sectionLabel('Completion Contract', skill.completionContract.narrative));
      }
    }

    if (mode === 'tool_assisted' || mode === 'side_effect_eligible') {
      const tools = collectSkillTools([{ ...match, source: match.source }]);
      if (tools.length) {
        sections.push(`### Tool Guidance\nUse only relevant tools for this step. Candidate tools: ${tools.join(', ')}`);
      }
    }

    if (skill.examples?.length) {
      const ex = skill.examples.slice(0, 2).map((item) => `- Input: ${item.input}\n  Output: ${item.output}`).join('\n');
      sections.push(`### Examples\n${ex}`);
    }

    sections.push(sectionLabel('Selection Rationale', match.rationale));
    parts.push(...sections.filter((item): item is string => Boolean(item)));
  }

  return `${parts.join('\n\n')}\n`;
}

export function buildSkillSystemPrompt(matches: SkillMatch[]): string {
  const activation: SkillActivationResult = {
    considered: matches,
    selected: matches,
    rejected: [],
    mode: 'reasoning_support',
  };
  return buildSkillInvocationPrompt(activation, 'reasoning_support');
}

export function applySkillsToPrompt(
  basePrompt: string | undefined,
  matches: SkillMatch[],
  mode: SkillInvocationMode = 'reasoning_support',
): string | undefined {
  const activation: SkillActivationResult = {
    considered: matches,
    selected: matches,
    rejected: [],
    mode,
  };
  const skillBlock = buildSkillInvocationPrompt(activation, mode);
  if (!skillBlock && !basePrompt) return undefined;
  if (!skillBlock) return basePrompt;
  if (!basePrompt) return skillBlock;
  return `${basePrompt.trim()}\n\n${skillBlock}`;
}

export function collectSkillTools(matches: readonly SkillMatch[]): string[] {
  const tools = new Set<string>();
  for (const match of matches) {
    const policyAllowed = match.skill.policy?.allowedTools;
    const toolCandidates = policyAllowed ?? match.skill.toolNames ?? [];
    for (const tool of toolCandidates) {
      if ((match.skill.policy?.disallowedTools ?? []).includes(tool)) continue;
      tools.add(tool);
    }
  }
  return [...tools];
}

export function createSkillTelemetry(args: {
  skill: SkillDefinition;
  durationMs?: number;
  selectedBy: string;
  metadata?: Record<string, unknown>;
}): CapabilityTelemetrySummary {
  return {
    kind: 'skill',
    key: args.skill.id,
    name: args.skill.name,
    description: args.skill.summary || args.skill.description || 'Skill capability execution summary.',
    version: args.skill.version,
    selectedBy: args.selectedBy,
    durationMs: args.durationMs,
    tags: args.skill.tags,
    metadata: args.metadata,
  };
}

function keepIfCategory(skill: SkillDefinition, categories: SkillCategory[] | undefined): boolean {
  if (!categories?.length) return true;
  const category = skill.category ?? 'general';
  return categories.includes(category);
}

export async function activateSkills(
  query: string,
  skills: readonly SkillDefinition[],
  opts: SkillActivationOptions = {},
): Promise<SkillActivationResult> {
  const mode = opts.mode ?? 'reasoning_support';
  const maxCandidates = opts.maxCandidates ?? 6;
  const maxSelected = opts.maxSelected ?? 3;
  const minScore = opts.minScore ?? 0.12;

  const overlaid = applySkillOverlays(skills, opts.overlays);

  const considered: SkillMatch[] = overlaid
    .filter((skill) => skill.enabled !== false)
    .filter((skill) => keepIfCategory(skill, opts.categories))
    .map((skill) => ({
      skill,
      score: semanticScore(query, skill),
      matchedPatterns: [] as string[],
      rationale: semanticRationale(skill, query),
      source: 'semantic' as const,
    }))
    .filter((match) => match.score >= minScore)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const pa = a.skill.priority ?? 0;
      const pb = b.skill.priority ?? 0;
      if (pb !== pa) return pb - pa;
      return a.skill.name.localeCompare(b.skill.name);
    })
    .slice(0, maxCandidates);

  if (!considered.length) {
    const emptyResult: SkillActivationResult = {
      considered: [],
      selected: [],
      rejected: [],
      noSkillReason: 'No semantically relevant skill candidates found.',
      mode,
    };
    opts.hooks?.onActivation?.({ query, activation: emptyResult });
    opts.hooks?.onTelemetry?.({
      stage: 'activation',
      telemetry: {
        kind: 'skill',
        key: 'skills.activation',
        name: 'Skills Activation',
        description: 'Activation pipeline found no semantically relevant skills.',
        selectedBy: opts.selector ? 'semantic+reasoning' : 'semantic',
        metadata: {
          mode,
          consideredCount: 0,
          selectedCount: 0,
          rejectedCount: 0,
        },
      },
    });
    return emptyResult;
  }

  const rejected: Array<{ skillId: string; reason: string }> = [];
  let selected: SkillMatch[] = considered.slice(0, maxSelected);

  if (opts.selector) {
    try {
      const decision = await opts.selector({
        query,
        mode,
        candidates: considered,
        context: opts.context,
      });

      if (decision.useNoSkillPath) {
        const noSkillResult: SkillActivationResult = {
          considered,
          selected: [],
          rejected: considered.map((item) => ({ skillId: item.skill.id, reason: 'Reasoning selector chose no-skill path.' })),
          noSkillReason: decision.rationale ?? 'Reasoning selector rejected all candidates.',
          mode,
        };
        opts.hooks?.onActivation?.({ query, activation: noSkillResult });
        opts.hooks?.onTelemetry?.({
          stage: 'activation',
          telemetry: {
            kind: 'skill',
            key: 'skills.activation',
            name: 'Skills Activation',
            description: 'Reasoning selector rejected all semantic candidates.',
            selectedBy: 'reasoning',
            metadata: {
              mode,
              consideredCount: considered.length,
              selectedCount: 0,
              rejectedCount: noSkillResult.rejected.length,
              noSkillReason: noSkillResult.noSkillReason,
            },
          },
        });
        return noSkillResult;
      }

      const selectedIds = new Set(decision.selectedSkillIds);
      selected = considered
        .filter((item) => selectedIds.has(item.skill.id))
        .map((item) => ({ ...item, source: 'reasoning' as const, rationale: decision.rationale ?? item.rationale }))
        .slice(0, maxSelected);

      const rejectedIds = new Set(decision.rejectedSkillIds ?? []);
      for (const id of rejectedIds) {
        rejected.push({ skillId: id, reason: 'Rejected by reasoning selector.' });
      }
    } catch {
      // Selector is an optional enhancement; fallback keeps runtime available.
    }
  }

  if (opts.policyEvaluator) {
    const policySelected: SkillMatch[] = [];
    for (const match of selected) {
      const decision = opts.policyEvaluator({
        skill: match.skill,
        mode,
        query,
        context: opts.context,
      });
      if (!decision.allowed) {
        rejected.push({ skillId: match.skill.id, reason: decision.reason ?? 'Blocked by policy.' });
        continue;
      }

      const enforcedSkill: SkillDefinition = decision.enforcedAllowedTools
        ? {
            ...match.skill,
            policy: {
              ...match.skill.policy,
              allowedTools: decision.enforcedAllowedTools,
            },
          }
        : match.skill;
      policySelected.push({ ...match, skill: enforcedSkill });
    }
    selected = policySelected;
  }

  if (!selected.length) {
    const blockedResult: SkillActivationResult = {
      considered,
      selected: [],
      rejected,
      noSkillReason: 'All candidates were rejected by reasoning or policy.',
      mode,
    };
    opts.hooks?.onActivation?.({ query, activation: blockedResult });
    opts.hooks?.onTelemetry?.({
      stage: 'activation',
      telemetry: {
        kind: 'skill',
        key: 'skills.activation',
        name: 'Skills Activation',
        description: 'All skill candidates were filtered out by selector or policy gates.',
        selectedBy: opts.selector ? 'semantic+reasoning+policy' : 'semantic+policy',
        metadata: {
          mode,
          consideredCount: considered.length,
          selectedCount: 0,
          rejectedCount: rejected.length,
        },
      },
    });
    return blockedResult;
  }

  const activationResult: SkillActivationResult = {
    considered,
    selected,
    rejected,
    mode,
  };

  opts.hooks?.onActivation?.({ query, activation: activationResult });
  opts.hooks?.onTelemetry?.({
    stage: 'activation',
    telemetry: {
      kind: 'skill',
      key: 'skills.activation',
      name: 'Skills Activation',
      description: 'Skill activation completed with selected semantic/reasoned capabilities.',
      selectedBy: opts.selector ? 'semantic+reasoning+policy' : 'semantic+policy',
      metadata: {
        mode,
        consideredCount: considered.length,
        selectedCount: selected.length,
        rejectedCount: rejected.length,
        selectedSkillIds: selected.map((item) => item.skill.id),
      },
    },
  });

  return activationResult;
}

export function evaluateSkillCompletion(
  skill: SkillDefinition,
  output: string,
  opts?: {
    evidence?: readonly string[];
    blockedByPolicy?: boolean;
    missingContext?: boolean;
    hooks?: SkillLifecycleHooks;
  },
): SkillCompletionEvaluation {
  const hooks = opts?.hooks;

  if (opts?.blockedByPolicy) {
    const result: SkillCompletionEvaluation = {
      state: 'blocked_by_policy',
      reasons: ['Execution was blocked by deterministic policy controls.'],
      missingEvidence: [],
      needsHumanReview: false,
    };
    hooks?.onCompletion?.({ skill, result });
    hooks?.onTelemetry?.({
      stage: 'completion',
      telemetry: createSkillTelemetry({
        skill,
        selectedBy: 'completion_eval',
        metadata: { state: result.state, reasons: result.reasons },
      }),
    });
    return result;
  }

  if (opts?.missingContext) {
    const result: SkillCompletionEvaluation = {
      state: 'blocked_by_missing_context',
      reasons: ['Required context was missing for completion.'],
      missingEvidence: [],
      needsHumanReview: false,
    };
    hooks?.onCompletion?.({ skill, result });
    hooks?.onTelemetry?.({
      stage: 'completion',
      telemetry: createSkillTelemetry({
        skill,
        selectedBy: 'completion_eval',
        metadata: { state: result.state, reasons: result.reasons },
      }),
    });
    return result;
  }

  const lower = output.toLowerCase();
  const evidenceRequired = skill.completionContract?.requiredEvidence ?? [];
  const missingEvidence = evidenceRequired.filter((item) => !lower.includes(item.toLowerCase()));
  const containsAmbiguity = /\b(uncertain|ambiguous|not enough|insufficient|unknown)\b/.test(lower);

  if (!output.trim()) {
    const result: SkillCompletionEvaluation = {
      state: 'incomplete',
      reasons: ['Output is empty.'],
      missingEvidence: [...evidenceRequired],
      needsHumanReview: false,
    };
    hooks?.onCompletion?.({ skill, result });
    hooks?.onTelemetry?.({
      stage: 'completion',
      telemetry: createSkillTelemetry({
        skill,
        selectedBy: 'completion_eval',
        metadata: { state: result.state, missingEvidence: result.missingEvidence },
      }),
    });
    return result;
  }

  if (containsAmbiguity && missingEvidence.length > 0) {
    const result: SkillCompletionEvaluation = {
      state: 'ambiguous',
      reasons: ['Output identifies ambiguity but does not satisfy all required evidence.'],
      missingEvidence,
      needsHumanReview: Boolean(skill.completionContract?.humanReviewWhen),
    };
    hooks?.onCompletion?.({ skill, result });
    hooks?.onTelemetry?.({
      stage: 'completion',
      telemetry: createSkillTelemetry({
        skill,
        selectedBy: 'completion_eval',
        metadata: { state: result.state, missingEvidence: result.missingEvidence },
      }),
    });
    return result;
  }

  if (missingEvidence.length > 0) {
    const result: SkillCompletionEvaluation = {
      state: 'incomplete',
      reasons: ['Output missed required evidence from completion contract.'],
      missingEvidence,
      needsHumanReview: false,
    };
    hooks?.onCompletion?.({ skill, result });
    hooks?.onTelemetry?.({
      stage: 'completion',
      telemetry: createSkillTelemetry({
        skill,
        selectedBy: 'completion_eval',
        metadata: { state: result.state, missingEvidence: result.missingEvidence },
      }),
    });
    return result;
  }

  const warningWords = ['might', 'possibly', 'likely'];
  const hasWarningTone = warningWords.some((word) => lower.includes(word));

  const result: SkillCompletionEvaluation = {
    state: hasWarningTone ? 'complete_with_warnings' : 'complete',
    reasons: hasWarningTone ? ['Output completed with uncertainty language.'] : ['Output satisfies completion expectations.'],
    missingEvidence: [],
    needsHumanReview: Boolean(skill.completionContract?.humanReviewWhen && hasWarningTone),
  };

  hooks?.onCompletion?.({ skill, result });
  hooks?.onTelemetry?.({
    stage: 'completion',
    telemetry: createSkillTelemetry({
      skill,
      selectedBy: 'completion_eval',
      metadata: { state: result.state, reasons: result.reasons },
    }),
  });

  return result;
}

export function createSkillRegistry(): SkillRegistry {
  const skills = new Map<string, SkillDefinition>();

  return {
    register(skill: SkillDefinition): void {
      skills.set(skill.id, defineSkill(skill));
    },

    unregister(skillId: string): void {
      skills.delete(skillId);
    },

    get(skillId: string): SkillDefinition | undefined {
      return skills.get(skillId);
    },

    list(): SkillDefinition[] {
      return [...skills.values()];
    },

    discover(query: string, opts: SkillDiscoveryOptions = {}): SkillMatch[] {
      const maxSkills = opts.maxSkills ?? 3;
      const minScore = opts.minScore ?? 0.12;
      const categories = opts.categories;

      const matches: SkillMatch[] = [...skills.values()]
        .filter((skill) => skill.enabled !== false)
        .filter((skill) => keepIfCategory(skill, categories))
        .map((skill) => ({
          skill,
          score: semanticScore(query, skill),
          matchedPatterns: [] as string[],
          rationale: semanticRationale(skill, query),
          source: 'semantic' as const,
        }))
        .filter((match) => match.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, maxSkills);

      return matches;
    },

    async activate(query: string, opts: SkillActivationOptions = {}): Promise<SkillActivationResult> {
      return activateSkills(query, [...skills.values()], opts);
    },
  };
}

export interface SkillRow {
  id: string;
  name: string;
  description: string;
  category: string;
  trigger_patterns: string;
  instructions: string;
  tool_names: string | null;
  examples: string | null;
  tags: string | null;
  priority: number;
  version: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

function safeParseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

function safeParseExamples(raw: string | null | undefined): SkillExample[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item === 'object')
      .map((item) => {
        const rec = item as Record<string, unknown>;
        return {
          input: String(rec['input'] ?? ''),
          output: String(rec['output'] ?? ''),
          notes: typeof rec['notes'] === 'string' ? rec['notes'] : undefined,
        };
      })
      .filter((item) => Boolean(item.input && item.output));
  } catch {
    return [];
  }
}

export function skillFromRow(row: SkillRow): SkillDefinition {
  const examples = safeParseExamples(row.examples);
  const tools = safeParseStringArray(row.tool_names);
  const triggerPatterns = safeParseStringArray(row.trigger_patterns);
  const tags = safeParseStringArray(row.tags);

  return defineSkill({
    id: row.id,
    name: row.name,
    version: row.version,
    enabled: row.enabled !== 0,
    category: row.category,
    summary: row.description || row.instructions,
    purpose: row.description,
    executionGuidance: row.instructions,
    whenToUse: triggerPatterns.length
      ? `Legacy hints from stored trigger patterns: ${triggerPatterns.join(', ')}`
      : undefined,
    examples: examples.length ? examples : undefined,
    tags: tags.length ? tags : undefined,
    triggerPatterns,
    toolNames: tools,
    description: row.description,
    instructions: row.instructions,
    priority: row.priority,
    policy: tools.length ? { allowedTools: tools } : undefined,
    completionContract: {
      narrative: 'Provide a complete response with evidence and surface ambiguity explicitly when confidence is low.',
      requiredEvidence: ['evidence', 'confidence'],
      ambiguityBehavior: 'Use explicit uncertainty language when context is incomplete.',
    },
  });
}

export const BUILT_IN_SKILLS: SkillDefinition[] = [
  defineSkill({
    id: 'skill-investigation-brief',
    name: 'Investigation Briefing',
    version: '2.0',
    category: 'analysis',
    summary: 'Turn a complex problem into a concise diagnostic brief with hypotheses, evidence, and clear next checks.',
    purpose: 'Help models reason transparently when debugging incidents, regressions, and architecture tradeoffs.',
    whenToUse: 'Use for bug triage, architecture reviews, and failure analysis where evidence and uncertainty should both be explicit.',
    whenNotToUse: 'Avoid for trivial factual requests where no multi-step reasoning is needed.',
    requiredContext: 'Include observed behavior, expected behavior, constraints, and known signals from logs/tests.',
    reasoningGuidance: 'Generate plausible hypotheses, rank by likelihood, gather confirming/disconfirming evidence, then converge.',
    executionGuidance: 'Keep analysis grounded in observed artifacts. Do not claim certainty without concrete evidence.',
    outputGuidance: 'Return: findings, confidence per finding, gaps, and immediate next actions.',
    completionGuidance: 'Done means top issues are identified, evidence is cited, and ambiguity is explicitly surfaced.',
    ambiguityGuidance: 'If evidence conflicts, mark ambiguous and request additional validation.',
    failureGuidance: 'If blocked, state what data is missing and how to collect it.',
    toolNames: ['text_analysis', 'json_format'],
    policy: {
      allowedTools: ['text_analysis', 'json_format'],
      sideEffectsAllowed: false,
      requiresApproval: false,
      sensitivityHandling: 'Avoid exposing secrets in summaries.',
    },
    completionContract: {
      narrative: 'Identify probable root causes, confidence, and explicit evidence before recommending actions.',
      requiredEvidence: ['evidence', 'confidence'],
      humanReviewWhen: 'When the recommendation could change production behavior.',
    },
    tags: ['debugging', 'investigation', 'analysis'],
    triggerPatterns: [],
    examples: [
      {
        input: 'API suddenly returns 401 in compliance routes after refactor.',
        output: 'Finding: auth middleware path mismatch likely introduced. Evidence: auth tests pass, compliance suite fails with 401. Confidence: medium. Next check: compare route registration + permission guard wiring.',
      },
    ],
  }),
  defineSkill({
    id: 'skill-structured-extraction',
    name: 'Structured Evidence Extraction',
    version: '2.0',
    category: 'extraction',
    summary: 'Extract required entities and evidence from noisy text into a deterministic schema while preserving ambiguity.',
    purpose: 'Support workflows that need machine-consumable outputs and confidence-aware extraction behavior.',
    whenToUse: 'Use for compliance checks, data normalization, and pipeline handoffs that require explicit fields.',
    whenNotToUse: 'Avoid when user only needs conversational summaries.',
    requiredContext: 'Provide schema goals, constraints, and examples of valid outputs.',
    executionGuidance: 'Prefer faithful extraction over inference; if uncertain, flag ambiguity instead of fabricating data.',
    outputGuidance: 'Return structured JSON with extracted values, confidence, and evidence spans.',
    completionGuidance: 'Complete only when required fields are populated or explicitly marked missing with reasons.',
    ambiguityGuidance: 'Use `ambiguous` state when evidence is conflicting or missing.',
    failureGuidance: 'Return blocked state and missing context checklist if input is insufficient.',
    toolNames: ['json_format'],
    policy: {
      allowedTools: ['json_format'],
      sideEffectsAllowed: false,
    },
    completionContract: {
      narrative: 'Populate required fields, include confidence, and cite evidence for each extracted claim.',
      requiredEvidence: ['confidence', 'evidence'],
    },
    triggerPatterns: [],
  }),
  defineSkill({
    id: 'skill-tool-orchestrated-analysis',
    name: 'Tool-Orchestrated Analysis',
    version: '2.0',
    category: 'planning',
    summary: 'Plan and execute multi-step analysis that combines reasoning with governed tool usage.',
    purpose: 'Guide the model to choose tools deliberately, verify outputs, and report completion states safely.',
    whenToUse: 'Use when direct model reasoning is insufficient and tool outputs are required as evidence.',
    whenNotToUse: 'Avoid when policy forbids tool usage for the current context or tenant scope.',
    requiredContext: 'Provide task objective, tool availability, runtime budgets, and sensitivity constraints.',
    reasoningGuidance: 'Decide if tools are needed, sequence calls, verify outputs, then synthesize conclusions.',
    executionGuidance: 'Use the minimum required tool set and retry only with clear corrective intent.',
    outputGuidance: 'Report tool evidence, latency-sensitive caveats, and completion status.',
    completionGuidance: 'Done means output includes evidence-backed conclusion and explicit unresolved gaps.',
    failureGuidance: 'If a required tool is blocked, return blocked_by_policy with exact guard reason.',
    toolNames: ['web_search', 'calculator', 'json_format'],
    policy: {
      allowedTools: ['web_search', 'calculator', 'json_format'],
      disallowedTools: ['cse_run_code'],
      sideEffectsAllowed: false,
      requiresApproval: true,
      runtimeBudgetMs: 20000,
    },
    completionContract: {
      narrative: 'Evidence-backed answer with declared confidence and unresolved unknowns.',
      requiredEvidence: ['evidence', 'confidence'],
      humanReviewWhen: 'Recommendations involve external actions or policy exceptions.',
    },
    triggerPatterns: [],
  }),
];
