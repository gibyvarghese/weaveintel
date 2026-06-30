// SPDX-License-Identifier: MIT
/**
 * @weaveintel/notes — SCHEDULED / TRIGGERED WORKSPACE AGENTS (weaveNotes Phase 3).
 *
 * A scheduled agent is a recurring, multi-step AI task over your OWN notes — "every weekday at 8am,
 * summarise the notes I touched yesterday into a digest", "weekly, suggest wiki-links between related
 * notes", "flag notes I haven't opened in 60 days". The 2026 norm (Notion AI agents, OpenAI scheduled
 * tasks, LangGraph/Claude HITL) is: run unattended, but for anything that WRITES, stage the result as
 * a reviewable suggestion the human approves — never silently overwrite — and run inside a hard BUDGET
 * (max steps + max tokens) so an autonomous loop can't run away.
 *
 * This module is the pure core: the typed config + validator, the built-in task RECIPES, the run
 * BUDGET model, and a small timezone-aware CRON evaluator (next-run + match). The heavy lifting — the
 * actual LLM steps, reading the user's notes, and staging suggestions — lives in the app, reusing the
 * existing weaveNotes editor agent + the track-changes suggestion system. Pure + zero-dependency.
 */

/** The built-in task recipes (each a useful, bounded multi-step note task). `custom` = free-form prompt. */
export type ScheduleRecipe = 'daily_digest' | 'link_suggester' | 'action_items' | 'stale_flagger' | 'custom';
export const SCHEDULE_RECIPES: readonly ScheduleRecipe[] = ['daily_digest', 'link_suggester', 'action_items', 'stale_flagger', 'custom'];

/** How the agent fires: on a clock (cron) or only when run by hand / a tool. */
export type ScheduleTriggerType = 'schedule' | 'manual';

/** Which notes the agent looks at. */
export type ScheduleScope = 'recent' | 'all' | 'tag';

export interface ScheduledAgentConfig {
  /** A human label, e.g. "Morning digest". */
  name: string;
  /** Which built-in task (or `custom`). */
  recipe: ScheduleRecipe;
  /** Free-form extra instruction (required for `custom`; optional flavour for the others). */
  taskPrompt: string;
  /** Clock-triggered or manual-only. */
  triggerType: ScheduleTriggerType;
  /** Standard 5-field cron (minute hour day-of-month month day-of-week), evaluated in `timezone`. */
  cron: string;
  /** IANA timezone the cron is read in (e.g. "America/New_York"). Defaults to UTC. */
  timezone: string;
  /** Which notes to consider. */
  scope: ScheduleScope;
  /** When scope = 'tag', the tag/word to match. */
  scopeTag: string;
  /** For recent-scope / digests: how many days back to look. */
  lookbackDays: number;
  /** Hard cap on how many notes the run will scan (cost control). */
  maxNotes: number;
  /** Hard per-run TOKEN budget — the run stops gracefully when this is reached. */
  tokenBudget: number;
  /** Hard per-run STEP budget (tool calls / LLM steps) — anti-runaway. */
  maxSteps: number;
  /** Stage all writes as pending suggestions for human approval (overnight-safe). */
  requireApproval: boolean;
  /** Paused agents keep their definition but never fire. */
  enabled: boolean;
}

export interface RecipeInfo { id: ScheduleRecipe; label: string; description: string; defaultPrompt: string; writes: string }
/** The catalog the UI/admin shows + the runner reads for default behaviour. */
export const RECIPE_CATALOG: readonly RecipeInfo[] = [
  { id: 'daily_digest', label: 'Daily digest', description: 'Summarise the notes you touched recently into one digest note.', defaultPrompt: 'Write a concise digest of what changed across these notes, grouped by theme, with the key points and any open questions.', writes: 'Creates a new digest note' },
  { id: 'link_suggester', label: 'Link suggester', description: 'Find related notes and suggest wiki-links between them.', defaultPrompt: 'For each note, name the 1–3 most related other notes and the phrase that should link to them.', writes: 'Suggests [[wiki-links]] as edits' },
  { id: 'action_items', label: 'Action-item extractor', description: 'Pull action items / to-dos out of recent notes into one list.', defaultPrompt: 'Extract every concrete action item or to-do, with who/when if stated, as a checklist.', writes: 'Creates an action-items note' },
  { id: 'stale_flagger', label: 'Stale-note flagger', description: 'List notes you have not updated in a while so nothing rots.', defaultPrompt: 'List the notes that look stale and, for each, one sentence on what to do with it.', writes: 'Creates a "needs attention" note' },
  { id: 'custom', label: 'Custom task', description: 'Your own instruction, run over the chosen notes.', defaultPrompt: '', writes: 'Per your instruction (staged for approval)' },
];

export function recipeInfo(r: ScheduleRecipe): RecipeInfo { return RECIPE_CATALOG.find((x) => x.id === r) ?? RECIPE_CATALOG[RECIPE_CATALOG.length - 1]!; }

