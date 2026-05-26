import type {
  SkillDefinition,
  SkillMatch,
  SkillActivationOptions,
  SkillActivationResult,
  SkillDiscoveryOptions,
  SkillRegistry,
  SkillCategory,
} from './types.js';
import { defineSkill } from './types.js';
import { semanticScore, semanticRationale } from './matching.js';
import { keepIfCategory, activateSkills } from './activation.js';

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
      const categories = opts.categories as SkillCategory[] | undefined;

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
