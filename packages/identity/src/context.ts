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
  persona?: string;
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
    persona: opts.persona,
    tenantId: opts.tenantId,
    roles: opts.roles ?? [],
    scopes: opts.scopes ?? [],
    metadata: opts.metadata ?? {},
  };
}

/**
 * L-26: Guard against runtime wildcard permission assignment.
 *
 * The `'*'` permission grants unconditional access to every resource and
 * action. Assigning it at runtime (e.g. via a user-facing role assignment
 * API) is a privilege-escalation vulnerability. It should only ever appear
 * in bootstrap / seed contexts (test setup, admin console seed scripts,
 * the `createBootstrapIdentityContext` function below).
 *
 * Throws `Error` if any of the supplied permissions are `'*'` unless the
 * caller explicitly passes `{ allowWildcard: true }`.
 */
function validatePermissions(permissions: string[], allowWildcard: boolean): string[] {
  if (!allowWildcard && permissions.includes('*')) {
    throw new Error(
      '[identity] Wildcard permission (*) may not be assigned at runtime. ' +
      'Use createBootstrapIdentityContext() for bootstrap/seed-only contexts, ' +
      'or assign specific permissions instead.',
    );
  }
  return permissions;
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
    // L-26: validate that wildcard permission is not assigned at runtime.
    effectivePermissions: validatePermissions(opts?.permissions ?? [], false),
    expiresAt: opts?.expiresAt,
  };
}

/**
 * L-26: Bootstrap-only variant of `createIdentityContext` that explicitly
 * allows the wildcard `'*'` permission. Use this in:
 *  - Unit test setup and seed scripts.
 *  - Admin console / platform bootstrap during first-run initialization.
 *  - Any context where full super-admin access is genuinely required.
 *
 * Never use this in production request-handling paths.
 */
export function createBootstrapIdentityContext(
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
    effectivePermissions: validatePermissions(opts?.permissions ?? [], true),
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
