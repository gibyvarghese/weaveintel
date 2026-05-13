/**
 * Phase 8 — Intent-RAG Tool Retrieval (lever L3 strategy upgrade).
 *
 * Per-step top-K tool retrieval via cosine similarity between the agent's
 * current goal text and pre-computed tool description embeddings. Sits
 * alongside the Phase 5 `'phase'` strategy as a second concrete impl of
 * `ToolSubsetConfig.strategy`. Operators opt-in per-policy by setting
 * `toolSubset.strategy = 'intent-rag'` on a `cost_policies` row.
 *
 * Inspired by the LlamaIndex agentic-rag tool-retrieval pattern referenced
 * in `docs/COST_CONTROL_PLAN.md` §5.2 / §6 Phase 8.
 *
 * Reusability invariant: this module imports only from `@weaveintel/core`
 * (transitively via `governor.ts` types) and the cost-governor's own types.
 * Embedder + EmbeddingStore are consumer-supplied interfaces — apps wire
 * them to their preferred embedding model (OpenAI, local, llamacpp, etc.)
 * and persistence layer (SQLite, Postgres, in-memory, Redis, …). The
 * package never opens a network socket and never reads from a database.
 *
 * Graceful-degradation invariant (HARD): like every cost-governor lever,
 * intent-rag is NEVER load-bearing. Any of these conditions returns
 * pass-through (filter returns null → consumer keeps the full registry):
 *   - missing or malformed config
 *   - missing embedder
 *   - missing or empty embedding store
 *   - missing goal text (resolver returns null/empty)
 *   - embedder throws on goal embedding
 *   - zero overlap between top-K keys and available keys
 *   - any unexpected error
 *
 * Conventions:
 *   - cosine similarity = (a·b) / (||a|| * ||b||)
 *   - `topK` default = 6
 *   - `minSimilarity` default = 0.15
 *   - `includeAlways` keys are always added to the final keep set when they
 *     are present in `availableKeys`, even when their similarity score is
 *     below `minSimilarity`. Useful for `submit` / `final_answer` style
 *     tools that the agent must always be able to reach.
 */

import type { CostLeverContext, CostToolFilter } from './governor.js';
import type { ToolSubsetConfig } from './policy.js';
import type { ToolSubsetDecision } from './tool-subset.js';

// ─── Public interfaces (consumer-supplied) ─────────────────────────────

/**
 * Minimal embedder contract. Apps adapt their preferred embedding model
 * (typically `EmbeddingModel` from `@weaveintel/core` via a one-liner
 * wrapper) into this shape so the cost-governor package stays free of
 * provider imports.
 */
export interface Embedder {
  /** Stable model identifier — used to invalidate cached embeddings on model change. */
  readonly modelId: string;
  /** Output vector dimension. */
  readonly dimension: number;
  /** Embed one or more texts. Order of returned vectors MUST match input order. */
  embed(texts: ReadonlyArray<string>): Promise<ReadonlyArray<ReadonlyArray<number>>>;
}

/** Cached embedding for a single tool. */
export interface ToolEmbedding {
  readonly toolKey: string;
  readonly modelId: string;
  readonly dimension: number;
  readonly vector: ReadonlyArray<number>;
  /** Hash of the tool description that produced this embedding. */
  readonly descriptionHash: string;
}

/**
 * Persistence contract for cached tool embeddings. Apps implement this over
 * SQLite / Postgres / Redis / in-memory. The package never assumes a backend.
 */
export interface EmbeddingStore {
  get(toolKey: string): Promise<ToolEmbedding | null>;
  /** Returns ALL cached embeddings. Callers filter to availableKeys themselves. */
  getAll(): Promise<ReadonlyArray<ToolEmbedding>>;
  upsert(embedding: ToolEmbedding): Promise<void>;
}

/** Resolves the intent / goal text for the current tick. */
export type GoalResolver = (ctx: CostLeverContext) => Promise<string | null | undefined> | string | null | undefined;

/** Operator-facing intent-RAG knobs (subset of `ToolSubsetConfig`). */
export interface IntentRagConfig {
  readonly topK?: number;
  readonly minSimilarity?: number;
  readonly includeAlways?: ReadonlyArray<string>;
}

// ─── Pure helpers ──────────────────────────────────────────────────────

