/**
 * Tests — streaming announcements (stream-announce.ts). Positive / negative / stress / security.
 */
import { describe, it, expect } from 'vitest';
import {
  computeAppendedText, lastSentenceBoundary, nextStreamAnnouncement,
  GENERATING_MESSAGE, STOPPED_MESSAGE, type AnnounceInput,
} from './stream-announce.js';

describe('computeAppendedText', () => {
  it('POSITIVE — returns only the newly-appended tail', () => {
    expect(computeAppendedText('Hello', 'Hello world')).toBe(' world');
  });
  it('reset/divergence — returns the whole new text', () => {
    expect(computeAppendedText('Hello world', 'Bye')).toBe('Bye');
  });
  it('SECURITY/robustness — non-string inputs never throw', () => {
    expect(computeAppendedText(null, undefined)).toBe('');
    expect(computeAppendedText(42 as unknown, 'x')).toBe('x');
    expect(computeAppendedText('a', { toString() { return 'nope'; } } as unknown)).toBe('');
  });
});

describe('lastSentenceBoundary', () => {
  it('finds the index after the last sentence end', () => {
    expect(lastSentenceBoundary('One. Two.')).toBe(9);
    expect(lastSentenceBoundary('One. Two')).toBe(4);   // after "One."
    expect(lastSentenceBoundary('no end yet')).toBe(0);
    expect(lastSentenceBoundary('line one\nline two')).toBe(9); // newline counts
  });
});

const base = (over: Partial<AnnounceInput>): AnnounceInput => ({
  phase: 'delta', fullText: '', lastAnnouncedLen: 0, mode: 'summary', nowMs: 10_000, lastAnnounceAtMs: 0, ...over,
});

describe('nextStreamAnnouncement — summary mode (default)', () => {
  it('start → "Generating response…"', () => {
    const r = nextStreamAnnouncement(base({ phase: 'start' }));
    expect(r.text).toBe(GENERATING_MESSAGE);
    expect(r.announcedLen).toBe(0);
  });
  it('deltas are SILENT in summary mode (no per-token spam)', () => {
    expect(nextStreamAnnouncement(base({ phase: 'delta', fullText: 'partial answer so far' })).text).toBeNull();
  });
  it('done → announces the FULL answer once', () => {
    const r = nextStreamAnnouncement(base({ phase: 'done', fullText: 'The whole answer.', lastAnnouncedLen: 0 }));
    expect(r.text).toBe('The whole answer.');
    expect(r.announcedLen).toBe('The whole answer.'.length);
  });
});

describe('nextStreamAnnouncement — off mode', () => {
  it('announces nothing in any phase', () => {
    for (const phase of ['start', 'delta', 'done', 'stopped'] as const) {
      expect(nextStreamAnnouncement(base({ phase, mode: 'off', fullText: 'anything' })).text).toBeNull();
    }
  });
});

describe('nextStreamAnnouncement — live mode', () => {
  it('throttles: within the min interval → nothing', () => {
    const r = nextStreamAnnouncement(base({ phase: 'delta', mode: 'live', fullText: 'A sentence. ', nowMs: 500, lastAnnounceAtMs: 0, minIntervalMs: 1200 }));
    expect(r.text).toBeNull();
  });
  it('after the interval, announces up to the last COMPLETE sentence (never mid-word)', () => {
    const r = nextStreamAnnouncement(base({ phase: 'delta', mode: 'live', fullText: 'First done. Second half', lastAnnouncedLen: 0, nowMs: 2000, lastAnnounceAtMs: 0 }));
    expect(r.text).toBe('First done.');            // "Second half" (incomplete) withheld
    expect(r.announcedLen).toBe('First done.'.length);
  });
  it('no complete sentence yet → nothing, even past the interval', () => {
    const r = nextStreamAnnouncement(base({ phase: 'delta', mode: 'live', fullText: 'still going', nowMs: 5000, lastAnnounceAtMs: 0 }));
    expect(r.text).toBeNull();
  });
  it('done announces only the remaining tail (not re-reading what live already said)', () => {
    const r = nextStreamAnnouncement(base({ phase: 'done', mode: 'live', fullText: 'First done. Second done.', lastAnnouncedLen: 'First done.'.length }));
    expect(r.text).toBe('Second done.');
  });
});

describe('nextStreamAnnouncement — stopped', () => {
  it('announces the stopped notice', () => {
    expect(nextStreamAnnouncement(base({ phase: 'stopped', fullText: 'partial' })).text).toBe(STOPPED_MESSAGE);
  });
});

describe('robustness + stress', () => {
  it('SECURITY — a non-string fullText / out-of-range pointer never throws', () => {
    const r = nextStreamAnnouncement(base({ phase: 'done', fullText: 12345 as unknown, lastAnnouncedLen: 999 }));
    expect(r.text).toBeNull();
  });
  it('a lastAnnouncedLen past the end is clamped (no negative slice)', () => {
    const r = nextStreamAnnouncement(base({ phase: 'done', fullText: 'short', lastAnnouncedLen: 9999 }));
    expect(r.text).toBeNull();
    expect(r.announcedLen).toBe('short'.length);
  });
  it('STRESS — a 200k-char answer resolves fast', () => {
    const big = 'sentence. '.repeat(20_000); // 200k chars
    const t = Date.now();
    const r = nextStreamAnnouncement(base({ phase: 'done', fullText: big, lastAnnouncedLen: 0 }));
    expect(Date.now() - t).toBeLessThan(300);
    expect((r.text ?? '').length).toBeGreaterThan(100_000);
  });
});
