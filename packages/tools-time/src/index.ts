/**
 * @weaveintel/tools-time — Time and timezone helpers
 */

import type { ExecutionContext, Tool } from '@weaveintel/core';
import { weaveTool } from '@weaveintel/core';

export interface TimeFormatOptions {
  format?: 'iso' | 'unix' | 'human' | 'date' | 'time' | 'weekday';
  timezone?: string;
  locale?: string;
  now?: Date;
}

export interface TimezoneSnapshot {
  timezone: string;
  nowIso: string;
  date: string;
  time: string;
  human: string;
}

type RuntimeState = 'running' | 'paused' | 'stopped';

export interface TimerRecord {
  id: string;
  label?: string;
  durationMs?: number;
  state: RuntimeState;
  createdAt: string;
  startedAt?: string;
  pausedAt?: string;
  resumedAt?: string;
  stoppedAt?: string;
  elapsedMs: number;
}

export interface StopwatchRecord {
  id: string;
  label?: string;
  state: RuntimeState;
  createdAt: string;
  startedAt?: string;
  pausedAt?: string;
  resumedAt?: string;
  stoppedAt?: string;
  elapsedMs: number;
  laps: number[];
}

export interface ReminderRecord {
  id: string;
  text: string;
  dueAt: string;
  timezone: string;
  status: 'scheduled' | 'cancelled';
  createdAt: string;
  cancelledAt?: string;
}

export interface TemporalStore {
  saveTimer(scope: string, timer: TimerRecord): Promise<void> | void;
  getTimer(scope: string, timerId: string): Promise<TimerRecord | null> | TimerRecord | null;
  listTimers(scope: string): Promise<TimerRecord[]> | TimerRecord[];
  saveStopwatch(scope: string, watch: StopwatchRecord): Promise<void> | void;
  getStopwatch(scope: string, watchId: string): Promise<StopwatchRecord | null> | StopwatchRecord | null;
  listStopwatches(scope: string): Promise<StopwatchRecord[]> | StopwatchRecord[];
  saveReminder(scope: string, reminder: ReminderRecord): Promise<void> | void;
  getReminder(scope: string, reminderId: string): Promise<ReminderRecord | null> | ReminderRecord | null;
  listReminders(scope: string): Promise<ReminderRecord[]> | ReminderRecord[];
}

export function createInMemoryTemporalStore(): TemporalStore {
  const timers = new Map<string, Map<string, TimerRecord>>();
  const stopwatches = new Map<string, Map<string, StopwatchRecord>>();
  const reminders = new Map<string, Map<string, ReminderRecord>>();

  function getScopedMap<T>(root: Map<string, Map<string, T>>, scope: string): Map<string, T> {
    let scoped = root.get(scope);
    if (!scoped) {
      scoped = new Map<string, T>();
      root.set(scope, scoped);
    }
    return scoped;
  }

  return {
    saveTimer(scope, timer) {
      getScopedMap(timers, scope).set(timer.id, timer);
    },
    getTimer(scope, timerId) {
      return getScopedMap(timers, scope).get(timerId) ?? null;
    },
    listTimers(scope) {
      return [...getScopedMap(timers, scope).values()];
    },
    saveStopwatch(scope, watch) {
      getScopedMap(stopwatches, scope).set(watch.id, watch);
    },
    getStopwatch(scope, watchId) {
      return getScopedMap(stopwatches, scope).get(watchId) ?? null;
    },
    listStopwatches(scope) {
      return [...getScopedMap(stopwatches, scope).values()];
    },
    saveReminder(scope, reminder) {
      getScopedMap(reminders, scope).set(reminder.id, reminder);
    },
    getReminder(scope, reminderId) {
      return getScopedMap(reminders, scope).get(reminderId) ?? null;
    },
    listReminders(scope) {
      return [...getScopedMap(reminders, scope).values()];
    },
  };
}

export interface TimeToolOptions {
  defaultTimezone?: string;
  locale?: string;
  store?: TemporalStore;
}

