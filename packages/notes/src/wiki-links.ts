// SPDX-License-Identifier: MIT
/**
 * @weaveintel/notes — wiki-links + unlinked-mention detection (weaveNotes Phase 5).
 *
 * This is the heart of a personal knowledge graph (the Obsidian/Tana idea): you
 * connect notes by writing `[[Another Note]]`, and the app builds the reverse
 * connection automatically (a "backlink"). On top of that, "unlinked mentions" find
 * places where you *typed the name* of another note but didn't make it a link yet —
 * a cheap, high-signal way to surface connections your notes already imply.
 *
 * --- For someone new to this ---
 * A "wiki-link" is the `[[Title]]` you write inside a note to point at another note
 * (like a hyperlink, but by title). A "backlink" is the same connection seen from
 * the other side ("which notes point at me?"). An "unlinked mention" is when a note
 * literally contains another note's title as plain text, without the `[[ ]]` — so we
 * can suggest turning it into a real link. These functions are PURE (no I/O), so they
 * are easy to test and run anywhere.
 */

/** One `[[target]]` or `[[target|alias]]` reference found in a note's text. */
export interface WikiLink {
  /** The link target (a note title), trimmed. */
  target: string;
  /** Optional display alias after a `|`. */
  alias?: string;
  /** The exact matched substring (e.g. `[[Foo|bar]]`). */
  raw: string;
}

const WIKI_LINK_RE = /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g;

/**
 * Parse all `[[wiki-links]]` from a note's text/Markdown. Supports `[[Title]]` and
 * `[[Title|display alias]]`. Targets are trimmed; empty targets are skipped.
 */
export function parseWikiLinks(text: string): WikiLink[] {
  if (!text) return [];
  const out: WikiLink[] = [];
  for (const m of text.matchAll(WIKI_LINK_RE)) {
    const target = (m[1] ?? '').trim();
    if (!target) continue;
    const alias = m[2]?.trim();
    out.push({ target, raw: m[0], ...(alias ? { alias } : {}) });
  }
  return out;
}

/** Strip `[[wiki-links]]` from text (so an existing link isn't also counted as an unlinked mention). */
function stripWikiLinks(text: string): string {
  return text.replace(WIKI_LINK_RE, ' ');
}

