// SPDX-License-Identifier: MIT
/**
 * Scope-to-tool.
 *
 * Each tool names the OAuth scopes a caller's token must carry. A tool is listed only when the token
 * carries all of them, and a call to a tool the token lacks a scope for is answered with the
 * `insufficient_scope` challenge of RFC 6750 §3.1, which the MCP authorization spec (2025-11-25 and
 * later) uses for step-up: HTTP 403 with a `WWW-Authenticate: Bearer error="insufficient_scope",
 * scope="…", resource_metadata="…"` header. A client can then ask the person for the wider scope and
 * retry.
 *
 * The scopes a token carries are whatever the host put on `authInfo.scopes` after verifying it; the
 * caller's JSON-RPC params never decide them.
 */

/** RFC 6749 §3.3 scope-token: one or more of %x21 / %x23-5B / %x5D-7E (no space, `"` or `\`). */
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

/** Throws unless `scope` is an RFC 6749 scope token (so it can never break the challenge header). */
export function assertScopeToken(scope: string): void {
  if (typeof scope !== 'string' || !SCOPE_TOKEN.test(scope)) {
    throw new TypeError(`Not an OAuth scope token: ${JSON.stringify(scope)}`);
  }
}

/** The required scopes the granted set lacks, in the order required. Whole tokens only, case-sensitive. */
export function missingScopes(required: readonly string[], granted: readonly string[]): string[] {
  const have = new Set(granted);
  return required.filter((s) => !have.has(s));
}

export interface BearerChallengeParams {
  readonly error?: 'invalid_request' | 'invalid_token' | 'insufficient_scope';
  readonly scope?: readonly string[];
  /** RFC 9728 protected-resource metadata URL. */
  readonly resourceMetadata?: string;
  readonly description?: string;
}

/** Remove what would end a quoted-string or the header line. */
function quoteSafe(value: string): string {
  return value.replace(/["\\\r\n\x00-\x08\x0A-\x1F\x7F]/g, '');
}

/** A `WWW-Authenticate` value for the Bearer scheme (RFC 6750 §3), parameters quoted and sanitised. */
export function bearerChallenge(p: BearerChallengeParams): string {
  const parts: string[] = [];
  if (p.error) parts.push(`error="${p.error}"`);
  if (p.scope && p.scope.length > 0) parts.push(`scope="${quoteSafe(p.scope.join(' '))}"`);
  if (p.resourceMetadata) parts.push(`resource_metadata="${quoteSafe(p.resourceMetadata)}"`);
  if (p.description) parts.push(`error_description="${quoteSafe(p.description)}"`);
  return parts.length === 0 ? 'Bearer' : `Bearer ${parts.join(', ')}`;
}

export interface InsufficientScopeChallenge {
  readonly status: 403;
  readonly wwwAuthenticate: string;
  /** The scopes the token lacked. */
  readonly missing: string[];
}

/**
 * The step-up answer for a call the token lacks a scope for. The challenge's `scope` asks for what the
 * token already had plus what the tool needs: clients (the official SDK among them) re-authorise with
 * exactly the challenged scope, so naming only the missing one would cost them the rest.
 */
export function insufficientScopeChallenge(p: {
  required: readonly string[];
  granted: readonly string[];
  resourceMetadataUrl?: string | undefined;
}): InsufficientScopeChallenge {
  const missing = missingScopes(p.required, p.granted);
  const wanted = [...p.granted.filter((s) => SCOPE_TOKEN.test(s))];
  for (const s of p.required) if (!wanted.includes(s)) wanted.push(s);
  return {
    status: 403,
    missing,
    wwwAuthenticate: bearerChallenge({
      error: 'insufficient_scope',
      scope: wanted,
      ...(p.resourceMetadataUrl ? { resourceMetadata: p.resourceMetadataUrl } : {}),
      description: `This tool needs the scope${missing.length > 1 ? 's' : ''}: ${missing.join(' ')}`,
    }),
  };
}
