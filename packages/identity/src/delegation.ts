/**
 * @weaveintel/identity — Delegation chain management
 *
 * Supports building, validating, and inspecting delegation chains
 * where one identity acts on behalf of another.
 */

import type { RuntimeIdentity, DelegationContext } from '@weaveintel/core';
import { DelegationExpiredError } from './errors.js';
import { WeaveIntelError } from '@weaveintel/core';

/** Build a delegation context from one identity to another. */
export function createDelegation(
  from: RuntimeIdentity,
  to: RuntimeIdentity,
  scopes: string[],
  reason: string,
  opts?: { chain?: string[]; expiresAt?: string },
): DelegationContext {
  const chain = opts?.chain ?? [];
  // H-16: Include `to.id` in the chain so that if `to` later attempts to
  // delegate to anyone already in this chain (including back to `from`),
  // `validateDelegationChain` will detect it as circular.
  //
  // Before this fix the chain only recorded ancestors (`from.id` and its
  // ancestors), so a cross-chain cycle like A→B then B→A was undetectable:
  // B's chain was [B.id] and A.id was not in it. Now A→B records [from_ancestors,
  // from.id, to.id], so any delegation originating from `to` that tries to
  // reach `from` (or any prior node) will find its own id already present.
  return {
    from,
    to,
    scopes,
    reason,
    chain: [...chain, from.id, to.id],
    expiresAt: opts?.expiresAt,
  };
}

/** Check whether a delegation has expired. */
export function isDelegationExpired(d: DelegationContext): boolean {
  if (!d.expiresAt) return false;
  return new Date(d.expiresAt).getTime() < Date.now();
}

/** Check whether a delegation covers the requested scope. */
export function isDelegationAuthorised(d: DelegationContext, requiredScope: string): boolean {
  // Wildcard scope covers everything
  if (d.scopes.includes('*')) return true;
  return d.scopes.includes(requiredScope);
}

/**
 * L-27+A-6: Throwing asserter — validates a delegation chain and throws a
 * typed domain error instead of returning a result object. Use this in
 * middleware and route handlers where the delegation must be valid to proceed:
 *
 *   assertDelegationValid(delegation);  // throws DelegationExpiredError or WeaveIntelError
 *
 * `validateDelegationChain` remains available for callers that prefer a
 * discriminated-union result over exceptions.
 */
export function assertDelegationValid(d: DelegationContext): void {
  if (isDelegationExpired(d)) {
    throw new DelegationExpiredError(
      d.from.id,
      d.to.id,
      d.expiresAt ? new Date(d.expiresAt).getTime() : undefined,
    );
  }
  const seen = new Set<string>();
  for (const id of d.chain) {
    if (seen.has(id)) {
      throw new WeaveIntelError({
        code: 'POLICY_DENIED',
        message: `Circular delegation detected: identity "${id}" appears more than once in chain [${d.chain.join(' → ')}]`,
      });
    }
    seen.add(id);
  }
}

/** Validate the full delegation chain: no expiry, no circular references. */
export function validateDelegationChain(d: DelegationContext): {
  valid: boolean;
  reason?: string;
} {
  if (isDelegationExpired(d)) {
    // Return the object form — callers that need to throw use assertDelegationValid.
    return { valid: false, reason: 'Delegation has expired' };
  }
  // H-16: `d.chain` now contains both ancestors AND `to.id` (added by
  // `createDelegation`). A duplicate in the chain indicates a cycle — either
  // `from` delegating to itself, or a multi-hop cycle like A→B→A.
  const seen = new Set<string>();
  for (const id of d.chain) {
    if (seen.has(id)) {
      return { valid: false, reason: `Circular delegation detected (identity ${id} appears more than once in chain)` };
    }
    seen.add(id);
  }
  return { valid: true };
}
