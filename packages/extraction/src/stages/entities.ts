import type { DocumentInput, ExtractionResult, ExtractionStage, ExtractedEntity } from '@weaveintel/core';
import type { StageProcessor } from '../pipeline.js';

export interface EntityStageConfig {
  id?: string;
  enabled?: boolean;
  order?: number;
  types?: string[];
}

interface PatternDef {
  type: string;
  pattern: RegExp;
  confidence: number;
}

const PATTERNS: PatternDef[] = [
  { type: 'email', pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, confidence: 0.95 },
  { type: 'url', pattern: /https?:\/\/[^\s<>"{}|\\^`[\]]+/g, confidence: 0.95 },
  { type: 'phone', pattern: /(?:\+\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g, confidence: 0.75 },
  { type: 'date', pattern: /\b\d{4}-\d{2}-\d{2}\b/g, confidence: 0.9 },
  { type: 'date', pattern: /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/gi, confidence: 0.85 },
  { type: 'date', pattern: /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, confidence: 0.7 },
  { type: 'currency', pattern: /[$€£¥]\s?\d[\d,]*\.?\d*/g, confidence: 0.9 },
  { type: 'currency', pattern: /\d[\d,]*\.?\d*\s?(?:USD|EUR|GBP|JPY)\b/g, confidence: 0.85 },
  { type: 'percentage', pattern: /\b\d+(?:\.\d+)?%/g, confidence: 0.9 },
];

export function createEntityStage(config?: EntityStageConfig): StageProcessor {
  const stage: ExtractionStage = {
    id: config?.id ?? 'entities',
    name: 'Entity Extraction',
    type: 'entities',
    enabled: config?.enabled ?? true,
    order: config?.order ?? 2,
  };

  const allowedTypes = config?.types ? new Set(config.types) : null;

  function process(input: DocumentInput, result: ExtractionResult): ExtractionResult {
    const text = typeof input.content === 'string' ? input.content : input.content.toString('utf-8');
    const newEntities: ExtractedEntity[] = [];

    for (const def of PATTERNS) {
      if (allowedTypes && !allowedTypes.has(def.type)) continue;

      const regex = new RegExp(def.pattern.source, def.pattern.flags);
      let match: RegExpExecArray | null;

      while ((match = regex.exec(text)) !== null) {
        newEntities.push({
          text: match[0],
          type: def.type,
          confidence: def.confidence,
          startOffset: match.index,
          endOffset: match.index + match[0].length,
        });
      }
    }

    // Deduplicate by text + type
    const seen = new Set<string>();
    const dedupedEntities: ExtractedEntity[] = [];
    for (const entity of newEntities) {
      const key = `${entity.type}::${entity.text}::${entity.startOffset}`;
      if (!seen.has(key)) {
        seen.add(key);
        dedupedEntities.push(entity);
      }
    }

    return {
      ...result,
      entities: [...result.entities, ...dedupedEntities],
    };
  }

  return { stage, process };
}
