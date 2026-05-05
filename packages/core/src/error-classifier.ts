/**
 * @weaveintel/core — Error classification
 *
 * Phase 1 of the shared resilience pipeline. Centralises the small set of
 * primitives that every provider/tool reaches for when an outbound call fails:
 *
 * - `parseRetryAfterMs`  — parse RFC 7231 Retry-After (seconds or HTTP-date)
 * - `httpStatusToErrorCode` — map an HTTP status to a WeaveIntelError code
 * - `classifyError`      — bucket any error into a small set of `ErrorClass`
 *                          values that retry/backoff/circuit logic can switch on
 *
 * Provider packages used to duplicate `parseRetryAfterMs` four ways. They now
 * import it from here. Higher layers (the planned `@weaveintel/resilience`
 * pipeline) consume `classifyError` to decide whether to retry, throttle, or
 * trip a circuit.
 */

import { WeaveIntelError, normalizeError, type ErrorCode } from './errors.js';

/**
 * Coarse-grained classification used by retry / backoff / circuit-breaker
 * logic. Keep this set small — it is a routing decision, not a diagnostic.
 */
export type ErrorClass =
  | 'rate_limited'   // 429, RPM/TPM exceeded, quota exhausted
  | 'transient'      // 5xx, ECONNRESET, timeout, network blip
  | 'auth'           // 401, 403, expired/invalid credentials
  | 'invalid_input'  // 400, schema violation — never retry
  | 'not_found'      // 404
  | 'cancelled'      // user/abort
  | 'budget'         // local budget guard tripped
  | 'policy'         // policy/guardrail denied
  | 'unknown';

export interface ClassifiedError {
  /** Bucket the rest of the platform routes on. */
  readonly class: ErrorClass;
  /** Whether retrying the same call has any chance of succeeding. */
  readonly retryable: boolean;
  /**
   * If known, how long the caller should wait before the next attempt.
   * Honours `Retry-After` for `rate_limited`; computed by retry policy
   * for everything else.
   */
  readonly retryAfterMs?: number;
  /**
   * Hint for the *outer* scheduler/observer (not the inline retry loop):
   * e.g. "stop sending traffic to this endpoint for N ms". Defaults to
   * `retryAfterMs` for `rate_limited`, undefined otherwise.
   */
  readonly cooldownHintMs?: number;
  /** Normalised underlying error. Always present. */
  readonly cause: WeaveIntelError;
}

const DEFAULT_MAX_RETRY_AFTER_MS = 30_000;
const DEFAULT_FALLBACK_RETRY_AFTER_MS = 60_000;

/**
 * Parse an RFC 7231 `Retry-After` header value, accepting either delta-seconds
 * (e.g. `"9"`) or an HTTP-date. Result is clamped to `[0, maxMs]` so a
 * misconfigured upstream can't park us for hours.
 *
 * Back-compat: the 2-arg form `parseRetryAfterMs(header, fallbackMs)` matches
 * the original provider helpers and is kept identical.
 */
export function parseRetryAfterMs(
  retryAfterHeader: string | null | undefined,
  fallbackMs: number = DEFAULT_FALLBACK_RETRY_AFTER_MS,
  maxMs: number = DEFAULT_MAX_RETRY_AFTER_MS,
): number {
  if (!retryAfterHeader) return Math.min(maxMs, Math.max(0, fallbackMs));
  const asNumber = Number.parseInt(retryAfterHeader, 10);
  if (!Number.isNaN(asNumber) && Number.isFinite(asNumber)) {
    return Math.min(maxMs, Math.max(0, asNumber * 1000));
  }
  const asDate = Date.parse(retryAfterHeader);
  if (!Number.isNaN(asDate)) {
    return Math.min(maxMs, Math.max(0, asDate - Date.now()));
  }
  return Math.min(maxMs, Math.max(0, fallbackMs));
}

/**
 * Map an HTTP status code to the closest `WeaveIntelError` code. Providers
 * may still attach a richer `details` payload, but the code here is the
 * canonical one for their thrown error.
 */
export function httpStatusToErrorCode(status: number): ErrorCode {
  if (status === 408) return 'TIMEOUT';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 401) return 'AUTH_FAILED';
  if (status === 403) return 'PERMISSION_DENIED';
  if (status === 404) return 'NOT_FOUND';
  if (status >= 400 && status < 500) return 'INVALID_INPUT';
  if (status >= 500 && status < 600) return 'PROVIDER_ERROR';
  return 'PROVIDER_ERROR';
}

/**
 * Classify any thrown value into a `ClassifiedError`. Safe to call with raw
 * `unknown` — it normalises through `normalizeError` first.
 *
 * The returned bucket is *advisory*: callers decide whether to retry, throttle,
 * trip a circuit, or surface to the user. Centralising the mapping ensures
 * "what counts as rate-limited" is consistent across providers and tools.
 */
export function classifyError(err: unknown, provider?: string): ClassifiedError {
  const cause = err instanceof WeaveIntelError ? err : normalizeError(err, provider);
  const code = cause.code;

  switch (code) {
    case 'RATE_LIMITED': {
      const retryAfterMs = cause.retryAfterMs;
      const result: ClassifiedError = {
        class: 'rate_limited',
        retryable: true,
        cause,
        ...(retryAfterMs !== undefined ? { retryAfterMs, cooldownHintMs: retryAfterMs } : {}),
      };
      return result;
    }
    case 'TIMEOUT':
    case 'PROVIDER_ERROR':
    case 'CONNECTOR_ERROR':
    case 'PROTOCOL_ERROR':
    case 'INTERNAL_ERROR': {
      const result: ClassifiedError = {
        class: 'transient',
        retryable: cause.retryable,
        cause,
        ...(cause.retryAfterMs !== undefined ? { retryAfterMs: cause.retryAfterMs } : {}),
      };
      return result;
    }
    case 'AUTH_FAILED':
    case 'PERMISSION_DENIED':
      return { class: 'auth', retryable: false, cause };
    case 'INVALID_INPUT':
    case 'INVALID_CONFIG':
      return { class: 'invalid_input', retryable: false, cause };
    case 'NOT_FOUND':
      return { class: 'not_found', retryable: false, cause };
    case 'CANCELLED':
      return { class: 'cancelled', retryable: false, cause };
    case 'BUDGET_EXCEEDED':
      return { class: 'budget', retryable: false, cause };
    case 'POLICY_DENIED':
    case 'CIRCUIT_OPEN':
      return { class: 'policy', retryable: false, cause };
    case 'MODEL_ERROR':
    case 'TOOL_ERROR':
    case 'VECTOR_STORE_ERROR':
    case 'MEMORY_ERROR':
    case 'REDACTION_ERROR':
    default: {
      const result: ClassifiedError = {
        class: 'unknown',
        retryable: cause.retryable,
        cause,
        ...(cause.retryAfterMs !== undefined ? { retryAfterMs: cause.retryAfterMs } : {}),
      };
      return result;
    }
  }
}
