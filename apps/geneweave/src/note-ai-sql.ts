// SPDX-License-Identifier: MIT
/**
 * geneWeave note AI co-author service (weaveNotes Phase 3) — the AI INSIDE the note.
 *
 * Phase 2 made a note co-editable by humans through the relay. Phase 3 lets the AI
 * agent participate in the SAME document, two ways:
 *
 *  1. **Track-changes suggestions** (the safe default). AI actions — *continue*,
 *     *rewrite*, *summarize*, *ask AI* — produce Markdown which we turn into staged
 *     {@link BlockOp}s that are NOT applied to the canonical doc. A human ACCEPTS
 *     (the ops are applied + broadcast) or REJECTS (discarded). The AI never
 *     silently mutates a human's document — the mid-2026 best practice, and the
 *     defence against a prompt-injected agent rewriting a doc.
 *
 *  2. **Direct co-editing** (the agent as a peer). The `note_edit` tool and
 *     AI-block refresh apply ops immediately through the Phase 2 relay, authored
 *     under a distinct `agent:*` CRDT site, so they converge with concurrent human
 *     edits exactly like a second person typing.
 *
 * Staged ops are authored under a UNIQUE site per suggestion, so two pending
 * suggestions never mint colliding op ids; and because RGA ops reference element
 * ids (not positions), a suggestion still applies cleanly on accept even after the
 * document moved on. The service is self-contained: it owns the relay, persists the
 * note's rendered `doc_json`, and broadcasts live over the Phase 2 SSE hub.
 */
import {
  BlockDoc,
  createBlockAgentPeer,
  markdownToBlocks,
  blocksToProseMirror,
  diffBlocks,
  pmToBlocks,
  type BlockOp,
  type BlockDocSnapshot,
  type BlockSpec,
  type RgaId,
} from '@weaveintel/coedit';
import { newUUIDv7, weaveContext, type ModelRequest } from '@weaveintel/core';
import { templateByKey, SYSTEM_TEMPLATES } from '@weaveintel/notes';
import { roleAtLeast } from '@weaveintel/collaboration';
import { getOrCreateModel, type ChatEngineConfig } from './chat-runtime.js';
import { createNoteCoeditRepo, resolveNoteAccess, type NoteAccess } from './note-coedit-sql.js';
import { noteCoeditHub } from './note-coedit-hub.js';
import type { DatabaseAdapter } from './db-types.js';
import type { NoteSuggestionRow } from './db-types/adapter-me.js';

// ─── LLM text generator ───────────────────────────────────────────────────────

/** A minimal "prompt → text" function so the notes layer never imports the chat pipeline. */
export type NoteAiGenerate = (opts: {
  system?: string;
  user: string;
  userId?: string;
  tenantId?: string | null;
  maxTokens?: number;
  temperature?: number;
}) => Promise<string>;

/**
 * Build a {@link NoteAiGenerate} from a {@link ChatEngineConfig} (the host's resolved
 * providers + default model). Used by both the AI-action HTTP endpoints and the
 * `note_edit` agent tool, so they share ONE model-acquisition path.
 */
export function createModelTextGenerator(modelConfig: ChatEngineConfig): NoteAiGenerate {
  return async ({ system, user, userId, tenantId, maxTokens, temperature }) => {
    const provider = modelConfig.defaultProvider;
    const model = await getOrCreateModel(provider, modelConfig.defaultModel, modelConfig.providers[provider] ?? {});
    const ctx = weaveContext({ userId, tenantId: tenantId ?? undefined, runtime: modelConfig.runtime });
    const request: ModelRequest = {
      messages: [
        ...(system ? [{ role: 'system' as const, content: system }] : []),
        { role: 'user' as const, content: user },
      ],
      maxTokens: maxTokens ?? 1024,
      temperature: temperature ?? 0.4,
    };
    const res = await model.generate(ctx, request);
    return typeof res.content === 'string' ? res.content : '';
  };
}

// ─── AI action prompts ────────────────────────────────────────────────────────

export type AiAction = 'continue' | 'rewrite' | 'summarize' | 'ask';

