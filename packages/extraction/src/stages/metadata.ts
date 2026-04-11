import type { DocumentInput, ExtractionResult, ExtractionStage } from '@weaveintel/core';
import type { StageProcessor } from '../pipeline.js';

export interface MetadataStageConfig {
  id?: string;
  enabled?: boolean;
  order?: number;
}

export function createMetadataStage(config?: MetadataStageConfig): StageProcessor {
  const stage: ExtractionStage = {
    id: config?.id ?? 'metadata',
    name: 'Metadata Extraction',
    type: 'metadata',
    enabled: config?.enabled ?? true,
    order: config?.order ?? 0,
  };

  function process(input: DocumentInput, result: ExtractionResult): ExtractionResult {
    const text = typeof input.content === 'string' ? input.content : input.content.toString('utf-8');

    const charCount = text.length;
    const wordCount = text.split(/\s+/).filter((w) => w.length > 0).length;
    const lineCount = text.split('\n').length;
    const sentenceCount = text.split(/[.!?]+/).filter((s) => s.trim().length > 0).length;

    return {
      ...result,
      metadata: {
        ...result.metadata,
        charCount,
        wordCount,
        lineCount,
        sentenceCount,
        mimeType: input.mimeType,
        filename: input.filename ?? null,
      },
    };
  }

  return { stage, process };
}
