// SPDX-License-Identifier: MIT
/**
 * @weaveintel/notes — the weaveNotes capability CONFIGURATION (weaveNotes Phase 0).
 *
 * weaveNotes is configuration-as-data: how the notes AI behaves is not hard-coded, it is a
 * record in the database that an admin edits through the Builder. This module is the SHARED
 * schema for that record — the typed shape, the safe defaults, and a pure validator that
 * clamps/normalises any partial update — so the package, the app, and the admin UI all agree
 * on what a valid weaveNotes config is. (geneWeave stores it in a single-row `weavenotes_settings`
 * table and exposes it as a Builder admin resource.)
 *
 * --- For someone new to this ---
 * Think of these as the assistant's "settings dials" for notes: which theme pages open in,
 * whether the AI must ASK before changing your words, whether it keeps a little history of what
 * changed, and a spending cap so a single AI edit can't run away. Defaults are chosen to be safe
 * and calm; an admin can tune them in the Builder without touching code.
 */

export type NotesTheme = 'pro' | 'creative';

export interface WeaveNotesConfig {
  /** The theme a note opens in by default: clean "pro" or playful "creative". */
  defaultTheme: NotesTheme;
  /** Apply the "colour encodes agency" contract (AI content in mint, human ink coral, etc.). */
  agencyColorEnabled: boolean;
  /** The AI proposes changes as reviewable suggestions instead of writing silently (recommended on). */
  aiSuggestionsRequireApproval: boolean;
  /** Record a small activity log of note create/update/AI-edit events so the AI knows what changed. */
  activityTrackingEnabled: boolean;
  /** How many days of note activity to keep before pruning. */
  activityRetentionDays: number;
  /** Cap the tokens a single AI note edit may spend (cost guard). */
  maxAiTokensPerEdit: number;
  /** Route sensitive notes to a local model (provider-ollama/llamacpp) instead of a cloud one. */
  localModelForSensitive: boolean;
  /** Show live collaborator cursors (coloured carets + names) while co-editing (Phase 3). */
  liveCursorsEnabled: boolean;
  /** Show the AI as a live participant ("weaveIntel AI") while it edits a note (Phase 3). */
  aiPresenceEnabled: boolean;
  /** Phase 4: let the AI create node/edge diagrams (flow / mind-map / process / block). */
  diagramsEnabled: boolean;
  /** Phase 4: let the AI draw freehand ink (underline / arrow / sketch / organic outline). */
  inkEnabled: boolean;
  /** Phase 4: let the AI author detailed SVG illustrations (vector art — a heart, a leaf, a logo). */
  illustrationEnabled: boolean;
  /** Phase 4: let the AI GENERATE raster images via an image model (realistic pictures; costs money). */
  imageGenerationEnabled: boolean;
  /** Phase 4: the image model used when image generation is enabled. */
  imageModel: string;
  /** Phase 5: let the AI turn a note into flashcards + schedule reviews (SM-2 spaced repetition). */
  flashcardsEnabled: boolean;
  /** Phase 5: cap how many NEW cards a study session introduces per day (active-recall pacing). */
  dailyNewCardLimit: number;
  /** Phase 7: let the mobile app work OFFLINE — edit notes with no signal and sync when back online. */
  mobileOfflineEnabled: boolean;
  /** Phase 7: let people DRAW freehand ink on a phone/tablet (synced to the web note untouched). */
  mobileInkEnabled: boolean;
  /** Phase 7: cap how many notes the mobile app keeps cached on-device for offline use. */
  mobileOfflineNoteLimit: number;
  /** The note AI tools the editor agent is allowed to use (subset of the catalog). */
  enabledAiTools: string[];
}

/** The full set of note AI tools weaveNotes ships (the editor agent's toolbelt). */
export const WEAVENOTES_AI_TOOLS = [
  'create_note', 'note_edit', 'find_related_notes', 'workspace_search',
  'capture_web_page', 'autofill_database', 'read_note_activity',
  // Phase 2 — the AI selection card's colour tools.
  'apply_highlight', 'apply_text_color', 'colorize_semantic',
  // Phase 4 — the AI creative tools (ink + diagrams + illustrations + images).
  'create_diagram', 'draw_ink', 'recolor_ink',
  'create_illustration', 'generate_image', 'create_visual',
  // Phase 5 — AI study: turn a note into flashcards.
  'make_flashcards',
] as const;

export const DEFAULT_WEAVENOTES_CONFIG: WeaveNotesConfig = {
  defaultTheme: 'pro',
  agencyColorEnabled: true,
  aiSuggestionsRequireApproval: true,
  activityTrackingEnabled: true,
  activityRetentionDays: 90,
  maxAiTokensPerEdit: 4000,
  localModelForSensitive: false,
  liveCursorsEnabled: true,
  aiPresenceEnabled: true,
  diagramsEnabled: true,
  inkEnabled: true,
  illustrationEnabled: true,
  imageGenerationEnabled: false, // off by default: raster image generation costs money + needs an image model
  imageModel: 'gpt-image-1',
  flashcardsEnabled: true,
  dailyNewCardLimit: 20,
  mobileOfflineEnabled: true,
  mobileInkEnabled: true,
  mobileOfflineNoteLimit: 200,
  enabledAiTools: [...WEAVENOTES_AI_TOOLS],
};