/** Build the system + user prompt for an AI action over a note. */
function buildActionPrompt(action: AiAction, ctx: { noteMarkdown: string; selectionText?: string; instruction?: string }): { system: string; user: string } {
  const doc = ctx.noteMarkdown.slice(0, 6000); // bound the context window
  switch (action) {
    case 'continue':
      return {
        system: 'You are a writing assistant co-authoring a document. Continue the document naturally where it leaves off. Output ONLY the new Markdown content to append — no preamble, no repetition of existing text.',
        user: `Here is the document so far:\n\n${doc}\n\n${ctx.instruction ? `Guidance: ${ctx.instruction}\n\n` : ''}Continue it.`,
      };
    case 'rewrite':
      return {
        system: 'You are an editor. Rewrite the provided passage to be clearer and better, preserving its meaning. Output ONLY the rewritten Markdown — no preamble.',
        user: `Document context:\n\n${doc}\n\nPassage to rewrite:\n\n${ctx.selectionText ?? doc}\n\n${ctx.instruction ? `Instruction: ${ctx.instruction}` : 'Rewrite the passage.'}`,
      };
    case 'summarize':
      return {
        system: 'You summarize documents. Output ONLY a short Markdown section: a "## Summary" heading followed by 3-5 concise bullet points capturing the key points. No preamble.',
        user: `Summarize this document:\n\n${doc}`,
      };
    case 'ask':
      return {
        system: 'You answer questions about a document for the author, who will paste your answer into their notes. Output ONLY Markdown content to add — no preamble, no "Sure!".',
        user: `Document:\n\n${doc}\n\nQuestion: ${ctx.instruction ?? 'Summarize the key takeaway.'}`,
      };
  }
}

// ─── The service ──────────────────────────────────────────────────────────────

// The service touches notes, the Phase 2 co-edit relay, access resolution, and the
// Phase 3 suggestion store — i.e. the full adapter surface — so it takes the adapter.
type NoteAiDb = DatabaseAdapter;

export interface AiActionResult {
  ok: boolean;
  error?: string;
  suggestionId?: string;
  preview?: string;
  action?: string;
}

/** A short, unique CRDT site for a batch of agent-authored ops (no cross-suggestion collision). */
function agentSite(noteId: string, tag: string): string {
  return `agent:${noteId.slice(0, 8)}:${tag}:${newUUIDv7().slice(0, 8)}`;
}

