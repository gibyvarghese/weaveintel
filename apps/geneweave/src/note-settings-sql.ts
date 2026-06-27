// SPDX-License-Identifier: MIT
/**
 * geneWeave weaveNotes SETTINGS + ACTIVITY service (weaveNotes Phase 0).
 *
 * Two foundation jobs, both database-backed:
 *   1. Read/update the single global weaveNotes capability config (the `weavenotes_settings`
 *      row), going through the shared `validateWeaveNotesConfig` so a value can never be saved
 *      out of range or with an unknown tool. The Builder edits this row.
 *   2. Record + read the per-note ACTIVITY log so the AI can be given an understanding of what
 *      changed before it acts ("created", "updated", "ai_edit" …). Recording is gated on the
 *      config's `activityTrackingEnabled` flag and is best-effort (never blocks a save).
 *
 * Reuses the pure config schema from `@weaveintel/notes`; everything is owner-scoped.
 */
import { validateWeaveNotesConfig, DEFAULT_WEAVENOTES_CONFIG, type WeaveNotesConfig } from '@weaveintel/notes';
import { newUUIDv7 } from '@weaveintel/core';
import { resolveNoteAccess } from './note-coedit-sql.js';
import type { DatabaseAdapter } from './db-types.js';
import type { WeaveNotesSettingsRow } from './db-types/adapter-me.js';

type SettingsDb = DatabaseAdapter;

function rowToConfig(row: WeaveNotesSettingsRow | null): WeaveNotesConfig {
  if (!row) return DEFAULT_WEAVENOTES_CONFIG;
  let tools: unknown = DEFAULT_WEAVENOTES_CONFIG.enabledAiTools;
  try { tools = JSON.parse(row.enabled_ai_tools); } catch { /* default */ }
  return validateWeaveNotesConfig({
    defaultTheme: row.default_theme,
    agencyColorEnabled: row.agency_color_enabled !== 0,
    aiSuggestionsRequireApproval: row.ai_suggestions_require_approval !== 0,
    activityTrackingEnabled: row.activity_tracking_enabled !== 0,
    activityRetentionDays: row.activity_retention_days,
    maxAiTokensPerEdit: row.max_ai_tokens_per_edit,
    localModelForSensitive: row.local_model_for_sensitive !== 0,
    enabledAiTools: tools,
  }).config;
}

export interface NoteActivityView { id: string; action: string; actor: string; summary: string | null; createdAt: string }

export function createNoteSettingsService(db: SettingsDb, opts: { now?: () => number } = {}) {
  const now = opts.now ?? (() => Date.now());

  /** The current weaveNotes config (validated; falls back to defaults). */
  async function getConfig(): Promise<WeaveNotesConfig> {
    return rowToConfig(await db.getWeaveNotesSettings());
  }

  /** Validate + persist a (partial) config update. Returns the normalised config + any warnings. */
  async function updateConfig(partial: Partial<Record<keyof WeaveNotesConfig, unknown>>): Promise<{ config: WeaveNotesConfig; warnings: string[] }> {
    const base = await getConfig();
    const { config, warnings } = validateWeaveNotesConfig(partial, base);
    await db.updateWeaveNotesSettings({
      default_theme: config.defaultTheme,
      agency_color_enabled: config.agencyColorEnabled ? 1 : 0,
      ai_suggestions_require_approval: config.aiSuggestionsRequireApproval ? 1 : 0,
      activity_tracking_enabled: config.activityTrackingEnabled ? 1 : 0,
      activity_retention_days: config.activityRetentionDays,
      max_ai_tokens_per_edit: config.maxAiTokensPerEdit,
      local_model_for_sensitive: config.localModelForSensitive ? 1 : 0,
      enabled_ai_tools: JSON.stringify(config.enabledAiTools),
    });
    return { config, warnings };
  }

  /**
   * Record a note-activity event (best-effort; skipped when activity tracking is off). `actor`
   * is 'user' or 'ai' so the AI can tell its own past edits from the human's.
   */
  async function recordActivity(input: { noteId: string; userId: string; tenantId?: string | null; action: string; actor?: 'user' | 'ai'; summary?: string; detail?: unknown }): Promise<void> {
    try {
      const cfg = await getConfig();
      if (!cfg.activityTrackingEnabled) return;
      await db.recordNoteActivity({
        id: newUUIDv7(), note_id: input.noteId, user_id: input.userId, tenant_id: input.tenantId ?? null,
        action: input.action, actor: input.actor ?? 'user',
        summary: input.summary ?? null, detail_json: input.detail != null ? JSON.stringify(input.detail) : null,
        created_at: new Date(now()).toISOString(),
      });
    } catch { /* never block the write that triggered it */ }
  }

  /** Read a note's recent activity (newest first). Owner-scoped. */
  async function readActivity(input: { noteId: string; userId: string; limit?: number }): Promise<NoteActivityView[] | null> {
    const access = await resolveNoteAccess(db, input.noteId, input.userId);
    if (!access) return null;
    return (await db.listNoteActivity(input.noteId, input.limit ?? 20)).map((r) => ({ id: r.id, action: r.action, actor: r.actor, summary: r.summary, createdAt: r.created_at }));
  }

  /** The `read_note_activity` agent-tool entry point: a compact, AI-readable change summary. */
  async function agentReadActivity(args: { userId: string; tenantId?: string | null; noteId: string; limit?: number }): Promise<{ ok: boolean; error?: string; noteId: string; events: NoteActivityView[] }> {
    const events = await readActivity({ noteId: args.noteId, userId: args.userId, ...(args.limit ? { limit: args.limit } : {}) });
    if (events === null) return { ok: false, error: 'note not found or not accessible', noteId: args.noteId, events: [] };
    return { ok: true, noteId: args.noteId, events };
  }

  return { getConfig, updateConfig, recordActivity, readActivity, agentReadActivity };
}

export type NoteSettingsService = ReturnType<typeof createNoteSettingsService>;