const TOOL_SET = new Set<string>(WEAVENOTES_AI_TOOLS);
function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function asBool(v: unknown, fallback: boolean): boolean {
  if (v === true || v === 1 || v === '1' || v === 'true') return true;
  if (v === false || v === 0 || v === '0' || v === 'false') return false;
  return fallback;
}

/**
 * Validate + normalise a (possibly partial, possibly hostile) config update against the
 * defaults. Always returns a COMPLETE, safe config (clamped numbers, known theme, known tools)
 * plus a list of human-readable warnings for anything that was corrected — so an admin save can
 * never persist an out-of-range or unknown value, and the UI can show what it fixed.
 */
export function validateWeaveNotesConfig(
  partial: Partial<Record<keyof WeaveNotesConfig, unknown>> | null | undefined,
  base: WeaveNotesConfig = DEFAULT_WEAVENOTES_CONFIG,
): { config: WeaveNotesConfig; warnings: string[] } {
  const p = partial ?? {};
  const warnings: string[] = [];

  const theme: NotesTheme = p.defaultTheme === 'creative' || p.defaultTheme === 'pro' ? p.defaultTheme : base.defaultTheme;
  if (p.defaultTheme !== undefined && theme !== p.defaultTheme) warnings.push(`Unknown theme "${String(p.defaultTheme)}" — kept "${theme}".`);

  const retention = clampInt(p.activityRetentionDays ?? base.activityRetentionDays, 1, 3650, base.activityRetentionDays);
  if (p.activityRetentionDays !== undefined && retention !== Math.trunc(Number(p.activityRetentionDays))) warnings.push(`Activity retention clamped to ${retention} days (1–3650).`);

  const maxTokens = clampInt(p.maxAiTokensPerEdit ?? base.maxAiTokensPerEdit, 256, 200_000, base.maxAiTokensPerEdit);
  if (p.maxAiTokensPerEdit !== undefined && maxTokens !== Math.trunc(Number(p.maxAiTokensPerEdit))) warnings.push(`Max AI tokens per edit clamped to ${maxTokens} (256–200000).`);

  let tools = base.enabledAiTools;
  if (p.enabledAiTools !== undefined) {
    const arr = Array.isArray(p.enabledAiTools) ? p.enabledAiTools.map(String) : [];
    const valid = [...new Set(arr.filter((t) => TOOL_SET.has(t)))];
    const dropped = arr.filter((t) => !TOOL_SET.has(t));
    if (dropped.length) warnings.push(`Ignored unknown tools: ${[...new Set(dropped)].join(', ')}.`);
    tools = valid;
  }

  return {
    config: {
      defaultTheme: theme,
      agencyColorEnabled: asBool(p.agencyColorEnabled ?? base.agencyColorEnabled, base.agencyColorEnabled),
      aiSuggestionsRequireApproval: asBool(p.aiSuggestionsRequireApproval ?? base.aiSuggestionsRequireApproval, base.aiSuggestionsRequireApproval),
      activityTrackingEnabled: asBool(p.activityTrackingEnabled ?? base.activityTrackingEnabled, base.activityTrackingEnabled),
      activityRetentionDays: retention,
      maxAiTokensPerEdit: maxTokens,
      localModelForSensitive: asBool(p.localModelForSensitive ?? base.localModelForSensitive, base.localModelForSensitive),
      liveCursorsEnabled: asBool(p.liveCursorsEnabled ?? base.liveCursorsEnabled, base.liveCursorsEnabled),
      aiPresenceEnabled: asBool(p.aiPresenceEnabled ?? base.aiPresenceEnabled, base.aiPresenceEnabled),
      diagramsEnabled: asBool(p.diagramsEnabled ?? base.diagramsEnabled, base.diagramsEnabled),
      inkEnabled: asBool(p.inkEnabled ?? base.inkEnabled, base.inkEnabled),
      illustrationEnabled: asBool(p.illustrationEnabled ?? base.illustrationEnabled, base.illustrationEnabled),
      imageGenerationEnabled: asBool(p.imageGenerationEnabled ?? base.imageGenerationEnabled, base.imageGenerationEnabled),
      imageModel: typeof p.imageModel === 'string' && p.imageModel.trim() ? p.imageModel.trim().slice(0, 64) : base.imageModel,
      flashcardsEnabled: asBool(p.flashcardsEnabled ?? base.flashcardsEnabled, base.flashcardsEnabled),
      dailyNewCardLimit: clampInt(p.dailyNewCardLimit ?? base.dailyNewCardLimit, 1, 1000, base.dailyNewCardLimit),
      mobileOfflineEnabled: asBool(p.mobileOfflineEnabled ?? base.mobileOfflineEnabled, base.mobileOfflineEnabled),
      mobileInkEnabled: asBool(p.mobileInkEnabled ?? base.mobileInkEnabled, base.mobileInkEnabled),
      mobileOfflineNoteLimit: clampInt(p.mobileOfflineNoteLimit ?? base.mobileOfflineNoteLimit, 10, 5000, base.mobileOfflineNoteLimit),
      enabledAiTools: tools,
    },
    warnings,
  };
}
