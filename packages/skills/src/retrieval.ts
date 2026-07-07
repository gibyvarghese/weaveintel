// SPDX-License-Identifier: MIT
/**
 * Skill retrieval — how the runtime finds the *candidate* skills for a query
 * before the (optional) reasoning selector makes the final pick.
 *
 * The original matcher is **lexical** (word-overlap / TF-cosine). It is exact and
 * zero-dependency, but it misses paraphrase and synonyms ("tidy up my code" never
 * matches a skill described as "refactor and improve source quality").
 *
 * This module adds a pluggable `SkillRetriever` seam with three strategies:
 *   • `lexicalSkillRetriever()`   — the existing word-overlap matcher. Default, no deps.
 *   • `embeddingSkillRetriever()` — meaning-based: embeds each skill's short "card" and
 *                                   ranks by vector similarity to the query. You inject the
 *                                   embedder (e.g. from an OpenAI provider), so this package
 *                                   stays model-agnostic.
 *   • `hybridSkillRetriever()`    — runs both and fuses them with Reciprocal Rank Fusion
 *                                   (reused from `@weaveintel/retrieval`). Best of both:
 *                                   embeddings catch paraphrase, lexical catches rare/exact
 *                                   terms (skill ids, trigger keywords). Falls back to lexical
 *                                   if the embedder is unavailable.
 *
 * `createSkillRouter()` implements the "retrieve-then-select" pattern: retrieve a small
 * top-K, then only reason over those K — so a 5,000-skill catalog costs the same prompt
 * budget as a 6-skill one.
 *
 * Design intent (open-core): the *engine* (these strategies) lives here; the *choice* of
 * embedding model, catalog, and thresholds is the app's, injected in.
 */

import { reciprocalRankFusion } from '@weaveintel/retrieval';
import type {
  SkillDefinition,
  SkillMatch,
  SkillReasoningSelector,
  SkillInvocationMode,
} from './types.js';
import { semanticScore, semanticRationale } from './matching.js';

/** Embed one or more texts into vectors. Inject your provider's embedder here. */
export type SkillEmbedFn = (texts: readonly string[]) => Promise<number[][]>;

/** A retrieved skill candidate with its score, 1-based rank, and where it came from. */
export interface SkillCandidate {
  readonly skill: SkillDefinition;
  readonly score: number;
  readonly rank: number;
  readonly source: 'lexical' | 'embedding' | 'hybrid';
}

export interface SkillRetrieveOptions {
  /** Maximum candidates to return (default 6). */
  readonly limit?: number;
  /** Drop candidates below this score (retriever-specific scale; default 0). */
  readonly minScore?: number;
}

/** The seam: given a query and the enabled skills, return ranked candidates. */
export interface SkillRetriever {
  retrieve(
    query: string,
    skills: readonly SkillDefinition[],
    opts?: SkillRetrieveOptions,
  ): Promise<SkillCandidate[]>;
}

// ─── Skill "card" (Level-1 disclosure text used for retrieval) ────────────────
//
// We embed/score against a *short* card, not the whole playbook: the name, one-line
// summary, when-to-use, trigger phrases and tags. This is what actually signals "is
// this skill relevant?" and keeps embedding cost + noise low.
export function skillCard(skill: SkillDefinition): string {
  return [
    skill.name,
    skill.summary,
    skill.whenToUse,
    skill.purpose,
    (skill.triggerPatterns ?? []).join('  '),
    (skill.tags ?? []).join(' '),
  ]
    .filter(Boolean)
    .join('\n')
    .trim();
}

function toMatch(c: SkillCandidate): SkillMatch {
  return {
    skill: c.skill,
    score: c.score,
    matchedPatterns: [],
    rationale:
      c.source === 'embedding'
        ? 'Meaning-based (embedding) similarity to the request.'
        : c.source === 'hybrid'
          ? 'Hybrid match: meaning (embedding) + keyword overlap, rank-fused.'
          : semanticRationale(c.skill, ''),
    source: 'semantic',
  };
}

/** Convert retriever candidates into the `SkillMatch[]` the activation pipeline expects. */
export function candidatesToMatches(cands: readonly SkillCandidate[]): SkillMatch[] {
  return cands.map(toMatch);
}

// ─── Lexical retriever (default, zero-dep) ───────────────────────────────────

