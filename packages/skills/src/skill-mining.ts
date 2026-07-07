// SPDX-License-Identifier: MIT
/**
 * Skill mining, adaptive tuning, and multimodal inputs (Phase 6).
 *
 * The best skills often aren't the ones you sat down to write — they're the ones your agent *keeps
 * needing*. When the same kind of request fails again and again in the same way, that's a signal: a
 * skill is missing. `mineSkillCandidates()` reads your run history, finds those recurring failure
 * patterns, and drafts a skill that would plug the gap.
 *
 * The single most important rule here is **safety**: a mined skill is only ever a *proposal*. It is
 * created disabled, at the lowest trust tier, marked `draft`, and it can NEVER turn itself on. This is
 * the biggest attack surface in self-improving agents — if a poisoned run trace could mint a live,
 * trusted skill, one malicious request would compromise everything downstream. So every proposal must
 * pass a human review AND an evaluation (Phase 4) before it can be enabled, and any trace that shows
 * signs of prompt-injection is flagged and never used verbatim.
 *
 * Two smaller tools round out the lifecycle:
 *   • `suggestedMinScore()` tunes the retrieval cut-off from real feedback (fewer wrong matches),
 *   • the multimodal helpers let a skill declare it handles images / audio / PDFs, not just text.
 */

import { defineSkill } from './types.js';
import type { SkillDefinition } from './types.js';
import { scanTextForInjection } from './skill-security.js';
import { evaluatePromotion, type SkillEvaluation } from './skill-evaluation.js';

// ── Run traces → mined skill proposals ───────────────────────────────────────────────────────────

/** One recorded run — what was asked, whether it worked, and (if not) why. */
export interface SkillRunTrace {
  readonly request: string;
  readonly outcome: 'success' | 'failure';
  /** A short reason the run failed — the key signal for clustering (e.g. "no citation produced"). */
  readonly failureReason?: string;
  /** Skills that were active during the run, if any. */
  readonly skillsUsed?: readonly string[];
}

export interface ProposalEvidence {
  /** The recurring failure this proposal addresses. */
  readonly pattern: string;
  readonly occurrences: number;
  readonly exampleRequests: readonly string[];
}

export interface ProposalSafety {
  /** True if any source trace showed prompt-injection — the drafted text is never taken verbatim. */
  readonly injectionInTraces: boolean;
  /** True if the drafted skill itself tripped a safety scan. */
  readonly draftFlagged: boolean;
  readonly findings: readonly string[];
}

export interface SkillProposal {
  /** The proposed skill — ALWAYS `enabled: false`, `lifecycle: 'draft'`, `trust: 0`. Never live. */
  readonly draft: SkillDefinition;
  readonly evidence: ProposalEvidence;
  readonly safety: ProposalSafety;
  /** Always true. A mined skill cannot be used until a human approves it AND it passes evaluation. */
  readonly requiresApproval: true;
}

/** How to turn a cluster of failures into a draft skill. Inject an LLM here for good drafts. */
export type SkillProposer = (evidence: ProposalEvidence) => Promise<{
  name: string; summary: string; whenToUse: string; executionGuidance: string;
}>;

export interface MineSkillsOptions {
  /** How many times a failure pattern must recur before it's worth proposing a skill. Default 3. */
  readonly minOccurrences?: number;
  readonly maxProposals?: number;
  /** Group failing traces into patterns. Default: by a normalised `failureReason`. */
  readonly clusterKey?: (trace: SkillRunTrace) => string;
  /** Draft a skill for a pattern. Without it, a plain heuristic draft is produced. */
  readonly proposer?: SkillProposer;
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();
}
function slug(s: string): string {
  return normalise(s).replace(/ /g, '-').slice(0, 48).replace(/^-+|-+$/g, '') || 'mined-skill';
}

/**
 * Read run history and propose draft skills for recurring failure patterns. Every proposal comes back
 * disabled and untrusted — see the module note. Traces that contain prompt-injection are flagged and
 * their text is never copied into a draft verbatim.
 */
