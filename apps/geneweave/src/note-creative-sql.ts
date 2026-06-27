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
  sanitizeSvg, svgToDataUri, type WeaveNotesConfig,
} from '@weaveintel/notes';
import { newUUIDv7, weaveContext } from '@weaveintel/core';
import { roleAtLeast } from '@weaveintel/collaboration';
import type { ChatEngineConfig } from './chat-runtime.js';
import { createNoteCoeditRepo, resolveNoteAccess, type NoteAccess } from './note-coedit-sql.js';
import { noteCoeditHub } from './note-coedit-hub.js';
import { createNoteSettingsService } from './note-settings-sql.js';
import { withAiPresence } from './note-ai-presence.js';
import type { DatabaseAdapter } from './db-types.js';
import type { NoteAiGenerate } from './note-ai-sql.js';

type NoteCreativeDb = DatabaseAdapter;

/** Generate a raster image from a prompt; returns base64 PNG (no data-uri prefix) or null. */
export type NoteImageGenerate = (opts: { prompt: string; model?: string; size?: string; userId?: string; tenantId?: string | null }) => Promise<string | null>;

export type VisualKind = 'auto' | 'diagram' | 'ink' | 'illustration' | 'image';

export interface CreativeResult { ok: boolean; error?: string; suggestionId?: string; preview?: string; action?: string; artifactId?: string | null; kind?: string }

function creativeSite(noteId: string, tag: string): string { return `agent:${noteId.slice(0, 8)}:${tag}:${newUUIDv7().slice(0, 8)}`; }

/** Best-effort JSON extraction from a model reply (handles ```json fences + prose). */
function extractJson(raw: string, kind: 'object' | 'array'): unknown {
  const t = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const open = kind === 'array' ? '[' : '{'; const close = kind === 'array' ? ']' : '}';
  const start = t.indexOf(open); const end = t.lastIndexOf(close);
  if (start === -1 || end <= start) return kind === 'array' ? [] : {};
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return kind === 'array' ? [] : {}; }
}

