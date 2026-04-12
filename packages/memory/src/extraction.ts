/**
 * @weaveintel/memory — Hybrid memory extraction tools
 *
 * Reusable extraction pipeline that combines deterministic regex rules with
 * optional LLM extraction, then merges results with confidence-aware dedupe.
 */

import type { ExecutionContext } from '@weaveintel/core';

export type ExtractionRuleType = 'self_disclosure' | 'entity_extraction';

export interface MemoryExtractionRule {
  id: string;
  ruleType: ExtractionRuleType;
  entityType?: string | null;
  pattern: string;
  flags?: string | null;
  factsTemplate?: Record<string, unknown> | null;
  priority?: number;
  enabled?: boolean;
}

export interface ExtractedEntity {
  name: string;
  type: string;
  facts: Record<string, unknown>;
  confidence: number;
  source: 'regex' | 'llm';
  ruleId?: string;
}

export interface ExtractionEvent {
  stage: 'self_disclosure' | 'regex_entity' | 'llm_entity' | 'merge';
  source: 'regex' | 'llm' | 'hybrid';
  message: string;
  details?: Record<string, unknown>;
}

export interface MemoryExtractionInput {
  userContent: string;
  assistantContent?: string;
}

export type LlmEntityExtractor = (
  ctx: ExecutionContext,
  input: MemoryExtractionInput,
) => Promise<ExtractedEntity[]>;

export interface MemoryExtractionResult {
  selfDisclosure: boolean;
  entities: ExtractedEntity[];
  events: ExtractionEvent[];
}

function safeRegex(pattern: string, flags?: string | null): RegExp | null {
  try {
    const validFlags = (flags ?? '').replace(/[^dgimsuy]/g, '');
    return new RegExp(pattern, validFlags);
  } catch {
    return null;
  }
}

function normalizeEntityName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function evaluateSelfDisclosureByRules(
  text: string,
  rules: MemoryExtractionRule[],
): { matched: boolean; matchedRuleIds: string[] } {
  const matchedRuleIds: string[] = [];
  const candidates = rules
    .filter((r) => (r.enabled ?? true) && r.ruleType === 'self_disclosure')
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  for (const rule of candidates) {
    const re = safeRegex(rule.pattern, rule.flags);
    if (!re) continue;
    if (re.test(text)) {
      matchedRuleIds.push(rule.id);
    }
  }

  return { matched: matchedRuleIds.length > 0, matchedRuleIds };
}

export function extractEntitiesByRegexRules(
  text: string,
  rules: MemoryExtractionRule[],
): ExtractedEntity[] {
  const candidates = rules
    .filter((r) => (r.enabled ?? true) && r.ruleType === 'entity_extraction')
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  const out: ExtractedEntity[] = [];
  for (const rule of candidates) {
    const re = safeRegex(rule.pattern, rule.flags);
    if (!re) continue;

    const matches = re.global ? [...text.matchAll(re)] : [re.exec(text)].filter(Boolean) as RegExpExecArray[];
    for (const m of matches.slice(0, 5)) {
      const rawName = m[1] ?? '';
      const name = normalizeEntityName(rawName);
      if (!name || name.length > 120) continue;

      out.push({
        name,
        type: rule.entityType ?? 'general',
        facts: { ...(rule.factsTemplate ?? {}) },
        confidence: 0.92,
        source: 'regex',
        ruleId: rule.id,
      });
    }
  }

  return out;
}

export function mergeExtractedEntities(
  entities: ExtractedEntity[],
): ExtractedEntity[] {
  const merged = new Map<string, ExtractedEntity>();

  for (const entity of entities) {
    const key = `${entity.type.toLowerCase()}::${normalizeEntityName(entity.name).toLowerCase()}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...entity,
        name: normalizeEntityName(entity.name),
        confidence: clampConfidence(entity.confidence),
      });
      continue;
    }

    const winner = existing.confidence >= entity.confidence ? existing : entity;
    const loser = winner === existing ? entity : existing;

    merged.set(key, {
      ...winner,
      name: normalizeEntityName(winner.name),
      confidence: clampConfidence(Math.max(existing.confidence, entity.confidence)),
      facts: { ...loser.facts, ...winner.facts },
    });
  }

  return [...merged.values()];
}

export async function runHybridMemoryExtraction(opts: {
  ctx: ExecutionContext;
  input: MemoryExtractionInput;
  rules: MemoryExtractionRule[];
  llmExtractor?: LlmEntityExtractor;
}): Promise<MemoryExtractionResult> {
  const { ctx, input, rules, llmExtractor } = opts;
  const events: ExtractionEvent[] = [];

  const selfDisclosureResult = evaluateSelfDisclosureByRules(input.userContent, rules);
  events.push({
    stage: 'self_disclosure',
    source: 'regex',
    message: selfDisclosureResult.matched ? 'Matched self disclosure rules' : 'No self disclosure rule matched',
    details: { matchedRuleIds: selfDisclosureResult.matchedRuleIds },
  });

  const regexEntities = extractEntitiesByRegexRules(input.userContent, rules);
  events.push({
    stage: 'regex_entity',
    source: 'regex',
    message: `Regex extraction produced ${regexEntities.length} entities`,
  });

  let llmEntities: ExtractedEntity[] = [];
  if (llmExtractor) {
    try {
      llmEntities = (await llmExtractor(ctx, input)).map((e) => ({
        ...e,
        name: normalizeEntityName(e.name),
        confidence: clampConfidence(e.confidence),
        source: 'llm',
      }));
      events.push({
        stage: 'llm_entity',
        source: 'llm',
        message: `LLM extraction produced ${llmEntities.length} entities`,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown LLM extractor error';
      events.push({
        stage: 'llm_entity',
        source: 'llm',
        message: `LLM extraction failed: ${msg}`,
      });
    }
  }

  const merged = mergeExtractedEntities([...regexEntities, ...llmEntities]);
  events.push({
    stage: 'merge',
    source: 'hybrid',
    message: `Merged to ${merged.length} unique entities`,
  });

  return {
    selfDisclosure: selfDisclosureResult.matched,
    entities: merged,
    events,
  };
}
