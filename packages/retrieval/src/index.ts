// SPDX-License-Identifier: MIT
export { weaveChunker } from './chunker.js';
export {
  weaveEmbeddingPipeline,
  weaveRetriever,
  type EmbeddingPipelineConfig,
  type VectorRetrieverConfig,
} from './pipeline.js';

// Phase 5 extensions
export { weaveHybridRetriever, type HybridRetrieverConfig } from './hybrid.js';
export { weaveQueryRewriter, type QueryRewriter, type QueryRewriterConfig } from './query-rewriter.js';
export { weaveCitationExtractor, type CitationExtractor, type ExtractedCitation, type CitationResult } from './citations.js';
export { weaveRetrievalDiagnostics, type RetrievalDiagnosticsTracker, type RetrievalDiagnostics } from './diagnostics.js';

// ── RAG helpers: cited answers (character-verified quotes), query expansion, RRF ──
// The canonical `Citation` (a verified quote citation) lives here; the retriever's
// per-chunk model is `ExtractedCitation` (see citations.ts).
export {
  type RagHit,
  type CitedSource,
  snippetAround,
  reciprocalRankFusion,
  buildCitedContext,
  parseCitedIds,
  type CitableSource,
  type RawCitation,
  type Citation,
  locateQuote,
  buildCitedAnswerPrompt,
  parseCitedAnswer,
  verifyCitations,
  type AnswerCitationCoverage,
  answerCitationCoverage,
  enforceCitationStrictness,
  type ExpandedQueries,
  MAX_QUERY_VARIANTS,
  buildQueryExpansionPrompt,
  parseExpandedQueries,
} from './rag.js';
