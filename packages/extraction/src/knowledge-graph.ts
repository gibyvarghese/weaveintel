// SPDX-License-Identifier: MIT
/**
 * @weaveintel/extraction — LLM-backed knowledge-graph extraction (weaveNotes Phase 5).
 *
 * The deterministic stages in this package catch *shapes* (emails, dates, tasks). To
 * build a real knowledge graph from a note we also want the *meaning*: the people,
 * places, organizations, concepts a note is about (ENTITIES), and how they relate
 * ("Alice works_at Acme", "Majorana qubit is_a topological qubit") — RELATIONS.
 * That needs a language model, so this module is model-AGNOSTIC: you pass a `generate`
 * function (text-in → text-out) and we own the prompt + the strict parsing/sanitizing.
 * Keeping the model out of the package means it stays pure + testable (feed a fake
 * `generate`), and the host (geneWeave) wires in whichever LLM it uses.
 *
 * --- For someone new to this ---
 * An "entity" is a thing the text is about (a person, a company, a concept). A
 * "relation" is a labelled connection between two entities, written as a little
 * sentence: subject → predicate → object. Collect enough of these across your notes
 * and you get a *knowledge graph* — a web of what-relates-to-what you can browse.
 */

/** A thing the note is about. */
export interface GraphEntity {
  /** Canonical display name (e.g. "Majorana qubit"). */
  name: string;
  /** A coarse type — person | organization | location | concept | technology | event | other. */
  type: string;
}

/** A labelled connection: `subject —predicate→ object`. */
export interface GraphRelation {
  subject: string;
  predicate: string;
  object: string;
}

export interface KnowledgeGraph {
  entities: GraphEntity[];
  relations: GraphRelation[];
}

/** A minimal "prompt → text" function (so the package never imports a model). */
export type GenerateFn = (opts: { system?: string; user: string; maxTokens?: number; temperature?: number }) => Promise<string>;

export interface ExtractKnowledgeGraphOptions {
  /** Cap entities/relations kept (anti-bloat). Default 24 each. */
  maxItems?: number;
  /** Bound the text sent to the model. Default 6000 chars. */
  maxChars?: number;
}

const ENTITY_TYPES = new Set(['person', 'organization', 'location', 'concept', 'technology', 'event', 'product', 'other']);

const SYSTEM = [
  'You extract a small knowledge graph from a document for a personal note-taking app.',
  'Return ONLY compact JSON (no prose, no code fences) of the form:',
  '{"entities":[{"name":"...","type":"person|organization|location|concept|technology|event|product|other"}],',
  ' "relations":[{"subject":"...","predicate":"short_snake_case","object":"..."}]}',
  'Rules: only entities clearly present in the text; canonical names (no pronouns);',
  'predicates are short verb phrases in snake_case (e.g. works_at, is_a, located_in, founded, uses, part_of);',
  'every relation\'s subject and object SHOULD be among the entities; keep it concise and high-signal.',
].join('\n');

/** Coerce an arbitrary parsed value into a clean string, or null. */
function cleanStr(v: unknown, maxLen = 120): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/\s+/g, ' ');
  return s.length === 0 || s.length > maxLen ? (s.length > maxLen ? s.slice(0, maxLen) : null) : s;
}

/** Best-effort JSON extraction (handles stray code fences / leading prose). */
function parseJsonLoose(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { /* give up */ }
  }
  return null;
}

/**
 * Extract a knowledge graph (entities + relations) from text using the provided
 * `generate` function. Deterministically sanitizes the model output: dedupes
 * entities by lowercased name, clamps types to the known set, drops malformed
 * relations, and caps the count. Returns an empty graph (never throws) on bad output.
 */
export async function extractKnowledgeGraph(
  text: string,
  generate: GenerateFn,
  opts: ExtractKnowledgeGraphOptions = {},
): Promise<KnowledgeGraph> {
  const maxItems = opts.maxItems ?? 24;
  const maxChars = opts.maxChars ?? 6000;
  const doc = (text ?? '').slice(0, maxChars).trim();
  if (!doc) return { entities: [], relations: [] };

  let out = '';
  try {
    out = await generate({ system: SYSTEM, user: `Extract the knowledge graph from this document:\n\n${doc}`, temperature: 0, maxTokens: 900 });
  } catch {
    return { entities: [], relations: [] };
  }
  const parsed = parseJsonLoose(out);
  if (!parsed || typeof parsed !== 'object') return { entities: [], relations: [] };
  const obj = parsed as { entities?: unknown; relations?: unknown };

  // Entities — dedupe by lowercased name, clamp type.
  const byName = new Map<string, GraphEntity>();
  if (Array.isArray(obj.entities)) {
    for (const e of obj.entities) {
      if (!e || typeof e !== 'object') continue;
      const name = cleanStr((e as { name?: unknown }).name);
      if (!name) continue;
      let type = cleanStr((e as { type?: unknown }).type, 24)?.toLowerCase() ?? 'other';
      if (!ENTITY_TYPES.has(type)) type = 'other';
      const key = name.toLowerCase();
      if (!byName.has(key) && byName.size < maxItems) byName.set(key, { name, type });
    }
  }

  // Relations — keep only well-formed triples.
  const relations: GraphRelation[] = [];
  const seenRel = new Set<string>();
  if (Array.isArray(obj.relations)) {
    for (const r of obj.relations) {
      if (!r || typeof r !== 'object' || relations.length >= maxItems) continue;
      const subject = cleanStr((r as { subject?: unknown }).subject);
      const predicate = cleanStr((r as { predicate?: unknown }).predicate, 48);
      const object = cleanStr((r as { object?: unknown }).object);
      if (!subject || !predicate || !object) continue;
      const pred = predicate.replace(/\s+/g, '_').toLowerCase();
      const k = `${subject.toLowerCase()}|${pred}|${object.toLowerCase()}`;
      if (seenRel.has(k)) continue;
      seenRel.add(k);
      relations.push({ subject, predicate: pred, object });
      // Make sure relation endpoints exist as entities too (so the graph connects).
      for (const n of [subject, object]) {
        const key = n.toLowerCase();
        if (!byName.has(key) && byName.size < maxItems) byName.set(key, { name: n, type: 'other' });
      }
    }
  }

  return { entities: [...byName.values()], relations };
}
