/**
 * Example 26 — Advanced Retrieval (Phase 5)
 *
 * Demonstrates Phase 5 retrieval extensions beyond the basic RAG pipeline in example 03:
 *  • weaveHybridRetriever — dense vector + sparse keyword search (reciprocal rank fusion)
 *  • weaveQueryRewriter   — LLM-powered query expansion for broader recall
 *  • weaveCitationExtractor — formats chunk sources as numbered inline citations
 *  • weaveRetrievalDiagnostics — tracks retrieval quality metrics across queries
 *
 * WeaveIntel packages used:
 *   @weaveintel/retrieval — Phase 5 extensions:
 *     • weaveHybridRetriever  — Combines dense vector search (embedding similarity) with
 *                               sparse keyword (BM25-style) search. Results are merged via
 *                               reciprocal rank fusion (RRF): each result's final score is
 *                               vectorWeight/(rank+1) + keywordWeight/(rank+1). This beats
 *                               pure vector search on precise term queries (names, acronyms,
 *                               serial numbers) while keeping semantic coverage for vague
 *                               or conceptual queries.
 *     • weaveQueryRewriter    — Sends the user query to an LLM to generate N semantically
 *                               equivalent rewrites. The hybrid retriever runs each rewrite
 *                               in parallel and merges results. Increases recall without
 *                               sacrificing precision. Useful when users ask vague or typo-
 *                               heavy questions.
 *     • weaveCitationExtractor— Takes a RetrievalResult and produces numbered citations:
 *                               [1] Source: content snippet...
 *                               Also annotates LLM-generated text with citation markers
 *                               ([1], [2]) using a snippet-match heuristic.
 *     • weaveRetrievalDiagnostics — Lightweight metrics tracker. Records per-query latency,
 *                               result count, and top score. getStats() returns aggregate
 *                               averages and the empty-result rate — essential for
 *                               identifying retrieval degradation in production.
 *
 *   @weaveintel/retrieval (core, from example 03):
 *     • weaveChunker          — Splits long documents into overlapping chunks
 *     • weaveEmbeddingPipeline— Embeds chunks and upserts them into a VectorStore
 *     • weaveRetriever        — Pure vector similarity retrieval (baseline)
 *
 *   @weaveintel/testing — weaveFakeModel(), weaveFakeEmbedding(), weaveFakeVectorStore()
 *   @weaveintel/core    — ExecutionContext, weaveContext()
 *
 * No API keys needed — uses in-memory fake primitives from @weaveintel/testing.
 *
 * Run: npx tsx examples/26-advanced-retrieval.ts
 */

import {
  weaveChunker,
  weaveEmbeddingPipeline,
  weaveRetriever,
  weaveHybridRetriever,
  weaveQueryRewriter,
  weaveCitationExtractor,
  weaveRetrievalDiagnostics,
} from '@weaveintel/retrieval';
import { weaveContext } from '@weaveintel/core';
import { weaveFakeModel, weaveFakeEmbedding, weaveFakeVectorStore } from '@weaveintel/testing';

// Sample knowledge base — represents chunks ingested from product documentation
const KNOWLEDGE_BASE = [
  {
    id: 'doc-001',
    content: `WeaveIntel is an open-source TypeScript framework for building production-grade AI agents.
It provides modular packages for models, memory, tools, guardrails, and observability.
The core package exports ExecutionContext, EventBus, and the Model interface.`,
    source: 'docs/overview.md',
  },
  {
    id: 'doc-002',
    content: `The @weaveintel/retrieval package implements RAG (Retrieval-Augmented Generation).
Phase 5 adds hybrid retrieval combining BM25 keyword scoring with dense embedding vectors.
Reciprocal Rank Fusion (RRF) merges results from both search strategies.`,
    source: 'docs/retrieval.md',
  },
  {
    id: 'doc-003',
    content: `DuckDuckGo provider uses the Instant Answer API. For real-world queries (events,
concerts, ticket prices) the HTML SERP fallback is automatically triggered.
The fallback parses result__a anchors and decodes uddg redirect parameters.`,
    source: 'docs/tools-search.md',
  },
  {
    id: 'doc-004',
    content: `The @weaveintel/cache package offers semantic caching using cosine similarity.
When a query embedding exceeds the similarity threshold against a cached entry,
the stored response is returned without calling the LLM again.`,
    source: 'docs/cache.md',
  },
  {
    id: 'doc-005',
    content: `geneWeave is the reference full-stack application bundled with WeaveIntel.
It demonstrates streaming chat, multi-model selection, and per-tool-call trace spans.
The traces are stored in SQLite with name = "tool_call.<toolName>" for each invocation.`,
    source: 'docs/geneweave.md',
  },
];

