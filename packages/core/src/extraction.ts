/**
 * @weaveintel/core — Document extraction contracts
 */

// ─── Pipeline ────────────────────────────────────────────────

export interface DocumentTransformPipeline {
  id: string;
  name: string;
  stages: ExtractionStage[];
  run(input: DocumentInput): Promise<ExtractionResult>;
}

export interface DocumentInput {
  content: string | Buffer;
  mimeType: string;
  filename?: string;
  metadata?: Record<string, unknown>;
}

// ─── Stages ──────────────────────────────────────────────────

export type ExtractionStageType = 'metadata' | 'language' | 'entities' | 'tables' | 'code' | 'tasks' | 'timeline' | 'custom';

export interface ExtractionStage {
  id: string;
  name: string;
  type: ExtractionStageType;
  config?: Record<string, unknown>;
  enabled: boolean;
  order: number;
}

// ─── Extracted Data ──────────────────────────────────────────

export interface ExtractedEntity {
  text: string;
  type: string;
  confidence: number;
  startOffset?: number;
  endOffset?: number;
  metadata?: Record<string, unknown>;
}

export interface ExtractedTask {
  title: string;
  description?: string;
  assignee?: string;
  dueDate?: string;
  priority?: string;
  confidence: number;
}

export interface ExtractedTimeline {
  events: Array<{
    date: string;
    description: string;
    type?: string;
    confidence: number;
  }>;
}

// ─── Result ──────────────────────────────────────────────────

export interface ExtractionResult {
  pipelineId: string;
  entities: ExtractedEntity[];
  tasks: ExtractedTask[];
  timeline?: ExtractedTimeline;
  tables?: Array<{ headers: string[]; rows: string[][] }>;
  codeBlocks?: Array<{ language: string; code: string }>;
  metadata: Record<string, unknown>;
  artifacts: TransformationArtifact[];
}

export interface TransformationArtifact {
  stageId: string;
  type: string;
  data: unknown;
  durationMs: number;
}
