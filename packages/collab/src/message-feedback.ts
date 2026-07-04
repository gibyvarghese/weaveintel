/**
 * @weaveintel/collaboration — Answer feedback (end-user thumbs + tiered reasons).
 *
 * This EXTENDS the run-annotation model (`run-annotation.ts`) to the chat surface: an end user rating a
 * single assistant answer. It deliberately reuses the same value/source model (`AnnotationSource`,
 * `normalizeAnnotationValue`) so a thumb on a chat message aggregates through the SAME machinery as an
 * LLM-judge score or a run rating — one quality signal, many sources.
 *
 * Research grounding (2026 practice):
 *  - Binary thumbs alone are near-useless as a signal; the productive pattern (ChatGPT / Claude / Gemini)
 *    is thumbs + a TIERED reason on a down-vote (a small fixed taxonomy) + optional free text. That's what
 *    turns feedback into an actionable eval/RLHF signal rather than a vanity metric. So a down-vote may
 *    carry one or more `FeedbackCategory`; an up-vote carries none.
 *  - Feedback must be attributable + tenant-scoped + auditable for enterprise → validation lives here (pure,
 *    testable) and both the API route and any agent tool go through it, so they can't drift.
 *
 * Everything in this file is PURE (no I/O) so it can be unit-tested exhaustively and reused server-side.
 */
import type { AnnotationSource } from './run-annotation.js';
import { normalizeAnnotationValue } from './run-annotation.js';

/** A binary answer rating. */
export type FeedbackRating = 'up' | 'down';

/**
 * The fixed taxonomy of reasons a user can attach to a DOWN vote. Small + stable on purpose (a long list
 * lowers completion + fragments the signal). Ordered by how often they occur in practice.
 */
export const FEEDBACK_CATEGORIES = [
  { key: 'inaccurate', label: 'Not accurate', help: 'Facts or reasoning are wrong' },
  { key: 'unhelpful', label: 'Not helpful', help: "Didn't answer what I asked" },
  { key: 'incomplete', label: 'Incomplete', help: 'Missing important parts' },
  { key: 'not_following', label: "Didn't follow instructions", help: 'Ignored my constraints or format' },
  { key: 'unsafe', label: 'Unsafe or harmful', help: 'Could cause harm' },
  { key: 'offensive', label: 'Offensive', help: 'Rude, biased, or inappropriate' },
  { key: 'other', label: 'Something else', help: '' },
] as const;

export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number]['key'];
const CATEGORY_KEYS = new Set<string>(FEEDBACK_CATEGORIES.map((c) => c.key));

/** The metric name feedback is recorded under, so it aggregates with other `answer_rating` signals. */
export const ANSWER_RATING_METRIC = 'answer_rating';

/** Max length of a free-text comment (kept modest — this is a reason, not an essay). */
export const FEEDBACK_COMMENT_MAX = 1000;

export interface MessageFeedbackInput {
  rating: unknown;
  categories?: unknown;
  comment?: unknown;
}

export interface ValidatedMessageFeedback {
  rating: FeedbackRating;
  categories: FeedbackCategory[];
  comment: string | null;
}

// C0/C1 control characters (defined via \u escapes so this source stays plain ASCII).
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

/**
 * Validate + sanitise raw feedback from any caller (route or agent tool). Rejects invalid ratings; keeps
 * only known categories; strips control chars + caps the comment (defence against stored-XSS / abuse). An
 * up-vote never keeps categories (they only make sense as reasons for a down-vote).
 */
