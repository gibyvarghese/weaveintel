/**
 * @weaveintel/identity/scope — scope-token.ts
 *
 * Issue and validate CrossScopeTokens — the authorization tickets that
 * agents must present when crossing a scope boundary via A2A.
 *
 * Token design follows OAuth 2.1 / JIT credential principles:
 *   - Tokens are short-lived (10 minutes by default)
 *   - Tokens are bound to a specific taskId + sessionId (non-transferable)
 *   - Tokens carry only the minimum permissions needed
 *   - Tokens are HMAC-SHA256 signed to detect tampering without DB lookups
 *
 * In a production deployment the secret should be a per-deployment secret
 * from your secrets manager (e.g. WEAVE_SCOPE_TOKEN_SECRET env var).
 * This module uses Node's built-in `crypto` module — no external dependencies.
 */
import { createHmac, randomUUID } from 'crypto';
import type { CrossScopeToken } from './types.js';
import { InvalidScopeTokenError } from './errors.js';

/** Default token TTL: 10 minutes */
const DEFAULT_TOKEN_TTL_MS = 10 * 60 * 1000;

/**
 * Canonical payload for HMAC signing.
 *
 * All fields except `signature` are included. The order is fixed so the
 * signature is reproducible. JSON.stringify with a replacer is used to
 * guarantee key ordering — plain JSON.stringify is engine-dependent.
 */
function buildSignablePayload(token: Omit<CrossScopeToken, 'signature'>): string {
  return JSON.stringify({
    id: token.id,
    fromScope: token.fromScope,
    toScope: token.toScope,
    taskId: token.taskId,
    sessionId: token.sessionId,
    permissions: [...token.permissions].sort(),  // sorted for determinism
    issuedAt: token.issuedAt,
    expiresAt: token.expiresAt,
  });
}

/**
 * Computes the HMAC-SHA256 signature for a token payload.
 *
 * @param payload  Canonical JSON string of the token fields
 * @param secret   Shared secret (from env var or key management system)
 */
function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Issues a new CrossScopeToken authorizing one cross-scope delegation.
 *
 * Call this when:
 *   1. ScopeGuard.checkA2ADelegation() returns allowed=true, requiresA2A=true
 *   2. Before making the actual A2A call to the target scope
 *
 * The token must be passed to deriveScopeContext() in the receiving scope.
 *
 * @param fromScope   Source scope issuing this token
 * @param toScope     Target scope this token grants access to
 * @param taskId      Task correlation ID (must match ScopeContext.taskId)
 * @param sessionId   Session ID (must match ScopeContext.sessionId)
 * @param permissions Permissions to grant (e.g. ['analytics:read'])
 * @param secret      HMAC secret for signing
 * @param ttlMs       Token lifetime (default: 10 minutes)
 */
export function issueCrossScopeToken(
  fromScope: string,
  toScope: string,
  taskId: string,
  sessionId: string,
  permissions: readonly string[],
  secret: string,
  ttlMs: number = DEFAULT_TOKEN_TTL_MS,
): CrossScopeToken {
  const now = Date.now();
  const partial: Omit<CrossScopeToken, 'signature'> = {
    id: randomUUID(),
    fromScope,
    toScope,
    taskId,
    sessionId,
    permissions,
    issuedAt: now,
    expiresAt: now + ttlMs,
  };
  const payload = buildSignablePayload(partial);
  const signature = sign(payload, secret);
  return { ...partial, signature };
}

/**
 * Validates a CrossScopeToken.
 *
 * Checks:
 *   1. Signature is correct (token has not been tampered with)
 *   2. Token has not expired
 *   3. Token bindings match the expected taskId and sessionId
 *
 * Throws InvalidScopeTokenError if any check fails.
 *
 * @param token      The token to validate
 * @param secret     HMAC secret (same one used to sign)
 * @param taskId     Expected task ID (must match token.taskId)
 * @param sessionId  Expected session ID (must match token.sessionId)
 */
export function validateCrossScopeToken(
  token: CrossScopeToken,
  secret: string,
  taskId: string,
  sessionId: string,
): void {
  // 1. Verify signature
  const { signature, ...rest } = token;
  const expectedSig = sign(buildSignablePayload(rest), secret);
  if (expectedSig !== signature) {
    throw new InvalidScopeTokenError('signature mismatch — token may have been tampered with');
  }

  // 2. Check expiry
  if (Date.now() > token.expiresAt) {
    throw new InvalidScopeTokenError(
      `token expired at ${new Date(token.expiresAt).toISOString()}`,
    );
  }

  // 3. Validate bindings
  if (token.taskId !== taskId) {
    throw new InvalidScopeTokenError(
      `task ID mismatch: token bound to '${token.taskId}', got '${taskId}'`,
    );
  }
  if (token.sessionId !== sessionId) {
    throw new InvalidScopeTokenError(
      `session ID mismatch: token bound to '${token.sessionId}', got '${sessionId}'`,
    );
  }
}

/** Returns true if the token is past its expiry time. */
export function isCrossScopeTokenExpired(token: CrossScopeToken): boolean {
  return Date.now() > token.expiresAt;
}

/**
 * Returns a summary string for logging without exposing the signature.
 * Example: "cst:abc123 analytics→code [permissions: analytics:read, code:execute]"
 */
export function describeCrossScopeToken(token: CrossScopeToken): string {
  const id = token.id.slice(0, 8);
  const perms = token.permissions.join(', ');
  return `cst:${id} ${token.fromScope}→${token.toScope} [${perms}]`;
}
