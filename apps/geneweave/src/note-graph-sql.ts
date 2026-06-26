// SPDX-License-Identifier: MIT
/**
 * geneWeave notes KNOWLEDGE GRAPH service (weaveNotes Phase 5).
 *
 * Connects notes into a browsable web of meaning — the Obsidian/Tana idea — by
 * combining three reusable package primitives with the existing note-link store:
 *
 *   1. `[[wiki-links]]` (`@weaveintel/notes` parseWikiLinks) → resolved to note ids →
 *      stored as `note_links` (target_kind 'note'), which gives **backlinks** for free.
 *   2. **Entities + relations** (`@weaveintel/extraction` extractKnowledgeGraph, LLM-backed)
 *      → stored per note in `note_entities` / `note_relations`.
 *   3. **Semantic "related notes"** — each note is embedded once (`note_embeddings`) and
 *      compared by cosine similarity (`@weaveintel/cache` cosineSimilarity), so we can
 *      surface connections even when there is no explicit link.
 *
 * Plus **unlinked mentions** (`@weaveintel/notes` findUnlinkedMentions): notes whose title
 * you typed without making a link — one-click candidates to wire up.
 *
 * `indexNote` re-derives all of a note's graph contribution (idempotent: it replaces
 * the note's entities/relations and re-points its auto-links). Everything is
 * owner-scoped + tenant-isolated.
 */
import { BlockDoc, pmToBlocks, blocksToMarkdown } from '@weaveintel/coedit';
import { parseWikiLinks, findUnlinkedMentions, titleKey, extractPlainText, type Note } from '@weaveintel/notes';
import { extractKnowledgeGraph } from '@weaveintel/extraction';
import { cosineSimilarity } from '@weaveintel/cache';
import { newUUIDv7, weaveContext } from '@weaveintel/core';
import { createHash } from 'node:crypto';
import { getActiveGuardrailEmbeddingModel } from './guardrail-judge.js';
import type { NoteAccess } from './note-coedit-sql.js';
import type { NoteAiGenerate } from './note-ai-sql.js';
import type { DatabaseAdapter } from './db-types.js';
import type { NoteEntityRow, NoteRelationRow, NoteEmbeddingRow } from './db-types/adapter-me.js';

type NoteGraphDb = DatabaseAdapter;

export interface IndexResult {
  ok: boolean;
  error?: string;
  /** Number of note→note wiki-links resolved + stored. */
  links: number;
  entities: number;
  relations: number;
  embedded: boolean;
}

export interface RelatedNote { noteId: string; title: string; score: number }
export interface BacklinkRef { noteId: string; title: string }
export interface GraphNode { id: string; label: string; kind: 'note' | 'entity'; type?: string }
export interface GraphEdge { source: string; target: string; label: string }

function hashOf(s: string): string { return createHash('sha256').update(s).digest('hex').slice(0, 16); }

/** Render a note's current content to plain text (for wiki-links, entities, embedding). */
function noteText(note: { doc_json?: string }, ownerId: string): { text: string; markdown: string } {
  let pm: unknown = { type: 'doc', content: [] };
  try { pm = JSON.parse(note.doc_json ?? '') as unknown; } catch { /* empty */ }
  const text = extractPlainText(pm);
  let markdown = text;
  try { markdown = blocksToMarkdown(BlockDoc.fromBlocks(`u:${ownerId}`, pmToBlocks(pm)).blocks()); } catch { /* fall back to plain text */ }
  return { text, markdown };
}

