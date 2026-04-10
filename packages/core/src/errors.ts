/**
 * @weaveintel/core — Error model
 *
 * Why: Normalized errors across all providers. Consumers handle WeaveIntelError,
 * not provider-specific HTTP/SDK errors. Error codes are stable contracts.
 */

export type ErrorCode =
  | 'CANCELLED'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'AUTH_FAILED'
  | 'PERMISSION_DENIED'
  | 'NOT_FOUND'
  | 'INVALID_INPUT'
  | 'INVALID_CONFIG'
  | 'MODEL_ERROR'
  | 'TOOL_ERROR'
  | 'CONNECTOR_ERROR'
  | 'VECTOR_STORE_ERROR'
  | 'MEMORY_ERROR'
  | 'REDACTION_ERROR'
  | 'POLICY_DENIED'
  | 'BUDGET_EXCEEDED'
  | 'CIRCUIT_OPEN'
  | 'PROVIDER_ERROR'
  | 'PROTOCOL_ERROR'
  | 'INTERNAL_ERROR';

export class WeaveIntelError extends Error {
  readonly code: ErrorCode;
  readonly provider?: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly details?: Record<string, unknown>;

  constructor(opts: {
    code: ErrorCode;
    message: string;
    provider?: string;
    retryable?: boolean;
    retryAfterMs?: number;
    details?: Record<string, unknown>;
    cause?: Error;
  }) {
    super(opts.message);
    this.name = 'WeaveIntelError';
    this.code = opts.code;
    this.provider = opts.provider;
    this.retryable = opts.retryable ?? false;
    this.retryAfterMs = opts.retryAfterMs;
    this.details = opts.details;
    if (opts.cause) this.cause = opts.cause;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      provider: this.provider,
      retryable: this.retryable,
      retryAfterMs: this.retryAfterMs,
      details: this.details,
    };
  }
}

/** Wrap unknown errors into WeaveIntelError */
export function normalizeError(err: unknown, provider?: string): WeaveIntelError {
  if (err instanceof WeaveIntelError) return err;
  if (err instanceof Error) {
    if (err.name === 'AbortError') {
      return new WeaveIntelError({
        code: 'CANCELLED',
        message: 'Operation was cancelled',
        provider,
        cause: err,
      });
    }
    return new WeaveIntelError({
      code: 'PROVIDER_ERROR',
      message: err.message,
      provider,
      retryable: false,
      cause: err,
    });
  }
  return new WeaveIntelError({
    code: 'INTERNAL_ERROR',
    message: String(err),
    provider,
  });
}