export function lexicalSkillRetriever(): SkillRetriever {
  return {
    async retrieve(query, skills, opts) {
      if (!query.trim()) return [];
      const limit = opts?.limit ?? 6;
      const minScore = opts?.minScore ?? 0;
      return skills
        .filter((s) => s.enabled !== false)
        .map((skill) => ({ skill, score: semanticScore(query, skill) }))
        .filter((r) => r.score >= minScore)
        .sort((a, b) => b.score - a.score || (b.skill.priority ?? 0) - (a.skill.priority ?? 0))
        .slice(0, limit)
        .map((r, i): SkillCandidate => ({ skill: r.skill, score: r.score, rank: i + 1, source: 'lexical' }));
    },
  };
}

// ─── Embedding index (in-memory, cached) ─────────────────────────────────────

function dot(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}
function norm(a: readonly number[]): number {
  return Math.sqrt(dot(a, a)) || 1;
}
export function cosine(a: readonly number[], b: readonly number[]): number {
  return dot(a, b) / (norm(a) * norm(b));
}

// A tiny stable hash of a skill's card, so we only re-embed when the card text changes.
function hashCard(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export interface SkillEmbeddingIndex {
  /** Embed any new/changed skill cards (cheap on re-run — unchanged cards are cached). */
  sync(skills: readonly SkillDefinition[]): Promise<void>;
  /** Rank the indexed skills against a query by cosine similarity. */
  query(query: string, limit: number): Promise<Array<{ id: string; score: number }>>;
  size(): number;
}

/**
 * Build an in-memory embedding index over skill cards. Suitable for catalogs up to
 * tens of thousands of skills (O(n) cosine per query, sub-millisecond for thousands).
 * For very large / multi-tenant catalogs, back it with a `VectorStore` from
 * `@weaveintel/retrieval` instead (see the README).
 */
export function createSkillEmbeddingIndex(embed: SkillEmbedFn): SkillEmbeddingIndex {
  // id -> { hash, vector }
  const store = new Map<string, { hash: string; vector: number[] }>();

  return {
    async sync(skills) {
      const pending: Array<{ id: string; hash: string; text: string }> = [];
      const liveIds = new Set<string>();
      for (const s of skills) {
        if (s.enabled === false) continue;
        liveIds.add(s.id);
        const text = skillCard(s);
        const hash = hashCard(text);
        const existing = store.get(s.id);
        if (!existing || existing.hash !== hash) pending.push({ id: s.id, hash, text });
      }
      // drop skills that disappeared
      for (const id of [...store.keys()]) if (!liveIds.has(id)) store.delete(id);

      if (pending.length) {
        const vectors = await embed(pending.map((p) => p.text));
        pending.forEach((p, i) => {
          const v = vectors[i];
          if (v && v.length) store.set(p.id, { hash: p.hash, vector: v });
        });
      }
    },
    async query(query, limit) {
      if (store.size === 0) return [];
      const [qv] = await embed([query]);
      if (!qv || !qv.length) return [];
      const scored: Array<{ id: string; score: number }> = [];
      for (const [id, { vector }] of store) scored.push({ id, score: cosine(qv, vector) });
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit);
    },
    size: () => store.size,
  };
}

export interface EmbeddingRetrieverConfig {
  readonly embed: SkillEmbedFn;
  /** Reuse a pre-built index (avoids re-embedding across calls). Optional. */
  readonly index?: SkillEmbeddingIndex;
}

export function embeddingSkillRetriever(config: EmbeddingRetrieverConfig): SkillRetriever {
  const index = config.index ?? createSkillEmbeddingIndex(config.embed);
  return {
    async retrieve(query, skills, opts) {
      if (!query.trim()) return [];
      const limit = opts?.limit ?? 6;
      const minScore = opts?.minScore ?? 0;
      await index.sync(skills);
      const byId = new Map(skills.map((s) => [s.id, s]));
      const ranked = await index.query(query, Math.max(limit, 1));
      return ranked
        .filter((r) => r.score >= minScore && byId.has(r.id))
        .slice(0, limit)
        .map((r, i): SkillCandidate => ({ skill: byId.get(r.id)!, score: r.score, rank: i + 1, source: 'embedding' }));
    },
  };
}

// ─── Hybrid retriever (lexical + embedding, RRF-fused) ───────────────────────

