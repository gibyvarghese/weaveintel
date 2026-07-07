// SPDX-License-Identifier: MIT
/**
 * Skill evaluation & lifecycle — measuring whether a skill is good, and managing its life.
 *
 * A registry full of skills is only as useful as the skills are *good*. Three things make a skill
 * worth keeping (the mid-2026 consensus on skill quality):
 *   • **Reusability** — does it generalise across many requests, or is it a brittle one-off?
 *   • **Composability** — can it slot into a bigger plan alongside other skills?
 *   • **Maintainability** — is it clear, versioned, and robust rather than a fragile wall of text?
 * …and above all, **task completion** — when you actually run it on real examples, does it get the
 * job done? Because lab scores and real behaviour famously diverge, task completion is measured by
 * *running* the skill on example cases and grading the results, not by inspecting the text.
 *
 * `evaluateSkill()` produces those four scores. It works with no model at all (fast heuristics), and
 * gets sharper when you inject an LLM judge (shaped exactly like `@weaveintel/testing`'s rubric judge,
 * so you can pass that straight in) and a way to run/grade example cases.
 *
 * Two governance pieces build on the score:
 *   • **Promotion gating** — a skill only moves up a trust tier (Phase 3) when its evaluation clears
 *     the bar. Reaching the high, powerful tiers needs a **human sign-off too**, so a tampered or
 *     "gamed" eval dataset can't quietly promote a skill on its own.
 *   • **Lifecycle** — draft → active → deprecated → retired, with automatic demotion when a skill
 *     regresses, and deprecation that points users at a replacement instead of leaving a dead skill.
 */

import type { SkillDefinition } from './types.js';

// ── The evaluation model ─────────────────────────────────────────────────────────────────────────

export type SkillEvalDimension = 'reusability' | 'composability' | 'maintainability' | 'taskCompletion';

export interface DimensionScore {
  /** 0–1. */
  readonly score: number;
  /** Whether this dimension was actually measured (task completion needs example cases). */
  readonly measured: boolean;
  readonly reasons: readonly string[];
}

export interface SkillEvaluation {
  readonly skillId: string;
  readonly reusability: DimensionScore;
  readonly composability: DimensionScore;
  readonly maintainability: DimensionScore;
  readonly taskCompletion: DimensionScore;
  /** Weighted 0–1 across the measured dimensions. */
  readonly overall: number;
  /** True when `overall` and `taskCompletion` both clear the thresholds. */
  readonly passed: boolean;
  readonly findings: readonly string[];
}

// A judge shaped like @weaveintel/testing's RubricJudgeAdapter, so that adapter plugs in directly.
export interface SkillRubricCriterion { readonly id: string; readonly description: string; readonly weight: number }
export interface SkillJudgeRequest { readonly content: string; readonly criteria: SkillRubricCriterion[]; readonly expectedOutput?: string; readonly context?: Record<string, unknown> }
export interface SkillJudgeResponse { readonly score: number; readonly reason?: string; readonly criteriaScores?: Record<string, number> }
export interface SkillJudge { score(args: SkillJudgeRequest): Promise<SkillJudgeResponse> }

/** One example the skill should handle: an input, and (optionally) what a good result looks like. */
export interface SkillEvalCase { readonly input: string; readonly expectation?: string }

export interface EvaluateSkillOptions {
  /** Example cases to measure task completion against. Without these, task completion is "not measured". */
  readonly cases?: readonly SkillEvalCase[];
  /** Run the skill on one input and return its output. You wire this to your agent/LLM. */
  readonly runCase?: (skill: SkillDefinition, input: string) => Promise<string>;
  /** Grade whether an output satisfies a case. Defaults to a simple expectation-substring check. */
  readonly judgeCase?: (args: { input: string; output: string; expectation?: string }) => Promise<{ pass: boolean; reason?: string }>;
  /** Optional LLM judge for the qualitative dimensions (reusability/composability/maintainability). */
  readonly judge?: SkillJudge;
  /** Override the dimension weights (defaults: completion .4, reusability .2, composability .2, maintainability .2). */
  readonly weights?: Partial<Record<SkillEvalDimension, number>>;
  readonly thresholds?: { overall?: number; taskCompletion?: number };
}

const DEFAULT_WEIGHTS: Record<SkillEvalDimension, number> = { taskCompletion: 0.4, reusability: 0.2, composability: 0.2, maintainability: 0.2 };
const DEFAULT_THRESHOLDS = { overall: 0.7, taskCompletion: 0.8 };

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

// ── Heuristic scorers (no model needed) ──────────────────────────────────────────────────────────

