import { describe, it, expect } from 'vitest';
import { activateSkills, collectSkillTools, createSkillTelemetry, keepIfCategory } from '../activation.js';
import type { SkillDefinition, SkillMatch } from '../types.js';

function makeSkill(id: string, overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    id,
    name: `Skill ${id}`,
    summary: `Summary for skill ${id}`,
    enabled: true,
    priority: 0,
    ...overrides,
  };
}

function makeMatch(skill: SkillDefinition, score = 0.5): SkillMatch {
  return { skill, score, matchedPatterns: [], rationale: 'test', source: 'semantic' };
}

describe('keepIfCategory', () => {
  it('returns true when no categories filter is given', () => {
    const skill = makeSkill('s', { category: 'research' });
    expect(keepIfCategory(skill, undefined)).toBe(true);
    expect(keepIfCategory(skill, [])).toBe(true);
  });

  it('returns true when skill category matches filter', () => {
    const skill = makeSkill('s', { category: 'coding' });
    expect(keepIfCategory(skill, ['coding', 'research'])).toBe(true);
  });

  it('returns false when skill category does not match filter', () => {
    const skill = makeSkill('s', { category: 'analysis' });
    expect(keepIfCategory(skill, ['coding'])).toBe(false);
  });

  it('uses "general" as default category when category is unset', () => {
    const skill = makeSkill('s');
    expect(keepIfCategory(skill, ['general'])).toBe(true);
    expect(keepIfCategory(skill, ['coding'])).toBe(false);
  });
});

describe('collectSkillTools', () => {
  it('returns empty array for no matches', () => {
    expect(collectSkillTools([])).toHaveLength(0);
  });

  it('collects tool names from all matched skills', () => {
    const skill1 = makeSkill('s1', { toolNames: ['web_search', 'calculator'] });
    const skill2 = makeSkill('s2', { toolNames: ['datetime'] });
    const tools = collectSkillTools([makeMatch(skill1), makeMatch(skill2)]);
    expect(tools).toContain('web_search');
    expect(tools).toContain('calculator');
    expect(tools).toContain('datetime');
  });

  it('deduplicates tools across skills', () => {
    const skill1 = makeSkill('s1', { toolNames: ['web_search', 'calculator'] });
    const skill2 = makeSkill('s2', { toolNames: ['web_search', 'datetime'] });
    const tools = collectSkillTools([makeMatch(skill1), makeMatch(skill2)]);
    const searchCount = tools.filter((t) => t === 'web_search').length;
    expect(searchCount).toBe(1);
  });

  it('uses policy.allowedTools over toolNames when set', () => {
    const skill = makeSkill('s1', {
      toolNames: ['web_search', 'calculator'],
      policy: { allowedTools: ['calculator'] },
    });
    const tools = collectSkillTools([makeMatch(skill)]);
    expect(tools).toContain('calculator');
    expect(tools).not.toContain('web_search');
  });

  it('excludes policy.disallowedTools', () => {
    const skill = makeSkill('s1', {
      toolNames: ['web_search', 'calculator', 'datetime'],
      policy: { disallowedTools: ['calculator'] },
    });
    const tools = collectSkillTools([makeMatch(skill)]);
    expect(tools).not.toContain('calculator');
    expect(tools).toContain('web_search');
    expect(tools).toContain('datetime');
  });
});

describe('createSkillTelemetry', () => {
  it('produces a telemetry summary with correct shape', () => {
    const skill = makeSkill('tel-skill', { version: '1.2', tags: ['data', 'analysis'] });
    const telemetry = createSkillTelemetry({ skill, durationMs: 42, selectedBy: 'semantic' });
    expect(telemetry.kind).toBe('skill');
    expect(telemetry.key).toBe('tel-skill');
    expect(telemetry.selectedBy).toBe('semantic');
    expect(telemetry.durationMs).toBe(42);
    expect(telemetry.version).toBe('1.2');
    expect(telemetry.tags).toEqual(['data', 'analysis']);
  });

  it('uses summary as description when available', () => {
    const skill = makeSkill('s', { summary: 'My summary', description: 'My description' });
    const telemetry = createSkillTelemetry({ skill, selectedBy: 'semantic' });
    expect(telemetry.description).toBe('My summary');
  });

  it('falls back to description when summary is absent', () => {
    const skill = makeSkill('s', { summary: undefined, description: 'Only description' });
    const telemetry = createSkillTelemetry({ skill, selectedBy: 'semantic' });
    expect(telemetry.description).toBe('Only description');
  });
});

describe('activateSkills', () => {
  it('returns empty arrays for empty skill list', async () => {
    const result = await activateSkills('some query', []);
    expect(result.selected).toHaveLength(0);
    expect(result.considered).toHaveLength(0);
  });

  it('returns empty selected for an unrelated query', async () => {
    const skills = [
      makeSkill('niche', { name: 'niche xqzf specialization', summary: 'Handles xqzf workflows only', triggerPatterns: ['xqzf'] }),
    ];
    const result = await activateSkills('plan a birthday party for kids', skills);
    expect(result.selected).toHaveLength(0);
  });

  it('selects relevant skills for a matching query', async () => {
    const skills = [
      makeSkill('code-review', {
        name: 'code review',
        summary: 'Review source code for quality, correctness, and maintainability',
        triggerPatterns: ['review my code', 'check code quality', 'code review'],
        enabled: true,
      }),
    ];
    const result = await activateSkills('can you review my code for quality issues', skills);
    expect(result.selected.length).toBeGreaterThan(0);
    expect(result.selected[0]!.skill.id).toBe('code-review');
  });

  it('does not select disabled skills', async () => {
    const skills = [
      makeSkill('disabled', {
        name: 'disabled analysis',
        summary: 'Perform data analysis',
        triggerPatterns: ['analyse data'],
        enabled: false,
      }),
    ];
    const result = await activateSkills('analyse this data', skills);
    expect(result.selected).toHaveLength(0);
  });

  it('respects maxSelected option', async () => {
    const skills = Array.from({ length: 10 }, (_, i) =>
      makeSkill(`skill-${i}`, {
        name: `analysis skill ${i}`,
        summary: `Perform data analysis task variant ${i}`,
        triggerPatterns: [`analyse data ${i}`, 'data analysis'],
        enabled: true,
        priority: i,
      }),
    );
    const result = await activateSkills('data analysis task', skills, { maxSelected: 2 });
    expect(result.selected.length).toBeLessThanOrEqual(2);
  });

  it('orders selected skills by score descending', async () => {
    const skills = [
      makeSkill('high', {
        name: 'high priority analysis',
        summary: 'High-relevance data analysis for statistics reports',
        triggerPatterns: ['data analysis statistics', 'analyse data for reports'],
        priority: 10,
        enabled: true,
      }),
      makeSkill('low', {
        name: 'low relevance general task',
        summary: 'General purpose task handler',
        enabled: true,
      }),
    ];
    const result = await activateSkills('data analysis statistics report', skills);
    if (result.selected.length > 1) {
      expect(result.selected[0]!.score).toBeGreaterThanOrEqual(result.selected[1]!.score);
    }
  });

  it('filters by category', async () => {
    const skills = [
      makeSkill('research-task', { name: 'research analysis', summary: 'Analyse research data', category: 'research', enabled: true }),
      makeSkill('coding-task', { name: 'code analysis', summary: 'Analyse source code', category: 'coding', enabled: true }),
    ];
    const result = await activateSkills('analyse this', skills, { categories: ['research'], minScore: 0 });
    for (const match of result.selected) {
      expect(match.skill.category).toBe('research');
    }
  });
});
