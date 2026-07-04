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
 *   4. **Recency**  — *temporal decay*: newer memories score higher, with an
 *      exponential half-life (the "second brain" wants what you told it recently
 *      to surface first). Off by default (weight 0); opt in via `recencyWeight`.
 *
 *   5. **Importance** — the entry's salience weight (LLM-rated significance).
 *      Off by default; opt in via `importanceWeight`.
 *
 * Signals 4–5 make retrieval *temporally aware* (the Generative-Agents recency ×
 * importance × relevance scoring). Set `excludeSuperseded` to drop facts that have
 * been invalidated (bi-temporal `invalidAt`) — e.g. a preference you've since changed.
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
  /** Weight for the temporal recency signal (exponential decay). Defaults to 0 (off). */
  readonly recencyWeight?: number;
  /** Weight for the importance/salience signal. Defaults to 0 (off). */
  readonly importanceWeight?: number;
  /** Half-life for the recency decay, in ms. Defaults to 14 days. */
  readonly halfLifeMs?: number;
  /** Reference "now" for recency decay, in ms since epoch. Defaults to Date.now(). */
  readonly nowMs?: number;
  /** Drop entries that have been superseded/invalidated (bi-temporal `invalidAt` in the past). */
  readonly excludeSuperseded?: boolean;
}

export interface FusedMemoryResult {
  readonly entry: MemoryEntry;
  /** Weighted combined score (0–1). Higher is more relevant. */
  readonly score: number;
  readonly signals: {
    readonly semantic?: number;
    readonly keyword?: number;
    readonly entity?: number;
    readonly recency?: number;
    readonly importance?: number;
  };
}

/** Exponential recency decay in [0,1]: 1.0 at age 0, 0.5 at one half-life, → 0 as it ages. */
export function recencyDecay(ageMs: number, halfLifeMs: number): number {
  if (!(halfLifeMs > 0)) return 1;
  const a = Math.max(0, ageMs);
  return Math.pow(0.5, a / halfLifeMs);
}

/** The age (ms) of a memory relative to `nowMs`, using bi-temporal `validAt` then `createdAt`. */
function memoryAgeMs(entry: MemoryEntry, nowMs: number): number {
  const t = Date.parse(entry.validAt ?? entry.createdAt ?? '');
  return Number.isFinite(t) ? nowMs - t : 0;
}

/** Whether a memory has been superseded (bi-temporal `invalidAt` set and in the past). */
function isSuperseded(entry: MemoryEntry, nowMs: number): boolean {
  if (!entry.invalidAt) return false;
  const t = Date.parse(entry.invalidAt);
  return Number.isFinite(t) && t <= nowMs;
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
  const recencyW = opts.recencyWeight ?? 0;
  const importanceW = opts.importanceWeight ?? 0;
  const halfLifeMs = opts.halfLifeMs ?? 14 * 24 * 60 * 60 * 1000;
  const nowMs = opts.nowMs ?? Date.now();

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
  // Temporal awareness: optionally drop facts that have been superseded (bi-temporal invalidAt).
  const entries = (opts.excludeSuperseded
    ? [...byId.values()].filter((e) => !isSuperseded(e, nowMs))
    : [...byId.values()]);
  if (entries.length === 0) return [];

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

  // Temporal signals — recency (exponential decay) + importance (salience). Already in [0,1].
  const rawRecency: number[] = entries.map((e) => (recencyW > 0 ? recencyDecay(memoryAgeMs(e, nowMs), halfLifeMs) : 0));
  const rawImportance: number[] = entries.map((e) => {
    if (importanceW <= 0) return 0;
    const meta = typeof e.metadata?.['importance'] === 'number' ? (e.metadata['importance'] as number) : undefined;
    const imp = typeof e.importance === 'number' ? e.importance : meta;
    return typeof imp === 'number' ? Math.max(0, Math.min(1, imp)) : 0.5;
  });

  const normSemantic = normalise(rawSemantic);
  const normKeyword = normalise(rawKeyword);
  const normEntity = normalise(rawEntity);

  // ── Weighted sum + rank ──────────────────────────────────────────────────
  const results: FusedMemoryResult[] = entries.map((entry, i) => {
    const sem = normSemantic[i] ?? 0;
    const kw = normKeyword[i] ?? 0;
    const ent = normEntity[i] ?? 0;
    const rec = rawRecency[i] ?? 0;
    const imp = rawImportance[i] ?? 0;
    const score = sem * semanticW + kw * keywordW + ent * entityW + rec * recencyW + imp * importanceW;
    return {
      entry,
      score,
      signals: {
        ...(sem > 0 ? { semantic: sem } : {}),
        ...(kw > 0 ? { keyword: kw } : {}),
        ...(ent > 0 ? { entity: ent } : {}),
        ...(recencyW > 0 ? { recency: rec } : {}),
        ...(importanceW > 0 ? { importance: imp } : {}),
      },
    };
  });

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}
