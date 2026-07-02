// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import {
  validateScheduledAgent, DEFAULT_SCHEDULED_AGENT, SCHEDULE_RECIPES, RECIPE_CATALOG, recipeInfo,
  newRunBudget, chargeBudget, budgetExhausted, budgetRemaining,
  isValidCron, isValidTimezone, cronMatches, cronNextRun,
} from './scheduled-agent.js';

describe('scheduled-agent — config validation', () => {
  it('accepts a valid config', () => {
    const { config, warnings } = validateScheduledAgent({ name: 'Morning digest', recipe: 'daily_digest', cron: '0 8 * * MON-FRI', timezone: 'America/New_York', lookbackDays: 3, tokenBudget: 12000, maxSteps: 6 });
    expect(config.recipe).toBe('daily_digest');
    expect(config.cron).toBe('0 8 * * MON-FRI');
    expect(config.timezone).toBe('America/New_York');
    expect(config.tokenBudget).toBe(12000);
    expect(warnings).toEqual([]);
  });
  it('rejects unknown recipe/scope (keeps base + warns)', () => {
    const r = validateScheduledAgent({ recipe: 'mine' as never, scope: 'galaxy' as never });
    expect(r.config.recipe).toBe(DEFAULT_SCHEDULED_AGENT.recipe);
    expect(r.config.scope).toBe(DEFAULT_SCHEDULED_AGENT.scope);
    expect(r.warnings.length).toBe(2);
  });
  it('rejects an invalid cron + bad timezone with warnings', () => {
    const r = validateScheduledAgent({ cron: 'not a cron', timezone: 'Mars/Phobos' });
    expect(r.config.cron).toBe(DEFAULT_SCHEDULED_AGENT.cron); // kept the valid base
    expect(r.config.timezone).toBe('UTC');
    expect(r.warnings.join(' ')).toMatch(/cron/i);
    expect(r.warnings.join(' ')).toMatch(/timezone/i);
  });
  it('clamps budgets/steps/lookback/maxNotes', () => {
    const c = validateScheduledAgent({ tokenBudget: 99999999, maxSteps: 999, lookbackDays: 0, maxNotes: 99999 }).config;
    expect(c.tokenBudget).toBe(200_000);
    expect(c.maxSteps).toBe(30);
    expect(c.lookbackDays).toBe(1);
    expect(c.maxNotes).toBe(200);
  });
  it('warns when a custom task has no instruction; never throws on junk', () => {
    expect(validateScheduledAgent({ recipe: 'custom', taskPrompt: '' }).warnings.join(' ')).toMatch(/custom/i);
    expect(() => validateScheduledAgent({ tokenBudget: 'x' as never, maxSteps: null as never })).not.toThrow();
    expect(SCHEDULE_RECIPES).toContain('daily_digest');
    expect(RECIPE_CATALOG.length).toBe(SCHEDULE_RECIPES.length);
    expect(recipeInfo('link_suggester').writes).toMatch(/link/i);
  });
});

describe('scheduled-agent — run budget (anti-runaway)', () => {
  it('charges tokens + steps and reports exhaustion on EITHER ceiling', () => {
    const b = newRunBudget({ tokenBudget: 1000, maxSteps: 3 });
    expect(budgetExhausted(b)).toBe(false);
    chargeBudget(b, 400); expect(budgetRemaining(b)).toBe(600); expect(budgetExhausted(b)).toBe(false);
    chargeBudget(b, 700); expect(budgetExhausted(b)).toBe(true); // tokens 1100 ≥ 1000
  });
  it('exhausts on the step ceiling even under token budget', () => {
    const b = newRunBudget({ tokenBudget: 100000, maxSteps: 2 });
    chargeBudget(b, 1); chargeBudget(b, 1);
    expect(budgetExhausted(b)).toBe(true); // 2 steps ≥ 2
  });
  it('tolerates negative/NaN token charges', () => {
    const b = newRunBudget({ tokenBudget: 1000, maxSteps: 5 });
    chargeBudget(b, -50); chargeBudget(b, NaN);
    expect(b.tokensUsed).toBe(0); expect(b.steps).toBe(2);
  });
});

describe('scheduled-agent — cron evaluator', () => {
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
    expect(cronNextRun('bad cron', Date.now())).toBeNull();
  });
});