export interface HybridRetrieverConfig {
  readonly embed: SkillEmbedFn;
  readonly index?: SkillEmbeddingIndex;
  /** RRF constant (higher = flatter fusion). Default 60 — the community standard. */
  readonly rrfK?: number;
  /** Over-fetch factor per retriever before fusion (default 2×). */
  readonly candidateMultiplier?: number;
  /** If the embedder throws, fall back to lexical-only instead of failing (default true). */
  readonly fallbackToLexical?: boolean;
}

export function hybridSkillRetriever(config: HybridRetrieverConfig): SkillRetriever {
  const lexical = lexicalSkillRetriever();
  const embedding = embeddingSkillRetriever({ embed: config.embed, index: config.index });
  const rrfK = config.rrfK ?? 60;
  const mult = config.candidateMultiplier ?? 2;
  const fallback = config.fallbackToLexical ?? true;

  return {
    async retrieve(query, skills, opts) {
      if (!query.trim()) return [];
      const limit = opts?.limit ?? 6;
      const fetch = Math.max(limit * mult, limit);
      const lexRanked = await lexical.retrieve(query, skills, { limit: fetch });

      let embRanked: SkillCandidate[] = [];
      try {
        embRanked = await embedding.retrieve(query, skills, { limit: fetch });
      } catch (err) {
        if (!fallback) throw err;
        // Embedder unavailable → lexical-only (graceful, no throw).
        return lexRanked.slice(0, limit).map((c, i) => ({ ...c, rank: i + 1 }));
      }
      if (!embRanked.length) return lexRanked.slice(0, limit).map((c, i) => ({ ...c, rank: i + 1 }));

      // Fuse the two ranked lists by rank (score-scale agnostic) — reused from retrieval.
      const fused = reciprocalRankFusion(
        [lexRanked.map((c) => ({ id: c.skill.id })), embRanked.map((c) => ({ id: c.skill.id }))],
        rrfK,
      );
      const byId = new Map(skills.map((s) => [s.id, s]));
      return fused
        .filter((f) => byId.has(f.id))
        .slice(0, limit)
        .map((f, i): SkillCandidate => ({ skill: byId.get(f.id)!, score: f.score, rank: i + 1, source: 'hybrid' }));
    },
  };
}

// ─── Retrieve-then-select router ─────────────────────────────────────────────

export interface SkillRouterConfig {
  readonly retriever: SkillRetriever;
  /** Optional reasoning selector run over ONLY the retrieved top-K (keeps context bounded). */
  readonly selector?: SkillReasoningSelector;
  /** How many candidates to retrieve before selecting (default 6). */
  readonly retrieveK?: number;
  /** Final cap on selected skills (default 3). */
  readonly maxSelected?: number;
  readonly mode?: SkillInvocationMode;
}

export interface SkillRouterResult {
  readonly candidates: SkillCandidate[];
  readonly selected: SkillMatch[];
  readonly noSkillReason?: string;
}

/**
 * Retrieve-then-select: fetch a small top-K with the retriever, then (optionally) let the
 * reasoning selector choose among just those K. This is what keeps a huge catalog cheap —
 * the model only ever sees the K most relevant skills, not the whole library.
 */
export function createSkillRouter(config: SkillRouterConfig) {
  const retrieveK = config.retrieveK ?? 6;
  const maxSelected = config.maxSelected ?? 3;
  const mode = config.mode ?? 'reasoning_support';

  return {
    async route(query: string, skills: readonly SkillDefinition[]): Promise<SkillRouterResult> {
      const candidates = await config.retriever.retrieve(query, skills, { limit: retrieveK });
      if (!candidates.length) {
        return { candidates: [], selected: [], noSkillReason: 'No relevant skill candidates found.' };
      }
      const matches = candidatesToMatches(candidates);
      if (!config.selector) {
        return { candidates, selected: matches.slice(0, maxSelected) };
      }
      try {
        const decision = await config.selector({ query, mode, candidates: matches });
        if (decision.useNoSkillPath) {
          return { candidates, selected: [], noSkillReason: decision.rationale ?? 'Selector chose no-skill path.' };
        }
        const chosen = new Set(decision.selectedSkillIds);
        const selected = matches
          .filter((m) => chosen.has(m.skill.id))
          .map((m) => ({ ...m, source: 'reasoning' as const, rationale: decision.rationale ?? m.rationale }))
          .slice(0, maxSelected);
        return { candidates, selected };
      } catch {
        // Selector is an optional enhancement — fall back to top-K by relevance.
        return { candidates, selected: matches.slice(0, maxSelected) };
      }
    },
  };
}
