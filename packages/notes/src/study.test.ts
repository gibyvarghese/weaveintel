// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import {
  ratingToQuality, initialSchedule, sm2, isDue, dueCards, studyStats, validateFlashcards,
  MIN_EASE, INITIAL_EASE, type CardSchedule,
} from './study.js';

const T0 = 1_700_000_000_000; // a fixed "now" for deterministic dates
const DAY = 86_400_000;

describe('study — SM-2 scheduler', () => {
  it('a fresh card starts new, due now, with the default ease', () => {
    const s = initialSchedule(T0);
    expect(s).toMatchObject({ easeFactor: INITIAL_EASE, intervalDays: 0, repetitions: 0, dueAt: T0, lastReviewedAt: null });
    expect(isDue(s, T0)).toBe(true);
  });

  it('maps the 4 buttons to SM-2 quality grades', () => {
    expect(ratingToQuality('again')).toBeLessThan(3); // a fail
    expect(ratingToQuality('hard')).toBe(3);
    expect(ratingToQuality('good')).toBe(4);
    expect(ratingToQuality('easy')).toBe(5);
  });

  it('grows the interval 1 → 6 → ×ease on consecutive passes (the classic ladder)', () => {
    let s = initialSchedule(T0);
    s = sm2(s, 'good', T0);            // 1st pass
    expect(s.repetitions).toBe(1); expect(s.intervalDays).toBe(1);
    expect(s.dueAt).toBe(T0 + 1 * DAY);
    s = sm2(s, 'good', s.dueAt);       // 2nd pass
    expect(s.repetitions).toBe(2); expect(s.intervalDays).toBe(6);
    const efAfter2 = s.easeFactor;
    s = sm2(s, 'good', s.dueAt);       // 3rd pass → 6 × ease
    expect(s.repetitions).toBe(3);
    expect(s.intervalDays).toBe(Math.round(6 * efAfter2));
  });

  it('"Again" resets the streak + re-queues the card for today', () => {
    let s = initialSchedule(T0);
    s = sm2(s, 'good', T0); s = sm2(s, 'good', s.dueAt); // interval = 6, reps = 2
    const before = s.easeFactor;
    s = sm2(s, 'again', s.dueAt);
    expect(s.repetitions).toBe(0);
    expect(s.intervalDays).toBe(0);
    expect(s.dueAt).toBe(s.lastReviewedAt); // due again now
    expect(s.easeFactor).toBeLessThan(before); // a fail lowers ease
  });

  it('"Easy" raises ease, "Hard" lowers it; ease never drops below 1.3', () => {
    expect(sm2(initialSchedule(T0), 'easy', T0).easeFactor).toBeGreaterThan(INITIAL_EASE);
    expect(sm2(initialSchedule(T0), 'hard', T0).easeFactor).toBeLessThan(INITIAL_EASE);
    // hammer a card with "again" many times — ease floors at 1.3, never below.
    let s = initialSchedule(T0);
    for (let i = 0; i < 50; i++) s = sm2(s, 'again', T0 + i * 1000);
    expect(s.easeFactor).toBe(MIN_EASE);
  });

  it('matches the canonical SM-2 ease formula for q=5 and q=3', () => {
    // q=5: EF + 0.1 ; q=3: EF + (0.1 - 2*(0.08+2*0.02)) = EF - 0.14
    expect(sm2(initialSchedule(T0), 'easy', T0).easeFactor).toBeCloseTo(2.6, 5);
    expect(sm2(initialSchedule(T0), 'hard', T0).easeFactor).toBeCloseTo(2.36, 5);
  });
});

describe('study — due filter + stats', () => {
  const mk = (over: Partial<CardSchedule>): { schedule: CardSchedule } => ({ schedule: { ...initialSchedule(T0), ...over } });
  it('filters + sorts due cards soonest-first', () => {
    const cards = [mk({ dueAt: T0 + DAY }), mk({ dueAt: T0 - DAY }), mk({ dueAt: T0 - 2 * DAY })];
    const due = dueCards(cards, T0);
    expect(due).toHaveLength(2);
    expect(due[0]!.schedule.dueAt).toBeLessThan(due[1]!.schedule.dueAt); // oldest-due first
  });
  it('classifies fresh / learning / mature', () => {
    const cards = [
      mk({ lastReviewedAt: null }),                       // fresh
      mk({ lastReviewedAt: T0, intervalDays: 6 }),        // learning (<21d)
      mk({ lastReviewedAt: T0, intervalDays: 40, dueAt: T0 + 40 * DAY }), // mature, not due
    ];
    const st = studyStats(cards, T0);
    expect(st).toMatchObject({ total: 3, fresh: 1, learning: 1, mature: 1 });
    expect(st.due).toBeGreaterThanOrEqual(2); // the two with dueAt ≤ now
  });
});

describe('study — validateFlashcards (robust + secure)', () => {
  it('accepts front/back and common aliases, stamps a fresh schedule', () => {
    const cards = validateFlashcards([
      { front: 'What pumps blood?', back: 'The heart' },
      { question: 'How many chambers?', answer: 'Four' },
      { q: 'Term', a: 'Definition' },
    ], T0);
    expect(cards).toHaveLength(3);
    expect(cards[0]).toMatchObject({ front: 'What pumps blood?', back: 'The heart' });
    expect(cards[1]!.front).toBe('How many chambers?');
    expect(cards.every((c) => c.schedule.dueAt === T0 && c.schedule.repetitions === 0)).toBe(true);
  });
  it('trims, drops empties, de-duplicates by front', () => {
    const cards = validateFlashcards([
      { front: '  A  ', back: ' x ' }, { front: 'A', back: 'y' }, { front: '', back: 'z' }, { front: 'B', back: '' },
    ], T0);
    expect(cards.map((c) => c.front)).toEqual(['A']); // dupe + empties dropped; trimmed
    expect(cards[0]!.back).toBe('x');
  });
  it('STRESS/SECURITY: caps count + lengths; never throws on junk', () => {
    expect(validateFlashcards(null)).toEqual([]);
    expect(validateFlashcards('cards')).toEqual([]);
    expect(validateFlashcards([1, 'x', null, {}, { front: 5, back: 6 }])).toEqual([]);
    const huge = Array.from({ length: 500 }, (_, i) => ({ front: `F${i} ${'x'.repeat(2000)}`, back: 'y'.repeat(9000) }));
    const v = validateFlashcards(huge, T0);
    expect(v.length).toBeLessThanOrEqual(200);
    expect(v[0]!.front.length).toBeLessThanOrEqual(400);
    expect(v[0]!.back.length).toBeLessThanOrEqual(2000);
  });
});
