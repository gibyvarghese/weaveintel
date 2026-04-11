/**
 * Citation generator — extracts and formats citations from retrieval results
 */
import type { RetrievalResult, DocumentChunk } from '@weaveintel/core';

export interface Citation {
  index: number;
  chunkId: string;
  documentId: string;
  source?: string;
  content: string;
  score?: number;
}

export interface CitationResult {
  citations: Citation[];
  formatted: string;
}

export function weaveCitationExtractor() {
  return {
    extract(result: RetrievalResult): CitationResult {
      const citations: Citation[] = result.chunks.map((chunk, i) => ({
        index: i + 1,
        chunkId: chunk.id,
        documentId: chunk.documentId,
        source: chunk.source?.uri ?? chunk.metadata?.['source'] as string | undefined,
        content: chunk.content.slice(0, 200),
        score: chunk.metadata?.['score'] as number | undefined,
      }));

      const lines = citations.map(
        c => `[${c.index}] ${c.source ?? c.documentId}: ${c.content}${c.content.length >= 200 ? '...' : ''}`,
      );

      return { citations, formatted: lines.join('\n') };
    },

    /** Annotate text with citation markers based on chunk matches */
    annotate(text: string, chunks: DocumentChunk[]): string {
      let annotated = text;
      for (let i = 0; i < chunks.length; i++) {
        const snippet = chunks[i]!.content.slice(0, 50);
        if (snippet && annotated.includes(snippet.slice(0, 20))) {
          // Simple heuristic: if the text contains part of the chunk, add citation
          const marker = `[${i + 1}]`;
          if (!annotated.includes(marker)) {
            annotated = annotated.replace(new RegExp(`(?<=${snippet.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\[]{0,50})`, ''), marker);
          }
        }
      }
      return annotated;
    },
  };
}

export type CitationExtractor = ReturnType<typeof weaveCitationExtractor>;
