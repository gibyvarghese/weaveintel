import type { DocumentInput, ExtractionResult, ExtractionStage } from '@weaveintel/core';
import type { StageProcessor } from '../pipeline.js';

export interface CodeStageConfig {
  id?: string;
  enabled?: boolean;
  order?: number;
}

const FENCE_REGEX = /^```(\w*)\s*\n([\s\S]*?)^```\s*$/gm;

export function createCodeStage(config?: CodeStageConfig): StageProcessor {
  const stage: ExtractionStage = {
    id: config?.id ?? 'code',
    name: 'Code Block Extraction',
    type: 'code',
    enabled: config?.enabled ?? true,
    order: config?.order ?? 4,
  };

  function process(input: DocumentInput, result: ExtractionResult): ExtractionResult {
    const text = typeof input.content === 'string' ? input.content : input.content.toString('utf-8');
    const codeBlocks: Array<{ language: string; code: string }> = [];

    const regex = new RegExp(FENCE_REGEX.source, FENCE_REGEX.flags);
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      codeBlocks.push({
        language: match[1] || 'text',
        code: match[2]!.trimEnd(),
      });
    }

    return {
      ...result,
      codeBlocks: [...(result.codeBlocks ?? []), ...codeBlocks],
    };
  }

  return { stage, process };
}
