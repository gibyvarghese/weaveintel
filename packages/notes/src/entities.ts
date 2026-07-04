// SPDX-License-Identifier: MIT
/**
 * @weaveintel/notes — entity resolution / disambiguation for the knowledge graph.
 *
 * --- For someone new to this ---
 * When the AI reads your notes it pulls out the people, organisations and concepts they mention (their
 * "entities"). The problem: the SAME thing gets written many ways — "OpenAI", "Open AI", "OpenAI, Inc.",
 * or "World Health Organization" vs "WHO". If we treat each spelling as a different thing, the knowledge
 * graph fragments and notes that are really about the same subject never connect.
 *
 * "Entity resolution" (a.k.a. disambiguation) fixes that: it works out which surface forms are the SAME
 * entity and folds them into ONE canonical entity, so the graph links every note that mentions it. This
 * is the quality that turns a pile of extracted names into a real GraphRAG-style graph.
 *
 * These helpers are PURE (no I/O, no LLM) — cheap, deterministic, and easy to test. The app stores the
 * `canonicalKey` alongside each entity so the graph groups by it, and connects notes that share one.
 */

/** One raw entity the extractor found in a note. */
export interface EntityMention {
  name: string;
  type?: string;
}

/** A resolved entity: one canonical identity that may have several surface spellings (aliases). */
export interface CanonicalEntity {
  /** The stable key notes are grouped/linked by (normalised; never shown to users). */
  key: string;
  /** The best display name (the fullest, most specific surface form seen). */
  name: string;
  /** The most common type across the merged mentions (person/org/concept/…), if any. */
  type?: string;
  /** Every distinct surface form that folded into this entity. */
  aliases: string[];
  /** How many raw mentions folded in. */
  count: number;
}

const LEGAL_SUFFIXES = new Set(['inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'plc', 'gmbh', 'sa', 'ag', 'nv', 'llp', 'lp']);

/**
 * Normalise an entity name to a stable KEY for matching: lowercase, strip accents, drop a leading
 * "the ", remove punctuation, drop a trailing legal suffix (Inc/Ltd/LLC/…), and collapse whitespace.
 * "OpenAI, Inc." and "the OpenAI" both → "openai".
 */
export function canonicalizeEntityName(name: string): string {
  let s = (name ?? '').trim().toLowerCase();
  if (!s) return '';
  // Strip diacritics (é→e) so "São Paulo" and "Sao Paulo" match.
  s = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  s = s.replace(/^the\s+/, '');                 // drop a leading article
  s = s.replace(/[.,''`"()]/g, ' ');            // punctuation → space
  s = s.replace(/[^a-z0-9\s&/-]/g, ' ');        // keep alnum + a few joiners
  s = s.replace(/\s+/g, ' ').trim();
  // Drop a single trailing legal suffix ("openai inc" → "openai").
  const parts = s.split(' ');
  while (parts.length > 1 && LEGAL_SUFFIXES.has(parts[parts.length - 1]!)) parts.pop();
  return parts.join(' ');
}

/** Uppercase initials of a multi-word name, ignoring tiny joiner words ("World Health Organization" → "WHO"). */
function acronymOf(name: string): string {
  const words = canonicalizeEntityName(name).split(' ').filter((w) => w && !['of', 'and', 'the', 'for', 'de', 'la'].includes(w));
  if (words.length < 2) return '';
  return words.map((w) => w[0]!).join('').toUpperCase();
}

/** Pick the best display name from a set of surface forms: the longest (fullest) non-acronym, else the longest. */
function bestName(forms: string[]): string {
  const nonAcronym = forms.filter((f) => !/^[A-Z0-9]{2,6}$/.test(f.trim()));
  const pool = nonAcronym.length ? nonAcronym : forms;
  return pool.slice().sort((a, b) => b.trim().length - a.trim().length || a.localeCompare(b))[0]!;
}

/**
 * Resolve a list of raw entity mentions into canonical entities: fold together spellings that share a
 * canonical key, PLUS an acronym ↔ full-name match (so "WHO" merges with "World Health Organization"
 * when both appear). Returns one `CanonicalEntity` per real-world thing, most-mentioned first.
 */
export function resolveEntities(mentions: ReadonlyArray<EntityMention>): CanonicalEntity[] {
  // Bucket by canonical key first.
  const buckets = new Map<string, { forms: string[]; types: string[]; count: number }>();
  for (const m of mentions) {
    const name = (m.name ?? '').trim();
    if (!name) continue;
    const key = canonicalizeEntityName(name);
    if (!key) continue;
    const b = buckets.get(key) ?? { forms: [], types: [], count: 0 };
    b.forms.push(name);
    if (m.type) b.types.push(m.type.trim().toLowerCase());
    b.count++;
    buckets.set(key, b);
  }

  // Acronym pass: if a short bucket's key looks like the acronym of a longer bucket, merge into the longer.
  const keys = [...buckets.keys()];
  const acronymIndex = new Map<string, string>(); // acronym → the fuller entity's key
  for (const k of keys) {
    const ac = acronymOf([...buckets.get(k)!.forms][0]!);
    if (ac) acronymIndex.set(ac.toLowerCase(), k);
  }
  const merged = new Map<string, { forms: string[]; types: string[]; count: number }>();
  const remap = new Map<string, string>();
  for (const k of keys) {
    // A bucket whose key IS an acronym (single token, matches the initials of a longer entity) folds in.
    const asAcronym = k.replace(/\s+/g, '');
    const target = (!k.includes(' ') && acronymIndex.has(asAcronym) && acronymIndex.get(asAcronym) !== k)
      ? acronymIndex.get(asAcronym)!
      : k;
    remap.set(k, target);
  }
  for (const k of keys) {
    const target = remap.get(k)!;
    const src = buckets.get(k)!;
    const dst = merged.get(target) ?? { forms: [], types: [], count: 0 };
    dst.forms.push(...src.forms); dst.types.push(...src.types); dst.count += src.count;
    merged.set(target, dst);
  }

  const out: CanonicalEntity[] = [];
  for (const [key, b] of merged) {
    const aliases = [...new Set(b.forms)];
    const type = mostCommon(b.types);
    out.push({ key, name: bestName(aliases), aliases, count: b.count, ...(type ? { type } : {}) });
  }
  out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return out;
}

function mostCommon(xs: string[]): string | undefined {
  if (!xs.length) return undefined;
  const counts = new Map<string, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

/**
 * Chunk an array into batches of at most `size` — used to embed many notes in one model call
 * instead of N (fixing the N+1 embedding cost). Pure.
 */
export function chunk<T>(items: ReadonlyArray<T>, size: number): T[][] {
  const n = Math.max(1, Math.floor(size) || 1);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}
