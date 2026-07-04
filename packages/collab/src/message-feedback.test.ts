/**
 * Tests — answer feedback (message-feedback.ts). Positive / negative / stress / security, as required.
 */
import { describe, it, expect } from 'vitest';
import {
  validateMessageFeedback, feedbackToAnnotationValue, summarizeMessageFeedback,
  sanitizeFeedbackCategories, signalToRating,
  FEEDBACK_CATEGORIES, FEEDBACK_COMMENT_MAX, type FeedbackRow,
} from './message-feedback.js';

describe('sanitizeFeedbackCategories', () => {
  it('POSITIVE — keeps known keys, de-dupes, preserves order', () => {
    expect(sanitizeFeedbackCategories(['incomplete', 'incomplete', 'inaccurate'])).toEqual(['incomplete', 'inaccurate']);
  });
  it('NEGATIVE — non-array / unknown / non-string entries are dropped', () => {
    expect(sanitizeFeedbackCategories('inaccurate')).toEqual([]);
    expect(sanitizeFeedbackCategories(['bogus', 42, null, { key: 'inaccurate' }])).toEqual([]);
  });
  it('SECURITY — an injection-y string is not a known key, so it is dropped', () => {
    expect(sanitizeFeedbackCategories(['<script>', "'; DROP TABLE message_feedback;--"])).toEqual([]);
  });
});

describe('signalToRating', () => {
  it('maps the platform signal vocabulary onto up/down', () => {
    expect(signalToRating('thumbs_up')).toBe('up');
    expect(signalToRating('copy')).toBe('up');
    expect(signalToRating('thumbs_down')).toBe('down');
    expect(signalToRating('regenerate')).toBe('down');
    expect(signalToRating('nonsense')).toBeNull();
  });
});

describe('validateMessageFeedback', () => {
  it('POSITIVE — an up-vote with no categories is valid; up never keeps categories', () => {
    const r = validateMessageFeedback({ rating: 'up', categories: ['inaccurate'], comment: 'great' });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ rating: 'up', categories: [], comment: 'great' });
  });

  it('POSITIVE — a down-vote keeps only KNOWN categories, de-duplicated', () => {
    const r = validateMessageFeedback({ rating: 'down', categories: ['inaccurate', 'inaccurate', 'unhelpful', 'bogus'] });
    expect(r.ok).toBe(true);
    expect(r.value!.categories).toEqual(['inaccurate', 'unhelpful']); // 'bogus' dropped, dupes collapsed
  });

  it('NEGATIVE — an invalid rating is rejected', () => {
    expect(validateMessageFeedback({ rating: 'meh' }).ok).toBe(false);
    expect(validateMessageFeedback({ rating: 5 }).ok).toBe(false);
    expect(validateMessageFeedback({ rating: null }).ok).toBe(false);
  });

  it('SECURITY — control chars stripped + comment length-capped (no stored-XSS/abuse payload survives)', () => {
    const payload = `bad${String.fromCharCode(0)}${String.fromCharCode(27)}\n<script>` + 'A'.repeat(5000);
    const r = validateMessageFeedback({ rating: 'down', categories: ['other'], comment: payload });
    expect(r.ok).toBe(true);
    const c = r.value!.comment ?? '';
    expect(/[\u0000-\u001F\u007F-\u009F]/.test(c)).toBe(false);   // no control chars
    expect(c.length).toBeLessThanOrEqual(FEEDBACK_COMMENT_MAX);
  });

  it('NEGATIVE — a whitespace-only comment becomes null', () => {
    expect(validateMessageFeedback({ rating: 'up', comment: '   \n\t ' }).value!.comment).toBeNull();
  });

  it('all category keys are stable + non-empty', () => {
    for (const c of FEEDBACK_CATEGORIES) { expect(c.key).toBeTruthy(); expect(c.label).toBeTruthy(); }
  });
});

describe('feedbackToAnnotationValue — the eval bridge', () => {
  it('up→1, down→0; categories join into the string value', () => {
    expect(feedbackToAnnotationValue({ rating: 'up', categories: [], comment: null }).value).toBe(1);
    const down = feedbackToAnnotationValue({ rating: 'down', categories: ['inaccurate', 'unhelpful'], comment: 'x' });
    expect(down.value).toBe(0);
    expect(down.stringValue).toBe('inaccurate,unhelpful');
    expect(down.comment).toBe('x');
  });
});

describe('summarizeMessageFeedback', () => {
  it('POSITIVE — counts, satisfaction rate, and ranked down-vote reasons', () => {
    const rows: FeedbackRow[] = [
      { rating: 'up', categories: [] },
      { rating: 'up', categories: [] },
      { rating: 'down', categories: ['inaccurate'] },
      { rating: 'down', categories: ['inaccurate', 'unhelpful'] },
    ];
    const s = summarizeMessageFeedback(rows);
    expect(s.total).toBe(4); expect(s.up).toBe(2); expect(s.down).toBe(2);
    expect(s.satisfaction).toBe(0.5);
    expect(s.topCategories[0]).toMatchObject({ key: 'inaccurate', count: 2 });
    expect(s.topCategories[1]).toMatchObject({ key: 'unhelpful', count: 1 });
  });

  it('empty set → satisfaction null (no divide-by-zero)', () => {
    expect(summarizeMessageFeedback([]).satisfaction).toBeNull();
  });

  it('STRESS — 50k mixed rows aggregate correctly + fast', () => {
    const rows: FeedbackRow[] = [];
    for (let i = 0; i < 50_000; i++) rows.push(i % 3 === 0 ? { rating: 'down', categories: ['inaccurate'] } : { rating: 'up', categories: [] });
    const t = Date.now();
    const s = summarizeMessageFeedback(rows);
    expect(Date.now() - t).toBeLessThan(500);
    expect(s.total).toBe(50_000);
    expect(s.up + s.down).toBe(50_000);
    expect(s.satisfaction).toBeGreaterThan(0.6);
  });
});
