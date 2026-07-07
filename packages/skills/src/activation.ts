import type { CapabilityTelemetrySummary } from '@weaveintel/core';
import type {
  SkillDefinition,
  SkillMatch,
  SkillActivationOptions,
  SkillActivationResult,
  SkillCompletionEvaluation,
  SkillLifecycleHooks,
  SkillCategory,
} from './types.js';
import { applySkillOverlays } from './types.js';
import { semanticScore, semanticRationale } from './matching.js';
import { candidatesToMatches } from './retrieval.js';

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

export function keepIfCategory(skill: SkillDefinition, categories: SkillCategory[] | undefined): boolean {
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
  const eligible = overlaid
    .filter((skill) => skill.enabled !== false)
    .filter((skill) => keepIfCategory(skill, opts.categories));

  let considered: SkillMatch[];
  if (opts.retriever) {
    // Pluggable candidate stage (embedding / hybrid). Keeps the rest of the pipeline
    // (selector → policy) identical; only *how candidates are found* changes.
    const cands = await opts.retriever.retrieve(query, eligible, { limit: maxCandidates, minScore });
    considered = candidatesToMatches(cands);
  } else {
    // Default: built-in lexical (word-overlap / TF-cosine) scoring.
    considered = eligible
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
  }

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
