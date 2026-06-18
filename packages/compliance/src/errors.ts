/**
 * @weaveintel/compliance — Domain error classes
 *
 * L-27+A-6: Typed subclasses of WeaveIntelError for compliance violations.
 * Using typed subclasses instead of plain WeaveIntelError lets callers use
 * `instanceof` to discriminate error types without parsing message strings,
 * and lets error monitoring tools group compliance incidents by category.
 *
 * All classes keep `code: 'POLICY_DENIED'` so existing callers that switch on
 * `err.code` continue to work without changes.
 */
import { WeaveIntelError } from '@weaveintel/core';

/**
 * Thrown when an operation (deletion, overwrite, export) is blocked because
 * one or more active legal holds cover the requested subject or data category.
 *
 * @example
 *   if (manager.isHeld(subjectId, 'messages')) {
 *     throw new LegalHoldActiveError(subjectId, 'messages');
 *   }
 */
export class LegalHoldActiveError extends WeaveIntelError {
  /** The subject ID (user, tenant, etc.) covered by the hold. */
  readonly subjectId: string;
  /** The data category that is held (e.g. 'messages', '*'). */
  readonly dataCategory: string;

  constructor(subjectId: string, dataCategory: string, extraMessage?: string) {
    super({
      code: 'POLICY_DENIED',
      message:
        `Legal hold is active for subject "${subjectId}" on data category "${dataCategory}"` +
        (extraMessage ? `: ${extraMessage}` : '') +
        '. The operation cannot proceed until the hold is released.',
    });
    this.name = 'LegalHoldActiveError';
    this.subjectId = subjectId;
    this.dataCategory = dataCategory;
  }
}

/**
 * Thrown when an operation requires user consent for a given purpose but the
 * consent record has expired or was withdrawn.
 *
 * @example
 *   if (!manager.isConsented(userId, 'analytics')) {
 *     throw new ConsentExpiredError(userId, 'analytics');
 *   }
 */
export class ConsentExpiredError extends WeaveIntelError {
  /** The user ID whose consent is missing or expired. */
  readonly userId: string;
  /** The consent purpose that was required (e.g. 'analytics', 'marketing'). */
  readonly purpose: string;

  constructor(userId: string, purpose: string, extraMessage?: string) {
    super({
      code: 'POLICY_DENIED',
      message:
        `Consent for purpose "${purpose}" is missing or expired for user "${userId}"` +
        (extraMessage ? `: ${extraMessage}` : '') +
        '. Re-consent is required before this operation can proceed.',
    });
    this.name = 'ConsentExpiredError';
    this.userId = userId;
    this.purpose = purpose;
  }
}

/**
 * Thrown when routing a request or storing data would violate a geographic
 * residency constraint (e.g. EU data must not leave the EU region).
 *
 * @example
 *   if (!engine.isAllowed(region, dataCategory)) {
 *     throw new ResidencyViolationError(region, dataCategory);
 *   }
 */
export class ResidencyViolationError extends WeaveIntelError {
  /** The region/location that was proposed (e.g. 'us-east-1'). */
  readonly proposedRegion: string;
  /** The data category that triggered the violation (e.g. 'pii', '*'). */
  readonly dataCategory: string;

  constructor(proposedRegion: string, dataCategory: string, extraMessage?: string) {
    super({
      code: 'POLICY_DENIED',
      message:
        `Residency violation: data category "${dataCategory}" is not permitted in region "${proposedRegion}"` +
        (extraMessage ? `: ${extraMessage}` : '') +
        '. Reconfigure the target region or adjust the residency policy.',
    });
    this.name = 'ResidencyViolationError';
    this.proposedRegion = proposedRegion;
    this.dataCategory = dataCategory;
  }
}