function scoreComposability(skill: SkillDefinition): DimensionScore {
  const reasons: string[] = [];
  let s = 0.2; // a bare skill is minimally composable
  if (skill.provides?.length) { s += 0.3; reasons.push('declares typed outputs (provides)'); }
  if (skill.precondition?.requires?.length) { s += 0.2; reasons.push('declares typed inputs (precondition)'); }
  if (skill.requires?.length || skill.composesWith?.length) { s += 0.15; reasons.push('declares relationships to other skills'); }
  if (skill.conflictsWith?.length) { s += 0.1; reasons.push('declares conflicts (safe to plan around)'); }
  if (skill.toolNames?.length) { s += 0.05; reasons.push('names the tools it uses'); }
  if (!skill.provides?.length && !skill.precondition?.requires?.length) reasons.push('no typed inputs/outputs — hard to order in a plan');
  return { score: clamp01(s), measured: true, reasons };
}

function scoreMaintainability(skill: SkillDefinition): DimensionScore {
  const reasons: string[] = [];
  let s = 0.1;
  if (skill.version) { s += 0.2; reasons.push('versioned'); }
  if ((skill.examples?.length ?? 0) >= 1) { s += 0.2; reasons.push('has worked examples'); }
  if (skill.whenNotToUse) { s += 0.15; reasons.push('says when NOT to use it'); }
  if (skill.completionContract) { s += 0.2; reasons.push('has a definition of done'); }
  const guidance = skill.executionGuidance ?? skill.instructions ?? '';
  if (guidance.length > 40 && guidance.length < 8000) { s += 0.15; reasons.push('guidance is present and reasonably sized'); }
  else if (guidance.length >= 8000) reasons.push('guidance is very long — harder to maintain');
  else reasons.push('little or no execution guidance');
  if ((skill.toolNames?.length ?? 0) > 12) reasons.push('depends on many tools — more brittle');
  return { score: clamp01(s), measured: true, reasons };
}

function scoreReusability(skill: SkillDefinition): DimensionScore {
  const reasons: string[] = [];
  let s = 0.3;
  const examples = skill.examples?.length ?? 0;
  if (examples >= 3) { s += 0.3; reasons.push('several examples → covers varied inputs'); }
  else if (examples >= 1) { s += 0.15; reasons.push('has at least one example'); }
  const when = skill.whenToUse ?? '';
  if (when.length > 30) { s += 0.2; reasons.push('describes a general situation, not one exact request'); }
  if (skill.triggerPatterns?.length) { s += 0.1; reasons.push('recognises multiple phrasings'); }
  // A skill hard-wired to one narrow phrase is less reusable.
  if (when && when.length < 20) reasons.push('when-to-use is very narrow');
  if (skill.category) { s += 0.1; reasons.push('categorised for discovery'); }
  return { score: clamp01(s), measured: true, reasons };
}

// Qualitative dimensions can be refined by an LLM judge scoring against a rubric.
async function judgeQualitative(skill: SkillDefinition, judge: SkillJudge): Promise<Partial<Record<SkillEvalDimension, number>>> {
  const content = [
    `Skill: ${skill.name}`,
    skill.summary && `Summary: ${skill.summary}`,
    skill.whenToUse && `When to use: ${skill.whenToUse}`,
    skill.executionGuidance && `How: ${skill.executionGuidance}`,
    skill.examples?.length ? `Examples: ${skill.examples.length}` : undefined,
  ].filter(Boolean).join('\n');
  const criteria: SkillRubricCriterion[] = [
    { id: 'reusability', description: 'Generalises across many requests rather than one narrow case.', weight: 1 },
    { id: 'composability', description: 'Can be combined with other skills in a larger plan.', weight: 1 },
    { id: 'maintainability', description: 'Clear, well-scoped, and robust to change.', weight: 1 },
  ];
  const r = await judge.score({ content, criteria });
  return r.criteriaScores ?? {};
}

// ── evaluateSkill ──────────────────────────────────────────────────────────────────────────────

/**
 * Score a skill on the four dimensions. Runs `cases` through `runCase` + `judgeCase` to measure task
 * completion; falls back to fast heuristics for the rest, refined by `judge` when supplied.
 */
