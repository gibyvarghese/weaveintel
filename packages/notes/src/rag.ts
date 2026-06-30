// SPDX-License-Identifier: MIT
/**
 * @weaveintel/notes — WORKSPACE RAG helpers (weaveNotes Phase 8).
 *
 * "RAG" (retrieval-augmented generation) means: before the AI answers, FETCH the most
 * relevant pieces of your own content, hand them to the model as context, and have it
 * answer FROM those pieces — citing each one. That turns "the AI guessed" into "the AI
 * summarized what YOUR notes and past chats actually say, with links you can click to
 * check." This module is the pure, reusable core of that: it does NOT do any embedding,
 * database, or network work (the app does), so it is trivially testable.
 *
 * Three jobs:
 *   1. `snippetAround` — pull a short, readable excerpt from a long document, centred on
 *      the part that matches the query (so a citation shows the relevant sentence, not the
 *      first 200 characters of an unrelated intro).
 *   2. `reciprocalRankFusion` — when results come from MORE than one place (your notes AND
 *      your past chat runs), merge the ranked lists fairly into one. RRF is the standard,
 *      score-scale-independent way to do this: an item's fused score is the sum of
 *      1/(k+rank) across the lists it appears in, so being near the top of several lists
 *      beats being #1 in only one.
 *   3. `buildCitedContext` — format the chosen hits into a numbered context block for the
 *      LLM ("[1] … [2] …") plus a parallel `sources` list, and `parseCitedIds` reads the
 *      [N] markers back out of the answer so the UI can show exactly which sources were used.
 *
 * --- For someone new to this ---
 * Think of it like writing an essay with footnotes: you gather the relevant quotes (snippets),
 * number them [1], [2], [3] (the context), write your answer referring to those numbers, and
 * the reader can follow each number back to its source. RAG makes the AI do exactly that.
 */

export interface RagHit {
  /** A stable id for the source (e.g. a note id or run id). */
  id: string;
  /** What kind of thing this is (for the UI badge + grouping). */
  kind: 'note' | 'run' | string;
  /** A human title for the source. */
  title: string;
  /** The full text of the source (a snippet is derived from it). */
  content: string;
  /** The retrieval score (e.g. cosine similarity), higher = more relevant. */
  score: number;
}

export interface CitedSource {
  /** The 1-based citation number used in the context + answer ("[n]"). */
  n: number;
  id: string;
  kind: string;
  title: string;
  /** The excerpt shown for this source. */
  snippet: string;
}

/** Lowercase word tokens (≥2 chars) for cheap keyword matching. */
function tokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []);
}

/**
 * Extract a short, readable excerpt from `content`, centred on the first place a query
 * word appears (so the snippet is RELEVANT, not just the opening). Falls back to the start
 * of the document when nothing matches. Collapses whitespace and adds ellipses at cut edges.
 */