export function createNoteCreativeService(db: NoteCreativeDb, generate: NoteAiGenerate, opts: { now?: () => number; generateImage?: NoteImageGenerate } = {}) {
  const now = opts.now ?? (() => Date.now());
  const relay = createNoteCoeditRepo(db, { now });
  const settings = createNoteSettingsService(db);
  const cfg = (): Promise<WeaveNotesConfig> => settings.getConfig();

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

  type CreativeAction = 'create_diagram' | 'draw_ink' | 'create_illustration' | 'generate_image';

  /**
   * Ask the model WHERE a new block belongs, so a diagram/drawing/image is placed next to the most
   * related content instead of always at the end. Returns the block id to insert AFTER, or null (=end).
   * One cheap, focused call over the note's OUTLINE (it never sees raw block ids, only an index).
   */
  async function pickAnchorAfter(blocks: ReturnType<BlockDoc['blocks']>, description: string, access: NoteAccess): Promise<unknown | null> {
    const items = blocks.map((b, i) => ({ i, b })).filter(({ b }) => (b.text && b.text.trim()) || b.type.startsWith('heading'));
    if (items.length < 2) return null; // nothing meaningful to anchor to → end
    const outline = items.map(({ i, b }) => `${i}: [${b.type}] ${(b.text || '').replace(/\s+/g, ' ').slice(0, 70)}`).join('\n');
    try {
      const reply = await generate({
        system: 'You place new content in a note. Reply with ONLY a single number (an index from the outline) or the word END — nothing else.',
        user: `Note outline (index: [type] "text"):\n${outline}\n\nWe are inserting: ${description}\nAfter which numbered line should it go so it sits with the most related content? Reply ONLY the number, or END for the very end.`,
        userId: access.ownerId, tenantId: access.tenantId, temperature: 0, maxTokens: 6,
      });
      if (/end/i.test(reply)) return null;
      const m = reply.match(/\d+/);
      if (!m) return null;
      const idx = parseInt(m[0], 10);
      return (idx >= 0 && idx < blocks.length) ? blocks[idx]!.id : null;
    } catch { return null; }
  }

  /** Insert a new creative atom as a STAGED suggestion; mirror its SVG (or use a pre-saved artifact).
   *  `placeDescription` (when given) lets the AI choose WHERE to insert it instead of appending. */
  async function stageInsert(noteId: string, access: NoteAccess, action: CreativeAction, blockType: 'diagram' | 'inkCanvas' | 'image', attrs: Record<string, unknown>, preview: string, mirror: { svg?: string; artifactId?: string | null } = {}, placeDescription?: string): Promise<CreativeResult> {
    const view = await relay.ensureDoc({ noteId, tenantId: access.tenantId, ownerId: access.ownerId, seedPm: await seedFor(noteId, access.ownerId) });
    const site = creativeSite(noteId, action);
    const shadow = BlockDoc.fromSnapshot(site, view.snapshot);
    const blocks = shadow.blocks();
    let after = blocks.length ? blocks[blocks.length - 1]!.id : null;
    if (placeDescription) { const anchored = await pickAnchorAfter(blocks, placeDescription, access); if (anchored) after = anchored as typeof after; }
    const { ops } = shadow.insertBlock(after, blockType, attrs);
    if (ops.length === 0) return { ok: false, error: 'no change produced', action };

    let artifactId = mirror.artifactId ?? null;
    if (!artifactId && mirror.svg) artifactId = await mirrorArtifact(noteId, access, blockType === 'inkCanvas' ? 'ink' : blockType, preview, mirror.svg, { action });
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
    const svg = diagramToSvg(scene, { style: 'sketch' });
    const preview = `Diagram: ${scene.title ?? 'untitled'} (${scene.nodes.length} node${scene.nodes.length === 1 ? '' : 's'})`;
    return stageInsert(input.noteId, input.access, 'create_diagram', 'diagram', { scene, title: scene.title ?? '', kind: scene.kind ?? 'flow', author: 'ai' }, preview, { svg }, `a diagram titled "${scene.title ?? input.instruction.slice(0, 50)}"`);
  }

  /** The model AUTHORS a detailed SVG illustration; we sanitise it + embed it as an inert image. */
  async function createIllustrationInner(input: { noteId: string; access: NoteAccess; instruction: string }): Promise<CreativeResult> {
    const sys = 'You are an SVG illustrator. Draw the requested subject as a single, clean, self-contained <svg> illustration — use <path> with curves, <circle>, <ellipse>, <polygon>, <rect>, <line>, <text>, and <linearGradient>/<radialGradient> for shading. Use a sensible viewBox (e.g. "0 0 320 320"), tasteful colours, and clear labels where helpful. Output ONLY the <svg>…</svg> markup — no markdown, no prose, no <script>.';
    const reply = await generate({ system: sys, user: input.instruction, userId: input.access.ownerId, tenantId: input.access.tenantId, temperature: 0.4, maxTokens: 3000 });
    const svg = sanitizeSvg(reply.replace(/^```(?:svg|xml|html)?/i, '').replace(/```$/, '').trim());
    if (!svg) return { ok: false, error: 'the model did not produce a usable SVG', action: 'create_illustration' };
    const alt = input.instruction.slice(0, 80);
    return stageInsert(input.noteId, input.access, 'create_illustration', 'image', { src: svgToDataUri(svg), alt, author: 'ai' }, `Illustration: ${alt}`, { svg }, `an illustration of ${alt}`);
  }

  /** The image MODEL generates a raster picture; we store it as an artifact + embed it. */
  async function generateImageInner(input: { noteId: string; access: NoteAccess; instruction: string }): Promise<CreativeResult> {
    const config = await cfg();
    if (!config.imageGenerationEnabled) return { ok: false, error: 'image generation is disabled in weaveNotes settings', action: 'generate_image' };
    if (!opts.generateImage) return { ok: false, error: 'no image model is configured on this server', action: 'generate_image' };
    if (!db.saveArtifact) return { ok: false, error: 'artifact storage is unavailable', action: 'generate_image' };
    const b64 = await opts.generateImage({ prompt: input.instruction, model: config.imageModel, size: '1024x1024', userId: input.access.ownerId, tenantId: input.access.tenantId });
    if (!b64) return { ok: false, error: 'the image model returned no image', action: 'generate_image' };
    let artifactId: string | null = null;
    try {
      const art = await db.saveArtifact({ name: input.instruction.slice(0, 80) || 'image', type: 'image', mimeType: 'image/png', data: b64, scope: 'user', userId: input.access.ownerId, ...(input.access.tenantId ? { tenantId: input.access.tenantId } : {}), tags: ['note', 'creative', 'image'], metadata: { source: 'note', noteId: input.noteId, kind: 'image', model: config.imageModel, encoding: 'base64' } });
      artifactId = art.id;
    } catch { return { ok: false, error: 'could not store the generated image', action: 'generate_image' }; }
    const alt = input.instruction.slice(0, 80);
    return stageInsert(input.noteId, input.access, 'generate_image', 'image', { src: `/api/artifacts/${artifactId}/data`, alt, author: 'ai' }, `Image: ${alt}`, { artifactId }, `an image of ${alt}`);
  }

  /** Heuristically pick the best visual KIND for a free-text request (when kind = 'auto'). */
  function classifyVisual(instruction: string): Exclude<VisualKind, 'auto'> {
    const t = instruction.toLowerCase();
    if (/\b(photo|photograph|realistic|render|painting|watercolou?r|3d|portrait|landscape)\b/.test(t)) return 'image';
    if (/\b(illustrat|drawing of|picture of|sketch of|icon|logo|anatom|diagram of the|cross.section|figure of)\b/.test(t)) return 'illustration';
    if (/\b(flow|flowchart|process|pipeline|mind.?map|org chart|architecture|sequence|block diagram|graph|tree|steps?)\b/.test(t)) return 'diagram';
    if (/\b(underline|arrow|circle|box|highlight|annotat|mark|scribble|doodle|ink)\b/.test(t)) return 'ink';
    return 'illustration'; // a generic "draw X" → a vector illustration (no cost, always available)
  }

  /** The model produces ink PRIMITIVES; we turn them into real editable strokes + stage them. */
  async function drawInkInner(input: { noteId: string; access: NoteAccess; instruction: string }): Promise<CreativeResult> {
    const sys = 'You draw simple hand ink. Output ONLY a JSON array of primitives, each ONE of: {"kind":"underline","x1":N,"x2":N,"y":N}, {"kind":"line","x1":N,"y1":N,"x2":N,"y2":N}, {"kind":"arrow","x1":N,"y1":N,"x2":N,"y2":N}, {"kind":"box","x":N,"y":N,"w":N,"h":N}, {"kind":"circle","cx":N,"cy":N,"r":N}, {"kind":"check","x":N,"y":N}. Add a "color" hex (e.g. "#3B6FB0" for blue). The canvas is about 320 wide by 140 tall. Keep it minimal — 1 to 4 primitives.';
    const reply = await generate({ system: sys, user: input.instruction, userId: input.access.ownerId, tenantId: input.access.tenantId, temperature: 0.3, maxTokens: 600 });
    const strokes: InkStroke[] = inkFromPrimitives(extractJson(reply, 'array'));
    if (strokes.length === 0) return { ok: false, error: 'the model produced no strokes', action: 'draw_ink' };
    const svg = strokesToSvg(strokes);
    return stageInsert(input.noteId, input.access, 'draw_ink', 'inkCanvas', { strokes, author: 'ai' }, `Ink: ${input.instruction.slice(0, 48)}`, { svg }, `a sketch: ${input.instruction.slice(0, 50)}`);
  }

  return {
    createDiagram(input: { noteId: string; access: NoteAccess; instruction: string }): Promise<CreativeResult> {
      return withAiPresence(db, input.noteId, () => createDiagramInner(input));
    },
    drawInk(input: { noteId: string; access: NoteAccess; instruction: string }): Promise<CreativeResult> {
      return withAiPresence(db, input.noteId, () => drawInkInner(input));
    },
    createIllustration(input: { noteId: string; access: NoteAccess; instruction: string }): Promise<CreativeResult> {
      return withAiPresence(db, input.noteId, () => createIllustrationInner(input));
    },
    generateImage(input: { noteId: string; access: NoteAccess; instruction: string }): Promise<CreativeResult> {
      return withAiPresence(db, input.noteId, () => generateImageInner(input));
    },
    /** The unified router: pick (or honour) the visual kind, gate by config, dispatch. */
    async createVisual(input: { noteId: string; access: NoteAccess; instruction: string; kind?: VisualKind }): Promise<CreativeResult> {
      const config = await cfg();
      let kind: Exclude<VisualKind, 'auto'> = (input.kind && input.kind !== 'auto') ? input.kind : classifyVisual(input.instruction);
      // Honour the per-workspace toggles; degrade gracefully to an always-available mode.
      const enabled: Record<Exclude<VisualKind, 'auto'>, boolean> = {
        diagram: config.diagramsEnabled, ink: config.inkEnabled, illustration: config.illustrationEnabled,
        image: config.imageGenerationEnabled && !!opts.generateImage,
      };
      if (!enabled[kind]) kind = enabled.illustration ? 'illustration' : enabled.diagram ? 'diagram' : enabled.ink ? 'ink' : kind;
      if (!enabled[kind]) return { ok: false, error: 'no visual modes are enabled in weaveNotes settings', action: 'create_visual' };
      const dispatch = { diagram: createDiagramInner, ink: drawInkInner, illustration: createIllustrationInner, image: generateImageInner }[kind];
      const r = await withAiPresence(db, input.noteId, () => dispatch(input));
      return { ...r, kind };
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

/**
 * Build a raster-image generator backed by the OpenAI image model (gpt-image-1 by default).
 * Returns `null` images when no OpenAI key is configured, so image generation simply stays
 * unavailable rather than erroring (it is also gated by the `image_generation_enabled` setting).
 */
export function createModelImageGenerator(modelConfig: ChatEngineConfig): NoteImageGenerate {
  return async ({ prompt, model, size, userId, tenantId }) => {
    const openaiCfg = modelConfig.providers['openai'];
    const apiKey = openaiCfg?.apiKey ?? process.env['OPENAI_API_KEY'];
    if (!apiKey) return null;
    try {
      const mod = await import('@weaveintel/provider-openai') as unknown as {
        weaveOpenAIImageModel: (id: string, opts: { apiKey?: string; baseUrl?: string }) => { generateImage: (ctx: unknown, req: { prompt: string; size?: string }) => Promise<{ images?: ReadonlyArray<{ image?: string }> }> };
      };
      const imgModel = mod.weaveOpenAIImageModel(model ?? 'gpt-image-1', { apiKey, ...(openaiCfg?.baseUrl ? { baseUrl: openaiCfg.baseUrl } : {}) });
      const ctx = weaveContext({ userId, tenantId: tenantId ?? undefined, runtime: modelConfig.runtime });
      const res = await imgModel.generateImage(ctx, { prompt, ...(size ? { size } : {}) });
      return res.images?.[0]?.image ?? null;
    } catch { return null; }
  };
}

// ─── Agent-tool entry points (resolve access themselves; viewers refused) ───────────

/** The creative TOOLS the chat agent can call. Each resolves note access itself (no escalation). */
export function createCreativeTools(db: NoteCreativeDb, generate: NoteAiGenerate, opts: { now?: () => number; generateImage?: NoteImageGenerate } = {}) {
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
    async createIllustration(args: { userId: string; noteId: string; instruction: string }): Promise<CreativeResult> {
      const a = await access(args.userId, args.noteId); if ('error' in a) return { ok: false, error: a.error };
      return svc.createIllustration({ noteId: args.noteId, access: a, instruction: args.instruction });
    },
    async generateImage(args: { userId: string; noteId: string; instruction: string }): Promise<CreativeResult> {
      const a = await access(args.userId, args.noteId); if ('error' in a) return { ok: false, error: a.error };
      return svc.generateImage({ noteId: args.noteId, access: a, instruction: args.instruction });
    },
    async createVisual(args: { userId: string; noteId: string; instruction: string; kind?: VisualKind }): Promise<CreativeResult> {
      const a = await access(args.userId, args.noteId); if ('error' in a) return { ok: false, error: a.error };
      return svc.createVisual({ noteId: args.noteId, access: a, instruction: args.instruction, ...(args.kind ? { kind: args.kind } : {}) });
    },
  };
}
