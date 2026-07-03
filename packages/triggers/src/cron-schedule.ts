// SPDX-License-Identifier: MIT
/**
 * @weaveintel/triggers — a small, correct, timezone-aware CRON evaluator (5-field).
 *
 * --- For someone new to this ---
 * A "cron expression" like `30 8 * * 1-5` means "at 08:30, Monday–Friday". This module answers two
 * questions about one, with no dependencies:
 *   • `cronMatches(expr, whenMs, tz)` — does this exact minute match the schedule?
 *   • `cronNextRun(expr, fromMs, tz)` — when does it next fire (strictly after `fromMs`)?
 *
 * Supports `*`, lists `a,b`, ranges `a-b`, steps `*​/n` and `a-b/n`, and 3-letter month/day names.
 * Times are evaluated against WALL-CLOCK time in an IANA timezone via `Intl` — so daylight-saving
 * transitions are handled correctly (08:30 local stays 08:30 across a DST change).
 *
 * Day-of-month vs day-of-week follows the standard Vixie/POSIX rule: when BOTH are restricted (neither
 * is `*`), a day matches if EITHER matches (union); otherwise both must match (intersection). This is
 * the long-standing, dominant cron behaviour (Vixie/ISC cron).
 */

const DOW_NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MON_NAMES: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function parseField(field: string, min: number, max: number, names: Record<string, number> = {}): Set<number> | null {
  const out = new Set<number>();
  for (const partRaw of field.split(',')) {
    const part = partRaw.trim().toLowerCase();
    if (!part) return null;
    let step = 1; let range = part;
    const slash = part.split('/');
    if (slash.length === 2) { step = parseInt(slash[1]!, 10); range = slash[0]!; if (!Number.isInteger(step) || step < 1) return null; }
    let lo = min, hi = max;
    if (range === '*') { /* full range */ }
    else if (range.includes('-')) {
      const [a, b] = range.split('-');
      lo = names[a!] ?? parseInt(a!, 10); hi = names[b!] ?? parseInt(b!, 10);
    } else {
      lo = hi = names[range] ?? parseInt(range, 10);
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size ? out : null;
}

interface CronSpec { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number> }
function parseCron(cron: string): CronSpec | null {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const minute = parseField(f[0]!, 0, 59);
  const hour = parseField(f[1]!, 0, 23);
  const dom = parseField(f[2]!, 1, 31);
  const month = parseField(f[3]!, 1, 12, MON_NAMES);
  const dow = parseField(f[4]!, 0, 7, DOW_NAMES); // allow 7=Sunday
  if (!minute || !hour || !dom || !month || !dow) return null;
  if (dow.has(7)) dow.add(0);
  return { minute, hour, dom, month, dow };
}

/** Is a cron string parseable? */
export function isValidCron(cron: string): boolean { return parseCron(cron) !== null; }

/** Is a string a usable IANA timezone? */
export function isValidTimezone(tz: unknown): boolean {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** The wall-clock fields (minute/hour/day/month/dow) of an instant, read in a timezone. */
function wallClock(ms: number, timezone: string): { minute: number; hour: number; dom: number; month: number; dow: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour12: false, minute: '2-digit', hour: '2-digit', day: '2-digit', month: '2-digit', weekday: 'short' }).formatToParts(new Date(ms));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '0';
  const hour = parseInt(get('hour'), 10) % 24; // Intl may render 24 for midnight
  return { minute: parseInt(get('minute'), 10), hour, dom: parseInt(get('day'), 10), month: parseInt(get('month'), 10), dow: DOW_NAMES[get('weekday').toLowerCase()] ?? 0 };
}

/** Does the instant `ms` match the cron, read in `timezone`? (Standard Vixie cron OR-semantics on dom/dow.) */
export function cronMatches(cron: string, ms: number, timezone = 'UTC'): boolean {
  const spec = parseCron(cron); if (!spec) return false;
  const w = wallClock(ms, timezone);
  // Vixie cron: when BOTH dom and dow are restricted, match if EITHER matches; else AND.
  const domRestricted = !(spec.dom.size === 31); const dowRestricted = !(spec.dow.size >= 7);
  const dayOk = domRestricted && dowRestricted ? (spec.dom.has(w.dom) || spec.dow.has(w.dow)) : (spec.dom.has(w.dom) && spec.dow.has(w.dow));
  return spec.minute.has(w.minute) && spec.hour.has(w.hour) && spec.month.has(w.month) && dayOk;
}

/**
 * The next instant (epoch-ms, aligned to the minute) at or after `fromMs` that matches the cron in
 * `timezone`. Returns null if nothing matches within ~13 months (e.g. an impossible Feb-31). Strictly
 * after `fromMs` minute (so a just-fired job doesn't immediately re-fire).
 */
export function cronNextRun(cron: string, fromMs: number, timezone = 'UTC'): number | null {
  if (!isValidCron(cron)) return null;
  // Start at the next whole minute after fromMs.
  let t = Math.ceil((fromMs + 1) / 60000) * 60000;
  const limit = fromMs + 400 * 24 * 60 * 60 * 1000;
  while (t <= limit) {
    if (cronMatches(cron, t, timezone)) return t;
    t += 60000;
  }
  return null;
}