/**
 * Cosine similarity. Returns 0 for either vector being all-zero or for
 * vectors of mismatched length (defensive — shouldn't happen in practice
 * but cost-governor never throws from a decision helper).
 */
export function cosineSimilarity(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * FNV-1a 64-bit hash of a UTF-8 string, returned as a 16-char lowercase
 * hex string. Pure, deterministic, runtime-agnostic — does not require
 * Node's `crypto` module so the package stays usable in browsers / edge
 * runtimes. Collision rate is fine for tool-description change detection.
 */
export function hashDescription(text: string): string {
  // FNV-1a 64-bit (Knuth offset basis)
  let hi = 0xcbf2_9ce4 >>> 0;
  let lo = 0x8422_3325 >>> 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // XOR low byte
    lo = (lo ^ code) >>> 0;
    // Multiply by 1099511628211 = 0x100000001b3
    // 64-bit multiply implemented as two 32-bit halves
    const aL = lo & 0xffff;
    const aH = lo >>> 16;
    const bL = 0x1b3;
    const bH = 0x100;
    const hiL = hi & 0xffff;
    const hiH = hi >>> 16;
    let r0 = aL * bL;
    let r1 = aH * bL + (r0 >>> 16);
    r0 = r0 & 0xffff;
    let r2 = aL * bH + (r1 & 0xffff);
    r1 = (r1 >>> 16) + (r2 >>> 16);
    r2 = r2 & 0xffff;
    let r3 = aH * bH + r1 + hiL * bL + hiH * 0;
    const newLo = ((r2 << 16) | r0) >>> 0;
    const newHi = (r3 + (((aL * bH) >>> 16) >>> 0)) >>> 0;
    lo = newLo;
    hi = newHi;
  }
  const hex = (n: number) => n.toString(16).padStart(8, '0');
  return hex(hi) + hex(lo);
}

// ─── Pure decision ─────────────────────────────────────────────────────

export interface DecideIntentRagInput {
  readonly config: IntentRagConfig | null | undefined;
  readonly availableKeys: ReadonlyArray<string>;
  readonly goalVector: ReadonlyArray<number> | null;
  readonly toolEmbeddings: ReadonlyArray<ToolEmbedding>;
}

/**
 * Pure ranking decision. Given a goal vector and a set of tool embeddings,
 * return which tool keys to keep based on cosine similarity, top-K, and
 * `includeAlways`. Never throws.
 *
 * Pass-through (`filtered: false`) is returned in any of:
 *   - no goal vector (caller could not resolve goal)
 *   - empty `toolEmbeddings`
 *   - no overlap between embedding keys and `availableKeys`
 *   - top-K ranked set is empty after similarity threshold AND there is no
 *     overlap between `includeAlways` and `availableKeys` either
 */
export function decideIntentRagSubset(input: DecideIntentRagInput): ToolSubsetDecision {
  const { config, availableKeys, goalVector, toolEmbeddings } = input;
  const passThrough = (reason: string): ToolSubsetDecision => ({
    keep: availableKeys,
    dropped: [],
    reason,
    filtered: false,
  });

  if (!goalVector || goalVector.length === 0) return passThrough('intent-rag: no goal vector');
  if (!toolEmbeddings || toolEmbeddings.length === 0) return passThrough('intent-rag: no tool embeddings cached');

  const topK = Math.max(1, config?.topK ?? 6);
  const minSim = config?.minSimilarity ?? 0.15;
  const alwaysSet = new Set(config?.includeAlways ?? []);
  const availSet = new Set(availableKeys);

  // Score every cached embedding whose key is currently available.
  const scored: Array<{ key: string; score: number }> = [];
  for (const emb of toolEmbeddings) {
    if (!availSet.has(emb.toolKey)) continue;
    if (emb.vector.length !== goalVector.length) continue; // dimension mismatch — skip silently
    const score = cosineSimilarity(goalVector, emb.vector);
    scored.push({ key: emb.toolKey, score });
  }

  if (scored.length === 0) {
    // No overlap between embeddings cache and available keys. If at least
    // one `includeAlways` key is present, return that; otherwise pass-through.
    const alwaysKeep = availableKeys.filter((k) => alwaysSet.has(k));
    if (alwaysKeep.length === 0) return passThrough('intent-rag: no overlap between embeddings and available tools');
    const dropped = availableKeys.filter((k) => !alwaysSet.has(k));
    return {
      keep: alwaysKeep,
      dropped,
      reason: `intent-rag: includeAlways-only (no embeddings overlapped)`,
      filtered: true,
    };
  }

  // Sort descending by score, then ascending by key for stability.
  scored.sort((a, b) => (b.score - a.score) || a.key.localeCompare(b.key));

  const topRanked = scored.filter((s) => s.score >= minSim).slice(0, topK).map((s) => s.key);
  const keepSet = new Set<string>(topRanked);
  // Always add includeAlways keys that are available, even if they didn't make top-K.
  for (const k of availableKeys) if (alwaysSet.has(k)) keepSet.add(k);

  if (keepSet.size === 0) {
    return passThrough(`intel-rag: zero tools above minSimilarity=${minSim} and no includeAlways overlap`);
  }

  const keep: string[] = [];
  const dropped: string[] = [];
  for (const k of availableKeys) {
    if (keepSet.has(k)) keep.push(k);
    else dropped.push(k);
  }

  return {
    keep,
    dropped,
    reason: `intent-rag: topK=${topK} minSim=${minSim} ranked=${topRanked.length} alwaysAdded=${keep.length - topRanked.length}`,
    filtered: true,
  };
}

