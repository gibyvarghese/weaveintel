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

async function reasonAboutSkillSelection(
  model: Model,
  ctx: ExecutionContext,
  query: string,
  mode: string,
  candidates: readonly SkillMatch[],
  parseJson: (text: string) => unknown,
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

    const useNoSkillPath = rec['useNoSkillPath'] === true;
    const rationale = typeof rec['rationale'] === 'string' ? rec['rationale'] : undefined;

    return { selectedSkillIds, useNoSkillPath, rationale };
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
): Promise<{ matches: SkillMatch[]; toolNames: string[] }> {
  try {
    const rows = await db.listEnabledSkills();
    if (!rows.length) return { matches: [], toolNames: [] };

    const registry = createSkillRegistry();
    for (const row of rows) {
      registry.register(skillFromRow(row));
    }

    const allSkills = registry.list();
    const activation = await activateSkills(userContent, allSkills, {
      maxCandidates: 6,
      maxSelected: 3,
      minScore: 0.12,
      mode: mode === 'direct' ? 'advisory' : 'tool_assisted',
      context: { chatMode: mode },
      selector: async ({ query, mode: invokeMode, candidates }) => {
        const decision = await reasonAboutSkillSelection(model, ctx, query, invokeMode, candidates, parseJson);
        if (!decision) {
          return {
            selectedSkillIds: candidates.slice(0, 3).map((candidate) => candidate.skill.id),
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

    const matches = [...activation.selected];
    const toolNames = collectSkillTools(matches);
    return { matches, toolNames };
  } catch {
    return { matches: [], toolNames: [] };
  }
}
