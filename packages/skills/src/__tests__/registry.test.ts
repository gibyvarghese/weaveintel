import { describe, it, expect } from 'vitest';
import { createSkillRegistry } from '../registry.js';
import type { SkillDefinition } from '../types.js';

function makeSkill(id: string, overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    id,
    name: `Skill ${id}`,
    summary: `Summary for ${id}`,
    enabled: true,
    priority: 0,
    ...overrides,
  };
}

describe('createSkillRegistry', () => {
  it('starts empty', () => {
    const registry = createSkillRegistry();
    expect(registry.list()).toHaveLength(0);
  });

  it('registers and retrieves a skill by id', () => {
    const registry = createSkillRegistry();
    const skill = makeSkill('skill-1');
    registry.register(skill);
    expect(registry.get('skill-1')).toBeDefined();
    expect(registry.get('skill-1')!.id).toBe('skill-1');
  });

  it('lists all registered skills', () => {
    const registry = createSkillRegistry();
    registry.register(makeSkill('a'));
    registry.register(makeSkill('b'));
    registry.register(makeSkill('c'));
    expect(registry.list()).toHaveLength(3);
  });

  it('overwrites a skill registered with the same id', () => {
    const registry = createSkillRegistry();
    registry.register(makeSkill('dup', { name: 'Original' }));
    registry.register(makeSkill('dup', { name: 'Updated' }));
    expect(registry.list()).toHaveLength(1);
    expect(registry.get('dup')!.name).toBe('Updated');
  });

  it('unregisters a skill by id', () => {
    const registry = createSkillRegistry();
    registry.register(makeSkill('remove-me'));
    registry.unregister('remove-me');
    expect(registry.get('remove-me')).toBeUndefined();
    expect(registry.list()).toHaveLength(0);
  });

  it('unregistering a non-existent skill is a no-op', () => {
    const registry = createSkillRegistry();
    expect(() => registry.unregister('does-not-exist')).not.toThrow();
  });

  describe('discover', () => {
    it('returns empty array when no skills are registered', () => {
      const registry = createSkillRegistry();
      expect(registry.discover('some query')).toHaveLength(0);
    });

    it('returns skills sorted by score descending', () => {
      const registry = createSkillRegistry();
      registry.register(makeSkill('data', {
        name: 'data analysis',
        summary: 'Analyse data and produce statistical reports',
        triggerPatterns: ['analyse data', 'data analysis'],
      }));
      registry.register(makeSkill('code', {
        name: 'code review',
        summary: 'Review source code for quality',
        triggerPatterns: ['review code', 'code quality'],
      }));
      const results = registry.discover('analyse this data for statistics');
      if (results.length > 1) {
        expect(results[0]!.score).toBeGreaterThanOrEqual(results[1]!.score);
      }
    });

    it('excludes disabled skills', () => {
      const registry = createSkillRegistry();
      registry.register(makeSkill('disabled', { enabled: false, name: 'disabled skill', summary: 'disabled' }));
      registry.register(makeSkill('active', { enabled: true, name: 'active skill', summary: 'active analysis' }));
      const results = registry.discover('analysis', { minScore: 0 });
      const ids = results.map((r) => r.skill.id);
      expect(ids).not.toContain('disabled');
    });

    it('respects maxSkills option', () => {
      const registry = createSkillRegistry();
      for (let i = 0; i < 10; i++) {
        registry.register(makeSkill(`skill-${i}`, { name: `analysis skill ${i}`, summary: `Perform analysis task ${i}` }));
      }
      const results = registry.discover('analysis task', { maxSkills: 2, minScore: 0 });
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('respects minScore threshold', () => {
      const registry = createSkillRegistry();
      registry.register(makeSkill('irrelevant', { name: 'unrelated topic', summary: 'Something about cooking recipes' }));
      const results = registry.discover('complex data analysis report', { minScore: 0.5 });
      for (const r of results) {
        expect(r.score).toBeGreaterThanOrEqual(0.5);
      }
    });

    it('filters by category when categories option is supplied', () => {
      const registry = createSkillRegistry();
      registry.register(makeSkill('research-skill', { name: 'research task', summary: 'Research analysis', category: 'research' }));
      registry.register(makeSkill('coding-skill', { name: 'code review task', summary: 'Code review analysis', category: 'coding' }));
      const results = registry.discover('analysis task', { categories: ['coding'], minScore: 0 });
      for (const r of results) {
        expect(r.skill.category).toBe('coding');
      }
    });
  });

  describe('activate', () => {
    it('returns a SkillActivationResult with selected and considered arrays', async () => {
      const registry = createSkillRegistry();
      registry.register(makeSkill('analysis', {
        name: 'data analysis',
        summary: 'Analyse datasets and produce reports',
        triggerPatterns: ['analyse data', 'analysis report'],
      }));
      const result = await registry.activate('analyse this dataset');
      expect(Array.isArray(result.selected)).toBe(true);
      expect(Array.isArray(result.considered)).toBe(true);
    });

    it('returns empty selected for unrelated query', async () => {
      const registry = createSkillRegistry();
      registry.register(makeSkill('niche', {
        name: 'obscure specialization xqzf',
        summary: 'Handles xqzf-specific workflows',
      }));
      const result = await registry.activate('plan my birthday party');
      expect(result.selected.length).toBe(0);
    });
  });
});
