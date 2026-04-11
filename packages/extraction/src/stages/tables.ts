import type { DocumentInput, ExtractionResult, ExtractionStage } from '@weaveintel/core';
import type { StageProcessor } from '../pipeline.js';

export interface TableStageConfig {
  id?: string;
  enabled?: boolean;
  order?: number;
}

function parsePipeRow(line: string): string[] {
  return line
    .split('|')
    .map((cell) => cell.trim())
    .filter((_, i, arr) => i > 0 && i < arr.length - 1 || (arr.length === 1));
}

function isSeparatorRow(line: string): boolean {
  const trimmed = line.trim();
  return /^\|?[\s\-:|]+\|[\s\-:|]+\|?$/.test(trimmed);
}

export function createTableStage(config?: TableStageConfig): StageProcessor {
  const stage: ExtractionStage = {
    id: config?.id ?? 'tables',
    name: 'Table Extraction',
    type: 'tables',
    enabled: config?.enabled ?? true,
    order: config?.order ?? 3,
  };

  function process(input: DocumentInput, result: ExtractionResult): ExtractionResult {
    const text = typeof input.content === 'string' ? input.content : input.content.toString('utf-8');
    const lines = text.split('\n');
    const tables: Array<{ headers: string[]; rows: string[][] }> = [];

    let i = 0;
    while (i < lines.length) {
      const line = lines[i]!.trim();

      // Look for a pipe-delimited header row followed by a separator
      if (line.includes('|') && i + 1 < lines.length && isSeparatorRow(lines[i + 1]!)) {
        const headers = parsePipeRow(line);
        // Skip separator
        i += 2;

        const rows: string[][] = [];
        while (i < lines.length) {
          const rowLine = lines[i]!.trim();
          if (!rowLine.includes('|') || rowLine.length === 0) break;
          if (isSeparatorRow(rowLine)) { i++; continue; }
          rows.push(parsePipeRow(rowLine));
          i++;
        }

        if (headers.length > 0) {
          tables.push({ headers, rows });
        }
      } else {
        i++;
      }
    }

    return {
      ...result,
      tables: [...(result.tables ?? []), ...tables],
    };
  }

  return { stage, process };
}