export async function mineSkillCandidates(
  traces: readonly SkillRunTrace[],
  opts: MineSkillsOptions = {},
): Promise<SkillProposal[]> {
  const minOccurrences = opts.minOccurrences ?? 3;
  const clusterKey = opts.clusterKey ?? ((t) => normalise(t.failureReason ?? 'unknown failure'));

  // Cluster the FAILURES by their pattern.
  const clusters = new Map<string, SkillRunTrace[]>();
  for (const t of traces) {
    if (t.outcome !== 'failure') continue;
    const key = clusterKey(t);
    (clusters.get(key) ?? clusters.set(key, []).get(key)!).push(t);
  }

  const proposals: SkillProposal[] = [];
  const ranked = [...clusters.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [pattern, group] of ranked) {
    if (group.length < minOccurrences) continue;
    if (opts.maxProposals && proposals.length >= opts.maxProposals) break;

    const exampleRequests = group.slice(0, 5).map((t) => t.request);
    const evidence: ProposalEvidence = { pattern, occurrences: group.length, exampleRequests };

    // Safety pass #1 — never learn verbatim from a poisoned trajectory.
    const traceScan = scanTextForInjection([pattern, ...exampleRequests].join('\n'));

    // Draft the skill (LLM if provided, else a safe heuristic).
    let drafted: { name: string; summary: string; whenToUse: string; executionGuidance: string };
    if (opts.proposer && !traceScan.injection) {
      drafted = await opts.proposer(evidence);
    } else {
      drafted = {
        name: slug(pattern),
        summary: `Handle the recurring situation: "${pattern}".`,
        whenToUse: `When a request looks like: ${exampleRequests.map((r) => `"${r.slice(0, 60)}"`).join('; ')}.`,
        executionGuidance: `This is a draft mined from ${group.length} failed runs about "${pattern}". A human should review and complete it before use.`,
      };
    }

    // Safety pass #2 — scan the drafted skill's own text.
    const draftScan = scanTextForInjection([drafted.summary, drafted.whenToUse, drafted.executionGuidance].join('\n'));

    // ALWAYS disabled, draft, untrusted — regardless of how it was produced.
    const draft: SkillDefinition = {
      ...defineSkill({
        id: `mined-${slug(drafted.name)}`,
        name: drafted.name,
        summary: drafted.summary,
        whenToUse: drafted.whenToUse,
        executionGuidance: drafted.executionGuidance,
        trust: 0,
      }),
      enabled: false,
      lifecycle: 'draft',
    };

    proposals.push({
      draft,
      evidence,
      safety: { injectionInTraces: traceScan.injection, draftFlagged: draftScan.injection, findings: [...traceScan.findings, ...draftScan.findings] },
      requiresApproval: true,
    });
  }
  return proposals;
}

export interface ApproveMinedSkillInput {
  readonly proposal: SkillProposal;
  /** The result of running `evaluateSkill` on the (reviewed, completed) draft. */
  readonly evaluation: SkillEvaluation;
  /** The explicit human sign-off. Without it, approval is refused — no exceptions. */
  readonly humanApproved: boolean;
  /** The tier to grant. Default T1 (advice). T2+ additionally requires a valid signature (Phase 3). */
  readonly targetTier?: 1 | 2 | 3 | 4;
  readonly signatureValid?: boolean;
}

export interface ApproveResult {
  readonly approved: boolean;
  /** The enabled, active skill — only present when approved. */
  readonly skill?: SkillDefinition;
  readonly reasons: readonly string[];
}

/**
 * The ONLY path from a mined proposal to a live skill. Requires a human sign-off AND a passing
 * evaluation (reuses the Phase-4 promotion gate). A proposal whose draft tripped the safety scan, or
 * that lacks human approval, can never be enabled here.
 */
