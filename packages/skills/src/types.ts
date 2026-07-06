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

/**
 * Machine-enforced execution contract for skills that must produce a
 * specific runtime shape (e.g. multi-pass delegations + structured report).
 * When set, the chat runtime extracts this contract from the rendered
 * system prompt and validates the agent result against it. Unset means
 * "no enforcement — guidance only".
 *
 * Failure modes are reported back to the model as concrete deltas
 * ("expected ≥ N delegations, got M"; "missing substring X") rather than
 * an opaque "skill plan was selected but not followed" error.
 */
export interface SkillExecutionContract {
  /** Minimum number of `delegate_to_worker` (or equivalent) calls expected. */
  readonly minDelegations?: number;
  /** Substrings that must appear in the final assistant output (case-insensitive). */
  readonly requiredOutputSubstrings?: readonly string[];
  /**
   * Regex sources (no flags; matched case-insensitive) that must each match
   * at least once in the final assistant output.
   */
  readonly requiredOutputPatterns?: readonly string[];
}

/**
 * A domain-scoped subsection of a skill playbook (e.g. sales/finance/operations).
 * Each section is treated as an optional, query-scorable PromptSection at render
 * time so query-aware filtering can pick only the domains relevant to the user
 * input rather than concatenating the entire playbook into the system prompt.
 */
export interface SkillDomainSection {
  readonly key: string;
  readonly label?: string;
  readonly content: string;
  readonly tags?: readonly string[];
}

/**
 * Composition interface — a skill's typed "wiring" so skills can be chained safely.
 *
 * We model inputs/outputs as small **capability tokens** (plain strings like
 * `dataset.loaded` or `analysis.done`) rather than JS predicates, so the whole graph
 * stays declarative, serialisable, and DB-storable (and can't smuggle in code).
 */
export interface SkillPrecondition {
  /** Capability tokens that must be available (from context, or produced by an earlier skill). */
  readonly requires?: readonly string[];
  /** Human-readable note about when this skill applies (shown to the model). */
  readonly narrative?: string;
}

export interface SkillTermination {
  /** The skill's work is complete once ALL these capability tokens are present. */
  readonly satisfiedWhen?: readonly string[];
  /** Hard cap on passes/iterations, so a composing runtime can't loop forever. */
  readonly maxIterations?: number;
  readonly narrative?: string;
}

export interface SkillDefinition {
  readonly id: string;
  readonly name: string;
  readonly version?: string;
  readonly enabled?: boolean;
  readonly category?: SkillCategory;

  // ── Composition (Phase 1) ──────────────────────────────────────────────────
  /** Capability tokens this skill PRODUCES (its typed effects/outputs). */
  readonly provides?: readonly string[];
  /** Applicability condition — the typed inputs this skill needs before it can run. */
  readonly precondition?: SkillPrecondition;
  /** When this skill's work is done (declarative, runtime-checkable). */
  readonly termination?: SkillTermination;
  /** Skill ids this skill REQUIRES — hard dependencies, auto-pulled in and ordered before it. */
  readonly requires?: readonly string[];
  /** Skill ids that pair well — a soft suggestion, pulled in if present, never required. */
  readonly composesWith?: readonly string[];
  /** Skill ids that must NOT be active alongside this one (mutually exclusive). */
  readonly conflictsWith?: readonly string[];
  /**
   * Privilege level (0 = default). A skill may only pull in dependencies whose `trust` is
   * ≤ its own — so a low-trust skill cannot escalate by requiring a high-trust one.
   * Formalised into the T1–T4 trust tiers in Phase 3.
   */
  readonly trust?: number;

  // ── Lifecycle governance (Phase 4) ─────────────────────────────────────────
  /** Where this skill sits in its life: draft → active → deprecated → retired. Defaults to 'active'. */
  readonly lifecycle?: import('./skill-evaluation.js').SkillLifecycleState;
  /** Set when a skill is deprecated — why, and what to use instead. */
  readonly deprecation?: import('./skill-evaluation.js').SkillDeprecation;
  /**
   * The kinds of input this skill can handle (Phase 6). Omitted = text only. Lets the runtime avoid
   * offering an image-only skill for a text request, and vice-versa.
   */
  readonly inputModalities?: readonly import('./skill-mining.js').SkillModality[];

  /**
   * Set when this skill was compiled from a `SKILL.md` package (Phase 2). A lightweight pointer — the
   * least-privilege manifest plus the names of the bundled reference files and scripts — so an
   * activated skill carries its permission posture and the app can build the Level-3 file tools for it
   * (via a `SkillPackageIndex`) without re-parsing. The file *contents* stay in the package, not here.
   */
  readonly package?: import('./skill-package.js').SkillPackageRef;

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
  /**
   * Optional machine-enforced execution contract. When set, the chat
   * runtime validates the agent result against this contract and reports
   * concrete failures back to the model on retry instead of a generic
   * "skill plan not followed" message.
   */
  readonly executionContract?: SkillExecutionContract;

  readonly tags?: readonly string[];
  readonly description?: string;
  readonly instructions?: string;
  readonly triggerPatterns?: readonly string[];
  readonly toolNames?: readonly string[];
  readonly priority?: number;
  /** Phase 6: key of the tool_policies row that governs tool calls while this skill is active */
  readonly toolPolicyKey?: string;
  /**
   * The agentic scope this skill belongs to (m75).
   * Used by ChatScopeGuard.filterSkillsByScope() to enforce domain boundaries.
   * Values: 'system' | 'analytics' | 'kaggle' | 'code' | 'browser' | 'voice' | 'memory'
   * Default (when absent): 'system' (most permissive — allowed from any scope).
   */
  readonly agenticScope?: string;
  /**
   * Optional domain-scoped sub-playbooks. When set, each section is rendered
   * as an optional PromptSection candidate so query-aware cosine relevance
   * can keep only the domains matching the user's input (e.g. only the
   * "sales" section for a sales-data query) instead of merging the entire
   * playbook into the supervisor system prompt.
   */
  readonly domainSections?: readonly SkillDomainSection[];
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
  /**
   * Optional candidate retriever (lexical / embedding / hybrid). When set, it replaces
   * the built-in lexical scoring for the *candidate* stage — so meaning-based (embedding)
   * or hybrid retrieval can surface paraphrased matches. Omit to keep the default lexical
   * behaviour unchanged. See `retrieval.ts`.
   */
  retriever?: import('./retrieval.js').SkillRetriever;
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
