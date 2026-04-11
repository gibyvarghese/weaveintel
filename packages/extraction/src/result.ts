import type { ExtractionResult } from '@weaveintel/core';

export function createEmptyResult(pipelineId: string): ExtractionResult {
  return {
    pipelineId,
    entities: [],
    tasks: [],
    timeline: undefined,
    tables: [],
    codeBlocks: [],
    metadata: {},
    artifacts: [],
  };
}

export function mergeResults(a: ExtractionResult, b: ExtractionResult): ExtractionResult {
  return {
    pipelineId: a.pipelineId,
    entities: [...a.entities, ...b.entities],
    tasks: [...a.tasks, ...b.tasks],
    timeline:
      a.timeline && b.timeline
        ? { events: [...a.timeline.events, ...b.timeline.events] }
        : a.timeline ?? b.timeline,
    tables: [...(a.tables ?? []), ...(b.tables ?? [])],
    codeBlocks: [...(a.codeBlocks ?? []), ...(b.codeBlocks ?? [])],
    metadata: { ...a.metadata, ...b.metadata },
    artifacts: [...a.artifacts, ...b.artifacts],
  };
}

export function summarizeResult(result: ExtractionResult): string {
  const lines: string[] = [];
  lines.push(`Pipeline: ${result.pipelineId}`);
  lines.push(`Entities: ${result.entities.length}`);
  lines.push(`Tasks: ${result.tasks.length}`);

  const eventCount = result.timeline?.events.length ?? 0;
  lines.push(`Timeline events: ${eventCount}`);

  const tableCount = result.tables?.length ?? 0;
  lines.push(`Tables: ${tableCount}`);

  const codeCount = result.codeBlocks?.length ?? 0;
  lines.push(`Code blocks: ${codeCount}`);

  const metaKeys = Object.keys(result.metadata);
  lines.push(`Metadata keys: ${metaKeys.length > 0 ? metaKeys.join(', ') : 'none'}`);

  lines.push(`Stages executed: ${result.artifacts.length}`);

  const totalMs = result.artifacts.reduce((sum, a) => sum + a.durationMs, 0);
  lines.push(`Total duration: ${totalMs.toFixed(1)}ms`);

  return lines.join('\n');
}