export async function evaluateSkill(skill: SkillDefinition, opts: EvaluateSkillOptions = {}): Promise<SkillEvaluation> {
  const findings: string[] = [];
  const reusability = scoreReusability(skill);
  const composability = scoreComposability(skill);
  const maintainability = scoreMaintainability(skill);

  // Task completion — actually run the skill on the example cases.
  let taskCompletion: DimensionScore;
  if (opts.cases?.length && opts.runCase) {
    const judgeCase: NonNullable<EvaluateSkillOptions['judgeCase']> = opts.judgeCase ?? (async ({ output, expectation }) => ({
      pass: !expectation || output.toLowerCase().includes(expectation.toLowerCase()),
    }));
    let passed = 0;
    const reasons: string[] = [];
    for (const c of opts.cases) {
      try {
        const output = await opts.runCase(skill, c.input);
        const verdict = await judgeCase({ input: c.input, output, expectation: c.expectation });
        if (verdict.pass) passed++;
        else reasons.push(`failed: "${c.input.slice(0, 50)}"${verdict.reason ? ` — ${verdict.reason}` : ''}`);
      } catch (e) {
        reasons.push(`errored on "${c.input.slice(0, 40)}": ${(e as Error).message}`);
      }
    }
    const rate = passed / opts.cases.length;
    taskCompletion = { score: rate, measured: true, reasons: [`${passed}/${opts.cases.length} cases passed`, ...reasons.slice(0, 5)] };
  } else {
    taskCompletion = { score: 0, measured: false, reasons: ['no example cases provided — task completion not measured'] };
    findings.push('task completion was not measured (no eval cases) — treat the score as provisional');
  }

  // Refine qualitative dimensions with the judge, if provided.
  let rQ = reusability, cQ = composability, mQ = maintainability;
  if (opts.judge) {
    try {
      const j = await judgeQualitative(skill, opts.judge);
      if (typeof j.reusability === 'number') rQ = { ...reusability, score: clamp01((reusability.score + clamp01(j.reusability)) / 2), reasons: [...reusability.reasons, 'refined by judge'] };
      if (typeof j.composability === 'number') cQ = { ...composability, score: clamp01((composability.score + clamp01(j.composability)) / 2), reasons: [...composability.reasons, 'refined by judge'] };
      if (typeof j.maintainability === 'number') mQ = { ...maintainability, score: clamp01((maintainability.score + clamp01(j.maintainability)) / 2), reasons: [...maintainability.reasons, 'refined by judge'] };
    } catch (e) {
      findings.push(`judge errored (${(e as Error).message}); used heuristic scores`);
    }
  }

  const weights = { ...DEFAULT_WEIGHTS, ...opts.weights };
  const dims: Array<[SkillEvalDimension, DimensionScore]> = [
    ['taskCompletion', taskCompletion], ['reusability', rQ], ['composability', cQ], ['maintainability', mQ],
  ];
  let wSum = 0, acc = 0;
  for (const [dim, d] of dims) if (d.measured) { acc += weights[dim] * d.score; wSum += weights[dim]; }
  const overall = wSum > 0 ? acc / wSum : 0;

  const thresholds = { ...DEFAULT_THRESHOLDS, ...opts.thresholds };
  const passed = overall >= thresholds.overall && (!taskCompletion.measured || taskCompletion.score >= thresholds.taskCompletion);
  if (overall < thresholds.overall) findings.push(`overall ${overall.toFixed(2)} is below the ${thresholds.overall} bar`);
  if (taskCompletion.measured && taskCompletion.score < thresholds.taskCompletion) findings.push(`task completion ${taskCompletion.score.toFixed(2)} is below the ${thresholds.taskCompletion} bar`);

  return { skillId: skill.id, reusability: rQ, composability: cQ, maintainability: mQ, taskCompletion, overall, passed, findings };
}

// ── Promotion gating (ties into Phase 3 trust tiers) ─────────────────────────────────────────────

export type SkillTrustTierNum = 1 | 2 | 3 | 4;

export interface PromotionPolicy {
  readonly minOverall?: number;
  readonly minTaskCompletion?: number;
  /** Tiers at or above this need a human sign-off — an eval alone can't promote here (anti-gaming). */
  readonly requireHumanApprovalAtOrAbove?: SkillTrustTierNum;
  /** Tiers at or above this need a valid signature (Phase 3). */
  readonly requireSignatureAtOrAbove?: SkillTrustTierNum;
  /** If a re-evaluation drops overall this far below the baseline, demote a tier. */
  readonly demoteOnRegressionDelta?: number;
}

const DEFAULT_PROMOTION_POLICY: Required<PromotionPolicy> = {
  minOverall: 0.7,
  minTaskCompletion: 0.8,
  requireHumanApprovalAtOrAbove: 3,
  requireSignatureAtOrAbove: 2,
  demoteOnRegressionDelta: 0.15,
};

export interface PromotionInput {
  readonly currentTier: SkillTrustTierNum;
  /** The tier we're considering moving to (usually currentTier + 1). */
  readonly targetTier: SkillTrustTierNum;
  readonly evaluation: SkillEvaluation;
  /** From Phase 3 — is the package validly signed? */
  readonly signatureValid?: boolean;
  /** The human sign-off (the gate a poisoned dataset cannot fake). */
  readonly humanApproved?: boolean;
  /** A previous evaluation, to detect regression. */
  readonly baseline?: SkillEvaluation;
}

export interface PromotionDecision {
  readonly decision: 'promote' | 'hold' | 'demote';
  readonly toTier: SkillTrustTierNum;
  readonly reasons: readonly string[];
}

