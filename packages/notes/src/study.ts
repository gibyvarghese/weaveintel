// SPDX-License-Identifier: MIT
/**
 * @weaveintel/notes — the STUDY model: flashcards + SM-2 spaced repetition (weaveNotes Phase 5).
 *
 * The most effective way to remember a note is ACTIVE RECALL on a SPACED schedule: turn the note
 * into question→answer flashcards, then review each card just before you'd forget it. This module
 * is the single source of truth for that — the flashcard shape, the strict validator over (AI- or
 * user-supplied) cards, and the scheduler that decides WHEN each card is next due.
 *
 * The scheduler is **SM-2** (the SuperMemo-2 algorithm — the classic, well-understood reference;
 * ~30 lines of arithmetic, no dependency). Each card carries an *ease factor* (how easy it is for
 * you), a *repetition count*, and an *interval* in days; after each review the interval grows (you
 * remembered) or resets (you forgot). The 4 review buttons map to SM-2 quality grades:
 *   Again → forgot (reset)   ·   Hard → just passed   ·   Good → passed   ·   Easy → easy (+ease).
 *
 * (Mid-2026 note: FSRS is a more accurate successor used by newer apps, but it is a trained model
 * with per-card parameters; SM-2 is the robust, transparent baseline the spec calls for, and the
 * `CardSchedule` shape here is forward-compatible with a future FSRS upgrade.)
 *
 * Pure + zero-dependency (browser- and server-safe; the time source is injected for testability).
 */

/** The 4 review ratings (the buttons a learner taps), in increasing recall quality. */
export type ReviewRating = 'again' | 'hard' | 'good' | 'easy';

/** A card's SM-2 scheduling state. `dueAt`/`lastReviewedAt` are epoch-ms. */
export interface CardSchedule {
  /** SM-2 ease factor (≥1.3; starts at 2.5). Higher = the card is easy for you → longer intervals. */
  easeFactor: number;
  /** Current interval in days until the next review. */
  intervalDays: number;
  /** How many times in a row you've passed this card (resets to 0 on "Again"). */
  repetitions: number;
  /** Epoch-ms when the card is next due. A new card is due immediately. */
  dueAt: number;
  /** Epoch-ms of the last review, or null if never reviewed. */
  lastReviewedAt: number | null;
}

/** A flashcard: a question (front), its answer (back), and its schedule. */
export interface Flashcard {
  front: string;
  back: string;
  schedule: CardSchedule;
}

export const MIN_EASE = 1.3;
export const INITIAL_EASE = 2.5;
const DAY_MS = 86_400_000;
const MAX_FRONT = 400;
const MAX_BACK = 2000;
const MAX_CARDS = 200;

/** Map a review button to the SM-2 quality grade q (0–5). "again" is a fail (q<3). */
export function ratingToQuality(rating: ReviewRating): number {
  switch (rating) {
    case 'again': return 2;
    case 'hard': return 3;
    case 'good': return 4;
    case 'easy': return 5;
    default: return 3;
  }
}

/** A fresh card's schedule — new, due immediately, with the default ease. */
export function initialSchedule(now = Date.now()): CardSchedule {
  return { easeFactor: INITIAL_EASE, intervalDays: 0, repetitions: 0, dueAt: now, lastReviewedAt: null };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

/**
 * Apply ONE SM-2 review to a card schedule and return the NEW schedule. Textbook SM-2:
 *   - the ease factor is nudged by `EF + (0.1 − (5−q)·(0.08 + (5−q)·0.02))`, floored at 1.3;
 *   - on a FAIL (q < 3, i.e. "Again") repetitions reset to 0 and the card is due again today;
 *   - on a PASS the interval grows: 1 day → 6 days → previous × ease (rounded);
 *   - the new due date = now + interval days.
 */
export function sm2(schedule: CardSchedule, rating: ReviewRating, now = Date.now()): CardSchedule {
  const q = ratingToQuality(rating);
  const ease = Math.max(MIN_EASE, round2(schedule.easeFactor + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))));

  let repetitions: number;
  let intervalDays: number;
  if (q < 3) {
    // Forgot → relearn: reset the streak and re-queue for today.
    repetitions = 0;
    intervalDays = 0;
  } else {
    repetitions = schedule.repetitions + 1;
    if (repetitions === 1) intervalDays = 1;
    else if (repetitions === 2) intervalDays = 6;
    else intervalDays = Math.max(1, Math.round(schedule.intervalDays * ease));
  }
  return { easeFactor: ease, intervalDays, repetitions, dueAt: now + intervalDays * DAY_MS, lastReviewedAt: now };
}

/** Is this card due for review at `now`? */
export function isDue(schedule: CardSchedule, now = Date.now()): boolean {
  return schedule.dueAt <= now;
}

/** The cards due at `now`, soonest-due first (oldest due date first). */
export function dueCards<T extends { schedule: CardSchedule }>(cards: readonly T[], now = Date.now()): T[] {
  return cards.filter((c) => isDue(c.schedule, now)).sort((a, b) => a.schedule.dueAt - b.schedule.dueAt);
}

export interface StudyStats { total: number; due: number; fresh: number; learning: number; mature: number }

/**
 * Summarise a deck: how many cards total, due now, FRESH (never reviewed), LEARNING (reviewed but
 * interval < 21 days), and MATURE (interval ≥ 21 days — well-remembered). Mirrors the Anki view.
 */
export function studyStats<T extends { schedule: CardSchedule }>(cards: readonly T[], now = Date.now()): StudyStats {
  let due = 0, fresh = 0, learning = 0, mature = 0;
  for (const c of cards) {
    if (isDue(c.schedule, now)) due += 1;
    if (c.schedule.lastReviewedAt === null) fresh += 1;
    else if (c.schedule.intervalDays >= 21) mature += 1;
    else learning += 1;
  }
  return { total: cards.length, due, fresh, learning, mature };
}

/**
 * Validate + normalise a (possibly AI- or client-supplied) list of `{front, back}` cards into safe
 * Flashcards: trim, cap lengths, drop empties, de-duplicate by front, cap the count, and stamp each
 * with a fresh schedule. Accepts a few common shapes (`front/back`, `question/answer`, `q/a`).
 */
export function validateFlashcards(input: unknown, now = Date.now()): Flashcard[] {
  if (!Array.isArray(input)) return [];
  const out: Flashcard[] = [];
  const seen = new Set<string>();
  for (const raw of input.slice(0, MAX_CARDS * 2)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const frontRaw = r['front'] ?? r['question'] ?? r['q'] ?? r['term'];
    const backRaw = r['back'] ?? r['answer'] ?? r['a'] ?? r['definition'];
    if (typeof frontRaw !== 'string' || typeof backRaw !== 'string') continue;
    const front = frontRaw.trim().slice(0, MAX_FRONT);
    const back = backRaw.trim().slice(0, MAX_BACK);
    if (!front || !back) continue;
    const key = front.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ front, back, schedule: initialSchedule(now) });
    if (out.length >= MAX_CARDS) break;
  }
  return out;
}
