import type {
  DocumentTransformPipeline,
  DocumentInput,
  ExtractionResult,
  ExtractionStage,
  TransformationArtifact,
} from '@weaveintel/core';
import { createEmptyResult } from './result.js';

export interface StageProcessor {
  stage: ExtractionStage;
  process(input: DocumentInput, result: ExtractionResult): ExtractionResult;
}

export interface PipelineOptions {
  id: string;
  name: string;
  stages: StageProcessor[];
}

export function createDocumentTransformPipeline(opts: PipelineOptions): DocumentTransformPipeline {
  const stageProcessors = opts.stages;

  const pipeline: DocumentTransformPipeline = {
    id: opts.id,
    name: opts.name,
    stages: stageProcessors.map((sp) => sp.stage),

    async run(input: DocumentInput): Promise<ExtractionResult> {
      let result = createEmptyResult(opts.id);
      const artifacts: TransformationArtifact[] = [];

      for (const sp of stageProcessors) {
        if (!sp.stage.enabled) continue;

        const start = performance.now();
        result = sp.process(input, result);
        const durationMs = performance.now() - start;

        artifacts.push({
          stageId: sp.stage.id,
          type: sp.stage.type,
          data: null,
          durationMs,
        });
      }

      result.artifacts = artifacts;
      return result;
    },
  };

  return pipeline;
}