export function createNoteGraphService(db: NoteGraphDb, opts: { generate?: NoteAiGenerate; now?: () => number } = {}) {
  const now = opts.now ?? (() => Date.now());

  /** Embed text with the active embedding model (or null if none configured). */
  async function embed(text: string, access: NoteAccess): Promise<number[] | null> {
    const model = getActiveGuardrailEmbeddingModel();
    if (!model || !text.trim()) return null;
    try {
      const ctx = weaveContext({ userId: access.ownerId, tenantId: access.tenantId ?? undefined });
      const res = await model.embed(ctx, { input: [text.slice(0, 4000)] });
      const vec = res.embeddings[0];
      return Array.isArray(vec) ? [...vec] : null;
    } catch { return null; }
  }

  return {
    /**
     * (Re)index a note into the knowledge graph: resolve its `[[wiki-links]]` to note
     * links, extract entities/relations (LLM), and embed it for semantic search.
     */
    async indexNote(input: { noteId: string; access: NoteAccess; extractGraph?: boolean }): Promise<IndexResult> {
      const note = await db.getNote(input.noteId, input.access.ownerId) as (Note | null);
      if (!note) return { ok: false, error: 'note not found', links: 0, entities: 0, relations: 0, embedded: false };
      const { text, markdown } = noteText(note, input.access.ownerId);

      // 1. Wiki-links → resolve to note ids by title → store as note→note links (idempotent).
      const allNotes = await db.listNotes(input.access.ownerId) as Note[];
      const byTitle = new Map<string, Note>();
      for (const n of allNotes) if (n.id !== input.noteId) byTitle.set(titleKey(n.title), n);
      const existing = await db.listNoteLinks(input.noteId);
      const linkedTargetIds = new Set(existing.filter((l) => l.target_kind === 'note').map((l) => l.target_id));
      let links = 0;
      for (const wl of parseWikiLinks(markdown)) {
        const target = byTitle.get(titleKey(wl.target));
        if (!target || linkedTargetIds.has(target.id)) continue;
        await db.createNoteLink({ id: newUUIDv7(), note_id: input.noteId, target_kind: 'note', target_id: target.id });
        linkedTargetIds.add(target.id);
        links++;
      }

      // 2. Entities + relations (LLM) — only when a generator is wired + requested.
      let entities = 0, relations = 0;
      if (opts.generate && input.extractGraph !== false) {
        const g = await extractKnowledgeGraph(text, (o) => opts.generate!({ ...o, userId: input.access.ownerId, tenantId: input.access.tenantId }));
        const ts = now();
        const entRows: NoteEntityRow[] = g.entities.map((e) => ({ id: newUUIDv7(), note_id: input.noteId, user_id: input.access.ownerId, tenant_id: input.access.tenantId, name: e.name, name_key: e.name.toLowerCase(), type: e.type, created_at: ts }));
        const relRows: NoteRelationRow[] = g.relations.map((r) => ({ id: newUUIDv7(), note_id: input.noteId, user_id: input.access.ownerId, tenant_id: input.access.tenantId, subject: r.subject, predicate: r.predicate, object: r.object, created_at: ts }));
        await db.replaceNoteEntities(input.noteId, entRows);
        await db.replaceNoteRelations(input.noteId, relRows);
        entities = entRows.length; relations = relRows.length;
      }

      // 3. Embedding for semantic "related notes" (skip when content unchanged).
      let embedded = false;
      const ch = hashOf(`${note.title}\n${text}`);
      const prior = await db.getNoteEmbedding(input.noteId);
      if (text.trim() && (!prior || prior.content_hash !== ch)) {
        const vec = await embed(`${note.title}\n${text}`, input.access);
        if (vec) {
          await db.upsertNoteEmbedding({ note_id: input.noteId, user_id: input.access.ownerId, tenant_id: input.access.tenantId, dim: vec.length, embedding_json: JSON.stringify(vec), content_hash: ch, title: note.title, updated_at: now() });
          embedded = true;
        }
      } else if (prior) {
        embedded = true;
      }

      return { ok: true, links, entities, relations, embedded };
    },

    /**
     * Semantic note SEARCH for an arbitrary query (the `find_related_notes` agent tool):
     * embed the query, cosine-rank the user's note embeddings, return the best matches.
     */
    async searchNotes(owner: { userId: string; tenantId?: string | null }, query: string, topK = 5): Promise<RelatedNote[]> {
      const access: NoteAccess = { noteId: '', ownerId: owner.userId, tenantId: owner.tenantId ?? null, role: 'owner' };
      const vec = await embed(query, access);
      if (!vec) return [];
      const all = await db.listUserNoteEmbeddings(owner.userId);
      const scored: RelatedNote[] = [];
      for (const row of all) {
        try {
          const other = JSON.parse(row.embedding_json) as number[];
          if (other.length !== vec.length) continue;
          scored.push({ noteId: row.note_id, title: row.title ?? '(untitled)', score: cosineSimilarity(vec, other) });
        } catch { /* skip */ }
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.filter((s) => s.score > 0.1).slice(0, topK);
    },

    /** Notes that link TO this note (backlinks), resolved to titles. */
    async backlinks(noteId: string, userId: string): Promise<BacklinkRef[]> {
      const rows = await db.listNoteBacklinks('note', noteId);
      const out: BacklinkRef[] = [];
      const seen = new Set<string>();
      for (const r of rows) {
        if (seen.has(r.note_id)) continue; seen.add(r.note_id);
        const n = await db.getNote(r.note_id, userId) as Note | null;
        if (n) out.push({ noteId: n.id, title: n.title });
      }
      return out;
    },

    /** Notes whose title this note MENTIONS in prose but hasn't `[[linked]]` yet. */
    async unlinkedMentions(noteId: string, access: NoteAccess): Promise<Array<{ noteId: string; title: string; count: number }>> {
      const note = await db.getNote(noteId, access.ownerId) as Note | null;
      if (!note) return [];
      const { text, markdown } = noteText(note, access.ownerId);
      const all = await db.listNotes(access.ownerId) as Note[];
      const candidates = all.filter((n) => n.id !== noteId && !n.is_template).map((n) => ({ id: n.id, title: n.title }));
      const linkedTitleKeys = new Set(parseWikiLinks(markdown).map((w) => titleKey(w.target)));
      const found = findUnlinkedMentions(text, candidates, { excludeIds: new Set([noteId]), linkedTitleKeys });
      return found.map((m) => ({ noteId: m.id, title: m.title, count: m.count }));
    },

    /** Semantically related notes (cosine over note embeddings), best first. */
    async relatedNotes(noteId: string, access: NoteAccess, topK = 5): Promise<RelatedNote[]> {
      const self = await db.getNoteEmbedding(noteId);
      let vec: number[] | null = self ? (JSON.parse(self.embedding_json) as number[]) : null;
      if (!vec) {
        const note = await db.getNote(noteId, access.ownerId) as Note | null;
        if (!note) return [];
        vec = await embed(`${note.title}\n${noteText(note, access.ownerId).text}`, access);
      }
      if (!vec) return [];
      const all = await db.listUserNoteEmbeddings(access.ownerId);
      const scored: RelatedNote[] = [];
      for (const row of all) {
        if (row.note_id === noteId) continue;
        try {
          const other = JSON.parse(row.embedding_json) as number[];
          if (other.length !== vec.length) continue;
          scored.push({ noteId: row.note_id, title: row.title ?? '(untitled)', score: cosineSimilarity(vec, other) });
        } catch { /* skip malformed */ }
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.filter((s) => s.score > 0.1).slice(0, topK);
    },

    /**
     * The local knowledge graph around a note: nodes = this note + linked notes +
     * extracted entities; edges = links_to / mentions / typed relations. For the UI.
     */
    async graph(noteId: string, access: NoteAccess): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
      const note = await db.getNote(noteId, access.ownerId) as Note | null;
      if (!note) return { nodes: [], edges: [] };
      const nodes = new Map<string, GraphNode>();
      const edges: GraphEdge[] = [];
      const noteNodeId = `note:${noteId}`;
      nodes.set(noteNodeId, { id: noteNodeId, label: note.title, kind: 'note' });

      // Outbound + inbound note links.
      for (const l of await db.listNoteLinks(noteId)) {
        if (l.target_kind !== 'note') continue;
        const t = await db.getNote(l.target_id, access.ownerId) as Note | null;
        if (!t) continue;
        const tid = `note:${t.id}`;
        nodes.set(tid, { id: tid, label: t.title, kind: 'note' });
        edges.push({ source: noteNodeId, target: tid, label: 'links to' });
      }
      for (const b of await db.listNoteBacklinks('note', noteId)) {
        const s = await db.getNote(b.note_id, access.ownerId) as Note | null;
        if (!s) continue;
        const sid = `note:${s.id}`;
        nodes.set(sid, { id: sid, label: s.title, kind: 'note' });
        edges.push({ source: sid, target: noteNodeId, label: 'links to' });
      }
      // Entities mentioned by this note + their typed relations.
      const entities = await db.listNoteEntities(noteId);
      for (const e of entities) {
        const eid = `entity:${e.name_key}`;
        nodes.set(eid, { id: eid, label: e.name, kind: 'entity', type: e.type });
        edges.push({ source: noteNodeId, target: eid, label: 'mentions' });
      }
      for (const r of await db.listNoteRelations(noteId)) {
        const sid = `entity:${r.subject.toLowerCase()}`, oid = `entity:${r.object.toLowerCase()}`;
        if (!nodes.has(sid)) nodes.set(sid, { id: sid, label: r.subject, kind: 'entity' });
        if (!nodes.has(oid)) nodes.set(oid, { id: oid, label: r.object, kind: 'entity' });
        edges.push({ source: sid, target: oid, label: r.predicate.replace(/_/g, ' ') });
      }
      return { nodes: [...nodes.values()], edges };
    },
  };
}

export type NoteGraphService = ReturnType<typeof createNoteGraphService>;
