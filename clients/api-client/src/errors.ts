/**
 * errors.ts — typed error hierarchy for @geneweave/api-client.
 *
 * Every non-2xx response that a typed method cannot turn into a meaningful
 * result surfaces as a `GeneweaveApiError` (or a subclass). Callers (the mobile
 * app, M3+) branch on `instanceof` to drive UX: re-authenticate on
 * `AuthExpiredError`, show a read-only banner on `ManagedByOrgError`, etc.
 */

/** Base error for any failed geneWeave API call. Carries the HTTP status + body. */
export class GeneweaveApiError extends Error {
  /** HTTP status code of the failed response. */
  readonly status: number;
  /** Parsed response body (object, string, or null) for diagnostics. */
  readonly body: unknown;
  /** The request method + path that failed, for logging. */
  readonly request: { method: string; path: string };

  constructor(
    message: string,
    opts: { status: number; body?: unknown; request: { method: string; path: string } },
  ) {
    super(message);
    this.name = 'GeneweaveApiError';
    this.status = opts.status;
    this.body = opts.body ?? null;
    this.request = opts.request;
  }
}

/**
 * The session is no longer valid and could not be refreshed. Thrown on a 401
 * after a single refresh attempt has already been made (or when no refresh
 * strategy is configured). The host should route the user back to sign-in.
 */
export class AuthExpiredError extends GeneweaveApiError {
  constructor(opts: { body?: unknown; request: { method: string; path: string } }) {
    super('Session expired — re-authentication required', { status: 401, ...opts });
    this.name = 'AuthExpiredError';
  }
}

/**
 * A user-memory mutation was rejected because the caller's organization manages
 * memory centrally (server responds `403 { managedByOrg: true }`). Reads still
 * work; only writes are blocked. The host should present a read-only state.
 */
export class ManagedByOrgError extends GeneweaveApiError {
  constructor(opts: { body?: unknown; request: { method: string; path: string } }) {
    super('User memory is managed by your organization and is read-only', { status: 403, ...opts });
    this.name = 'ManagedByOrgError';
  }
}

/**
 * The server returned a body that did not match the expected schema. Indicates
 * a client/server contract drift — surfaced loudly rather than silently
 * coercing, so a schema change is caught in tests / telemetry.
 */
export class ResponseShapeError extends GeneweaveApiError {
  /** Human-readable summary of the zod validation issues. */
  readonly issues: string;

  constructor(opts: { body?: unknown; issues: string; request: { method: string; path: string } }) {
    super(`Unexpected response shape from ${opts.request.method} ${opts.request.path}: ${opts.issues}`, {
      status: 0,
      body: opts.body,
      request: opts.request,
    });
    this.name = 'ResponseShapeError';
    this.issues = opts.issues;
  }
}
