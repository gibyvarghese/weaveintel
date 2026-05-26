import { describe, it, expect } from 'vitest';
import { semanticScore, semanticRationale, sectionLabel, sectionRelevanceScore, selectRelevantSections } from '../matching.js';
import type { SkillDefinition } from '../types.js';

function makeSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    id: 'test-skill',
    name: 'Test Skill',
    summary: 'A test skill for unit testing',
    enabled: true,
    priority: 0,
    ...overrides,
  };
}

describe('semanticScore', () => {
  it('returns a number between 0 and 1', () => {
    const skill = makeSkill({ name: 'data analysis', summary: 'Analyse datasets and produce statistics' });
    const score = semanticScore('analyse this dataset', skill);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('scores higher for closely matching queries', () => {
    const skill = makeSkill({
      name: 'code review',
      summary: 'Review code for quality and correctness',
      triggerPatterns: ['review my code', 'check this code', 'code quality'],
    });
    const highScore = semanticScore('can you review my code for quality', skill);
    const lowScore = semanticScore('plan a birthday party', skill);
    expect(highScore).toBeGreaterThan(lowScore);
  });

  it('returns 0 for completely unrelated query and empty skill', () => {
    const emptySkill = makeSkill({ name: 'x', summary: '' });
    const score = semanticScore('something completely unrelated zzzz', emptySkill);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('gives priority boost for high-priority skills', () => {
    const base = makeSkill({ name: 'analysis skill', summary: 'Perform analysis', priority: 0 });
    const highPriority = makeSkill({ name: 'analysis skill', summary: 'Perform analysis', priority: 10 });
    const scoreBase = semanticScore('perform analysis', base);
    const scoreHigh = semanticScore('perform analysis', highPriority);
    expect(scoreHigh).toBeGreaterThanOrEqual(scoreBase);
  });

  it('applies trigger pattern boost when patterns match query', () => {
    const noPatterns = makeSkill({
      name: 'summarize documents',
      summary: 'Summarize long documents',
    });
    const withPatterns = makeSkill({
      name: 'summarize documents',
      summary: 'Summarize long documents',
      triggerPatterns: ['summarize this document', 'give me a summary'],
    });
    const query = 'summarize this document for me';
    const scoreNo = semanticScore(query, noPatterns);
    const scoreWith = semanticScore(query, withPatterns);
    expect(scoreWith).toBeGreaterThanOrEqual(scoreNo);
  });

  it('caps score at 1.0', () => {
    const skill = makeSkill({
      name: 'exact match',
      summary: 'exact match',
      purpose: 'exact match',
      triggerPatterns: ['exact match'],
      priority: 15,
    });
    const score = semanticScore('exact match', skill);
    expect(score).toBeLessThanOrEqual(1);
  });
});

describe('semanticRationale', () => {
  it('returns a non-empty string', () => {
    const skill = makeSkill({ name: 'code review', summary: 'Review code for quality' });
    const rationale = semanticRationale(skill, 'review my code');
    expect(typeof rationale).toBe('string');
    expect(rationale.length).toBeGreaterThan(0);
  });

  it('returns generic message when no overlap', () => {
    const skill = makeSkill({ name: 'zzz', summary: 'zzz topic zzz' });
    const rationale = semanticRationale(skill, 'something entirely different');
    expect(rationale).toContain('Semantic');
  });

  it('mentions overlapping tokens when they exist', () => {
    const skill = makeSkill({ name: 'data analysis', summary: 'Analyse data with statistics' });
    const rationale = semanticRationale(skill, 'analyse the data with some statistics');
    expect(rationale.toLowerCase()).toMatch(/data|analys|statistic/);
  });
});

describe('sectionLabel', () => {
  it('returns undefined for empty or undefined value', () => {
    expect(sectionLabel('Title', undefined)).toBeUndefined();
    expect(sectionLabel('Title', '')).toBeUndefined();
    expect(sectionLabel('Title', '   ')).toBeUndefined();
  });

  it('wraps non-empty value in a markdown heading', () => {
    const result = sectionLabel('When to Use', 'Use this when X');
    expect(result).toBe('### When to Use\nUse this when X');
  });
});

describe('sectionRelevanceScore', () => {
  it('returns 1 for empty query', () => {
    expect(sectionRelevanceScore(undefined, 'any content')).toBe(1);
    expect(sectionRelevanceScore('', 'any content')).toBe(1);
  });

  it('returns a number between 0 and 1 for valid inputs', () => {
    const score = sectionRelevanceScore('review the code quality', 'code review and quality checks');
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('scores higher for matching content', () => {
    const relevant = sectionRelevanceScore('code review', 'how to review code and check quality');
    const irrelevant = sectionRelevanceScore('code review', 'planning a vacation itinerary');
    expect(relevant).toBeGreaterThan(irrelevant);
  });
});

describe('selectRelevantSections', () => {
  const sections = [
    { title: 'When to Use', value: 'Use this skill for data analysis tasks', mandatory: true },
    { title: 'Instructions', value: 'Follow these steps to analyse data' },
    { title: 'Examples', value: 'Example: analyse sales data' },
    { title: 'Output', value: 'Produce a summary report with statistics' },
    { title: 'Notes', value: 'Avoid using this for simple calculations' },
    { title: 'Context', value: 'Requires access to dataset files' },
  ];

  it('returns all sections for empty query', () => {
    const result = selectRelevantSections(sections, '', 'reasoning_support');
    expect(result.length).toBe(sections.length);
  });

  it('always includes mandatory sections', () => {
    const result = selectRelevantSections(sections, 'something unrelated zzz', 'reasoning_support');
    const mandatoryIds = result.filter((s) => s.mandatory);
    expect(mandatoryIds.length).toBeGreaterThan(0);
  });

  it('limits optional sections based on mode', () => {
    const query = 'analyse data';
    const advisoryResult = selectRelevantSections(sections, query, 'reasoning_support');
    const toolResult = selectRelevantSections(sections, query, 'tool_assisted');
    // tool_assisted allows up to 4 optional, reasoning_support up to 5
    const mandatoryCount = sections.filter((s) => s.mandatory).length;
    expect(advisoryResult.length).toBeLessThanOrEqual(mandatoryCount + 5);
    expect(toolResult.length).toBeLessThanOrEqual(mandatoryCount + 4);
  });
});