/** A lowercased, trimmed key for case-insensitive title matching. */
export function titleKey(title: string): string {
  return title.trim().toLowerCase();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface UnlinkedMention {
  id: string;
  title: string;
  /** How many times the title appears (as a whole phrase) in the note. */
  count: number;
}

export interface FindUnlinkedOptions {
  /** Candidate ids to exclude (e.g. the note itself). */
  excludeIds?: Set<string>;
  /** Title-keys already linked via `[[ ]]` (so we don't re-suggest them). */
  linkedTitleKeys?: Set<string>;
  /** Ignore very short titles to avoid noise (default 3 characters). */
  minTitleLength?: number;
}

/**
 * Find notes whose TITLE appears as plain text inside `text` but is NOT already a
 * `[[wiki-link]]` — the "unlinked mentions" a user can one-click convert into links.
 * Matching is case-insensitive and whole-phrase (word-boundary), and existing
 * `[[ ]]` links are removed first so they don't double-count.
 */
export function findUnlinkedMentions(
  text: string,
  candidates: ReadonlyArray<{ id: string; title: string }>,
  opts: FindUnlinkedOptions = {},
): UnlinkedMention[] {
  const minLen = opts.minTitleLength ?? 3;
  const haystack = stripWikiLinks(text ?? '');
  if (!haystack.trim()) return [];
  const exclude = opts.excludeIds ?? new Set<string>();
  const linked = opts.linkedTitleKeys ?? new Set<string>();
  const out: UnlinkedMention[] = [];
  for (const c of candidates) {
    const title = (c.title ?? '').trim();
    if (title.length < minLen) continue;
    if (exclude.has(c.id)) continue;
    if (linked.has(titleKey(title))) continue;
    // Whole-phrase, case-insensitive match. \b only anchors at word chars, so for
    // titles ending/starting in punctuation we also allow string boundaries.
    const re = new RegExp(`(?<![\\w])${escapeRegExp(title)}(?![\\w])`, 'gi');
    const matches = haystack.match(re);
    if (matches && matches.length > 0) out.push({ id: c.id, title, count: matches.length });
  }
  // Most-mentioned first.
  out.sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
  return out;
}

// ─── Phase 3: proactive linking (suggest connections as you write) ──────────────

/** A proactive link suggestion: turn a mention into a link, or link a semantically-related note. */
export interface LinkSuggestion {
  /** The note to link TO. */
  targetId: string;
  targetTitle: string;
  /** `mention` = the title appears verbatim (one-click linkify); `related` = semantically near. */
  kind: 'mention' | 'related';
  /** A short human reason for the suggestion. */
  reason: string;
  /** For mentions: how many times it appears. For related: the similarity score (0–1). */
  weight: number;
}

/**
 * Merge unlinked MENTIONS (high-confidence, verbatim) and semantically RELATED notes into one ranked
 * proactive suggestion list, deduped by target (a verbatim mention always wins over a fuzzy relation),
 * with already-linked targets removed. Mentions rank above related; ties by weight.
 */
export function buildLinkSuggestions(
  mentions: ReadonlyArray<{ id: string; title: string; count: number }>,
  related: ReadonlyArray<{ noteId: string; title: string; score: number }>,
  opts: { linkedTitleKeys?: Set<string>; max?: number } = {},
): LinkSuggestion[] {
  const linked = opts.linkedTitleKeys ?? new Set<string>();
  const byId = new Map<string, LinkSuggestion>();
  for (const m of mentions) {
    if (linked.has(titleKey(m.title))) continue;
    byId.set(m.id, { targetId: m.id, targetTitle: m.title, kind: 'mention', reason: m.count > 1 ? `mentioned ${m.count}×` : 'mentioned here', weight: m.count });
  }
  for (const r of related) {
    if (byId.has(r.noteId)) continue;                 // a verbatim mention already covers it
    if (linked.has(titleKey(r.title))) continue;
    byId.set(r.noteId, { targetId: r.noteId, targetTitle: r.title, kind: 'related', reason: `related (${Math.round(r.score * 100)}% similar)`, weight: r.score });
  }
  const all = [...byId.values()];
  all.sort((a, b) => (a.kind === b.kind ? b.weight - a.weight : a.kind === 'mention' ? -1 : 1));
  return typeof opts.max === 'number' ? all.slice(0, Math.max(0, opts.max)) : all;
}

/**
 * Wrap the FIRST unlinked, whole-phrase, case-insensitive occurrence of `title` in `text` with a
 * `[[wiki-link]]` (preserving the original casing as a display alias when it differs). Returns the new
 * text + whether anything changed. Skips occurrences already inside a `[[ ]]`.
 */
export function linkifyFirstMention(text: string, title: string): { text: string; changed: boolean } {
  const t = (title ?? '').trim();
  if (!text || t.length < 1) return { text, changed: false };
  const re = new RegExp(`(?<![\\w])${escapeRegExp(t)}(?![\\w])`, 'i');
  // Find a match that is NOT already inside an existing [[ ]] link.
  let searchFrom = 0;
  while (searchFrom <= text.length) {
    const slice = text.slice(searchFrom);
    const m = slice.match(re);
    if (!m || m.index === undefined) break;
    const at = searchFrom + m.index;
    const matched = m[0];
    // Already bracketed? (the 2 chars before are "[[" and after are "]]") → skip this occurrence.
    const before = text.slice(Math.max(0, at - 2), at);
    const after = text.slice(at + matched.length, at + matched.length + 2);
    if (before === '[[' && after === ']]') { searchFrom = at + matched.length; continue; }
    const replacement = matched === t ? `[[${t}]]` : `[[${t}|${matched}]]`;
    return { text: text.slice(0, at) + replacement + text.slice(at + matched.length), changed: true };
  }
  return { text, changed: false };
}
