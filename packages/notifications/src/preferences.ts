/**
 * Preference-based suppression: quiet hours and digests from preference rows (GAPS G-WI-16).
 *
 * --- For someone new to this ---
 * Whether a person gets a notification on a channel right now is decided by layers of rows:
 *
 *   org  → role → user   (each later layer overrides the one before it)
 *   policy               (set by an administrator; overrides everything and cannot be overridden)
 *
 * A row can match one type (`itsm.change.cab_scheduled`), a family (`itsm.change.*`), or every
 * type (`*`), and one channel or every channel. Within a layer the most specific row wins. A typed
 * notification starts on for the type's default channels only.
 * From the merged result the policy decides one of:
 *
 *   - `deliver` — send now;
 *   - `digest`  — hold it for the next digest (only for types marked `digestable`);
 *   - `suppress` — don't send on this channel.
 *
 * Quiet hours suppress (or, for digestable types, hold) anything that isn't a `breakthrough`
 * type such as a P1 page. If the preference rows cannot be read, the dispatcher treats the error
 * as "suppress" — it fails closed.
 */

import type { ExecutionContext } from '@weaveintel/core';
import type { SuppressionContext, SuppressionDecision, SuppressionPolicy } from './dispatcher.js';
import type { NotificationTypeRegistry } from './type-registry.js';

/** One preference row, as the host stores it. */
export interface NotificationPreference {
  readonly level: 'org' | 'role' | 'user' | 'policy';
  /** Exact type key, a `prefix.*` family, or `*`. Default `*`. */
  readonly typeKey?: string;
  /** Exact channel id or `*`. Default `*`. */
  readonly channelId?: string;
  /** `false` turns the type off on the channel. */
  readonly enabled?: boolean;
  /** `digest` holds digestable types for the next digest. */
  readonly delivery?: 'immediate' | 'digest';
  readonly quietHours?: QuietHours;
}

/** A daily window in a time zone, e.g. 22:00–07:00 Pacific/Auckland. It may cross midnight. */
export interface QuietHours {
  /** `HH:MM`, 24-hour. */
  readonly start: string;
  /** `HH:MM`, 24-hour. Equal to `start` means no quiet hours. */
  readonly end: string;
  /** IANA time zone, e.g. `Pacific/Auckland`. */
  readonly timeZone: string;
  /** Days the window starts on (0 = Sunday). Default every day. */
  readonly days?: readonly number[];
}

/** What the policy needs to look up a person's rows. */
export interface PreferenceQuery {
  readonly tenantId: string;
  readonly principalId: string;
  readonly channelId: string;
  /** Absent for a notification that carries no type key. */
  readonly typeKey?: string;
}

/** Returns every row that could apply (all levels); the policy does the matching and merging. */
export type PreferenceResolver = (ctx: ExecutionContext, query: PreferenceQuery) => Promise<readonly NotificationPreference[]>;

export interface PreferenceSuppressionOptions {
  readonly resolvePrefs: PreferenceResolver;
  /** Supplies `digestable` and `breakthrough` for typed notifications. */
  readonly types?: NotificationTypeRegistry;
  /** Clock, for tests. */
  readonly now?: () => Date;
}

/** The merged view of a person's preferences for one type on one channel. */
export interface EffectivePreference {
  readonly enabled: boolean;
  readonly delivery: 'immediate' | 'digest';
  readonly quietHours?: QuietHours;
  /** Which layer set each field, for "why didn't I get this?" in the settings UI. */
  readonly source: { readonly enabled?: string; readonly delivery?: string; readonly quietHours?: string };
}

const LEVEL_ORDER: Record<NotificationPreference['level'], number> = { org: 0, role: 1, user: 2, policy: 3 };
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** How specifically a row's type pattern matches a key: -1 no match, 0 `*`, 1+ family depth, 1000 exact. */
function typeScore(pattern: string | undefined, key: string | undefined): number {
  const p = pattern ?? '*';
  if (p === '*') return 0;
  if (key === undefined) return -1;
  if (p === key) return 1000;
  if (p.endsWith('.*')) {
    const prefix = p.slice(0, -1); // keep the dot
    return key.startsWith(prefix) ? prefix.split('.').length : -1;
  }
  return -1;
}

function channelScore(pattern: string | undefined, channelId: string): number {
  const p = pattern ?? '*';
  if (p === '*') return 0;
  return p === channelId ? 1 : -1;
}

/**
 * Merge rows into one effective preference: within a level the most specific row wins; a later
 * level overrides an earlier one field by field; `policy` rows win over everything.
 */
