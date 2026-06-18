/**
 * @weaveintel/identity — Domain error classes
 *
 * L-27+A-6: Typed subclass of WeaveIntelError for identity / delegation
 * violations. Using a typed subclass lets callers discriminate delegation
 * failures from generic permission errors via `instanceof`, which is
 * important for auth middleware that must distinguish "expired" (prompt
 * re-auth) from "denied" (access control failure).
 */
import { WeaveIntelError } from '@weaveintel/core';

/**
 * Thrown when an operation attempts to use a delegation chain that has
 * passed its `expiresAt` timestamp.
 *
 * Callers should catch this and prompt the originating principal to issue a
 * fresh delegation rather than treating it as a permanent permission denial.
 *
 * @example
 *   const validation = validateDelegationChain(delegation);
 *   if (!validation.valid && isDelegationExpired(delegation)) {
 *     throw new DelegationExpiredError(delegation.from.id, delegation.to.id);
 *   }
 */
export class DelegationExpiredError extends WeaveIntelError {
  /** The identity that issued the delegation. */
  readonly fromId: string;
  /** The identity that received (and attempted to use) the delegation. */
  readonly toId: string;
  /** The expiry timestamp in ms since epoch, if known. */
  readonly expiresAt?: number;

  constructor(fromId: string, toId: string, expiresAt?: number) {
    const expiryNote = expiresAt
      ? ` (expired at ${new Date(expiresAt).toISOString()})`
      : '';
    super({
      code: 'POLICY_DENIED',
      message: `Delegation from "${fromId}" to "${toId}" has expired${expiryNote}. Issue a new delegation to continue.`,
    });
    this.name = 'DelegationExpiredError';
    this.fromId = fromId;
    this.toId = toId;
    this.expiresAt = expiresAt;
  }
}
