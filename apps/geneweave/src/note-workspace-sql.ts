// SPDX-License-Identifier: MIT
/**
 * geneWeave WORKSPACE RAG service (weaveNotes Phase 8).
 *
 * "Chat with your workspace": ask a question and get an answer grounded in YOUR own
 * content — your notes (embedded in Phase 5's `note_embeddings`) AND your past chat runs
 * (embedded here in `run_embeddings`) — with click-to-source CITATIONS so you can verify
 * every claim. This is retrieval-augmented generation (RAG) over the personal workspace.
 *
 * How it works:
 *   1. INDEX — each chat run's text output is embedded once into `run_embeddings`
 *      (idempotent via a content hash), the run-side twin of Phase 5 note embeddings.
 *   2. SEARCH — a query is embedded; we cosine-rank notes and runs SEPARATELY, then fuse
 *      the two ranked lists with Reciprocal Rank Fusion (`@weaveintel/notes`
 *      reciprocalRankFusion) so a result strong in either corpus surfaces fairly.
 *   3. CITE — the top hits become a numbered context block (`buildCitedContext`) the model
 *      answers FROM, citing "[n]"; the UI maps "[n]" back to the real note/run.
 *
 * Reuses: the active embedding model (`getActiveGuardrailEmbeddingModel`), cosine similarity
 * (`@weaveintel/cache`), the run-access chokepoint (`resolveRunAccess`), and the pure RAG
 * helpers from `@weaveintel/notes`. Everything is owner-scoped + tenant-isolated.
 */
import { cosineSimilarity } from '@weaveintel/cache';
import { newUUIDv7, weaveContext } from '@weaveintel/core';
import { buildCitedContext, reciprocalRankFusion, snippetAround, extractPlainText, type RagHit, type CitedSource, type Note } from '@weaveintel/notes';
import { createHash } from 'node:crypto';
import { getActiveGuardrailEmbeddingModel } from './guardrail-judge.js';
import { resolveRunAccess } from './shared-session-sql.js';
import type { DatabaseAdapter } from './db-types.js';

type WorkspaceDb = DatabaseAdapter;

function hashOf(s: string): string { return createHash('sha256').update(s).digest('hex').slice(0, 16); }

export interface WorkspaceSearchResult {
  query: string;
  /** A numbered context block to hand the model ("[1] … [2] …"). */
  context: string;
  /** The sources behind the context, with citation numbers + snippets. */
  sources: CitedSource[];
}

