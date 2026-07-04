// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import { isValidCron, isValidTimezone, cronMatches, cronNextRun } from './cron-schedule.js';

describe('cron-schedule — evaluator', () => {
  it('validates well-formed crons + rejects malformed', () => {
    for (const c of ['0 8 * * *', '*/15 * * * *', '0 9 * * MON-FRI', '0 0 1 * *', '30 6,18 * * SUN', '0 9 1-7 * MON']) expect(isValidCron(c)).toBe(true);
    for (const c of ['', '* * *', '60 * * * *', '0 24 * * *', '0 8 * * XYZ', 'abc'] ) expect(isValidCron(c)).toBe(false);
  });
  it('matches a specific instant in UTC', () => {
    // 2026-03-02 is a Monday. 08:00 UTC.
    const monday0800 = Date.UTC(2026, 2, 2, 8, 0, 0);
    expect(cronMatches('0 8 * * *', monday0800, 'UTC')).toBe(true);
    expect(cronMatches('0 8 * * MON', monday0800, 'UTC')).toBe(true);
    expect(cronMatches('0 8 * * TUE', monday0800, 'UTC')).toBe(false);
    expect(cronMatches('0 9 * * *', monday0800, 'UTC')).toBe(false);
    expect(cronMatches('*/15 * * * *', monday0800, 'UTC')).toBe(true); // minute 0 divisible by 15
  });
  it('respects timezone (wall-clock), incl. DST handling via Intl', () => {
    // 13:00 UTC = 08:00 in America/New_York (EST, winter, UTC-5).
    const t = Date.UTC(2026, 0, 5, 13, 0, 0); // 2026-01-05 Monday
    expect(cronMatches('0 8 * * *', t, 'America/New_York')).toBe(true);
    expect(cronMatches('0 8 * * *', t, 'UTC')).toBe(false); // 13:00 in UTC, not 08:00
  });
  it('computes the next run strictly after the given time', () => {
    const from = Date.UTC(2026, 2, 2, 8, 0, 0); // exactly a match
    const next = cronNextRun('0 8 * * *', from, 'UTC')!;
    expect(next).toBe(Date.UTC(2026, 2, 3, 8, 0, 0)); // next day, not the same minute
    // every 30 min → next is :30 of the same hour
    expect(cronNextRun('*/30 * * * *', Date.UTC(2026, 2, 2, 8, 5, 0), 'UTC')).toBe(Date.UTC(2026, 2, 2, 8, 30, 0));
  });
  it('Vixie OR-semantics: dom AND dow both restricted → either matches', () => {
    // '0 0 13 * FRI' fires on the 13th OR any Friday.
    expect(cronMatches('0 0 13 * FRI', Date.UTC(2026, 2, 13, 0, 0), 'UTC')).toBe(true);  // the 13th (a Friday too)
    expect(cronMatches('0 0 13 * FRI', Date.UTC(2026, 2, 6, 0, 0), 'UTC')).toBe(true);   // a Friday (the 6th)
    expect(cronMatches('0 0 13 * FRI', Date.UTC(2026, 2, 10, 0, 0), 'UTC')).toBe(false); // neither
  });
  it('isValidTimezone + cronNextRun robustness', () => {
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('Nowhere/Nope')).toBe(false);
    expect(cronNextRun('bad cron', Date.UTC(2026, 0, 1, 0, 0, 0))).toBeNull();
  });
});
