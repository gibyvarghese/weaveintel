// Regression test for the CodeQL js/polynomial-redos fix: base URLs lose their
// trailing slashes as /\/+$/ did, without the quadratic backtracking.
import { describe, expect, it } from 'vitest';
import { trimTrailingSlashes } from './wire.js';

describe('trimTrailingSlashes', () => {
  it('trims like /\/+$/', () => {
    expect(trimTrailingSlashes('https://api.example.com/v1/')).toBe('https://api.example.com/v1');
    expect(trimTrailingSlashes('https://api.example.com/v1///')).toBe('https://api.example.com/v1');
    expect(trimTrailingSlashes('https://api.example.com/v1')).toBe('https://api.example.com/v1');
    expect(trimTrailingSlashes('')).toBe('');
  });

  it('is fast on a long run of slashes that is not at the end', () => {
    const evil = `https://x${'/'.repeat(100_000)}y`;
    const t0 = performance.now();
    expect(trimTrailingSlashes(evil)).toBe(evil);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});