export function createNoteWorkspaceService(db: WorkspaceDb, opts: { now?: () => number } = {}) {
  const now = opts.now ?? (() => Date.now());

  /** Embed text with the active embedding model (or null if none configured / empty). */
  async function embed(text: string, userId: string, tenantId?: string | null): Promise<number[] | null> {
    const model = getActiveGuardrailEmbeddingModel();
    if (!model || !text.trim()) return null;
    try {
      const ctx = weaveContext({ userId, tenantId: tenantId ?? undefined });
      const res = await model.embed(ctx, { input: [text.slice(0, 4000)] });
      const vec = res.embeddings[0];
      return Array.isArray(vec) ? [...vec] : null;
    } catch { return null; }
  }

  /** Concatenate a run's streamed text output (the `text.delta` events). */
  async function runOutputText(runId: string): Promise<string> {
    const events = await db.listUserRunEvents(runId);
    let out = '';
    for (const ev of events) {
      if (ev.kind !== 'text.delta') continue;
      try { const p = JSON.parse(ev.payload) as { delta?: unknown }; if (typeof p.delta === 'string') out += p.delta; } catch { /* skip */ }
    }
    return out.trim();
  }

  /** (Re)embed a single chat run's output into `run_embeddings` (idempotent). Owner/shared only. */
  async function indexRun(input: { runId: string; userId: string; tenantId?: string | null }): Promise<{ ok: boolean; embedded: boolean; error?: string }> {
    const access = await resolveRunAccess(db, input.runId, input.userId);
    if (!access) return { ok: false, embedded: false, error: 'run not found or not accessible' };
    const text = await runOutputText(input.runId);
    if (!text) return { ok: true, embedded: false };
    const title = (text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? 'Chat run').replace(/^#+\s*/, '').slice(0, 80);
    const ch = hashOf(text);
    const prior = await db.getRunEmbedding(input.runId);
    if (prior && prior.content_hash === ch) return { ok: true, embedded: true };
    const vec = await embed(`${title}\n${text}`, input.userId, input.tenantId);
    if (!vec) return { ok: true, embedded: false };
    await db.upsertRunEmbedding({
      run_id: input.runId, user_id: input.userId, tenant_id: input.tenantId ?? null,
      dim: vec.length, embedding_json: JSON.stringify(vec), content_hash: ch,
      title, content: text.slice(0, 8000), updated_at: now(),
    });
    return { ok: true, embedded: true };
  }

  /** Index the user's most recent runs (best-effort convenience for "reindex my workspace"). */
  async function reindexRuns(input: { userId: string; tenantId?: string | null; limit?: number }): Promise<{ indexed: number }> {
    const runs = await db.listUserRuns(input.userId, { status: 'completed', limit: Math.min(input.limit ?? 50, 200), offset: 0 });
    let indexed = 0;
    for (const r of runs) {
      const res = await indexRun({ runId: r.id, userId: input.userId, tenantId: input.tenantId ?? null });
      if (res.embedded) indexed++;
    }
    return { indexed };
  }

  /**
   * Search the workspace (notes + runs) for a query and return a CITED context block.
   * Notes come from Phase 5 `note_embeddings`; runs from `run_embeddings`. Each corpus is
   * cosine-ranked, then the two lists are fused (RRF) into one ranking.
   */
  async function workspaceSearch(input: { userId: string; tenantId?: string | null; query: string; limit?: number; scope?: 'all' | 'notes' | 'runs' }): Promise<WorkspaceSearchResult> {
    const scope = input.scope ?? 'all';
    const limit = Math.max(1, Math.min(input.limit ?? 6, 12));
    const qvec = await embed(input.query, input.userId, input.tenantId);
    if (!qvec) return { query: input.query, context: '', sources: [] };

    // Rank notes (cosine over note_embeddings).
    const noteRanked: Array<{ id: string; title: string; score: number }> = [];
    if (scope !== 'runs') {
      // SECURITY: scope embeddings to the caller's tenant (null-safe) so workspace RAG can never
      // surface another tenant's notes, even if a user id were ever shared/migrated across tenants.
      for (const row of await db.listUserNoteEmbeddings(input.userId, input.tenantId ?? null)) {
        try {
          const v = JSON.parse(row.embedding_json) as number[];
          if (v.length !== qvec.length) continue;
          noteRanked.push({ id: row.note_id, title: row.title ?? '(untitled note)', score: cosineSimilarity(qvec, v) });
        } catch { /* skip */ }
      }
      noteRanked.sort((a, b) => b.score - a.score);
    }

    // Rank runs (cosine over run_embeddings; content is stored for snippets).
    const runRanked: Array<{ id: string; title: string; score: number; content: string }> = [];
    if (scope !== 'notes') {
      for (const row of await db.listUserRunEmbeddings(input.userId, input.tenantId ?? null)) {
        try {
          const v = JSON.parse(row.embedding_json) as number[];
          if (v.length !== qvec.length) continue;
          runRanked.push({ id: row.run_id, title: row.title ?? 'Chat run', score: cosineSimilarity(qvec, v), content: row.content ?? '' });
        } catch { /* skip */ }
      }
      runRanked.sort((a, b) => b.score - a.score);
    }

    // Keep only meaningfully-similar hits, then fuse the two ranked lists (RRF).
    const notesTop = noteRanked.filter((r) => r.score > 0.1).slice(0, limit);
    const runsTop = runRanked.filter((r) => r.score > 0.1).slice(0, limit);
    const fused = reciprocalRankFusion([
      notesTop.map((r) => ({ id: `note:${r.id}` })),
      runsTop.map((r) => ({ id: `run:${r.id}` })),
    ]).slice(0, limit);

    // Materialize each fused hit into a RagHit (fetch note text on demand; runs carry content).
    const noteById = new Map(notesTop.map((r) => [r.id, r]));
    const runById = new Map(runsTop.map((r) => [r.id, r]));
    const hits: RagHit[] = [];
    for (const f of fused) {
      const [kind, id] = [f.id.slice(0, f.id.indexOf(':')), f.id.slice(f.id.indexOf(':') + 1)];
      if (kind === 'note') {
        const meta = noteById.get(id);
        const note = await db.getNote(id, input.userId) as (Note | null);
        if (!note) continue;
        let text = '';
        try { text = extractPlainText(JSON.parse(note.doc_json ?? '') as unknown); } catch { /* */ }
        hits.push({ id, kind: 'note', title: note.title || meta?.title || '(untitled note)', content: text, score: meta?.score ?? 0 });
      } else {
        const meta = runById.get(id);
        if (!meta) continue;
        hits.push({ id, kind: 'run', title: meta.title, content: meta.content, score: meta.score });
      }
    }

    const { context, sources } = buildCitedContext(hits, input.query, { maxSources: limit });
    return { query: input.query, context, sources };
  }

  /**
   * The `workspace_search` agent-tool entry point: returns the numbered context + sources so
   * the model answers FROM the user's own content and cites with "[n]".
   */
  async function agentWorkspaceSearch(args: { userId: string; tenantId?: string | null; query: string; limit?: number }): Promise<{ ok: boolean; query: string; context: string; sources: Array<{ n: number; id: string; kind: string; title: string }> }> {
    const r = await workspaceSearch({ userId: args.userId, tenantId: args.tenantId ?? null, query: args.query, ...(args.limit ? { limit: args.limit } : {}) });
    return { ok: true, query: r.query, context: r.context, sources: r.sources.map((s) => ({ n: s.n, id: s.id, kind: s.kind, title: s.title })) };
  }

  return { indexRun, reindexRuns, workspaceSearch, agentWorkspaceSearch, _snippetAround: snippetAround };
}

export type NoteWorkspaceService = ReturnType<typeof createNoteWorkspaceService>;
