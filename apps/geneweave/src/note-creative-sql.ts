// SPDX-License-Identifier: MIT
/**
 * geneWeave note AI CREATIVE service (weaveNotes Phase 4) — the AI draws ink + diagrams.
 *
 * Phase 2 let the AI colour a note; Phase 3 made it a live participant. Phase 4 lets it CREATE
 * visual content: a colour-coded diagram of a process, or real freehand ink (an underline, an
 * arrow, a circled word). Crucially the output is NATIVE + EDITABLE — the AI emits the SAME
 * stroke/scene data a human's pen or shape tool produces (validated by `@weaveintel/notes`), not
 * a flat picture — so "the AI drew this" and "I drew this" are the same kind of object afterward.
 *
 * Every creation rides the existing rails: it is staged as a track-changes SUGGESTION the human
 * accepts or rejects (mirroring `insertAiBlock` / `colorizeSemantic`), it shows the AI as a live
 * participant while it works (Phase 3), and the rendered SVG is mirrored to an ARTIFACT for export
 * / thumbnails / OCR. Colours come from the pre-validated WCAG-AA palette, so a diagram is always
 * legible.
 */
import { BlockDoc, type BlockOp } from '@weaveintel/coedit';
import {
  validateDiagramScene, diagramToSvg, type DiagramScene,
  inkFromPrimitives, strokesToSvg, validateStrokes, recolorStrokes, type InkStroke,
} from '@weaveintel/notes';
import { newUUIDv7 } from '@weaveintel/core';
import { roleAtLeast } from '@weaveintel/collaboration';
import { createNoteCoeditRepo, resolveNoteAccess, type NoteAccess } from './note-coedit-sql.js';
import { noteCoeditHub } from './note-coedit-hub.js';
import { createNoteSettingsService } from './note-settings-sql.js';
import { withAiPresence } from './note-ai-presence.js';
import type { DatabaseAdapter } from './db-types.js';
import type { NoteAiGenerate } from './note-ai-sql.js';

type NoteCreativeDb = DatabaseAdapter;

export interface CreativeResult { ok: boolean; error?: string; suggestionId?: string; preview?: string; action?: string; artifactId?: string | null }

function creativeSite(noteId: string, tag: string): string { return `agent:${noteId.slice(0, 8)}:${tag}:${newUUIDv7().slice(0, 8)}`; }

/** Best-effort JSON extraction from a model reply (handles ```json fences + prose). */
function extractJson(raw: string, kind: 'object' | 'array'): unknown {
  const t = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const open = kind === 'array' ? '[' : '{'; const close = kind === 'array' ? ']' : '}';
  const start = t.indexOf(open); const end = t.lastIndexOf(close);
  if (start === -1 || end <= start) return kind === 'array' ? [] : {};
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return kind === 'array' ? [] : {}; }
}

