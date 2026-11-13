// SPDX-License-Identifier: MIT
/**
 * URL elicitation: the server side of "the person confirms this in a page the agent cannot click".
 *
 * A tool call that needs the person's confirmation is not run. Instead the server answers with a URL the
 * person opens in their own browser (where they are signed in, see the action and confirm it), and the
 * client retries the same call afterwards. How that answer looks depends on the revision:
 *
 * - **2025-11-25** (session era, stateless HTTP): a JSON-RPC error `-32042` (URL elicitation required)
 *   whose `data.elicitations` lists `{ mode: 'url', elicitationId, url, message }`. This is the form a
 *   server can send without holding a stream open; the official SDK client turns it into its
 *   `UrlElicitationRequiredError`. The retry carries nothing: the server's own grant store decides.
 * - **2026-07-28** (multi round-trip request): a result with `resultType: 'input_required'` and an
 *   `inputRequests` map of `elicitation/create` requests; the client retries the same request with
 *   `inputResponses` (each an elicitation result: `action` accept, decline or cancel) and the
 *   `requestState` it was given.
 *
 * The client's "accept" is never proof that the person confirmed: anyone holding the token can send it.
 * It is handed to the confirm hook as a hint; the hook must find its own server-side grant (bound to the
 * call's parameter hash) before it lets the call proceed. A "decline" or "cancel" only ever refuses.
 */

/** JSON-RPC error code for "URL elicitation required" (2025-11-25). */
export const MCP_ERROR_URL_ELICITATION_REQUIRED = -32042;

/** One URL elicitation the server asks the client to show. */
export interface UrlElicitationRequest {
  /** Opaque id, unique within the server; the client echoes it. Never put a secret here. */
  readonly elicitationId: string;
  /** Where the person confirms: `https:`, or `http:` on a loopback host for local development. No credentials, no secrets. */
  readonly url: string;
  /** Plain words shown to the person. */
  readonly message: string;
}

/** What a confirm hook or tool returns to ask for a URL elicitation. */
export interface UrlElicitationOutcome {
  readonly kind: 'elicit';
  readonly elicitation: UrlElicitationRequest;
}

/** Ask the client to send the person to a URL before this call may run. */
export function urlElicitationRequired(elicitation: UrlElicitationRequest): UrlElicitationOutcome {
  return { kind: 'elicit', elicitation };
}

/** True when a handler's return value asks for a URL elicitation. */
export function isUrlElicitationOutcome(value: unknown): value is UrlElicitationOutcome {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { kind?: unknown }).kind === 'elicit' &&
    typeof (value as { elicitation?: unknown }).elicitation === 'object'
  );
}

/** The client's answer to one elicitation, as carried by a 2026-07-28 retry. */
export interface ElicitationAnswer {
  readonly action: 'accept' | 'decline' | 'cancel';
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Throws unless the elicitation is safe to hand a client: an absolute `https:` URL (or `http:` on a
 * loopback host, including `*.localhost`), no user-info, a non-empty id and message.
 */
export function assertUrlElicitation(e: UrlElicitationRequest): void {
  if (
    !e ||
    typeof e.elicitationId !== 'string' ||
    e.elicitationId === '' ||
    typeof e.message !== 'string' ||
    e.message === ''
  ) {
    throw new TypeError('URL elicitation needs an elicitationId and a message');
  }
  let u: URL;
  try {
    u = new URL(e.url);
  } catch {
    throw new TypeError('URL elicitation url is not an absolute URL');
  }
  const loopback = LOOPBACK.has(u.hostname) || u.hostname.endsWith('.localhost');
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && loopback)))
    throw new TypeError('URL elicitation url must be https (http only on loopback)');
  if (u.username !== '' || u.password !== '')
    throw new TypeError('URL elicitation url must not carry credentials');
}

/** The 2025-11-25 JSON-RPC error body for one elicitation. The message also carries the URL, for clients that only show text. */
export function urlElicitationError(e: UrlElicitationRequest): {
  code: number;
  message: string;
  data: { elicitations: Array<Record<string, string>> };
} {
  return {
    code: MCP_ERROR_URL_ELICITATION_REQUIRED,
    message: `${e.message} Open ${e.url} to continue, then try again.`,
    data: {
      elicitations: [
        { mode: 'url', elicitationId: e.elicitationId, url: e.url, message: e.message },
      ],
    },
  };
}

/** The 2026-07-28 `input_required` result for one elicitation, bound to `requestState`. */
export function urlElicitationInputRequired(
  e: UrlElicitationRequest,
  requestState: string,
): Record<string, unknown> {
  return {
    resultType: 'input_required',
    inputRequests: {
      [e.elicitationId]: {
        method: 'elicitation/create',
        params: { mode: 'url', elicitationId: e.elicitationId, url: e.url, message: e.message },
      },
    },
    requestState,
  };
}

/**
 * Read a 2026-07-28 retry's `inputResponses`, keeping only well-formed answers, and only when the
 * `requestState` the client echoed matches the one this call would be given (so answers given for other
 * arguments are dropped).
 */
export function readElicitationAnswers(
  params: Record<string, unknown> | undefined,
  expectedState: string,
): Record<string, ElicitationAnswer> {
  const out: Record<string, ElicitationAnswer> = {};
  if (!params || params['requestState'] !== expectedState) return out;
  const responses = params['inputResponses'];
  if (!responses || typeof responses !== 'object' || Array.isArray(responses)) return out;
  for (const [key, value] of Object.entries(responses as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const action = (value as { action?: unknown }).action;
    if (action === 'accept' || action === 'decline' || action === 'cancel') out[key] = { action };
  }
  return out;
}
