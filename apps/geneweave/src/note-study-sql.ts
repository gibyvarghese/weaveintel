// SPDX-License-Identifier: MIT
/**
 * geneWeave note STUDY service (weaveNotes Phase 5) — flashcards + SM-2 spaced repetition.
 *
 * "Make flashcards from this note" turns a note into question→answer cards for active recall, and
 * schedules each card so you review it just before you'd forget it. This service owns that:
 *   - `generateFlashcards` reads the note's text, asks the model for clean Q→A pairs, validates
 *     them (`@weaveintel/notes` `validateFlashcards`), and persists a deck of cards;
 *   - `listCards` / `deckStats` show a note's deck; `dueCards` is the cross-note review queue;
 *   - `reviewCard` applies the SM-2 scheduler (`sm2`) to one review and re-schedules the card.
 *
 * The SM-2 maths + the flashcard model live in `@weaveintel/notes` (pure + tested); this layer is
 * just persistence + the LLM call + access control. Cards are owner-scoped + tenant-isolated, and
 * the agent tool (`make_flashcards`) resolves access itself so a prompt-injected agent can't make
 * cards from a note the user can't read.
 */
import {
  validateFlashcards, sm2, studyStats, initialSchedule,
  type Flashcard, type ReviewRating, type CardSchedule, type StudyStats,
} from '@weaveintel/notes';
import { newUUIDv7 } from '@weaveintel/core';
import { roleAtLeast } from '@weaveintel/collaboration';
import { createNoteCoeditRepo, resolveNoteAccess, type NoteAccess } from './note-coedit-sql.js';
import { createNoteSettingsService } from './note-settings-sql.js';
import type { DatabaseAdapter } from './db-types.js';
import type { NoteAiGenerate } from './note-ai-sql.js';
import type { NoteFlashcardRow } from './db-types/adapter-agenda-notes.js';

type NoteStudyDb = DatabaseAdapter;

export interface FlashcardView { id: string; noteId: string; front: string; back: string; dueAt: number; intervalDays: number; repetitions: number; easeFactor: number; lastReviewedAt: number | null }
export interface StudyResult { ok: boolean; error?: string; created?: number; cards?: FlashcardView[]; stats?: StudyStats }

/** Schedule fields out of a stored row (for SM-2). */
function rowSchedule(r: NoteFlashcardRow): CardSchedule {
  return { easeFactor: r.ease_factor, intervalDays: r.interval_days, repetitions: r.repetitions, dueAt: r.due_at, lastReviewedAt: r.last_reviewed_at };
}
function rowToView(r: NoteFlashcardRow): FlashcardView {
  return { id: r.id, noteId: r.note_id, front: r.front, back: r.back, dueAt: r.due_at, intervalDays: r.interval_days, repetitions: r.repetitions, easeFactor: r.ease_factor, lastReviewedAt: r.last_reviewed_at };
}

/** Best-effort JSON-array extraction from a model reply (handles ```json fences + prose). */
function parseJsonArray(raw: string): unknown[] {
  const t = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = t.indexOf('['); const end = t.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  try { const v = JSON.parse(t.slice(start, end + 1)); return Array.isArray(v) ? v : []; } catch { return []; }
}