export function createNoteCreativeService(db: NoteCreativeDb, generate: NoteAiGenerate, opts: { now?: () => number } = {}) {
  const now = opts.now ?? (() => Date.now());
  const relay = createNoteCoeditRepo(db, { now });
  const settings = createNoteSettingsService(db);

  async function seedFor(noteId: string, ownerId: string): Promise<unknown> {
    const note = await db.getNote(noteId, ownerId) as { doc_json?: string } | null;
    if (!note?.doc_json) return { type: 'doc', content: [] };
    try { return JSON.parse(note.doc_json); } catch { return { type: 'doc', content: [] }; }
  }

  /** Mirror a rendered SVG to an artifact (for export / thumbnail / OCR). Best-effort. */
  async function mirrorArtifact(noteId: string, access: NoteAccess, kind: string, name: string, svg: string, meta: Record<string, unknown>): Promise<string | null> {
    if (!db.saveArtifact) return null;
    try {
      const art = await db.saveArtifact({
        name, type: kind, mimeType: 'image/svg+xml', data: svg, scope: 'user',
        userId: access.ownerId, ...(access.tenantId ? { tenantId: access.tenantId } : {}),
        tags: ['note', 'creative', kind], metadata: { source: 'note', noteId, kind, ...meta },
      });
      return art.id;
    } catch { return null; }
  }

  /** Insert a new creative atom (diagram / inkCanvas) as a STAGED suggestion + mirror its SVG. */
  async function stageInsert(noteId: string, access: NoteAccess, action: 'create_diagram' | 'draw_ink', blockType: 'diagram' | 'inkCanvas', attrs: Record<string, unknown>, svg: string, preview: string): Promise<CreativeResult> {
    const view = await relay.ensureDoc({ noteId, tenantId: access.tenantId, ownerId: access.ownerId, seedPm: await seedFor(noteId, access.ownerId) });
    const site = creativeSite(noteId, action);
    const shadow = BlockDoc.fromSnapshot(site, view.snapshot);
    const blocks = shadow.blocks();
    const after = blocks.length ? blocks[blocks.length - 1]!.id : null;
    const { ops } = shadow.insertBlock(after, blockType, attrs);
    if (ops.length === 0) return { ok: false, error: 'no change produced', action };

    const artifactId = await mirrorArtifact(noteId, access, blockType, preview, svg, { action });
    const id = newUUIDv7();
    await db.createNoteSuggestion({
      id, note_id: noteId, doc_id: view.docId, tenant_id: access.tenantId,
      author_kind: 'agent', author_id: access.ownerId, author_site: site, action,
      status: 'pending', ops_json: JSON.stringify(ops as BlockOp[]), preview_text: preview,
      anchor_json: JSON.stringify({ kind: 'insert', blockType, artifactId }), created_at: now(), resolved_at: null, resolved_by: null,
    });
    noteCoeditHub.broadcast(noteId, 'coedit.suggestion', { id, action, preview });
    void settings.recordActivity({ noteId, userId: access.ownerId, tenantId: access.tenantId ?? null, action: 'ai_suggestion', actor: 'ai', summary: preview });
    return { ok: true, suggestionId: id, preview, action, artifactId };
  }

  /** The model produces a diagram SCENE; we validate (WCAG-AA colours) + stage it as a suggestion. */
  async function createDiagramInner(input: { noteId: string; access: NoteAccess; instruction: string }): Promise<CreativeResult> {
    const view = await relay.ensureDoc({ noteId: input.noteId, tenantId: input.access.tenantId, ownerId: input.access.ownerId, seedPm: await seedFor(input.noteId, input.access.ownerId) });
    const sys = 'You design a small, clear diagram as JSON: {"kind":"flow|mindmap|graph","title":"…","nodes":[{"id":"…","label":"…","color":"…","shape":"box|pill|diamond|ellipse"}],"edges":[{"from":"id","to":"id","label":"…"}]}. Colours are ONE of: amber, pink, teal, blue, lavender, peach, sage, sky (pick with intent — e.g. a decision node amber). Keep it to at most 8 nodes. Output ONLY the JSON.';
    const reply = await generate({ system: sys, user: `${input.instruction}\n\nNote context:\n${view.markdown.slice(0, 3000)}`, userId: input.access.ownerId, tenantId: input.access.tenantId, temperature: 0.3, maxTokens: 1200 });
    const scene: DiagramScene = validateDiagramScene(extractJson(reply, 'object'));
    if (scene.nodes.length === 0) return { ok: false, error: 'the model produced no diagram', action: 'create_diagram' };
    const svg = diagramToSvg(scene);
    const preview = `Diagram: ${scene.title ?? 'untitled'} (${scene.nodes.length} node${scene.nodes.length === 1 ? '' : 's'})`;
    return stageInsert(input.noteId, input.access, 'create_diagram', 'diagram', { scene, title: scene.title ?? '', kind: scene.kind ?? 'flow', author: 'ai' }, svg, preview);
  }

  /** The model produces ink PRIMITIVES; we turn them into real editable strokes + stage them. */
  async function drawInkInner(input: { noteId: string; access: NoteAccess; instruction: string }): Promise<CreativeResult> {
    const sys = 'You draw simple hand ink. Output ONLY a JSON array of primitives, each ONE of: {"kind":"underline","x1":N,"x2":N,"y":N}, {"kind":"line","x1":N,"y1":N,"x2":N,"y2":N}, {"kind":"arrow","x1":N,"y1":N,"x2":N,"y2":N}, {"kind":"box","x":N,"y":N,"w":N,"h":N}, {"kind":"circle","cx":N,"cy":N,"r":N}, {"kind":"check","x":N,"y":N}. Add a "color" hex (e.g. "#3B6FB0" for blue). The canvas is about 320 wide by 140 tall. Keep it minimal — 1 to 4 primitives.';
    const reply = await generate({ system: sys, user: input.instruction, userId: input.access.ownerId, tenantId: input.access.tenantId, temperature: 0.3, maxTokens: 600 });
    const strokes: InkStroke[] = inkFromPrimitives(extractJson(reply, 'array'));
    if (strokes.length === 0) return { ok: false, error: 'the model produced no strokes', action: 'draw_ink' };
    const svg = strokesToSvg(strokes);
    return stageInsert(input.noteId, input.access, 'draw_ink', 'inkCanvas', { strokes, author: 'ai' }, svg, `Ink: ${input.instruction.slice(0, 48)}`);
  }

  return {
    createDiagram(input: { noteId: string; access: NoteAccess; instruction: string }): Promise<CreativeResult> {
      return withAiPresence(db, input.noteId, () => createDiagramInner(input));
    },
    drawInk(input: { noteId: string; access: NoteAccess; instruction: string }): Promise<CreativeResult> {
      return withAiPresence(db, input.noteId, () => drawInkInner(input));
    },
    /** Recolour the strokes of an existing inkCanvas block — staged as a suggestion (edit). */
    async recolorInk(input: { noteId: string; access: NoteAccess; color: string }): Promise<CreativeResult> {
      const view = await relay.ensureDoc({ noteId: input.noteId, tenantId: input.access.tenantId, ownerId: input.access.ownerId, seedPm: await seedFor(input.noteId, input.access.ownerId) });
      const site = creativeSite(input.noteId, 'recolor_ink');
      const shadow = BlockDoc.fromSnapshot(site, view.snapshot);
      const inkBlock = shadow.blocks().find((b) => b.type === 'inkCanvas');
      if (!inkBlock || !inkBlock.id) return { ok: false, error: 'no ink to recolour', action: 'recolor_ink' };
      const strokes = recolorStrokes(validateStrokes((inkBlock.attrs as { strokes?: unknown }).strokes), input.color);
      const op = shadow.setBlockAttr(inkBlock.id, 'strokes', strokes);
      if (!op) return { ok: false, error: 'no change', action: 'recolor_ink' };
      const id = newUUIDv7();
      await db.createNoteSuggestion({
        id, note_id: input.noteId, doc_id: view.docId, tenant_id: input.access.tenantId,
        author_kind: 'agent', author_id: input.access.ownerId, author_site: site, action: 'recolor_ink',
        status: 'pending', ops_json: JSON.stringify([op]), preview_text: `Recolour the ink`, anchor_json: JSON.stringify({ kind: 'recolor' }), created_at: now(), resolved_at: null, resolved_by: null,
      });
      noteCoeditHub.broadcast(input.noteId, 'coedit.suggestion', { id, action: 'recolor_ink', preview: 'Recolour the ink' });
      return { ok: true, suggestionId: id, action: 'recolor_ink' };
    },
  };
}