export function createNoteAiService(db: NoteAiDb, generate: NoteAiGenerate, opts: { now?: () => number } = {}) {
  const now = opts.now ?? (() => Date.now());
  const relay = createNoteCoeditRepo(db, { now });

  /** Load the note's current ProseMirror content for seeding the co-edit doc. */
  async function seedFor(noteId: string, ownerId: string): Promise<unknown> {
    const note = await db.getNote(noteId, ownerId) as { doc_json?: string } | null;
    if (!note?.doc_json) return { type: 'doc', content: [] };
    try { return JSON.parse(note.doc_json); } catch { return { type: 'doc', content: [] }; }
  }

  /** After applying ops: persist the rendered doc_json + broadcast live to open editors. */
  async function afterApply(noteId: string, ownerId: string, docId: string, applied: BlockOp[], pm: { type: 'doc'; content: unknown[] }): Promise<void> {
    if (applied.length === 0) return;
    noteCoeditHub.broadcast(noteId, 'coedit.op', { docId, ops: applied });
    try { await db.updateNote(noteId, ownerId, { doc_json: JSON.stringify(pm) }); } catch { /* non-fatal */ }
  }

  return {
    /**
     * Run an AI action and STAGE the result as a track-changes suggestion (pending).
     * Returns the suggestion id + a Markdown preview for the reviewer. The canonical
     * document is untouched until a human accepts.
     */
    async propose(input: { noteId: string; access: NoteAccess; action: AiAction; instruction?: string; selectionBlockId?: RgaId | null; selectionText?: string }): Promise<AiActionResult> {
      const { noteId, access, action } = input;
      const view = await relay.ensureDoc({ noteId, tenantId: access.tenantId, ownerId: access.ownerId, seedPm: await seedFor(noteId, access.ownerId) });
      const noteMarkdown = view.markdown;

      // Generate the AI's Markdown.
      const prompt = buildActionPrompt(action, { noteMarkdown, ...(input.selectionText ? { selectionText: input.selectionText } : {}), ...(input.instruction ? { instruction: input.instruction } : {}) });
      const aiMarkdown = (await generate({ ...prompt, userId: access.ownerId, tenantId: access.tenantId, temperature: action === 'summarize' ? 0.2 : 0.5 })).trim();
      if (!aiMarkdown) return { ok: false, error: 'the model returned no content' };

      // Turn the Markdown into STAGED ops (without touching the live doc), under a unique site.
      const site = agentSite(noteId, action);
      const snap = view.snapshot;
      const shadow = BlockDoc.fromSnapshot(site, snap);
      let ops: BlockOp[];
      let anchor: Record<string, unknown>;
      if (action === 'rewrite' && input.selectionBlockId) {
        // Replace the target block's content with the AI's blocks.
        const target: BlockSpec[] = shadow.blocks().map((b) => {
          if (b.id && input.selectionBlockId && b.id.counter === input.selectionBlockId.counter && b.id.siteId === input.selectionBlockId.siteId) {
            const repl = markdownToBlocks(aiMarkdown)[0] ?? { type: 'paragraph', text: aiMarkdown };
            return { type: repl.type, attrs: repl.attrs ?? b.attrs, text: repl.text ?? '', marks: repl.marks ?? [] };
          }
          return { type: b.type, attrs: b.attrs, text: b.text, marks: b.marks };
        });
        ops = diffBlocks(shadow, target);
        anchor = { kind: 'block', blockId: input.selectionBlockId };
      } else {
        // Append the AI's content as new blocks at the end.
        ops = createBlockAgentPeer(shadow, { mode: 'suggest' }).appendMarkdown(aiMarkdown);
        anchor = { kind: 'append' };
      }
      if (ops.length === 0) return { ok: false, error: 'no change produced' };

      const id = newUUIDv7();
      const row: NoteSuggestionRow = {
        id, note_id: noteId, doc_id: view.docId, tenant_id: access.tenantId,
        author_kind: 'user', author_id: access.ownerId, author_site: site, action,
        status: 'pending', ops_json: JSON.stringify(ops), preview_text: aiMarkdown,
        anchor_json: JSON.stringify(anchor), created_at: now(), resolved_at: null, resolved_by: null,
      };
      await db.createNoteSuggestion(row);
      noteCoeditHub.broadcast(noteId, 'coedit.suggestion', { id, action, preview: aiMarkdown });
      return { ok: true, suggestionId: id, preview: aiMarkdown, action };
    },

    /** List a note's suggestions (default: pending only). */
    async list(noteId: string, status: 'pending' | 'accepted' | 'rejected' | 'all' = 'pending'): Promise<NoteSuggestionRow[]> {
      return db.listNoteSuggestions(noteId, status === 'all' ? undefined : status);
    },

    /** Accept a pending suggestion: apply its staged ops through the relay + broadcast. */
    async accept(suggestionId: string, userId: string, access: NoteAccess): Promise<{ ok: boolean; error?: string; applied?: number }> {
      const sug = await db.getNoteSuggestion(suggestionId);
      if (!sug || sug.note_id !== access.noteId) return { ok: false, error: 'not found' };
      if (sug.status !== 'pending') return { ok: false, error: `already ${sug.status}` };
      // Atomically claim it (guards against a double-accept race).
      if ((await db.resolveNoteSuggestion(suggestionId, 'accepted', now(), userId)) === 0) return { ok: false, error: 'already resolved' };
      let ops: BlockOp[]; try { ops = JSON.parse(sug.ops_json) as BlockOp[]; } catch { return { ok: false, error: 'corrupt suggestion' }; }
      const result = await relay.submitOps(sug.doc_id, sug.author_site, ops);
      if (!result.ok) return { ok: false, error: result.error };
      await afterApply(access.noteId, access.ownerId, sug.doc_id, result.applied, result.view.prosemirror);
      noteCoeditHub.broadcast(access.noteId, 'coedit.suggestion.resolved', { id: suggestionId, status: 'accepted' });
      return { ok: true, applied: result.applied.length };
    },

    /** Reject a pending suggestion: mark it rejected; the staged ops are never applied. */
    async reject(suggestionId: string, userId: string, access: NoteAccess): Promise<{ ok: boolean; error?: string }> {
      const sug = await db.getNoteSuggestion(suggestionId);
      if (!sug || sug.note_id !== access.noteId) return { ok: false, error: 'not found' };
      if ((await db.resolveNoteSuggestion(suggestionId, 'rejected', now(), userId)) === 0) return { ok: false, error: `already ${sug.status}` };
      noteCoeditHub.broadcast(access.noteId, 'coedit.suggestion.resolved', { id: suggestionId, status: 'rejected' });
      return { ok: true };
    },

    /**
     * The `note_edit` agent-tool entry point. The agent contributes Markdown to a
     * note either DIRECTLY (applied as a peer, converging live) or as a SUGGESTION
     * (staged for human accept/reject). Resolves access itself (the tool only knows
     * the user + note id), so a prompt-injected agent cannot edit a note the user
     * cannot, and viewers are refused.
     */
    async agentEdit(args: { userId: string; noteId: string; markdown: string; mode: 'direct' | 'suggest' }): Promise<AiActionResult & { applied?: number }> {
      const access = await resolveNoteAccess(db, args.noteId, args.userId);
      if (!access) return { ok: false, error: 'note not found or not accessible' };
      if (!roleAtLeast(access.role, 'collaborator')) return { ok: false, error: 'forbidden: this note is read-only for you' };
      const markdown = (args.markdown ?? '').trim();
      if (!markdown) return { ok: false, error: 'no content' };

      const view = await relay.ensureDoc({ noteId: args.noteId, tenantId: access.tenantId, ownerId: access.ownerId, seedPm: await seedFor(args.noteId, access.ownerId) });
      const site = agentSite(args.noteId, 'edit');
      const ops = createBlockAgentPeer(BlockDoc.fromSnapshot(site, view.snapshot), { mode: 'suggest' }).appendMarkdown(markdown);
      if (ops.length === 0) return { ok: false, error: 'no change produced' };

      if (args.mode === 'direct') {
        const result = await relay.submitOps(view.docId, site, ops);
        if (!result.ok) return { ok: false, error: result.error };
        await afterApply(args.noteId, access.ownerId, view.docId, result.applied, result.view.prosemirror);
        return { ok: true, applied: result.applied.length, action: 'note_edit' };
      }
      // suggest
      const id = newUUIDv7();
      await db.createNoteSuggestion({
        id, note_id: args.noteId, doc_id: view.docId, tenant_id: access.tenantId,
        author_kind: 'agent', author_id: args.userId, author_site: site, action: 'note_edit',
        status: 'pending', ops_json: JSON.stringify(ops), preview_text: markdown, anchor_json: JSON.stringify({ kind: 'append' }),
        created_at: now(), resolved_at: null, resolved_by: null,
      });
      noteCoeditHub.broadcast(args.noteId, 'coedit.suggestion', { id, action: 'note_edit', preview: markdown });
      return { ok: true, suggestionId: id, preview: markdown, action: 'note_edit' };
    },

    /**
     * Insert a new "AI block" — a block whose content is generated from a prompt and
     * which remembers that prompt (+ an optional citation) so it can be REFRESHED
     * later. Applied directly (the user explicitly added it). Returns the new block id.
     */
    async insertAiBlock(input: { noteId: string; access: NoteAccess; prompt: string; citation?: string }): Promise<{ ok: boolean; error?: string; applied?: number; text?: string }> {
      const { noteId, access } = input;
      const view = await relay.ensureDoc({ noteId, tenantId: access.tenantId, ownerId: access.ownerId, seedPm: await seedFor(noteId, access.ownerId) });
      const text = (await generate({
        system: 'You generate a concise, self-contained note block from a prompt. Output ONLY the content as a short Markdown paragraph — no preamble.',
        user: `Document context:\n\n${view.markdown.slice(0, 4000)}\n\nGenerate content for: ${input.prompt}`,
        userId: access.ownerId, tenantId: access.tenantId, temperature: 0.4,
      })).trim();
      if (!text) return { ok: false, error: 'the model returned no content' };

      const site = agentSite(noteId, 'aiblock');
      const shadow = BlockDoc.fromSnapshot(site, view.snapshot);
      const existing = shadow.blocks();
      const after: RgaId | null = existing.length ? existing[existing.length - 1]!.id : null;
      const { ops: blockOps, blockId } = shadow.insertBlock(after, 'paragraph', { aiPrompt: input.prompt, aiCitation: input.citation ?? null, aiRefreshedAt: now() });
      const ops: BlockOp[] = [...blockOps, ...shadow.insertText(blockId, 0, text)];
      const result = await relay.submitOps(view.docId, site, ops);
      if (!result.ok) return { ok: false, error: result.error };
      await afterApply(noteId, access.ownerId, view.docId, result.applied, result.view.prosemirror);
      noteCoeditHub.broadcast(noteId, 'coedit.aiblock', { blockId, refreshed: false });
      return { ok: true, applied: result.applied.length, text };
    },

    /**
     * Refresh an existing AI block: re-run its stored `aiPrompt` against the current
     * document and replace the block's text (its prompt + citation are preserved,
     * `aiRefreshedAt` is bumped). Applied directly + broadcast. Acceptance: "cited AI
     * block refreshes".
     */
    async refreshAiBlock(input: { noteId: string; access: NoteAccess; blockId: RgaId }): Promise<{ ok: boolean; error?: string; applied?: number; text?: string }> {
      const { noteId, access } = input;
      const view = await relay.ensureDoc({ noteId, tenantId: access.tenantId, ownerId: access.ownerId, seedPm: await seedFor(noteId, access.ownerId) });
      const block = view.blocks.find((b) => b.id && b.id.counter === input.blockId.counter && b.id.siteId === input.blockId.siteId);
      if (!block) return { ok: false, error: 'block not found' };
      const aiPrompt = block.attrs['aiPrompt'];
      if (typeof aiPrompt !== 'string' || !aiPrompt) return { ok: false, error: 'not an AI block (no aiPrompt)' };

      const text = (await generate({
        system: 'You regenerate a single note block from its prompt and the current document. Output ONLY the refreshed content as a short Markdown paragraph — no preamble.',
        user: `Document context:\n\n${view.markdown.slice(0, 4000)}\n\nRegenerate content for: ${aiPrompt}`,
        userId: access.ownerId, tenantId: access.tenantId, temperature: 0.4,
      })).trim();
      if (!text) return { ok: false, error: 'the model returned no content' };

      // Replace just this block's text + bump aiRefreshedAt, via a diff on a private clone.
      const site = agentSite(noteId, 'refresh');
      const shadow = BlockDoc.fromSnapshot(site, view.snapshot);
      const target: BlockSpec[] = shadow.blocks().map((b) => {
        if (b.id && b.id.counter === input.blockId.counter && b.id.siteId === input.blockId.siteId) {
          return { type: b.type, attrs: { ...b.attrs, aiRefreshedAt: now() }, text, marks: [] };
        }
        return { type: b.type, attrs: b.attrs, text: b.text, marks: b.marks };
      });
      const ops = diffBlocks(shadow, target);
      const result = await relay.submitOps(view.docId, site, ops);
      if (!result.ok) return { ok: false, error: result.error };
      await afterApply(noteId, access.ownerId, view.docId, result.applied, result.view.prosemirror);
      noteCoeditHub.broadcast(noteId, 'coedit.aiblock', { blockId: input.blockId, refreshed: true });
      return { ok: true, applied: result.applied.length, text };
    },
  };
}

