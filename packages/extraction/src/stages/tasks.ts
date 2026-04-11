import type { DocumentInput, ExtractionResult, ExtractionStage, ExtractedTask } from '@weaveintel/core';
import type { StageProcessor } from '../pipeline.js';

export interface TaskStageConfig {
  id?: string;
  enabled?: boolean;
  order?: number;
}

const TODO_PATTERN = /\b(TODO|FIXME|ACTION|HACK|XXX):\s*(.+)/gi;
const CHECKLIST_PATTERN = /^[\s]*-\s*\[([ xX])\]\s*(.+)$/gm;
const DEADLINE_PATTERN = /\b(?:by|due|deadline)\s+(\d{4}-\d{2}-\d{2}|\w+\s+\d{1,2},?\s+\d{4})/gi;

function extractDeadline(text: string): string | undefined {
  const match = DEADLINE_PATTERN.exec(text);
  DEADLINE_PATTERN.lastIndex = 0;
  return match ? match[1] : undefined;
}

function priorityFromKeyword(keyword: string): string {
  const upper = keyword.toUpperCase();
  if (upper === 'FIXME' || upper === 'XXX') return 'high';
  if (upper === 'HACK') return 'medium';
  return 'normal';
}

export function createTaskStage(config?: TaskStageConfig): StageProcessor {
  const stage: ExtractionStage = {
    id: config?.id ?? 'tasks',
    name: 'Task Extraction',
    type: 'tasks',
    enabled: config?.enabled ?? true,
    order: config?.order ?? 5,
  };

  function process(input: DocumentInput, result: ExtractionResult): ExtractionResult {
    const text = typeof input.content === 'string' ? input.content : input.content.toString('utf-8');
    const tasks: ExtractedTask[] = [];

    // Extract TODO/FIXME/ACTION patterns
    const todoRegex = new RegExp(TODO_PATTERN.source, TODO_PATTERN.flags);
    let match: RegExpExecArray | null;

    while ((match = todoRegex.exec(text)) !== null) {
      const keyword = match[1]!;
      const title = match[2]!.trim();
      const dueDate = extractDeadline(title);

      tasks.push({
        title,
        priority: priorityFromKeyword(keyword),
        dueDate,
        confidence: 0.9,
      });
    }

    // Extract checklist items
    const checkRegex = new RegExp(CHECKLIST_PATTERN.source, CHECKLIST_PATTERN.flags);
    while ((match = checkRegex.exec(text)) !== null) {
      const completed = match[1] !== ' ';
      const title = match[2]!.trim();
      const dueDate = extractDeadline(title);

      tasks.push({
        title,
        priority: 'normal',
        dueDate,
        description: completed ? 'completed' : 'pending',
        confidence: 0.85,
      });
    }

    return {
      ...result,
      tasks: [...result.tasks, ...tasks],
    };
  }

  return { stage, process };
}