export type NoteCreativeService = ReturnType<typeof createNoteCreativeService>;

// ─── Agent-tool entry points (resolve access themselves; viewers refused) ───────────

/** The creative TOOLS the chat agent can call. Each resolves note access itself (no escalation). */
export function createCreativeTools(db: NoteCreativeDb, generate: NoteAiGenerate, opts: { now?: () => number } = {}) {
  const svc = createNoteCreativeService(db, generate, opts);
  async function access(userId: string, noteId: string): Promise<NoteAccess | { error: string }> {
    const a = await resolveNoteAccess(db, noteId, userId);
    if (!a) return { error: 'note not found or not accessible' };
    if (!roleAtLeast(a.role, 'collaborator')) return { error: 'forbidden: this note is read-only for you' };
    return a;
  }
  return {
    async createDiagram(args: { userId: string; noteId: string; instruction: string }): Promise<CreativeResult> {
      const a = await access(args.userId, args.noteId); if ('error' in a) return { ok: false, error: a.error };
      return svc.createDiagram({ noteId: args.noteId, access: a, instruction: args.instruction });
    },
    async drawInk(args: { userId: string; noteId: string; instruction: string }): Promise<CreativeResult> {
      const a = await access(args.userId, args.noteId); if ('error' in a) return { ok: false, error: a.error };
      return svc.drawInk({ noteId: args.noteId, access: a, instruction: args.instruction });
    },
  };
}
