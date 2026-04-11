import type { DocumentInput, ExtractionResult, ExtractionStage } from '@weaveintel/core';
import type { StageProcessor } from '../pipeline.js';

export interface LanguageStageConfig {
  id?: string;
  enabled?: boolean;
  order?: number;
}

const LANGUAGE_MARKERS: Record<string, string[]> = {
  en: ['the', 'is', 'and', 'of', 'to', 'in', 'that', 'it', 'for', 'was', 'with', 'as', 'are', 'be', 'this'],
  es: ['el', 'de', 'en', 'que', 'los', 'la', 'las', 'por', 'con', 'una', 'del', 'para', 'es', 'como', 'más'],
  fr: ['le', 'de', 'et', 'les', 'des', 'en', 'un', 'une', 'est', 'que', 'la', 'du', 'dans', 'pour', 'pas'],
  de: ['der', 'die', 'und', 'den', 'das', 'von', 'ist', 'ein', 'eine', 'auf', 'dem', 'mit', 'sich', 'nicht', 'des'],
  pt: ['de', 'que', 'não', 'com', 'uma', 'para', 'os', 'dos', 'como', 'em', 'por', 'foi', 'são', 'mas', 'das'],
  it: ['di', 'che', 'non', 'la', 'il', 'per', 'una', 'del', 'con', 'sono', 'alla', 'dei', 'gli', 'delle', 'anche'],
};

export function createLanguageStage(config?: LanguageStageConfig): StageProcessor {
  const stage: ExtractionStage = {
    id: config?.id ?? 'language',
    name: 'Language Detection',
    type: 'language',
    enabled: config?.enabled ?? true,
    order: config?.order ?? 1,
  };

  function process(input: DocumentInput, result: ExtractionResult): ExtractionResult {
    const text = typeof input.content === 'string' ? input.content : input.content.toString('utf-8');
    const words = text.toLowerCase().split(/\s+/).filter((w) => w.length > 0);

    if (words.length === 0) {
      return {
        ...result,
        metadata: { ...result.metadata, detectedLanguage: 'unknown', languageConfidence: 0 },
      };
    }

    const wordSet = new Set(words);
    let bestLang = 'unknown';
    let bestScore = 0;

    for (const [lang, markers] of Object.entries(LANGUAGE_MARKERS)) {
      let hits = 0;
      for (const marker of markers) {
        if (wordSet.has(marker)) hits++;
      }
      const score = hits / markers.length;
      if (score > bestScore) {
        bestScore = score;
        bestLang = lang;
      }
    }

    const confidence = Math.min(bestScore * 2, 1);
    const detected = confidence >= 0.1 ? bestLang : 'unknown';

    return {
      ...result,
      metadata: { ...result.metadata, detectedLanguage: detected, languageConfidence: confidence },
    };
  }

  return { stage, process };
}
