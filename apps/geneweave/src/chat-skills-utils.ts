/**
 * GeneWeave chat — skills discovery helpers
 *
 * Extracted from ChatEngine to keep chat.ts focused on orchestration.
 */

import type { Model, ExecutionContext } from '@weaveintel/core';
import {
  activateSkills,
  collectSkillTools,
  createSkillRegistry,
  skillFromRow,
  type SkillMatch,
} from '@weaveintel/skills';
import type { DatabaseAdapter } from './db.js';

// ── Private helper ──────────────────────────────────────────

function normalizeText(raw: string | undefined): string {
  return (raw ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenize(raw: string | undefined): string[] {
  const normalized = normalizeText(raw);
  if (!normalized) return [];
  const stop = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it', 'of', 'on', 'or', 'the', 'to', 'with']);
  return normalized
    .split(' ')
    .filter((token) => token.length > 2 && !stop.has(token));
}

function termFrequency(tokens: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const token of tokens) out.set(token, (out.get(token) ?? 0) + 1);
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

function semanticIntentScore(query: string, corpus: string): number {
  const q = termFrequency(tokenize(query));
  const c = termFrequency(tokenize(corpus));
  return cosineSimilarity(q, c);
}

function normalizeSelectionForIntent(
  query: string,
  candidates: readonly SkillMatch[],
  selectedSkillIds: readonly string[],
  hasTabularAttachment: boolean,
): string[] {
  const tabularIntent = semanticIntentScore(
    query,
    'csv spreadsheet dataset dataframe pandas python analysis chart plot exploratory statistics table columns rows',
  );
  const bankStatementIntent = semanticIntentScore(
    query,
    'bank statement transaction spending expenses merchant subscriptions personal finance income cash flow debt savings',
  );

  const hasDataAnalysisCandidate = candidates.some((candidate) => candidate.skill.id === 'skill-data-analysis-execution');
  const hasBankStatementCandidate = candidates.some((candidate) => candidate.skill.id === 'skill-bank-statement-analysis');

  const selected = [...selectedSkillIds];

  if ((hasTabularAttachment || tabularIntent >= 0.2) && bankStatementIntent < 0.14 && hasDataAnalysisCandidate) {
    if (!selected.includes('skill-data-analysis-execution')) {
      selected.unshift('skill-data-analysis-execution');
    }

    if (hasBankStatementCandidate) {
      const pruned = selected.filter((id) => id !== 'skill-bank-statement-analysis');
      return pruned.slice(0, 3);
    }
  }

  return selected.slice(0, 3);
}

async function reasonAboutSkillSelection(
  model: Model,
  ctx: ExecutionContext,
  query: string,
  mode: string,
  candidates: readonly SkillMatch[],
  parseJson: (text: string) => unknown,
  hasTabularAttachment: boolean,
): Promise<{ selectedSkillIds: string[]; rationale?: string; useNoSkillPath?: boolean } | null> {
  if (candidates.length <= 1) {
    return {
      selectedSkillIds: candidates.map((candidate) => candidate.skill.id),
      rationale: 'Only one semantic candidate available.',
    };
  }

  const compactCandidates = candidates.map((candidate, index) => ({
    rank: index + 1,
    id: candidate.skill.id,
    name: candidate.skill.name,
    score: Number(candidate.score.toFixed(3)),
    summary: candidate.skill.summary,
    whenToUse: candidate.skill.whenToUse,
    whenNotToUse: candidate.skill.whenNotToUse,
    policy: candidate.skill.policy,
  }));

  const selectionPrompt = [
    'Select the best skills for this request from the candidate list.',
    'Prioritize semantic fit, completion quality, and policy-safe execution.',
    'You may choose 0..3 skills. Choose zero if none fit.',
    'Respond ONLY as JSON with shape: {"selectedSkillIds": string[], "useNoSkillPath": boolean, "rationale": string }.',
    '',
    `Invocation mode: ${mode}`,
    `User request: ${query}`,
    `Candidates: ${JSON.stringify(compactCandidates)}`,
  ].join('\n');

  try {
    const response = await model.generate(ctx, {
      messages: [
        {
          role: 'system',
          content: 'You are a skill selector. Return strict JSON and prefer no skill over weak skill fit.',
        },
        {
          role: 'user',
          content: selectionPrompt,
        },
      ],
      temperature: 0,
      maxTokens: 350,
    });

    const parsed = parseJson(response.content);
    if (!parsed || typeof parsed !== 'object') return null;

    const rec = parsed as Record<string, unknown>;
    const selectedRaw = Array.isArray(rec['selectedSkillIds']) ? rec['selectedSkillIds'] : [];
    const selectedSkillIds = selectedRaw
      .filter((item): item is string => typeof item === 'string')
      .filter((id) => candidates.some((candidate) => candidate.skill.id === id))
      .slice(0, 3);

    const normalizedSelected = normalizeSelectionForIntent(query, candidates, selectedSkillIds, hasTabularAttachment);

    const useNoSkillPath = rec['useNoSkillPath'] === true;
    const rationale = typeof rec['rationale'] === 'string' ? rec['rationale'] : undefined;

    return { selectedSkillIds: normalizedSelected, useNoSkillPath, rationale };
  } catch {
    return null;
  }
}

// ── Exported helpers ────────────────────────────────────────

export async function discoverSkillsForInput(
  db: DatabaseAdapter,
  userContent: string,
  model: Model,
  ctx: ExecutionContext,
  mode: 'direct' | 'agent' | 'supervisor',
  parseJson: (text: string) => unknown,
  runtimeHints?: { hasTabularAttachment?: boolean },
): Promise<{ matches: SkillMatch[]; toolNames: string[] }> {
  try {
    const rows = await db.listEnabledSkills();
    if (!rows.length) return { matches: [], toolNames: [] };

    const registry = createSkillRegistry();
    for (const row of rows) {
      registry.register(skillFromRow(row));
    }

    const allSkills = registry.list();
    const hasTabularAttachment = runtimeHints?.hasTabularAttachment === true;

    const activation = await activateSkills(userContent, allSkills, {
      maxCandidates: 6,
      maxSelected: 3,
      minScore: 0.08,
      mode: mode === 'direct' ? 'advisory' : 'tool_assisted',
      context: { chatMode: mode },
      selector: async ({ query, mode: invokeMode, candidates }) => {
        const decision = await reasonAboutSkillSelection(model, ctx, query, invokeMode, candidates, parseJson, hasTabularAttachment);
        if (!decision) {
          return {
            selectedSkillIds: normalizeSelectionForIntent(
              query,
              candidates,
              candidates.slice(0, 3).map((candidate) => candidate.skill.id),
              hasTabularAttachment,
            ),
            rationale: 'Fallback to semantic ranking because reasoning selector did not return a valid decision.',
          };
        }
        return decision;
      },
      policyEvaluator: ({ skill, mode: invokeMode }) => {
        const disallowed = skill.policy?.sideEffectsAllowed === false && invokeMode === 'side_effect_eligible';
        if (disallowed) {
          return { allowed: false, reason: 'Skill blocks side-effect eligible execution in current mode.' };
        }
        return {
          allowed: true,
          enforcedAllowedTools: skill.policy?.allowedTools,
        };
      },
    });

    let matches = [...activation.selected];

    if (hasTabularAttachment && mode !== 'direct') {
      const dataSkill = allSkills.find((skill) => skill.id === 'skill-data-analysis-execution' && skill.enabled !== false);
      if (dataSkill && !matches.some((match) => match.skill.id === dataSkill.id)) {
        const syntheticScore = Math.max(0.25, matches[0]?.score ?? 0.25);
        matches = [
          {
            skill: dataSkill,
            score: syntheticScore,
            matchedPatterns: [],
            rationale: 'Tabular attachment detected; data-analysis execution skill is required for reliable analysis.',
            source: 'reasoning' as const,
          },
          ...matches,
        ]
          .filter((item, index, arr) => arr.findIndex((x) => x.skill.id === item.skill.id) === index)
          .slice(0, 3);
      }

      const bankIntentScore = semanticIntentScore(
        userContent,
        'bank statement transaction spending expenses merchant subscriptions personal finance income cash flow debt savings',
      );
      if (bankIntentScore < 0.14) {
        matches = matches.filter((match) => match.skill.id !== 'skill-bank-statement-analysis');
      }
    }

    const toolNames = collectSkillTools(matches);
    return { matches, toolNames };
  } catch {
    return { matches: [], toolNames: [] };
  }
}