export type NoteAiService = ReturnType<typeof createNoteAiService>;

/**
 * The `create_note` agent-tool entry point (weaveNotes Phase 3.1): create a BRAND-NEW
 * note owned by the user and (optionally) seed it with the agent's Markdown content —
 * so the agent can capture research / a summary / a plan it just produced as a real,
 * editable note. Reuses the Phase 1 `markdownToBlocks` → `blocksToProseMirror` path so
 * headings, lists, to-dos, code and inline formatting all render correctly. Returns the
 * new note id (which the agent can then hand to `note_edit` / `note_publish`).
 */
export async function agentCreateNote(
  db: Pick<DatabaseAdapter, 'createNote'>,
  args: { userId: string; tenantId?: string | null; title: string; markdown?: string },
): Promise<{ ok: boolean; noteId?: string; error?: string }> {
  const title = (args.title ?? '').trim() || 'Untitled note';
  let docJson = '{"type":"doc","content":[]}';
  if (args.markdown && args.markdown.trim()) {
    try {
      // markdown → blocks → a fresh BlockDoc → rendered ProseMirror (the note's doc_json).
      const blocks = BlockDoc.fromBlocks(`u:${args.userId}`, markdownToBlocks(args.markdown)).blocks();
      docJson = JSON.stringify(blocksToProseMirror(blocks));
    } catch { /* fall back to an empty doc rather than failing the whole create */ }
  }
  const id = newUUIDv7();
  try {
    await db.createNote({
      id, owner_user_id: args.userId, tenant_id: args.tenantId ?? null,
      title, doc_json: docJson, is_template: 0, favorite: 0, sensitivity: 'normal',
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'failed to create note' };
  }
  return { ok: true, noteId: id };
}

/**
 * weaveNotes Phase 6 — the `new_from_template` tool helper. Creates a new note for the user
 * pre-filled with a SYSTEM template's content (e.g. meeting minutes, Cornell notes, a project
 * brief). The templates are pure `doc_json` data from `@weaveintel/notes`, reused here, in the
 * gallery, and in the seed migration. Owner-scoped; an unknown key returns the available keys.
 */
export async function agentNewFromTemplate(
  db: Pick<DatabaseAdapter, 'createNote'>,
  args: { userId: string; tenantId?: string | null; templateKey: string; title?: string },
): Promise<{ ok: boolean; noteId?: string; title?: string; templateKey?: string; available?: string[]; error?: string }> {
  const tpl = templateByKey((args.templateKey ?? '').trim());
  if (!tpl) {
    return { ok: false, error: `unknown template "${args.templateKey}"`, available: SYSTEM_TEMPLATES.map((t) => t.key) };
  }
  const title = (args.title ?? '').trim() || tpl.title;
  const id = newUUIDv7();
  try {
    await db.createNote({
      id, owner_user_id: args.userId, tenant_id: args.tenantId ?? null,
      title, icon: tpl.icon, doc_json: JSON.stringify(tpl.doc),
      is_template: 0, favorite: 0, sensitivity: 'normal', template_key: tpl.key,
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'failed to create note' };
  }
  return { ok: true, noteId: id, title, templateKey: tpl.key };
}

/**
 * weaveNotes Phase 8 — the `recent_notes` tool helper. Lists the user's most recently created or
 * edited notes (newest first), so the assistant can understand what they have been working on and
 * pick up where they left off. Read-only + owner-scoped (reuses the same listing the app uses).
 */
export async function agentRecentNotes(
  db: Pick<DatabaseAdapter, 'listNotes'>,
  args: { userId: string; tenantId?: string | null; limit?: number },
): Promise<{ ok: boolean; notes: Array<{ noteId: string; title: string; updatedAt: string; favorite: boolean }> }> {
  const limit = Math.max(1, Math.min(50, args.limit ?? 10));
  // listNotes is owner-scoped, excludes templates + archived, and is ordered favorite DESC, updated_at DESC.
  const rows = await db.listNotes(args.userId, { limit });
  return {
    ok: true,
    notes: rows.map((r) => ({ noteId: r.id, title: r.title || 'Untitled', updatedAt: r.updated_at, favorite: r.favorite === 1 })),
  };
}