export function resolveEffectivePreference(
  rows: readonly NotificationPreference[],
  query: Pick<PreferenceQuery, 'channelId' | 'typeKey'>,
  /** Whether the channel is on before any row applies (a type's default channels are). */
  defaultEnabled = true,
): EffectivePreference {
  const matching = rows
    .map((r) => ({ r, t: typeScore(r.typeKey, query.typeKey), c: channelScore(r.channelId, query.channelId) }))
    .filter((m) => m.t >= 0 && m.c >= 0)
    // Apply least important first so later assignments win: by level, then specificity.
    .sort((a, b) => LEVEL_ORDER[a.r.level] - LEVEL_ORDER[b.r.level] || a.t - b.t || a.c - b.c);
  let enabled = defaultEnabled;
  let delivery: 'immediate' | 'digest' = 'immediate';
  let quietHours: QuietHours | undefined;
  const source: { enabled?: string; delivery?: string; quietHours?: string } = {};
  for (const { r } of matching) {
    if (r.enabled !== undefined) { enabled = r.enabled; source.enabled = r.level; }
    if (r.delivery !== undefined) { delivery = r.delivery; source.delivery = r.level; }
    if (r.quietHours !== undefined) { quietHours = r.quietHours; source.quietHours = r.level; }
  }
  return { enabled, delivery, ...(quietHours ? { quietHours } : {}), source };
}

function minutesOf(hhmm: string): number {
  const m = HHMM.exec(hhmm);
  if (!m) throw new Error(`quiet hours time must be HH:MM, got ${JSON.stringify(hhmm)}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Is `at` inside the quiet-hours window, in the window's own time zone? */
export function inQuietHours(q: QuietHours, at: Date): boolean {
  const start = minutesOf(q.start);
  const end = minutesOf(q.end);
  if (start === end) return false;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: q.timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const minute = Number(get('hour')) * 60 + Number(get('minute'));
  const day = WEEKDAYS[get('weekday')] ?? 0;
  const days = q.days && q.days.length > 0 ? new Set(q.days) : undefined;
  if (start < end) return minute >= start && minute < end && (!days || days.has(day));
  // Crosses midnight: the evening part belongs to today, the morning part to yesterday's window.
  if (minute >= start) return !days || days.has(day);
  if (minute < end) return !days || days.has((day + 6) % 7);
  return false;
}

/**
 * A `SuppressionPolicy` driven by preference rows. Its `decide` returns `deliver`, `digest` or
 * `suppress` with a reason; `shouldSuppress` is true for anything but `deliver`.
 */
export function preferenceSuppression(opts: PreferenceSuppressionOptions): SuppressionPolicy & {
  decide(ctx: ExecutionContext, sctx: SuppressionContext): Promise<SuppressionDecision>;
} {
  const now = opts.now ?? (() => new Date());
  async function decide(ctx: ExecutionContext, sctx: SuppressionContext): Promise<SuppressionDecision> {
    const typeKey = sctx.typeKey;
    const def = typeKey ? opts.types?.get(typeKey) : undefined;
    if (typeKey && opts.types && !def) return { action: 'suppress', reason: 'unknown_type' };
    const rows = await opts.resolvePrefs(ctx, {
      tenantId: sctx.tenantId,
      principalId: sctx.principalId,
      channelId: sctx.channelId,
      ...(typeKey ? { typeKey } : {}),
    });
    // A typed notification starts on only for the type's default channels; a row can opt a
    // person in to another channel or out of a default one.
    const defaultEnabled = def ? def.channels.includes(sctx.channelId) : true;
    const pref = resolveEffectivePreference(rows, { channelId: sctx.channelId, ...(typeKey ? { typeKey } : {}) }, defaultEnabled);
    if (!pref.enabled) return { action: 'suppress', reason: 'disabled' };
    const breakthrough = def?.breakthrough === true;
    const digestable = def?.digestable === true;
    if (breakthrough) return { action: 'deliver' };
    if (pref.quietHours && inQuietHours(pref.quietHours, now())) {
      return digestable ? { action: 'digest', reason: 'quiet_hours' } : { action: 'suppress', reason: 'quiet_hours' };
    }
    if (pref.delivery === 'digest' && digestable) return { action: 'digest', reason: 'digest_preference' };
    return { action: 'deliver' };
  }
  return {
    decide,
    async shouldSuppress(ctx, sctx) {
      return (await decide(ctx, sctx)).action !== 'deliver';
    },
  };
}
