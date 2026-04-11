/**
 * @weaveintel/retrieval — Chunking strategies
 *
 * Why: Chunking is the most critical step in RAG quality. Different content
 * types need different strategies. This module provides composable chunkers
 * that work independently of any vector store or model.
 */

import type { DocumentChunk, ChunkerConfig, Chunker, ChunkingStrategy } from '@weaveintel/core';

let chunkIdCounter = 0;

function makeChunkId(docId: string, index: number): string {
  return `${docId}_chunk_${index}_${++chunkIdCounter}`;
}

/** Fixed-size character chunker with overlap */
function fixedSizeChunk(
  content: string,
  documentId: string,
  chunkSize: number,
  overlap: number,
): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  let start = 0;
  let index = 0;

  while (start < content.length) {
    const end = Math.min(start + chunkSize, content.length);
    const text = content.slice(start, end);
    if (text.trim().length > 0) {
      chunks.push({
        id: makeChunkId(documentId, index),
        documentId,
        content: text,
        index,
        metadata: { strategy: 'fixed_size', start, end },
      });
      index++;
    }
    start += chunkSize - overlap;
  }
  return chunks;
}

/** Heading-aware chunker: splits on markdown/HTML headings */
function headingAwareChunk(content: string, documentId: string, maxSize: number): DocumentChunk[] {
  const headingPattern = /^#{1,6}\s+.+$/gm;
  const sections: { heading: string; content: string; start: number }[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = headingPattern.exec(content)) !== null) {
    if (match.index > lastIndex) {
      sections.push({
        heading: '',
        content: content.slice(lastIndex, match.index),
        start: lastIndex,
      });
    }
    lastIndex = match.index;
  }
  if (lastIndex < content.length) {
    sections.push({
      heading: '',
      content: content.slice(lastIndex),
      start: lastIndex,
    });
  }

  if (sections.length === 0) {
    return fixedSizeChunk(content, documentId, maxSize, 0);
  }

  const chunks: DocumentChunk[] = [];
  let index = 0;
  for (const section of sections) {
    const text = section.content.trim();
    if (text.length === 0) continue;
    if (text.length <= maxSize) {
      chunks.push({
        id: makeChunkId(documentId, index),
        documentId,
        content: text,
        index,
        metadata: { strategy: 'heading_aware', start: section.start },
      });
      index++;
    } else {
      // Sub-chunk large sections
      const subChunks = fixedSizeChunk(text, documentId, maxSize, Math.floor(maxSize * 0.1));
      for (const sc of subChunks) {
        chunks.push({ ...sc, index, id: makeChunkId(documentId, index) });
        index++;
      }
    }
  }
  return chunks;
}

/** Code-aware chunker: splits on function/class boundaries */
function codeAwareChunk(content: string, documentId: string, maxSize: number): DocumentChunk[] {
  // Split on common code boundaries
  const boundaries =
    /^(?:(?:export\s+)?(?:function|class|interface|type|const|let|var|enum|namespace|module)\s+|\/\*\*)/gm;
  const sections: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = boundaries.exec(content)) !== null) {
    if (match.index > lastIndex) {
      sections.push(content.slice(lastIndex, match.index));
    }
    lastIndex = match.index;
  }
  if (lastIndex < content.length) {
    sections.push(content.slice(lastIndex));
  }

  if (sections.length === 0) {
    return fixedSizeChunk(content, documentId, maxSize, 0);
  }

  const chunks: DocumentChunk[] = [];
  let index = 0;
  let buffer = '';

  for (const section of sections) {
    if (buffer.length + section.length > maxSize && buffer.length > 0) {
      chunks.push({
        id: makeChunkId(documentId, index),
        documentId,
        content: buffer.trim(),
        index,
        metadata: { strategy: 'code_aware' },
      });
      index++;
      buffer = '';
    }
    buffer += section;
  }
  if (buffer.trim().length > 0) {
    chunks.push({
      id: makeChunkId(documentId, index),
      documentId,
      content: buffer.trim(),
      index,
      metadata: { strategy: 'code_aware' },
    });
  }
  return chunks;
}

/** Semantic boundary chunker: splits on paragraph/sentence boundaries */
function semanticBoundaryChunk(
  content: string,
  documentId: string,
  maxSize: number,
  overlap: number,
): DocumentChunk[] {
  const paragraphs = content.split(/\n\n+/);
  const chunks: DocumentChunk[] = [];
  let index = 0;
  let buffer = '';

  for (const para of paragraphs) {
    if (buffer.length + para.length + 2 > maxSize && buffer.length > 0) {
      chunks.push({
        id: makeChunkId(documentId, index),
        documentId,
        content: buffer.trim(),
        index,
        metadata: { strategy: 'semantic_boundary' },
      });
      index++;
      // Keep overlap from end of previous chunk
      if (overlap > 0) {
        buffer = buffer.slice(-overlap);
      } else {
        buffer = '';
      }
    }
    buffer += (buffer.length > 0 ? '\n\n' : '') + para;
  }
  if (buffer.trim().length > 0) {
    chunks.push({
      id: makeChunkId(documentId, index),
      documentId,
      content: buffer.trim(),
      index,
      metadata: { strategy: 'semantic_boundary' },
    });
  }
  return chunks;
}

// ─── Public chunker factory ──────────────────────────────────

export function weaveChunker(config?: Partial<ChunkerConfig>): Chunker {
  const strategy: ChunkingStrategy = config?.strategy ?? 'semantic_boundary';
  const chunkSize = config?.chunkSize ?? 1000;
  const chunkOverlap = config?.chunkOverlap ?? 100;

  return {
    chunk(content: string, overrideConfig?: Partial<ChunkerConfig>): DocumentChunk[] {
      const s = overrideConfig?.strategy ?? strategy;
      const size = overrideConfig?.chunkSize ?? chunkSize;
      const overlap = overrideConfig?.chunkOverlap ?? chunkOverlap;
      const docId = `doc_${Date.now()}`;

      switch (s) {
        case 'fixed_size':
          return fixedSizeChunk(content, docId, size, overlap);
        case 'heading_aware':
          return headingAwareChunk(content, docId, size);
        case 'code_aware':
          return codeAwareChunk(content, docId, size);
        case 'semantic_boundary':
          return semanticBoundaryChunk(content, docId, size, overlap);
        case 'adaptive':
          // Adaptive: try heading-aware first, fall back to semantic
          const headingChunks = headingAwareChunk(content, docId, size);
          return headingChunks.length > 1
            ? headingChunks
            : semanticBoundaryChunk(content, docId, size, overlap);
        default:
          return fixedSizeChunk(content, docId, size, overlap);
      }
    },
  };
}
