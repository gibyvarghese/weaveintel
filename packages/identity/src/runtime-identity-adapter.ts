/**
 * Phase 6 — `RuntimeIdentitySlot` adapter for `@weaveintel/identity`.
 *
 * `createRuntimeIdentityAdapter(opts)` wires the identity evaluation engine
 * into the single `RuntimeIdentitySlot` shape that `weaveRuntime({ identity })`
 * expects. Pass the result directly to `weaveRuntime`.
 *
 * By default uses `DEFAULT_RBAC_POLICY` so adopters get working role-based
 * access control immediately. Override via `opts.policy` for custom personas
 * and fine-grained permissions.
 */

import type { RuntimeIdentitySlot, IdentityContext, AccessDecision, DelegationContext } from '@weaveintel/core';
import type { AccessRule } from './access.js'; // used in extraRules
import type { RbacPolicy } from './rbac.js';
import { createIdentity, createIdentityContext } from './context.js';
import { evaluateAccess } from './access.js';
import { validateDelegationChain } from './delegation.js';
import { DEFAULT_RBAC_POLICY, resolvePersonaPermissions } from './rbac.js';

export interface RuntimeIdentityAdapterOptions {
  /** RBAC policy to use for permission resolution. Defaults to `DEFAULT_RBAC_POLICY`. */
  policy?: RbacPolicy;
  /**
   * Extra access rules applied after RBAC permission resolution.
   * Useful for tenant-level resource restrictions.
   */
  extraRules?: AccessRule[];
}

export function createRuntimeIdentityAdapter(
  opts: RuntimeIdentityAdapterOptions = {},
): RuntimeIdentitySlot {
  const policy = opts.policy ?? DEFAULT_RBAC_POLICY;
  const extraRules = opts.extraRules ?? [];

  return {
    resolve(userId, tenantId, resolveOpts) {
      const roles = resolveOpts?.roles ?? ['tenant_user'];
      const persona = resolveOpts?.persona;

      // Gather permissions from roles + persona
      const rolePerms: string[] = roles.flatMap((roleId) => {
        const roleDef = policy.roles[roleId];
        return roleDef?.permissions ?? [];
      });
      const personaPerms: string[] = persona ? resolvePersonaPermissions(policy, persona) : [];
      const explicitScopes = resolveOpts?.scopes ?? [];
      const effectivePermissions = [...new Set([...rolePerms, ...personaPerms, ...explicitScopes])];

      const identity = createIdentity({
        type: 'user',
        id: userId,
        tenantId: tenantId ?? undefined,
        roles,
        ...(persona ? { persona } : {}),
      });

      return createIdentityContext(identity, { permissions: effectivePermissions });
    },

    evaluate(ctx: IdentityContext, resource: string, action: string, conditions?: Record<string, unknown>): AccessDecision {
      const permission = { resource, action, ...(conditions ? { conditions } : {}) };
      // Build allow rules only for the roles this identity actually holds so
      // wildcard permissions (e.g. `chat:*`) are matched via `matchResource`.
      // `effectivePermissions` only handles exact string matches; rules handle globs.
      const identityRoles = ctx.identity.roles ?? [];
      const roleRules: AccessRule[] = identityRoles.flatMap((roleId) => {
        const roleDef = policy.roles[roleId];
        if (!roleDef) return [];
        return roleDef.permissions.map((perm, idx) => {
          const colonIdx = perm.lastIndexOf(':');
          const ruleResource = colonIdx < 0 ? perm : perm.slice(0, colonIdx);
          const ruleAction = colonIdx < 0 ? '*' : perm.slice(colonIdx + 1);
          return {
            id: `rbac:${roleId}:${idx}`,
            name: `${roleId} — ${perm}`,
            resource: ruleResource,
            action: ruleAction,
            result: 'allow' as const,
            enabled: true,
          };
        });
      });
      return evaluateAccess(ctx, permission, [...roleRules, ...extraRules]);
    },

    validateDelegation(delegation: DelegationContext): { valid: boolean; reason?: string } {
      return validateDelegationChain(delegation);
    },
  };
}