export function snippetAround(content: string, query: string, maxLen = 240): string {
  const text = (content ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLen) return text;
  const qWords = new Set(tokens(query));
  // Find the earliest offset of any query word in the text (word-ish boundary).
  let hit = -1;
  if (qWords.size > 0) {
    const re = new RegExp(`\\b(${[...qWords].map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'i');
    const m = re.exec(text);
    if (m) hit = m.index;
  }
  if (hit < 0) return `${text.slice(0, maxLen).trimEnd()}…`;
  // Centre a window of maxLen on the hit, clamped to the text bounds.
  let start = Math.max(0, hit - Math.floor(maxLen / 3));
  let end = Math.min(text.length, start + maxLen);
  start = Math.max(0, end - maxLen);
  // Snap the start to a word boundary so we don't begin mid-word.
  if (start > 0) { const sp = text.indexOf(' ', start); if (sp >= 0 && sp < hit) start = sp + 1; }
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

/**
 * Reciprocal Rank Fusion: merge several ranked lists of ids into one fused ranking.
 * Each list is ASSUMED to be ordered best-first. An id's fused score is the sum over the
 * lists it appears in of `1 / (k + rank)` (rank is 1-based). `k` (default 60, the standard)
 * damps the influence of any single list's exact positions. Returns ids best-first with
 * their fused score. Score scales of the input lists are irrelevant — only ranks matter.
 */
export function reciprocalRankFusion(lists: Array<Array<{ id: string }>>, k = 60): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    for (let i = 0; i < list.length; i++) {
      const id = list[i]!.id;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
    }
  }
  return [...scores.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score);
}

/**
 * Turn the chosen hits into (a) a numbered CONTEXT block to hand the LLM and (b) a parallel
 * `sources` list for the UI. Each source gets a citation number `[n]`, a query-centred
 * snippet, and its id/kind/title. The model is meant to answer FROM this context and cite
 * with "[n]". `maxSources` caps how many we include (token budget); `snippetLen` bounds each.
 */
export function buildCitedContext(
  hits: RagHit[],
  query: string,
  opts: { maxSources?: number; snippetLen?: number } = {},
): { context: string; sources: CitedSource[] } {
  const maxSources = opts.maxSources ?? 6;
  const snippetLen = opts.snippetLen ?? 240;
  const chosen = hits.slice(0, maxSources);
  const sources: CitedSource[] = chosen.map((h, i) => ({
    n: i + 1,
    id: h.id,
    kind: h.kind,
    title: h.title || '(untitled)',
    snippet: snippetAround(h.content, query, snippetLen),
  }));
  const context = sources
    .map((s) => `[${s.n}] (${s.kind}: ${s.title})\n${s.snippet}`)
    .join('\n\n');
  return { context, sources };
}

/**
 * Read the citation markers ("[1]", "[2, 3]", "[1][4]") out of an answer and map them to
 * the source ids that were actually cited. Numbers outside the source range are ignored.
 * Returns the cited sources in first-mention order (deduped) — what the UI highlights.
 */
export function parseCitedIds(answer: string, sources: CitedSource[]): CitedSource[] {
  const byN = new Map(sources.map((s) => [s.n, s]));
  const seen = new Set<number>();
  const out: CitedSource[] = [];
  for (const m of (answer ?? '').matchAll(/\[([\d\s,]+)\]/g)) {
    for (const part of m[1]!.split(',')) {
      const n = Number(part.trim());
      if (!Number.isInteger(n) || seen.has(n)) continue;
      const src = byN.get(n);
      if (src) { seen.add(n); out.push(src); }
    }
  }
  return out;
}

// ─── Phase 2: VERIFIED CHARACTER-LEVEL citations ─────────────────────────────────────────────
//
// Source-level "[1]" citations tell you WHICH note an answer came from. Character-level citations
// tell you WHICH SENTENCE — each claim is backed by an exact verbatim QUOTE from the source, with
// the quote's character span. We then VERIFY every quote actually exists in the source text and DROP
// any the model invented (the #1 anti-hallucination control — the Anthropic Citations API pattern:
// the model may only cite real source text). The UI highlights the quote in the source on click.

/** A source the model may quote, with the FULL text a quote must be found within. */
export interface CitableSource { n: number; id: string; kind: string; title: string; content: string }

/** What the model claims it quoted (before we verify it). */
export interface RawCitation { source: number; quote: string }

/** A verified citation: the quote provably appears in `sourceId`'s text at [charStart, charEnd). */
export interface Citation {
  n: number;            // the source number it was drawn from
  sourceId: string;     // the note / run id (the UI opens this)
  sourceKind: string;
  sourceTitle: string;
  quote: string;        // the verbatim quote — exists in the source (the UI highlights it)
  charStart: number;    // offset into the source's plain text
  charEnd: number;
}

/** Collapse whitespace + lowercase, keeping a map from each normalised index → original index. */
function normalizeWithMap(text: string): { norm: string; map: number[] } {
  let norm = '';
  const map: number[] = [];
  let prevSpace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      if (prevSpace) continue;
      norm += ' '; map.push(i); prevSpace = true;
    } else {
      norm += ch.toLowerCase(); map.push(i); prevSpace = false;
    }
  }
  return { norm, map };
}

/**
 * Find the character span of `quote` inside `source`. Tries an EXACT substring match first, then a
 * whitespace-and-case-insensitive match (so a quote that differs only in spacing/casing still
 * resolves to the real span). Returns `null` when the quote is NOT in the source — i.e. the model
 * paraphrased or invented it, and the citation must be dropped. Never does fuzzy/semantic matching:
 * a citation is only "verified" if the actual words are present.
 */
export function locateQuote(source: string, quote: string): { start: number; end: number } | null {
  if (!source || !quote) return null;
  const q = quote.trim();
  if (q.length < 3) return null; // too short to be a meaningful, locatable quote
  const exact = source.indexOf(q);
  if (exact >= 0) return { start: exact, end: exact + q.length };
  // Normalised (whitespace + case) match, mapped back to original offsets.
  const { norm, map } = normalizeWithMap(source);
  const nq = q.replace(/\s+/g, ' ').toLowerCase();
  const nIdx = norm.indexOf(nq);
  if (nIdx >= 0) {
    const start = map[nIdx] ?? 0;
    const end = (map[nIdx + nq.length - 1] ?? start) + 1;
    return { start, end };
  }
  // Ellipsis quotes ("the start … the end") are wildcards: locate the first + last segment and
  // return the ENCLOSING span (both must be present, in order). Models elide the middle of a quote.
  if (/\.\.\.|…/.test(q)) {
    const segs = q.split(/\s*(?:\.\.\.|…)\s*/).map((s) => s.replace(/\s+/g, ' ').trim().toLowerCase()).filter((s) => s.length >= 3);
    if (segs.length >= 2) {
      const head = norm.indexOf(segs[0]!);
      const tailSeg = segs[segs.length - 1]!;
      const tail = norm.indexOf(tailSeg, head + segs[0]!.length);
      if (head >= 0 && tail > head) {
        const start = map[head] ?? 0;
        const end = (map[tail + tailSeg.length - 1] ?? start) + 1;
        return { start, end };
      }
    }
  }
  return null;
}

/**
 * Build the prompt that makes the model ANSWER a question FROM numbered sources AND, for each claim,
 * output the source number + the EXACT VERBATIM quote it relied on (so we can locate + verify the
 * span). Returns strict JSON. Instructs: quote word-for-word from the source (never paraphrase), keep
 * quotes short (one sentence), and say so plainly if the sources don't answer the question.
 */
export function buildCitedAnswerPrompt(query: string, sources: CitableSource[], opts: { perSourceChars?: number } = {}): { system: string; user: string } {
  const cap = opts.perSourceChars ?? 2400;
  const system = `You answer a question USING ONLY the numbered sources provided, and you ground every claim in an exact quote.

Rules:
- Answer the QUESTION using only facts found in the SOURCES. If the sources do not contain the answer, say so plainly and cite nothing.
- For each factual claim, include a citation: the source number AND the EXACT verbatim text you took it from. Copy the quote WORD-FOR-WORD from that source (do not paraphrase, fix spelling, or shorten mid-word) so it can be found in the original. Keep each quote to one short sentence or phrase.
- Write the answer in plain prose with [n] markers where each claim is supported.

Return ONLY this JSON: {"answer":"… [1] … [2] …","citations":[{"source":1,"quote":"exact words from source 1"},{"source":2,"quote":"exact words from source 2"}]}`;
  const blocks = sources.map((s) => `[${s.n}] (${s.kind}: ${s.title})\n${(s.content ?? '').slice(0, cap)}`).join('\n\n');
  const user = `SOURCES:\n${blocks}\n\nQUESTION: ${query}`;
  return { system, user };
}

/** Parse the model's `{answer, citations:[{source, quote}]}` reply (tolerant of surrounding prose). */
export function parseCitedAnswer(reply: string): { answer: string; citations: RawCitation[] } {
  let obj: Record<string, unknown> = {};
  try {
    const m = (reply ?? '').match(/\{[\s\S]*\}/);
    if (m) obj = JSON.parse(m[0]) as Record<string, unknown>;
  } catch { /* fall through */ }
  const answer = typeof obj['answer'] === 'string' ? obj['answer'] : (reply ?? '').trim();
  const raw = Array.isArray(obj['citations']) ? obj['citations'] : [];
  const citations: RawCitation[] = [];
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue;
    const source = Number((c as Record<string, unknown>)['source']);
    const quote = String((c as Record<string, unknown>)['quote'] ?? '');
    if (Number.isInteger(source) && quote.trim()) citations.push({ source, quote });
  }
  return { answer, citations };
}

/**
 * Verify each raw citation against its source: locate the quote, compute its char span, and KEEP only
 * the ones that are really present (dropping the model's invented quotes). Deduped by (source, span).
 */
export function verifyCitations(raw: RawCitation[], sources: CitableSource[]): Citation[] {
  const byN = new Map(sources.map((s) => [s.n, s]));
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const c of raw) {
    const src = byN.get(c.source);
    if (!src) continue;
    const span = locateQuote(src.content, c.quote);
    if (!span) continue; // invented / paraphrased quote — not verifiable, so dropped
    const key = `${src.id}:${span.start}:${span.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ n: c.source, sourceId: src.id, sourceKind: src.kind, sourceTitle: src.title, quote: src.content.slice(span.start, span.end), charStart: span.start, charEnd: span.end });
  }
  return out;
}
