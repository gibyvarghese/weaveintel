/**
 * Phase 5 — Multi-signal memory retrieval (`fusedMemorySearch`)
 *
 * Combines three complementary retrieval signals over a single `MemoryStore`:
 *
 *   1. **Semantic**  — cosine similarity between the query embedding and stored
 *      embeddings. Requires a pre-computed `embedding` in `opts`. Falls back to
 *      the store's keyword path when no embedding is supplied.
 *
 *   2. **Keyword (BM25-like)** — term-frequency overlap between query tokens
 *      and entry content. Simple but robust when no embedding model is present.
 *
 *   3. **Entity**   — name-match score on stored entity entries. Boosts
 *      factual knowledge-graph entries that share tokens with the query.
 *
 * Each signal's raw scores are normalised to [0, 1] independently, then
 * combined as a weighted sum. Results are deduplicated by entry id and the
 * top-K entries are returned with their per-signal scores for explainability.
 *
 * The function is purely functional — it takes a `MemoryStore` rather than
 * reaching for any singleton so it works with any backend.
 */

import type { ExecutionContext, MemoryEntry, MemoryStore } from '@weaveintel/core';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface FusedMemorySearchOpts {
  readonly query: string;
  /** Pre-computed query embedding. When omitted, the semantic signal is skipped. */
  readonly embedding?: readonly number[];
  /** Max results returned. Defaults to 5. */
  readonly topK?: number;
  /** User id used to scope memory queries. */
  readonly userId?: string;
  /** Tenant id used to scope memory queries. */
  readonly tenantId?: string;
  /** Weight for the semantic (vector) signal. Defaults to 0.6. */
  readonly semanticWeight?: number;
  /** Weight for the keyword (BM25-like) signal. Defaults to 0.25. */
  readonly keywordWeight?: number;
  /** Weight for the entity-name-match signal. Defaults to 0.15. */
  readonly entityWeight?: number;
}

export interface FusedMemoryResult {
  readonly entry: MemoryEntry;
  /** Weighted combined score (0–1). Higher is more relevant. */
  readonly score: number;
  readonly signals: {
    readonly semantic?: number;
    readonly keyword?: number;
    readonly entity?: number;
  };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/** Simple TF-overlap score: |intersection| / |query tokens|. */
function keywordScore(queryTokens: string[], content: string): number {
  if (queryTokens.length === 0) return 0;
  const contentTokens = new Set(tokenise(content));
  let hits = 0;
  for (const t of queryTokens) {
    if (contentTokens.has(t)) hits++;
  }
  return hits / queryTokens.length;
}

/** Boost if the entity name tokens overlap with query tokens. */
function entityScore(queryTokens: string[], entityName: string): number {
  if (queryTokens.length === 0) return 0;
  const nameTokens = tokenise(entityName);
  if (nameTokens.length === 0) return 0;
  let hits = 0;
  const qSet = new Set(queryTokens);
  for (const t of nameTokens) {
    if (qSet.has(t)) hits++;
  }
  return hits / nameTokens.length;
}

/** Normalise a list of raw scores to [0, 1] by dividing by the max. */
function normalise(scores: number[]): number[] {
  const max = Math.max(...scores, 0);
  if (max === 0) return scores.map(() => 0);
  return scores.map((s) => s / max);
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Run a three-signal fused search over `store` and return the top-K entries
 * ranked by a weighted combination of semantic, keyword, and entity scores.
 *
 * @param store  Any `MemoryStore` (SQLite, pgvector, in-memory, …).
 * @param ctx    Execution context for scoping and tracing.
 * @param opts   Query options — see `FusedMemorySearchOpts`.
 */
export async function fusedMemorySearch(
  store: MemoryStore,
  ctx: ExecutionContext,
  opts: FusedMemorySearchOpts,
): Promise<FusedMemoryResult[]> {
  const topK = opts.topK ?? 5;
  const semanticW = opts.semanticWeight ?? 0.6;
  const keywordW = opts.keywordWeight ?? 0.25;
  const entityW = opts.entityWeight ?? 0.15;

  const filter = (opts.userId || opts.tenantId)
    ? {
        ...(opts.userId ? { userId: opts.userId } : {}),
        ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
      }
    : undefined;

  const queryTokens = tokenise(opts.query);
  const fetchK = topK * 4;

  // Run all three query paths in parallel
  const [semanticResults, episodicResults, entityResults] = await Promise.all([
    // Signal 1: semantic (vector if embedding present, otherwise keyword)
    opts.embedding
      ? store.query(ctx, {
          type: 'semantic',
          embedding: opts.embedding,
          topK: fetchK,
          filter,
        }).catch(() => [] as MemoryEntry[])
      : store.query(ctx, {
          type: 'semantic',
          query: opts.query,
          topK: fetchK,
          filter,
        }).catch(() => [] as MemoryEntry[]),

    // Signal 2: keyword over episodic + procedural entries
    store.query(ctx, {
      query: opts.query,
      topK: fetchK,
      filter: {
        ...filter,
        types: ['episodic', 'procedural', 'conversation'] as const,
      },
    }).catch(() => [] as MemoryEntry[]),

    // Signal 3: entity entries (all, then score by name match)
    store.query(ctx, {
      type: 'entity',
      topK: fetchK,
      filter,
    }).catch(() => [] as MemoryEntry[]),
  ]);

  // ── Collect all unique entries ───────────────────────────────────────────
  const byId = new Map<string, MemoryEntry>();
  for (const e of [...semanticResults, ...episodicResults, ...entityResults]) {
    if (!byId.has(e.id)) byId.set(e.id, e);
  }
  if (byId.size === 0) return [];

  const semanticIdSet = new Set(semanticResults.map((e) => e.id));

  // ── Score per signal ─────────────────────────────────────────────────────
  const entries = [...byId.values()];

  const rawSemantic: number[] = entries.map((e) => {
    if (!semanticIdSet.has(e.id)) return 0;
    // Use stored score from vector query if available, otherwise rank position
    const stored = e.score;
    if (typeof stored === 'number') return Math.max(0, stored);
    const idx = semanticResults.findIndex((r) => r.id === e.id);
    return idx >= 0 ? Math.max(0, 1 - idx / semanticResults.length) : 0;
  });

  const rawKeyword: number[] = entries.map((e) =>
    keywordScore(queryTokens, e.content),
  );

  const rawEntity: number[] = entries.map((e) =>
    e.type === 'entity' ? entityScore(queryTokens, e.content) : 0,
  );

  const normSemantic = normalise(rawSemantic);
  const normKeyword = normalise(rawKeyword);
  const normEntity = normalise(rawEntity);

  // ── Weighted sum + rank ──────────────────────────────────────────────────
  const results: FusedMemoryResult[] = entries.map((entry, i) => {
    const sem = normSemantic[i] ?? 0;
    const kw = normKeyword[i] ?? 0;
    const ent = normEntity[i] ?? 0;
    const score = sem * semanticW + kw * keywordW + ent * entityW;
    return {
      entry,
      score,
      signals: {
        ...(sem > 0 ? { semantic: sem } : {}),
        ...(kw > 0 ? { keyword: kw } : {}),
        ...(ent > 0 ? { entity: ent } : {}),
      },
    };
  });

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}