/**
 * Decide whether a skill should move up, stay, or move down a trust tier. Promotion needs the
 * evaluation to clear the bar, a signature for T2+, and a human sign-off for the high tiers — so an
 * automated (or gamed) eval can never, by itself, push a skill into a powerful tier.
 */
export function evaluatePromotion(input: PromotionInput, policy: PromotionPolicy = {}): PromotionDecision {
  const p = { ...DEFAULT_PROMOTION_POLICY, ...policy };
  const { evaluation: ev, currentTier, targetTier } = input;
  const reasons: string[] = [];

  // Regression → demote (never below T1).
  if (input.baseline) {
    const delta = input.baseline.overall - ev.overall;
    if (delta >= p.demoteOnRegressionDelta) {
      const toTier = Math.max(1, currentTier - 1) as SkillTrustTierNum;
      return { decision: currentTier > 1 ? 'demote' : 'hold', toTier, reasons: [`regressed ${delta.toFixed(2)} below baseline — demoting`] };
    }
  }

  const clears = ev.passed && ev.overall >= p.minOverall && (!ev.taskCompletion.measured || ev.taskCompletion.score >= p.minTaskCompletion);
  if (!clears) { reasons.push('evaluation did not clear the promotion bar'); return { decision: 'hold', toTier: currentTier, reasons }; }
  if (targetTier <= currentTier) { reasons.push('no higher tier requested'); return { decision: 'hold', toTier: currentTier, reasons }; }

  if (targetTier >= p.requireSignatureAtOrAbove && !input.signatureValid) {
    reasons.push(`tier T${targetTier} requires a valid signature — held`);
    return { decision: 'hold', toTier: currentTier, reasons };
  }
  if (targetTier >= p.requireHumanApprovalAtOrAbove && !input.humanApproved) {
    reasons.push(`tier T${targetTier} requires human approval — an evaluation alone cannot promote here`);
    // Promote as far as the automated gate allows (just below the human-gated tier), never higher.
    const autoCeiling = Math.max(currentTier, (p.requireHumanApprovalAtOrAbove - 1) as SkillTrustTierNum) as SkillTrustTierNum;
    const toTier = Math.min(autoCeiling, targetTier) as SkillTrustTierNum;
    return { decision: toTier > currentTier ? 'promote' : 'hold', toTier, reasons };
  }

  reasons.push(`evaluation cleared the bar → promoting to T${targetTier}`);
  return { decision: 'promote', toTier: targetTier, reasons };
}

// ── Lifecycle ──────────────────────────────────────────────────────────────────────────────────

export type SkillLifecycleState = 'draft' | 'active' | 'deprecated' | 'retired';

export interface SkillDeprecation {
  readonly reason: string;
  /** The id of the skill to use instead, if any. */
  readonly replacedBy?: string;
  readonly since?: string;
}

/** Mark a skill deprecated — still usable (with a warning), but pointing users at a replacement. */
export function deprecateSkill(skill: SkillDefinition, deprecation: SkillDeprecation): SkillDefinition {
  return { ...skill, lifecycle: 'deprecated', deprecation };
}

/** Retire a skill — it is disabled and should no longer be offered or run. */
export function retireSkill(skill: SkillDefinition, reason: string, since?: string): SkillDefinition {
  return { ...skill, lifecycle: 'retired', enabled: false, deprecation: { reason, since } };
}

/** Whether a skill may still be offered/run. Retired skills cannot; deprecated ones can (with a warning). */
export function isSkillUsable(skill: SkillDefinition): boolean {
  const state = skill.lifecycle ?? 'active';
  if (state === 'retired') return false;
  if (skill.enabled === false) return false;
  return true;
}

/**
 * Given a fresh evaluation (and an optional baseline), decide the next lifecycle state. A healthy
 * skill stays active; a regressed one is demoted to deprecated so users are steered elsewhere while it
 * is fixed — the "demote after repair" pattern.
 */
export function lifecycleForEvaluation(
  current: SkillLifecycleState,
  evaluation: SkillEvaluation,
  opts: { baseline?: SkillEvaluation; regressionDelta?: number; reason?: string } = {},
): { next: SkillLifecycleState; changed: boolean; reason?: string } {
  const regressionDelta = opts.regressionDelta ?? 0.15;
  if (current === 'retired') return { next: 'retired', changed: false };
  if (opts.baseline && opts.baseline.overall - evaluation.overall >= regressionDelta) {
    if (current !== 'deprecated') return { next: 'deprecated', changed: true, reason: opts.reason ?? 'regressed against its baseline' };
    return { next: 'deprecated', changed: false };
  }
  if (current === 'draft' && evaluation.passed) return { next: 'active', changed: true, reason: 'passed evaluation' };
  return { next: current, changed: false };
}
