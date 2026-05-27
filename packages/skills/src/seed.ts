/**
 * @weaveintel/skills — Seed helper
 *
 * Export: `mapSkillToRow()` — converts a `SkillDefinition` to the DB row
 * shape expected by `db.createSkill()`. This eliminates the mapping boilerplate
 * that would otherwise be duplicated in every app that seeds BUILT_IN_SKILLS.
 *
 * @example
 * ```ts
 * import { BUILT_IN_SKILLS } from '@weaveintel/skills';
 * import { mapSkillToRow } from '@weaveintel/skills/seed';
 *
 * const existing = await db.listSkills();
 * if (existing.length === 0) {
 *   for (const s of BUILT_IN_SKILLS) await db.createSkill(mapSkillToRow(s));
 * }
 * ```
 */

import type { SkillDefinition } from './types.js';

export type SkillSeedRow = {
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
  enabled: 0 | 1;
  tool_policy_key: string | null;
};

export function mapSkillToRow(s: SkillDefinition): SkillSeedRow {
  return {
    id:               s.id,
    name:             s.name,
    description:      s.description ?? s.summary,
    category:         s.category ?? 'general',
    trigger_patterns: JSON.stringify(s.triggerPatterns ?? []),
    instructions:     s.instructions ?? s.executionGuidance ?? s.summary,
    tool_names:       s.toolNames?.length ? JSON.stringify(s.toolNames) : null,
    examples:         (s as { examples?: unknown[] }).examples?.length
                        ? JSON.stringify((s as { examples?: unknown[] }).examples)
                        : null,
    tags:             (s as { tags?: string[] }).tags?.length
                        ? JSON.stringify((s as { tags?: string[] }).tags)
                        : null,
    priority:         s.priority ?? 0,
    version:          s.version ?? '1.0',
    enabled:          s.enabled === false ? 0 : 1,
    tool_policy_key:  s.toolPolicyKey ?? null,
  };
}
