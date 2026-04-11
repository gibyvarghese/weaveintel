/**
 * @weaveintel/identity — Identity context builder
 *
 * Construct RuntimeIdentity and IdentityContext objects from
 * authentication tokens, headers, or explicit configuration.
 */

import type { RuntimeIdentity, IdentityContext } from '@weaveintel/core';

/** Options for building a runtime identity. */
export interface IdentityOptions {
  type: RuntimeIdentity['type'];
  id: string;
  name?: string;
  tenantId?: string;
  roles?: string[];
  scopes?: string[];
  metadata?: Record<string, unknown>;
}

/** Create a RuntimeIdentity from explicit values. */
export function createIdentity(opts: IdentityOptions): RuntimeIdentity {
  return {
    type: opts.type,
    id: opts.id,
    name: opts.name,
    tenantId: opts.tenantId,
    roles: opts.roles ?? [],
    scopes: opts.scopes ?? [],
    metadata: opts.metadata ?? {},
  };
}

/** Create an IdentityContext wrapping a RuntimeIdentity. */
export function createIdentityContext(
  identity: RuntimeIdentity,
  opts?: {
    sessionId?: string;
    delegatedFrom?: RuntimeIdentity;
    permissions?: string[];
    expiresAt?: string;
  },
): IdentityContext {
  return {
    identity,
    sessionId: opts?.sessionId,
    delegatedFrom: opts?.delegatedFrom,
    effectivePermissions: opts?.permissions ?? [],
    expiresAt: opts?.expiresAt,
  };
}

/** System identity used for background tasks. */
export function systemIdentity(): RuntimeIdentity {
  return createIdentity({
    type: 'system',
    id: 'system',
    name: 'System',
    roles: ['admin'],
    scopes: ['*'],
  });
}

/** Agent identity with scoped permissions. */
export function agentIdentity(
  id: string,
  name: string,
  scopes?: string[],
  tenantId?: string,
): RuntimeIdentity {
  return createIdentity({
    type: 'agent',
    id,
    name,
    tenantId,
    roles: ['agent'],
    scopes: scopes ?? ['chat', 'tools'],
  });
}
