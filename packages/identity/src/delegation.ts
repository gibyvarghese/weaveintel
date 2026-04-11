/**
 * @weaveintel/identity — Delegation chain management
 *
 * Supports building, validating, and inspecting delegation chains
 * where one identity acts on behalf of another.
 */

import type { RuntimeIdentity, DelegationContext } from '@weaveintel/core';

/** Build a delegation context from one identity to another. */
export function createDelegation(
  from: RuntimeIdentity,
  to: RuntimeIdentity,
  scopes: string[],
  reason: string,
  opts?: { chain?: string[]; expiresAt?: string },
): DelegationContext {
  const chain = opts?.chain ?? [];
  return {
    from,
    to,
    scopes,
    reason,
    chain: [...chain, from.id],
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

/** Validate the full delegation chain: no expiry, no circular references. */
export function validateDelegationChain(d: DelegationContext): {
  valid: boolean;
  reason?: string;
} {
  if (isDelegationExpired(d)) {
    return { valid: false, reason: 'Delegation has expired' };
  }
  // Circular delegation check
  if (d.chain.includes(d.to.id)) {
    return { valid: false, reason: 'Circular delegation detected' };
  }
  return { valid: true };
}
