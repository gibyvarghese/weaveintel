/**
 * Lightweight structured logger interface for WeaveIntel packages.
 *
 * A-8: Replaces bare console.* calls with a structured, level-filtered interface
 * that supports request correlation IDs and structured fields for machine parsing.
 *
 * The default implementation wraps console.* with structured JSON output when
 * LOG_FORMAT=json is set, or pretty-printed output otherwise.
 * Replace the module-level defaultLogger to redirect all package logs to pino,
 * OpenTelemetry, or any other backend without changing call sites.
 */

export interface WeaveLogger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  /** Create a child logger that merges `bindings` into every log entry. */
  child(bindings: Record<string, unknown>): WeaveLogger;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function resolveMinLevel(): LogLevel {
  const raw = (process.env['LOG_LEVEL'] ?? 'info').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return 'info';
}

function makeConsoleLogger(
  bindings: Record<string, unknown> = {},
  minLevel: LogLevel = resolveMinLevel(),
): WeaveLogger {
  const isJson = process.env['LOG_FORMAT'] === 'json';

  function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;
    if (isJson) {
      const entry = { level, msg, ...bindings, ...fields, time: Date.now() };
      const line = JSON.stringify(entry);
      if (level === 'error') {
        console.error(line);
      } else if (level === 'warn') {
        console.warn(line);
      } else {
        console.log(line);
      }
    } else {
      const prefix = bindings['component'] ? `[${String(bindings['component'])}]` : '';
      const suffix = fields && Object.keys(fields).length > 0
        ? ' ' + JSON.stringify(fields)
        : '';
      const formatted = `${prefix} ${msg}${suffix}`.trimStart();
      if (level === 'error') console.error(formatted);
      else if (level === 'warn') console.warn(formatted);
      else if (level === 'debug') console.debug(formatted);
      else console.log(formatted);
    }
  }

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info:  (msg, fields) => emit('info',  msg, fields),
    warn:  (msg, fields) => emit('warn',  msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (newBindings) => makeConsoleLogger({ ...bindings, ...newBindings }, minLevel),
  };
}

/** Process-wide default logger. Replace to redirect all package log output. */
export let defaultLogger: WeaveLogger = makeConsoleLogger();

/** Replace the process-wide default logger (e.g. with a pino instance adapter). */
export function setDefaultLogger(logger: WeaveLogger): void {
  defaultLogger = logger;
}

/**
 * Create a scoped logger for a specific component.
 * Equivalent to `defaultLogger.child({ component })`.
 */
export function createLogger(component: string, extra?: Record<string, unknown>): WeaveLogger {
  return defaultLogger.child({ component, ...extra });
}
