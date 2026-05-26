import type { SkillDefinition, SkillInvocationMode } from './types.js';

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have', 'if', 'in', 'into', 'is', 'it',
  'of', 'on', 'or', 'such', 'that', 'the', 'their', 'then', 'there', 'these', 'this', 'to', 'was', 'will', 'with',
]);

function normalizeText(raw: string | undefined): string {
  return (raw ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenize(raw: string | undefined): string[] {
  const text = normalizeText(raw);
  if (!text) return [];
  return text
    .split(' ')
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

function termFrequency(tokens: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const token of tokens) {
    out.set(token, (out.get(token) ?? 0) + 1);
  }
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

function skillSemanticDocument(skill: SkillDefinition): string {
  const parts = [
    skill.name,
    skill.summary,
    skill.purpose,
    skill.whenToUse,
    skill.whenNotToUse,
    skill.requiredContext,
    skill.helpfulContext,
    skill.reasoningGuidance,
    skill.executionGuidance,
    skill.outputGuidance,
    skill.completionGuidance,
    skill.ambiguityGuidance,
    skill.failureGuidance,
    skill.notes,
    skill.description,
    skill.instructions,
    (skill.tags ?? []).join(' '),
    (skill.triggerPatterns ?? []).join('\n'),
  ];
  return parts.filter(Boolean).join('\n');
}

/**
 * Generic, per-skill DB-driven trigger boost.
 *
 * Each skill row owns `triggerPatterns` (column `trigger_patterns` in the DB).
 * When any of those phrases occur in the user query, we add a deterministic
 * boost so the skill rises above the activation threshold. This is fully
 * generic — no skill IDs, keywords, or domains are hardcoded in the runtime.
 */
function triggerPatternBoost(query: string, skill: SkillDefinition): number {
  const patterns = skill.triggerPatterns ?? [];
  if (!patterns.length) return 0;

  const queryTf = termFrequency(tokenize(query));
  const patternDoc = patterns.join(' ');
  const patternTf = termFrequency(tokenize(patternDoc));
  const similarity = cosineSimilarity(queryTf, patternTf);

  if (similarity <= 0) return 0;
  return Math.min(0.2, similarity * 0.35);
}

export function semanticScore(query: string, skill: SkillDefinition): number {
  const queryTf = termFrequency(tokenize(query));
  const docTf = termFrequency(tokenize(skillSemanticDocument(skill)));
  const intentTf = termFrequency(tokenize([
    skill.name,
    skill.summary,
    skill.purpose,
    skill.whenToUse,
    skill.whenNotToUse,
    (skill.tags ?? []).join(' '),
  ].filter(Boolean).join('\n')));
  const nameTf = termFrequency(tokenize(skill.name));

  const base = cosineSimilarity(queryTf, docTf);
  const intent = cosineSimilarity(queryTf, intentTf);
  const name = cosineSimilarity(queryTf, nameTf);

  const weighted = (base * 0.5) + (intent * 0.35) + (name * 0.15);
  const priorityBoost = Math.min(0.15, (skill.priority ?? 0) * 0.01);
  const triggerBoost = triggerPatternBoost(query, skill);
  return Math.min(1, weighted + priorityBoost + triggerBoost);
}

export function semanticRationale(skill: SkillDefinition, query: string): string {
  const queryTokens = new Set(tokenize(query));
  const docTokens = tokenize(skillSemanticDocument(skill));
  const shared = Array.from(new Set(docTokens.filter((token) => queryTokens.has(token)))).slice(0, 6);
  if (!shared.length) return 'Semantic similarity across narrative sections.';
  return `Semantic overlap on: ${shared.join(', ')}`;
}

export function sectionLabel(title: string, value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  return `### ${title}\n${text}`;
}

export interface PromptSection {
  title: string;
  value: string;
  mandatory?: boolean;
}

export function sectionRelevanceScore(query: string | undefined, value: string): number {
  if (!query?.trim()) return 1;
  const queryTf = termFrequency(tokenize(query));
  const valueTf = termFrequency(tokenize(value));
  return cosineSimilarity(queryTf, valueTf);
}

export function selectRelevantSections(
  sections: PromptSection[],
  query: string | undefined,
  mode: SkillInvocationMode,
): PromptSection[] {
  if (!query?.trim()) return sections;

  const scored = sections.map((section) => ({
    section,
    score: sectionRelevanceScore(query, section.value),
  }));

  const mandatory = scored
    .filter((item) => item.section.mandatory)
    .map((item) => item.section);

  const optionalPool = scored
    .filter((item) => !item.section.mandatory)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.section);

  const optionalLimit = mode === 'tool_assisted' || mode === 'side_effect_eligible' ? 4 : 5;
  const optional = optionalPool.slice(0, optionalLimit);

  return [...mandatory, ...optional];
}