export function createNoteStudyService(db: NoteStudyDb, generate: NoteAiGenerate, opts: { now?: () => number } = {}) {
  const now = opts.now ?? (() => Date.now());
  const relay = createNoteCoeditRepo(db, { now });
  const settings = createNoteSettingsService(db);

  async function seedFor(noteId: string, ownerId: string): Promise<unknown> {
    const note = await db.getNote(noteId, ownerId) as { doc_json?: string } | null;
    if (!note?.doc_json) return { type: 'doc', content: [] };
    try { return JSON.parse(note.doc_json); } catch { return { type: 'doc', content: [] }; }
  }

  return {
    /**
     * Generate flashcards from a note's content + persist them, OWNED BY the requesting user
     * (`userId`) so they study their own deck even for a shared note. Returns how many were created.
     */
    async generateFlashcards(input: { noteId: string; access: NoteAccess; userId: string; count?: number }): Promise<StudyResult> {
      const cfg = await settings.getConfig();
      if (!cfg.flashcardsEnabled) return { ok: false, error: 'flashcards are disabled in weaveNotes settings' };
      const { noteId, access } = input;
      const cardOwner = input.userId;
      const view = await relay.ensureDoc({ noteId, tenantId: access.tenantId, ownerId: access.ownerId, seedPm: await seedFor(noteId, access.ownerId) });
      const markdown = view.markdown.slice(0, 8000);
      if (!markdown.trim()) return { ok: false, error: 'the note is empty' };
      const target = Math.max(3, Math.min(40, input.count ?? 10));
      const sys = `You write study flashcards for ACTIVE RECALL. From the note, produce up to ${target} clear question→answer cards covering the key facts, definitions and relationships. Each FRONT is a specific question; each BACK is the concise answer (one or two sentences). Do NOT just copy sentences — phrase real questions. Output ONLY a JSON array of {"front":"…","back":"…"} — no prose.`;
      const reply = await generate({ system: sys, user: `Note:\n\n${markdown}`, userId: access.ownerId, tenantId: access.tenantId, temperature: 0.3, maxTokens: 1800 });
      const cards: Flashcard[] = validateFlashcards(parseJsonArray(reply), now());
      if (cards.length === 0) return { ok: false, error: 'the model produced no usable cards' };

      const ts = now();
      const created: NoteFlashcardRow[] = cards.slice(0, target).map((c) => ({
        id: newUUIDv7(), note_id: noteId, owner_user_id: cardOwner, tenant_id: access.tenantId,
        front: c.front, back: c.back,
        ease_factor: c.schedule.easeFactor, interval_days: c.schedule.intervalDays, repetitions: c.schedule.repetitions,
        due_at: c.schedule.dueAt, last_reviewed_at: c.schedule.lastReviewedAt, created_at: ts,
      }));
      for (const row of created) await db.createNoteFlashcard(row);
      void settings.recordActivity({ noteId, userId: cardOwner, tenantId: access.tenantId ?? null, action: 'updated', actor: 'ai', summary: `Made ${created.length} flashcard${created.length === 1 ? '' : 's'}` });
      return { ok: true, created: created.length, cards: created.map(rowToView), stats: studyStats(created.map((r) => ({ schedule: rowSchedule(r) })), ts) };
    },

    /** A note's deck FOR A USER + its study stats (due / fresh / learning / mature). */
    async listCards(noteId: string, userId: string): Promise<StudyResult> {
      const rows = await db.listNoteFlashcards(noteId, userId);
      return { ok: true, cards: rows.map(rowToView), stats: studyStats(rows.map((r) => ({ schedule: rowSchedule(r) })), now()) };
    },

    /** The cross-note review QUEUE: the user's cards that are due now, soonest-due first. */
    async dueCards(userId: string, limit = 50): Promise<StudyResult> {
      const rows = await db.listDueFlashcards(userId, now(), limit);
      return { ok: true, cards: rows.map(rowToView) };
    },

    /** Apply one SM-2 review to a card (owner-scoped) and re-schedule it. */
    async reviewCard(input: { cardId: string; userId: string; rating: ReviewRating }): Promise<StudyResult & { card?: FlashcardView }> {
      const row = await db.getNoteFlashcard(input.cardId, input.userId);
      if (!row) return { ok: false, error: 'card not found' };
      const next = sm2(rowSchedule(row), input.rating, now());
      await db.updateNoteFlashcardSchedule(input.cardId, input.userId, {
        ease_factor: next.easeFactor, interval_days: next.intervalDays, repetitions: next.repetitions, due_at: next.dueAt, last_reviewed_at: next.lastReviewedAt ?? now(),
      });
      return { ok: true, card: rowToView({ ...row, ease_factor: next.easeFactor, interval_days: next.intervalDays, repetitions: next.repetitions, due_at: next.dueAt, last_reviewed_at: next.lastReviewedAt }) };
    },
  };
}

export type NoteStudyService = ReturnType<typeof createNoteStudyService>;

// ─── Agent-tool entry point (resolves access itself; viewers may still study but only owners write) ──

/** The `make_flashcards` tool: create a deck from a note the user can read. Resolves access itself. */
export function createStudyTool(db: NoteStudyDb, generate: NoteAiGenerate, opts: { now?: () => number } = {}) {
  const svc = createNoteStudyService(db, generate, opts);
  return {
    async makeFlashcards(args: { userId: string; noteId: string; count?: number }): Promise<StudyResult> {
      const access = await resolveNoteAccess(db, args.noteId, args.userId);
      if (!access) return { ok: false, error: 'note not found or not accessible' };
      if (!roleAtLeast(access.role, 'viewer')) return { ok: false, error: 'forbidden' };
      return svc.generateFlashcards({ noteId: args.noteId, access, userId: args.userId, ...(args.count ? { count: args.count } : {}) });
    },
  };
}

// re-export for the schedule helper used by tests/embedders
export { initialSchedule };