function makeId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now()}_${rand}`;
}

function getScope(ctx: ExecutionContext): string {
  const chatId = typeof ctx.metadata['chatId'] === 'string' ? String(ctx.metadata['chatId']) : '';
  const userOrTenant = ctx.userId ?? ctx.tenantId ?? 'anonymous';
  return chatId ? `${userOrTenant}:${chatId}` : userOrTenant;
}

function runningElapsed(elapsedMs: number, startedAt?: string): number {
  if (!startedAt) return elapsedMs;
  return elapsedMs + Math.max(0, Date.now() - new Date(startedAt).getTime());
}

function timerWithComputed(timer: TimerRecord): TimerRecord & { remainingMs?: number; overdueMs?: number } {
  const elapsedMs = timer.state === 'running' ? runningElapsed(timer.elapsedMs, timer.startedAt) : timer.elapsedMs;
  const result: TimerRecord & { remainingMs?: number; overdueMs?: number } = {
    ...timer,
    elapsedMs,
  };
  if (timer.durationMs != null) {
    const remaining = timer.durationMs - elapsedMs;
    if (remaining >= 0) result.remainingMs = remaining;
    else result.overdueMs = Math.abs(remaining);
  }
  return result;
}

function stopwatchWithComputed(watch: StopwatchRecord): StopwatchRecord {
  const elapsedMs = watch.state === 'running' ? runningElapsed(watch.elapsedMs, watch.startedAt) : watch.elapsedMs;
  return { ...watch, elapsedMs };
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function resolveTimezone(preferred?: string, fallback = 'UTC'): string {
  if (preferred && isValidTimezone(preferred)) return preferred;
  if (isValidTimezone(fallback)) return fallback;
  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (localTz && isValidTimezone(localTz)) return localTz;
  return 'UTC';
}

export function formatCurrentTime(opts: TimeFormatOptions = {}): string {
  const timezone = resolveTimezone(opts.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const locale = opts.locale ?? 'en-US';
  const now = opts.now ?? new Date();

  switch (opts.format ?? 'iso') {
    case 'unix':
      return String(Math.floor(now.getTime() / 1000));
    case 'human':
      return now.toLocaleString(locale, { timeZone: timezone });
    case 'date':
      return now.toLocaleDateString(locale, { timeZone: timezone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    case 'time':
      return now.toLocaleTimeString(locale, { timeZone: timezone });
    case 'weekday':
      return now.toLocaleDateString(locale, { timeZone: timezone, weekday: 'long' });
    default:
      return now.toISOString();
  }
}

export function getTimezoneSnapshot(timezone?: string, locale = 'en-US', now = new Date()): TimezoneSnapshot {
  const tz = resolveTimezone(timezone, Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  return {
    timezone: tz,
    nowIso: now.toISOString(),
    date: now.toLocaleDateString(locale, { timeZone: tz }),
    time: now.toLocaleTimeString(locale, { timeZone: tz }),
    human: now.toLocaleString(locale, { timeZone: tz }),
  };
}

export function createTimeTools(options: TimeToolOptions = {}): Tool[] {
  const store = options.store ?? createInMemoryTemporalStore();
  const locale = options.locale ?? 'en-US';

  return [
    weaveTool({
      name: 'datetime',
      description: 'Get the current date/time in different formats. Use format="weekday" to get the current day of the week (e.g. Sunday). Use format="date" to get the full date including day of week.',
      parameters: {
        type: 'object',
        properties: {
          format: { type: 'string', description: 'iso|unix|human|date|time|weekday — use weekday to get the current day of the week' },
          timezone: { type: 'string', description: 'IANA timezone override' },
          locale: { type: 'string', description: 'Locale (default en-US)' },
        },
      },
      execute: async (args: { format?: 'iso' | 'unix' | 'human' | 'date' | 'time' | 'weekday'; timezone?: string; locale?: string }) => {
        const timezone = resolveTimezone(args.timezone, options.defaultTimezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'));
        return formatCurrentTime({ format: args.format, timezone, locale: args.locale ?? locale });
      },
      tags: ['utility', 'datetime'],
    }),

    weaveTool({
      name: 'timezone_info',
      description: 'Get effective timezone and localized now snapshot.',
      parameters: {
        type: 'object',
        properties: {
          timezone: { type: 'string', description: 'IANA timezone override' },
          locale: { type: 'string', description: 'Locale (default en-US)' },
        },
      },
      execute: async (args: { timezone?: string; locale?: string }) => {
        const snapshot = getTimezoneSnapshot(args.timezone ?? options.defaultTimezone, args.locale ?? locale);
        return JSON.stringify(snapshot, null, 2);
      },
      tags: ['utility', 'datetime', 'timezone'],
    }),

    weaveTool({
      name: 'timer_start',
      description: 'Start a timer, optionally with duration in milliseconds.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Optional timer label' },
          durationMs: { type: 'number', description: 'Optional countdown duration in milliseconds' },
        },
      },
      execute: async (args: { label?: string; durationMs?: number }, ctx) => {
        const scope = getScope(ctx);
        const nowIso = new Date().toISOString();
        const timer: TimerRecord = {
          id: makeId('timer'),
          label: args.label,
          durationMs: args.durationMs,
          state: 'running',
          createdAt: nowIso,
          startedAt: nowIso,
          elapsedMs: 0,
        };
        await store.saveTimer(scope, timer);
        return JSON.stringify(timerWithComputed(timer), null, 2);
      },
      tags: ['utility', 'time', 'timer'],
    }),

    weaveTool({
      name: 'timer_pause',
      description: 'Pause a running timer.',
      parameters: {
        type: 'object',
        properties: {
          timerId: { type: 'string', description: 'Timer id' },
        },
        required: ['timerId'],
      },
      execute: async (args: { timerId: string }, ctx) => {
        const scope = getScope(ctx);
        const timer = await store.getTimer(scope, args.timerId);
        if (!timer) return { content: `Timer not found: ${args.timerId}`, isError: true };
        if (timer.state !== 'running') return JSON.stringify(timerWithComputed(timer), null, 2);
        const elapsedMs = runningElapsed(timer.elapsedMs, timer.startedAt);
        const pausedAt = new Date().toISOString();
        const next: TimerRecord = { ...timer, state: 'paused', elapsedMs, pausedAt, startedAt: undefined };
        await store.saveTimer(scope, next);
        return JSON.stringify(timerWithComputed(next), null, 2);
      },
      tags: ['utility', 'time', 'timer'],
    }),

    weaveTool({
      name: 'timer_resume',
      description: 'Resume a paused timer.',
      parameters: {
        type: 'object',
        properties: {
          timerId: { type: 'string', description: 'Timer id' },
        },
        required: ['timerId'],
      },
      execute: async (args: { timerId: string }, ctx) => {
        const scope = getScope(ctx);
        const timer = await store.getTimer(scope, args.timerId);
        if (!timer) return { content: `Timer not found: ${args.timerId}`, isError: true };
        if (timer.state !== 'paused') return JSON.stringify(timerWithComputed(timer), null, 2);
        const resumedAt = new Date().toISOString();
        const next: TimerRecord = { ...timer, state: 'running', resumedAt, startedAt: resumedAt, pausedAt: undefined };
        await store.saveTimer(scope, next);
        return JSON.stringify(timerWithComputed(next), null, 2);
      },
      tags: ['utility', 'time', 'timer'],
    }),

    weaveTool({
      name: 'timer_stop',
      description: 'Stop a timer and freeze elapsed time.',
      parameters: {
        type: 'object',
        properties: {
          timerId: { type: 'string', description: 'Timer id' },
        },
        required: ['timerId'],
      },
      execute: async (args: { timerId: string }, ctx) => {
        const scope = getScope(ctx);
        const timer = await store.getTimer(scope, args.timerId);
        if (!timer) return { content: `Timer not found: ${args.timerId}`, isError: true };
        const elapsedMs = timer.state === 'running' ? runningElapsed(timer.elapsedMs, timer.startedAt) : timer.elapsedMs;
        const stoppedAt = new Date().toISOString();
        const next: TimerRecord = { ...timer, state: 'stopped', elapsedMs, stoppedAt, startedAt: undefined, pausedAt: undefined };
        await store.saveTimer(scope, next);
        return JSON.stringify(timerWithComputed(next), null, 2);
      },
      tags: ['utility', 'time', 'timer'],
    }),

    weaveTool({
      name: 'timer_status',
      description: 'Get status for one timer.',
      parameters: {
        type: 'object',
        properties: {
          timerId: { type: 'string', description: 'Timer id' },
        },
        required: ['timerId'],
      },
      execute: async (args: { timerId: string }, ctx) => {
        const scope = getScope(ctx);
        const timer = await store.getTimer(scope, args.timerId);
        if (!timer) return { content: `Timer not found: ${args.timerId}`, isError: true };
        return JSON.stringify(timerWithComputed(timer), null, 2);
      },
      tags: ['utility', 'time', 'timer'],
    }),

    weaveTool({
      name: 'timer_list',
      description: 'List timers for current execution scope.',
      parameters: { type: 'object', properties: {} },
      execute: async (_args: Record<string, never>, ctx) => {
        const scope = getScope(ctx);
        const timers = (await store.listTimers(scope)).map(timerWithComputed);
        return JSON.stringify({ count: timers.length, timers }, null, 2);
      },
      tags: ['utility', 'time', 'timer'],
    }),

    weaveTool({
      name: 'stopwatch_start',
      description: 'Start a stopwatch.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Optional stopwatch label' },
        },
      },
      execute: async (args: { label?: string }, ctx) => {
        const scope = getScope(ctx);
        const nowIso = new Date().toISOString();
        const watch: StopwatchRecord = {
          id: makeId('watch'),
          label: args.label,
          state: 'running',
          createdAt: nowIso,
          startedAt: nowIso,
          elapsedMs: 0,
          laps: [],
        };
        await store.saveStopwatch(scope, watch);
        return JSON.stringify(stopwatchWithComputed(watch), null, 2);
      },
      tags: ['utility', 'time', 'stopwatch'],
    }),

    weaveTool({
      name: 'stopwatch_lap',
      description: 'Record a lap on a running stopwatch.',
      parameters: {
        type: 'object',
        properties: {
          stopwatchId: { type: 'string', description: 'Stopwatch id' },
        },
        required: ['stopwatchId'],
      },
      execute: async (args: { stopwatchId: string }, ctx) => {
        const scope = getScope(ctx);
        const watch = await store.getStopwatch(scope, args.stopwatchId);
        if (!watch) return { content: `Stopwatch not found: ${args.stopwatchId}`, isError: true };
        const computed = stopwatchWithComputed(watch);
        const next: StopwatchRecord = { ...computed, laps: [...computed.laps, computed.elapsedMs] };
        await store.saveStopwatch(scope, next);
        return JSON.stringify(next, null, 2);
      },
      tags: ['utility', 'time', 'stopwatch'],
    }),

    weaveTool({
      name: 'stopwatch_pause',
      description: 'Pause a stopwatch.',
      parameters: {
        type: 'object',
        properties: {
          stopwatchId: { type: 'string', description: 'Stopwatch id' },
        },
        required: ['stopwatchId'],
      },
      execute: async (args: { stopwatchId: string }, ctx) => {
        const scope = getScope(ctx);
        const watch = await store.getStopwatch(scope, args.stopwatchId);
        if (!watch) return { content: `Stopwatch not found: ${args.stopwatchId}`, isError: true };
        if (watch.state !== 'running') return JSON.stringify(stopwatchWithComputed(watch), null, 2);
        const elapsedMs = runningElapsed(watch.elapsedMs, watch.startedAt);
        const pausedAt = new Date().toISOString();
        const next: StopwatchRecord = { ...watch, state: 'paused', elapsedMs, pausedAt, startedAt: undefined };
        await store.saveStopwatch(scope, next);
        return JSON.stringify(next, null, 2);
      },
      tags: ['utility', 'time', 'stopwatch'],
    }),

    weaveTool({
      name: 'stopwatch_resume',
      description: 'Resume a paused stopwatch.',
      parameters: {
        type: 'object',
        properties: {
          stopwatchId: { type: 'string', description: 'Stopwatch id' },
        },
        required: ['stopwatchId'],
      },
      execute: async (args: { stopwatchId: string }, ctx) => {
        const scope = getScope(ctx);
        const watch = await store.getStopwatch(scope, args.stopwatchId);
        if (!watch) return { content: `Stopwatch not found: ${args.stopwatchId}`, isError: true };
        if (watch.state !== 'paused') return JSON.stringify(stopwatchWithComputed(watch), null, 2);
        const resumedAt = new Date().toISOString();
        const next: StopwatchRecord = { ...watch, state: 'running', resumedAt, startedAt: resumedAt, pausedAt: undefined };
        await store.saveStopwatch(scope, next);
        return JSON.stringify(stopwatchWithComputed(next), null, 2);
      },
      tags: ['utility', 'time', 'stopwatch'],
    }),

    weaveTool({
      name: 'stopwatch_stop',
      description: 'Stop a stopwatch.',
      parameters: {
        type: 'object',
        properties: {
          stopwatchId: { type: 'string', description: 'Stopwatch id' },
        },
        required: ['stopwatchId'],
      },
      execute: async (args: { stopwatchId: string }, ctx) => {
        const scope = getScope(ctx);
        const watch = await store.getStopwatch(scope, args.stopwatchId);
        if (!watch) return { content: `Stopwatch not found: ${args.stopwatchId}`, isError: true };
        const elapsedMs = watch.state === 'running' ? runningElapsed(watch.elapsedMs, watch.startedAt) : watch.elapsedMs;
        const stoppedAt = new Date().toISOString();
        const next: StopwatchRecord = { ...watch, state: 'stopped', elapsedMs, stoppedAt, startedAt: undefined, pausedAt: undefined };
        await store.saveStopwatch(scope, next);
        return JSON.stringify(next, null, 2);
      },
      tags: ['utility', 'time', 'stopwatch'],
    }),

    weaveTool({
      name: 'stopwatch_status',
      description: 'Get stopwatch status.',
      parameters: {
        type: 'object',
        properties: {
          stopwatchId: { type: 'string', description: 'Stopwatch id' },
        },
        required: ['stopwatchId'],
      },
      execute: async (args: { stopwatchId: string }, ctx) => {
        const scope = getScope(ctx);
        const watch = await store.getStopwatch(scope, args.stopwatchId);
        if (!watch) return { content: `Stopwatch not found: ${args.stopwatchId}`, isError: true };
        return JSON.stringify(stopwatchWithComputed(watch), null, 2);
      },
      tags: ['utility', 'time', 'stopwatch'],
    }),

    weaveTool({
      name: 'reminder_create',
      description: 'Create a reminder at an absolute time (ISO timestamp).',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Reminder text' },
          dueAt: { type: 'string', description: 'Due timestamp as ISO string' },
          timezone: { type: 'string', description: 'Timezone context for display' },
        },
        required: ['text', 'dueAt'],
      },
      execute: async (args: { text: string; dueAt: string; timezone?: string }, ctx) => {
        const due = new Date(args.dueAt);
        if (Number.isNaN(due.getTime())) {
          return { content: `Invalid dueAt timestamp: ${args.dueAt}`, isError: true };
        }
        const scope = getScope(ctx);
        const timezone = resolveTimezone(args.timezone, options.defaultTimezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'));
        const reminder: ReminderRecord = {
          id: makeId('reminder'),
          text: args.text,
          dueAt: due.toISOString(),
          timezone,
          status: 'scheduled',
          createdAt: new Date().toISOString(),
        };
        await store.saveReminder(scope, reminder);
        return JSON.stringify(reminder, null, 2);
      },
      tags: ['utility', 'time', 'reminder'],
    }),

    weaveTool({
      name: 'reminder_list',
      description: 'List reminders for the current execution scope.',
      parameters: {
        type: 'object',
        properties: {
          includeCancelled: { type: 'boolean', description: 'Whether to include cancelled reminders' },
        },
      },
      execute: async (args: { includeCancelled?: boolean }, ctx) => {
        const scope = getScope(ctx);
        const reminders = (await store.listReminders(scope))
          .filter((r) => args.includeCancelled ? true : r.status !== 'cancelled')
          .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
        return JSON.stringify({ count: reminders.length, reminders }, null, 2);
      },
      tags: ['utility', 'time', 'reminder'],
    }),

    weaveTool({
      name: 'reminder_cancel',
      description: 'Cancel a scheduled reminder.',
      parameters: {
        type: 'object',
        properties: {
          reminderId: { type: 'string', description: 'Reminder id' },
        },
        required: ['reminderId'],
      },
      execute: async (args: { reminderId: string }, ctx) => {
        const scope = getScope(ctx);
        const reminder = await store.getReminder(scope, args.reminderId);
        if (!reminder) return { content: `Reminder not found: ${args.reminderId}`, isError: true };
        const next: ReminderRecord = {
          ...reminder,
          status: 'cancelled',
          cancelledAt: new Date().toISOString(),
        };
        await store.saveReminder(scope, next);
        return JSON.stringify(next, null, 2);
      },
      tags: ['utility', 'time', 'reminder'],
    }),
  ];
}
