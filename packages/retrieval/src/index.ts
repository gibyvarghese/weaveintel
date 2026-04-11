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
export { weaveCitationExtractor, type CitationExtractor, type Citation, type CitationResult } from './citations.js';
export { weaveRetrievalDiagnostics, type RetrievalDiagnosticsTracker, type RetrievalDiagnostics } from './diagnostics.js';
