/**
 * Hybrid retrieval — combines dense vector search with sparse keyword search (BM25-style)
 */
import type {
  ExecutionContext,
  EmbeddingModel,
  VectorStore,
  Retriever,
  RetrievalQuery,
  RetrievalResult,
  DocumentChunk,
} from '@weaveintel/core';

export interface HybridRetrieverConfig {
  embeddingModel: EmbeddingModel;
  vectorStore: VectorStore;
  /** Weight for vector results (0-1). Keyword weight = 1 - vectorWeight */
  vectorWeight?: number;
  defaultTopK?: number;
  /** Corpus of documents for keyword search (stored in memory) */
  corpus?: Map<string, { content: string; metadata: Record<string, unknown> }>;
}

/** Simple BM25-ish keyword scoring */
function keywordScore(query: string, text: string): number {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const textLower = text.toLowerCase();
  let hits = 0;
  for (const term of terms) {
    if (textLower.includes(term)) hits++;
  }
  return terms.length > 0 ? hits / terms.length : 0;
}

export function weaveHybridRetriever(config: HybridRetrieverConfig): Retriever & {
  addToCorpus(id: string, content: string, metadata?: Record<string, unknown>): void;
} {
  const vectorWeight = config.vectorWeight ?? 0.7;
  const topK = config.defaultTopK ?? 5;
  const corpus = config.corpus ?? new Map<string, { content: string; metadata: Record<string, unknown> }>();

  return {
    addToCorpus(id: string, content: string, metadata: Record<string, unknown> = {}) {
      corpus.set(id, { content, metadata });
    },

    async retrieve(ctx: ExecutionContext, query: RetrievalQuery): Promise<RetrievalResult> {
      const k = query.topK ?? topK;

      // Dense vector search
      const embResp = await config.embeddingModel.embed(ctx, { input: [query.query] });
      const embedding = embResp.embeddings[0]!;
      const vectorResults = await config.vectorStore.search(ctx, {
        embedding,
        topK: k * 2,
        filter: query.filter,
      });

      // Keyword search over corpus
      const keywordResults: Array<{ id: string; score: number; content: string; metadata: Record<string, unknown> }> = [];
      for (const [id, doc] of corpus) {
        const score = keywordScore(query.query, doc.content);
        if (score > 0) keywordResults.push({ id, score, content: doc.content, metadata: doc.metadata });
      }
      keywordResults.sort((a, b) => b.score - a.score);

      // Merge scores with reciprocal rank fusion
      const scoreMap = new Map<string, { score: number; content: string; metadata: Record<string, unknown> }>();

      vectorResults.forEach((r, i) => {
        const rrf = vectorWeight / (i + 1);
        const existing = scoreMap.get(r.id);
        scoreMap.set(r.id, {
          score: (existing?.score ?? 0) + rrf,
          content: r.content,
          metadata: r.metadata,
        });
      });

      keywordResults.slice(0, k * 2).forEach((r, i) => {
        const rrf = (1 - vectorWeight) / (i + 1);
        const existing = scoreMap.get(r.id);
        scoreMap.set(r.id, {
          score: (existing?.score ?? 0) + rrf,
          content: existing?.content ?? r.content,
          metadata: existing?.metadata ?? r.metadata,
        });
      });

      const merged = [...scoreMap.entries()]
        .sort((a, b) => b[1].score - a[1].score)
        .slice(0, k);

      const chunks: DocumentChunk[] = merged.map(([id, r], i) => ({
        id,
        documentId: String(r.metadata['documentId'] ?? id),
        content: r.content,
        index: i,
        metadata: { ...r.metadata, hybridScore: r.score },
      }));

      return { chunks, query: query.query };
    },
  };
}
