// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { bandFor, needsReview, type UpgradePriority } from './priority.js';

const BANDS: Readonly<Record<string, UpgradePriority>> = { guardrails: 'P1', skills: 'P2', pricing: 'P5' };

describe('@weaveintel/upgrade — priority banding', () => {
  it('POSITIVE: maps a family to its injected band', () => {
    expect(bandFor('guardrails', 'stale', BANDS)).toBe('P1');
    expect(bandFor('skills', 'diverged', BANDS)).toBe('P2');
    expect(bandFor('pricing', 'stale', BANDS)).toBe('P5');
  });

  it('a collision/conflict is always the top band regardless of family', () => {
    expect(bandFor('pricing', 'collision', BANDS)).toBe('P1');
    expect(bandFor('pricing', 'conflict', BANDS)).toBe('P1');
    // configurable conflict band
    expect(bandFor('pricing', 'conflict', BANDS, { conflictBand: 'P2' })).toBe('P2');
  });

  it('NEGATIVE: an unknown family falls back to the default band', () => {
    expect(bandFor('mystery', 'stale', BANDS)).toBe('P3');
    expect(bandFor('mystery', 'stale', BANDS, { defaultBand: 'P4' })).toBe('P4');
  });

  it('SECURITY: a family from untrusted input cannot resolve a prototype key', () => {
    // 'constructor' / 'toString' exist on Object.prototype; an own-property lookup must NOT return them.
    expect(bandFor('constructor', 'stale', BANDS)).toBe('P3');
    expect(bandFor('toString', 'stale', BANDS)).toBe('P3');
    expect(bandFor('__proto__', 'stale', BANDS)).toBe('P3');
  });

  it('needsReview flags only human-actionable dispositions', () => {
    for (const d of ['customized', 'diverged', 'conflict', 'collision', 'removed', 'deferred'] as const) {
      expect(needsReview(d), d).toBe(true);
    }
    for (const d of ['in_sync', 'stale', 'new', 'adopted', 'published', 'auto_merged'] as const) {
      expect(needsReview(d), d).toBe(false);
    }
  });
});