export function validateMessageFeedback(input: MessageFeedbackInput): { ok: boolean; error?: string; value?: ValidatedMessageFeedback } {
  const rating = input.rating === 'up' || input.rating === 'down' ? input.rating : null;
  if (!rating) return { ok: false, error: "rating must be 'up' or 'down'" };

  let categories: FeedbackCategory[] = [];
  if (rating === 'down' && Array.isArray(input.categories)) {
    const seen = new Set<string>();
    for (const raw of input.categories) {
      const c = typeof raw === 'string' ? raw : '';
      if (CATEGORY_KEYS.has(c) && !seen.has(c)) { seen.add(c); categories.push(c as FeedbackCategory); }
    }
  }

  let comment: string | null = null;
  if (input.comment != null) {
    let s = String(input.comment).replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim();
    if (s.length > FEEDBACK_COMMENT_MAX) s = s.slice(0, FEEDBACK_COMMENT_MAX);
    comment = s.length ? s : null;
  }

  return { ok: true, value: { rating, categories, comment } };
}

/**
 * Keep only known, de-duplicated reason keys from arbitrary input (route/tool). Unlike
 * `validateMessageFeedback` this does not need a rating — the platform's existing feedback route uses a
 * `thumbs_up|thumbs_down|…` signal, and we attach categories to it directly.
 */
export function sanitizeFeedbackCategories(input: unknown): FeedbackCategory[] {
  if (!Array.isArray(input)) return [];
  const out: FeedbackCategory[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const c = typeof raw === 'string' ? raw : '';
    if (CATEGORY_KEYS.has(c) && !seen.has(c)) { seen.add(c); out.push(c as FeedbackCategory); }
  }
  return out;
}

/**
 * Map the platform's chat feedback `signal` vocabulary (thumbs_up|thumbs_down|regenerate|copy) onto the
 * binary answer rating used for satisfaction aggregation. `copy` counts as a soft positive, `regenerate` as
 * a soft negative; anything unknown is dropped from the rating count.
 */
export function signalToRating(signal: string): FeedbackRating | null {
  switch (signal) {
    case 'thumbs_up':
    case 'copy':        return 'up';
    case 'thumbs_down':
    case 'regenerate':  return 'down';
    default:            return null;
  }
}

/**
 * Map validated feedback to the annotation value model (so it flows through the same eval bridge as every
 * other score). `answer_rating` is boolean: up→1, down→0; the categories are carried as the string value.
 */
export function feedbackToAnnotationValue(fb: ValidatedMessageFeedback): { value: number | null; stringValue: string | null; comment: string | null } {
  const norm = normalizeAnnotationValue({ dataType: 'boolean', value: fb.rating === 'up' ? 1 : 0, stringValue: null });
  return { value: norm.value, stringValue: fb.categories.length ? fb.categories.join(',') : null, comment: fb.comment };
}

export interface FeedbackRow {
  rating: FeedbackRating;
  categories: FeedbackCategory[];
  source?: AnnotationSource;
}

export interface FeedbackSummary {
  total: number;
  up: number;
  down: number;
  /** Fraction of rated answers that were positive (0–1), or null when there's no feedback yet. */
  satisfaction: number | null;
  /** Down-vote reasons ranked by frequency. */
  topCategories: Array<{ key: FeedbackCategory; label: string; count: number }>;
}

const CATEGORY_LABEL = new Map(FEEDBACK_CATEGORIES.map((c) => [c.key, c.label] as const));

/** Aggregate feedback into an at-a-glance quality signal (for the Builder admin + the agent tool). */
export function summarizeMessageFeedback(rows: FeedbackRow[]): FeedbackSummary {
  let up = 0, down = 0;
  const catCounts = new Map<FeedbackCategory, number>();
  for (const r of rows) {
    if (r.rating === 'up') up++; else if (r.rating === 'down') down++;
    if (r.rating === 'down') for (const c of r.categories) catCounts.set(c, (catCounts.get(c) ?? 0) + 1);
  }
  const total = up + down;
  const topCategories = [...catCounts.entries()]
    .map(([key, count]) => ({ key, label: CATEGORY_LABEL.get(key) ?? key, count }))
    .sort((a, b) => b.count - a.count);
  return { total, up, down, satisfaction: total ? up / total : null, topCategories };
}