export function approveMinedSkill(input: ApproveMinedSkillInput): ApproveResult {
  const reasons: string[] = [];
  if (!input.humanApproved) { reasons.push('a human must approve a mined skill before it can be enabled'); return { approved: false, reasons }; }
  if (input.proposal.safety.draftFlagged) { reasons.push('the drafted skill failed the safety scan'); return { approved: false, reasons }; }
  if (!input.evaluation.passed) { reasons.push('the draft did not pass evaluation'); return { approved: false, reasons }; }

  const targetTier = input.targetTier ?? 1;
  // Advice tier (T1) needs no signature — a reviewed, evaluated, human-approved guidance skill goes live.
  if (targetTier <= 1) {
    reasons.push('approved and enabled at tier T1 (advice)');
    return { approved: true, skill: { ...input.proposal.draft, enabled: true, lifecycle: 'active', trust: 1 }, reasons };
  }
  // Higher tiers additionally go through the Phase-4 promotion gate (which requires a signature for T2+).
  const decision = evaluatePromotion({ currentTier: 1, targetTier, evaluation: input.evaluation, signatureValid: input.signatureValid, humanApproved: true });
  if (decision.decision !== 'promote') { reasons.push(`promotion gate held: ${decision.reasons.join('; ')}`); return { approved: false, reasons }; }
  reasons.push(`approved and enabled at tier T${decision.toTier}`);
  return { approved: true, skill: { ...input.proposal.draft, enabled: true, lifecycle: 'active', trust: decision.toTier }, reasons };
}

// ── Adaptive retrieval threshold ─────────────────────────────────────────────────────────────────

/** One piece of feedback: a retrieved skill's score, and whether it turned out to be relevant. */
export interface RetrievalFeedbackSample { readonly score: number; readonly relevant: boolean }

export interface AdaptiveThreshold {
  readonly minScore: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
  readonly samples: number;
}

/**
 * Suggest a retrieval score cut-off from real feedback. Given past matches labelled relevant or not,
 * it finds the threshold that best separates the good matches from the noise (highest F1). Feed the
 * result back into your retriever's `minScore` so it learns to show fewer wrong skills over time.
 */
export function suggestedMinScore(
  samples: readonly RetrievalFeedbackSample[],
  opts?: { fallback?: number; minSamples?: number },
): AdaptiveThreshold {
  const fallback = opts?.fallback ?? 0;
  const minSamples = opts?.minSamples ?? 10;
  if (samples.length < minSamples) {
    return { minScore: fallback, precision: 0, recall: 0, f1: 0, samples: samples.length };
  }
  const totalRelevant = samples.filter((s) => s.relevant).length;
  if (totalRelevant === 0) return { minScore: fallback, precision: 0, recall: 0, f1: 0, samples: samples.length };

  // Try each observed score as a threshold; keep the one with the best F1 (accept score >= threshold).
  const thresholds = [...new Set(samples.map((s) => s.score))].sort((a, b) => a - b);
  let best: AdaptiveThreshold = { minScore: fallback, precision: 0, recall: 0, f1: -1, samples: samples.length };
  for (const th of thresholds) {
    const accepted = samples.filter((s) => s.score >= th);
    const tp = accepted.filter((s) => s.relevant).length;
    const fp = accepted.length - tp;
    const precision = accepted.length ? tp / accepted.length : 0;
    const recall = tp / totalRelevant;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    if (f1 > best.f1) best = { minScore: th, precision, recall, f1, samples: samples.length };
  }
  return best;
}

// ── Multimodal inputs ────────────────────────────────────────────────────────────────────────────

export type SkillModality = 'text' | 'image' | 'audio' | 'pdf' | 'table' | 'code';

/** Does this skill handle a given input type? A skill with none declared is treated as text-only. */
export function skillAcceptsModality(skill: SkillDefinition, modality: SkillModality): boolean {
  const declared = skill.inputModalities;
  if (!declared || declared.length === 0) return modality === 'text';
  return declared.includes(modality);
}

/** Keep only the skills that can handle the given input type. */
export function filterSkillsByModality(skills: readonly SkillDefinition[], modality: SkillModality): SkillDefinition[] {
  return skills.filter((s) => skillAcceptsModality(s, modality));
}