async function main() {
  const ctx = weaveContext({ userId: 'retrieval-demo' });
  const embeddingModel = weaveFakeEmbedding({ dimensions: 1536 });
  const vectorStore = weaveFakeVectorStore();

  // --- 0. Ingest documents (same as example 03) ---
  console.log('=== 0. Document Ingestion ===');

  const chunker = weaveChunker({ chunkSize: 300, overlap: 50 });
  const embeddingPipeline = weaveEmbeddingPipeline({ embeddingModel, vectorStore });

  for (const doc of KNOWLEDGE_BASE) {
    const chunks = chunker.chunk(doc.content, { documentId: doc.id, source: { uri: doc.source } });
    await embeddingPipeline.ingest(ctx, chunks);
    console.log(`  Ingested "${doc.source}" → ${chunks.length} chunk(s)`);
  }

  // --- 1. Baseline: Pure vector retriever ---
  console.log('\n=== 1. Baseline — Pure Vector Retriever ===');

  const vectorRetriever = weaveRetriever({ embeddingModel, vectorStore, defaultTopK: 3 });
  const vectorResult = await vectorRetriever.retrieve(ctx, {
    query: 'How does semantic caching work?',
    topK: 3,
  });

  console.log(`Query: "How does semantic caching work?"`);
  console.log(`Vector results (${vectorResult.chunks.length}):`);
  for (const chunk of vectorResult.chunks) {
    console.log(`  [${chunk.documentId}] ${chunk.content.slice(0, 80)}...`);
  }

  // --- 2. Hybrid retriever (vector + keyword fusion) ---
  // The hybrid retriever outperforms pure vector search when the query contains
  // specific terms that appear verbatim in documents (like "BM25", "RRF", "uddg").
  console.log('\n=== 2. Hybrid Retriever (vector + keyword BM25 fusion) ===');

  const hybridRetriever = weaveHybridRetriever({
    embeddingModel,
    vectorStore,
    vectorWeight: 0.7, // 70% vector score, 30% keyword score
    defaultTopK: 3,
  });

  // Add documents to the keyword corpus
  for (const doc of KNOWLEDGE_BASE) {
    hybridRetriever.addToCorpus(doc.id, doc.content, { source: doc.source });
  }

  // Query that has precise terms ("RRF", "BM25") — keyword search helps a lot here
  const hybridQuery = 'Reciprocal Rank Fusion BM25 hybrid retrieval';
  const start = Date.now();
  const hybridResult = await hybridRetriever.retrieve(ctx, { query: hybridQuery, topK: 3 });
  const hybridLatency = Date.now() - start;

  console.log(`Query: "${hybridQuery}"`);
  console.log(`Hybrid results (${hybridResult.chunks.length}) in ${hybridLatency}ms:`);
  for (const chunk of hybridResult.chunks) {
    console.log(`  [${chunk.documentId}] score=${(chunk.metadata?.['score'] as number ?? 0).toFixed(3)} | ${chunk.content.slice(0, 80)}...`);
  }

  // --- 3. Query rewriter ---
  // weaveQueryRewriter uses an LLM to expand a query into N variants.
  // Running hybrid retrieval on each variant then merging increases recall.
  console.log('\n=== 3. Query Rewriter (LLM-based query expansion) ===');

  const rewriterModel = weaveFakeModel({
    responses: [
      {
        content: [
          '1. How does weaveIntel search the web for information?',
          '2. What is the DuckDuckGo HTML SERP fallback mechanism?',
          '3. Which web search providers are built into weaveIntel?',
        ].join('\n'),
      },
    ],
  });

  const queryRewriter = weaveQueryRewriter({
    model: rewriterModel,
    maxRewrites: 3,
  });

  const originalQuery = 'web search fallback';
  const rewrites = await queryRewriter.rewrite(ctx, { query: originalQuery });

  console.log(`Original: "${originalQuery}"`);
  console.log(`Rewrites (${rewrites.length} total including original):`);
  for (const q of rewrites) {
    console.log(`  → "${q}"`);
  }

  // Run hybrid retrieval on each rewrite and merge unique results
  const allRewriteResults = await Promise.all(
    rewrites.map((q) => hybridRetriever.retrieve(ctx, { query: q, topK: 2 })),
  );
  const seenIds = new Set<string>();
  const mergedChunks = allRewriteResults
    .flatMap((r) => r.chunks)
    .filter((c) => {
      if (seenIds.has(c.id)) return false;
      seenIds.add(c.id);
      return true;
    });

  console.log(`\nMerged results from all rewrites (${mergedChunks.length} unique chunks):`);
  for (const chunk of mergedChunks) {
    console.log(`  [${chunk.documentId}] ${chunk.content.slice(0, 70)}...`);
  }

  // --- 4. Citation extractor ---
  // weaveCitationExtractor() formats retrieval results as numbered citations
  // that can be appended to the LLM's response for source attribution.
  console.log('\n=== 4. Citation Extractor ===');

  const citationExtractor = weaveCitationExtractor();

  // Use the hybrid result from step 2
  const citations = citationExtractor.extract(hybridResult);

  console.log(`Citations (${citations.citations.length}):`);
  for (const c of citations.citations) {
    const src = c.source ?? c.documentId;
    console.log(`  [${c.index}] ${src}`);
    console.log(`       ${c.content.slice(0, 100)}${c.content.length >= 100 ? '...' : ''}`);
  }

  console.log('\nFormatted citation block (for appending to LLM response):');
  console.log(citations.formatted);

  // annotate() adds citation markers to LLM-generated text
  const llmResponse = `WeaveIntel supports hybrid retrieval that combines dense embedding search
with sparse keyword scoring. The results are merged using reciprocal rank fusion.`;
  const annotated = citationExtractor.annotate(llmResponse, hybridResult.chunks);
  console.log(`\nAnnotated LLM response:\n${annotated}`);

  // --- 5. Retrieval diagnostics ---
  // weaveRetrievalDiagnostics() tracks per-query metrics.
  // In production this feeds your observability dashboards and alerts
  // when empty-result rate rises above a threshold.
  console.log('\n=== 5. Retrieval Diagnostics ===');

  const diagnostics = weaveRetrievalDiagnostics();

  // Simulate a series of retrieval calls and record their metrics
  const demoQueries = [
    { query: 'what is weaveIntel', results: 3, topScore: 0.94, latency: 42 },
    { query: 'semantic cache threshold', results: 2, topScore: 0.88, latency: 35 },
    { query: 'how do I deploy geneWeave', results: 1, topScore: 0.71, latency: 51 },
    { query: 'xyzzy unknown concept', results: 0, topScore: 0, latency: 28 }, // empty
    { query: 'tool call observability sqlite', results: 3, topScore: 0.91, latency: 39 },
  ];

  for (const q of demoQueries) {
    diagnostics.record(q.query, q.results, q.topScore, q.latency);
  }

  const stats = diagnostics.getStats();
  console.log(`Total queries:      ${stats.queryCount}`);
  console.log(`Avg result count:   ${stats.avgResultCount.toFixed(1)}`);
  console.log(`Avg latency:        ${stats.avgLatencyMs.toFixed(0)}ms`);
  console.log(`Avg top score:      ${stats.avgTopScore.toFixed(3)}`);
  console.log(`Empty result rate:  ${(stats.emptyResultRate * 100).toFixed(0)}%`);
  if (stats.emptyResultRate > 0.1) {
    console.log('  ⚠ High empty-result rate — consider re-ingesting documents or lowering similarity threshold');
  }

  console.log('\nRecent queries:');
  for (const q of stats.queries) {
    const status = q.resultCount === 0 ? 'EMPTY' : `${q.resultCount} results`;
    console.log(`  "${q.query.slice(0, 40)}" → ${status} | score=${q.topScore.toFixed(2)} | ${q.latencyMs}ms`);
  }

  // --- Summary ---
  console.log('\n=== Summary ===');
  console.log('weaveHybridRetriever:  dense vector (0.7) + keyword BM25 (0.3) via RRF');
  console.log('weaveQueryRewriter:    LLM expands query → N rewrites → higher recall');
  console.log('weaveCitationExtractor: numbered source citations + text annotation');
  console.log('weaveRetrievalDiagnostics: latency, hit rate, empty rate — for production monitoring');
  console.log('\nFor the basic RAG pipeline (chunking, embedding, pure vector retrieval)');
  console.log('see example 03-rag-pipeline.ts');
}

main().catch(console.error);