// ─── Filter factory ────────────────────────────────────────────────────

export interface WeaveIntentRagToolSubsetFilterOptions {
  /** Operator config — typically read from `cost_policies.levers_json.toolSubset`. */
  readonly config: ToolSubsetConfig;
  readonly embedder: Embedder;
  readonly embeddingStore: EmbeddingStore;
  /** Resolves the goal/intent text for the current tick. */
  readonly goalResolver: GoalResolver;
  readonly log?: (msg: string) => void;
}

/**
 * Build a `CostToolFilter` that performs intent-RAG retrieval per call.
 * Returns `null` (= pass-through) on any pass-through condition.
 *
 * This factory is what consumers wire INSTEAD of `weaveToolSubsetFilter`
 * when their effective `CostPolicy.toolSubset.strategy === 'intent-rag'`.
 * The Phase 5 phase-strategy filter is still the right choice for small
 * tool catalogs and deterministic phase mappings — intent-rag pays off
 * once the catalog grows past ~50 tools and the agent's intent varies
 * within a single phase.
 */
export function weaveIntentRagToolSubsetFilter(
  opts: WeaveIntentRagToolSubsetFilterOptions,
): CostToolFilter {
  const log = opts.log ?? ((m) => console.log('[cost-governor.intent-rag]', m));
  return async (toolKeys, ctx) => {
    try {
      if (!opts.config || opts.config.strategy !== 'intent-rag') return null;
      let goal: string | null | undefined;
      try {
        goal = await opts.goalResolver(ctx);
      } catch (err) {
        log(`goalResolver threw, pass-through: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
      if (!goal || typeof goal !== 'string' || goal.trim().length === 0) return null;

      let toolEmbeddings: ReadonlyArray<ToolEmbedding> = [];
      try {
        toolEmbeddings = await opts.embeddingStore.getAll();
      } catch (err) {
        log(`embeddingStore.getAll threw, pass-through: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
      if (toolEmbeddings.length === 0) return null;

      let goalVector: ReadonlyArray<number> | null = null;
      try {
        const result = await opts.embedder.embed([goal]);
        goalVector = result[0] ?? null;
      } catch (err) {
        log(`embedder.embed threw, pass-through: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
      if (!goalVector || goalVector.length === 0) return null;

      const decision = decideIntentRagSubset({
        config: {
          ...(opts.config.topK !== undefined ? { topK: opts.config.topK } : {}),
          ...(opts.config.minSimilarity !== undefined ? { minSimilarity: opts.config.minSimilarity } : {}),
          ...(opts.config.includeAlways !== undefined ? { includeAlways: opts.config.includeAlways } : {}),
        },
        availableKeys: toolKeys,
        goalVector,
        toolEmbeddings,
      });
      return decision.filtered ? decision.keep : null;
    } catch (err) {
      log(`intent-rag filter unexpected error, pass-through: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };
}