export const DEFAULT_SCHEDULED_AGENT: ScheduledAgentConfig = {
  name: 'Scheduled task', recipe: 'daily_digest', taskPrompt: '', triggerType: 'schedule',
  cron: '0 8 * * *', timezone: 'UTC', scope: 'recent', scopeTag: '', lookbackDays: 1,
  maxNotes: 25, tokenBudget: 8000, maxSteps: 8, requireApproval: true, enabled: true,
};

const MIN_TOKEN_BUDGET = 500, MAX_TOKEN_BUDGET = 200_000;
const MIN_STEPS = 1, MAX_STEPS = 30;

function asBool(v: unknown, f: boolean): boolean { if (typeof v === 'boolean') return v; if (v === 1 || v === '1' || v === 'true') return true; if (v === 0 || v === '0' || v === 'false') return false; return f; }
function clampInt(v: unknown, lo: number, hi: number, f: number): number { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : f; }

/** Validate + normalise a (partial) scheduled-agent config. Rejects unknown enums + a clearly-invalid cron. */
export function validateScheduledAgent(partial: Partial<Record<keyof ScheduledAgentConfig, unknown>>, base: ScheduledAgentConfig = DEFAULT_SCHEDULED_AGENT): { config: ScheduledAgentConfig; warnings: string[] } {
  const p = partial ?? {}; const warnings: string[] = [];
  const recipe = SCHEDULE_RECIPES.includes(p.recipe as ScheduleRecipe) ? p.recipe as ScheduleRecipe : (p.recipe === undefined ? base.recipe : (warnings.push(`Unknown recipe "${String(p.recipe)}".`), base.recipe));
  const triggerType = p.triggerType === 'manual' || p.triggerType === 'schedule' ? p.triggerType : base.triggerType;
  const scope = (['recent', 'all', 'tag'] as const).includes(p.scope as ScheduleScope) ? p.scope as ScheduleScope : (p.scope === undefined ? base.scope : (warnings.push(`Unknown scope "${String(p.scope)}".`), base.scope));
  let cron = typeof p.cron === 'string' && p.cron.trim() ? p.cron.trim() : base.cron;
  if (triggerType === 'schedule' && !isValidCron(cron)) { warnings.push(`Invalid cron "${cron}" — kept previous.`); cron = isValidCron(base.cron) ? base.cron : '0 8 * * *'; }
  const name = String(p.name ?? base.name).trim().slice(0, 120) || 'Scheduled task';
  const taskPrompt = String(p.taskPrompt ?? base.taskPrompt).slice(0, 4000);
  if (recipe === 'custom' && !taskPrompt.trim()) warnings.push('A custom task needs an instruction (taskPrompt).');
  return {
    config: {
      name, recipe, taskPrompt, triggerType, cron,
      timezone: isValidTimezone(p.timezone) ? String(p.timezone) : (p.timezone === undefined ? base.timezone : (warnings.push(`Unknown timezone "${String(p.timezone)}" — using UTC.`), 'UTC')),
      scope, scopeTag: String(p.scopeTag ?? base.scopeTag).trim().slice(0, 80),
      lookbackDays: clampInt(p.lookbackDays ?? base.lookbackDays, 1, 365, base.lookbackDays),
      maxNotes: clampInt(p.maxNotes ?? base.maxNotes, 1, 200, base.maxNotes),
      tokenBudget: clampInt(p.tokenBudget ?? base.tokenBudget, MIN_TOKEN_BUDGET, MAX_TOKEN_BUDGET, base.tokenBudget),
      maxSteps: clampInt(p.maxSteps ?? base.maxSteps, MIN_STEPS, MAX_STEPS, base.maxSteps),
      requireApproval: asBool(p.requireApproval ?? base.requireApproval, base.requireApproval),
      enabled: asBool(p.enabled ?? base.enabled, base.enabled),
    },
    warnings,
  };
}

// ─── Run budget (anti-runaway) ──────────────────────────────────────────────

export interface RunBudget { tokenBudget: number; maxSteps: number; tokensUsed: number; steps: number }
export function newRunBudget(cfg: Pick<ScheduledAgentConfig, 'tokenBudget' | 'maxSteps'>): RunBudget { return { tokenBudget: cfg.tokenBudget, maxSteps: cfg.maxSteps, tokensUsed: 0, steps: 0 }; }
/** Charge a step's token use; returns the budget for chaining. */
export function chargeBudget(b: RunBudget, tokens: number): RunBudget { b.tokensUsed += Math.max(0, Math.trunc(tokens) || 0); b.steps += 1; return b; }
/** Has the run hit its token or step ceiling? (Check BEFORE doing the next step.) */
export function budgetExhausted(b: RunBudget): boolean { return b.tokensUsed >= b.tokenBudget || b.steps >= b.maxSteps; }
/** Remaining token headroom (never negative). */
export function budgetRemaining(b: RunBudget): number { return Math.max(0, b.tokenBudget - b.tokensUsed); }

// ─── Minimal timezone-aware CRON (5-field) ──────────────────────────────────
// Supports: '*', lists 'a,b', ranges 'a-b', steps '*/n' and 'a-b/n', and 3-letter month/day names.
// Evaluated against WALL-CLOCK time in the agent's IANA timezone (via Intl, so DST is handled).

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
