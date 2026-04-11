/**
 * @weaveintel/identity — Access control evaluator
 *
 * Evaluates access decisions against identity permissions,
 * roles, and configurable access rules.
 */

import type {
  RuntimeIdentity,
  IdentityContext,
  PermissionDescriptor,
  AccessDecision,
  AccessDecisionResult,
} from '@weaveintel/core';

/** An access rule used by the evaluator. */
export interface AccessRule {
  id: string;
  name: string;
  resource: string;       // glob-style, e.g. "chat:*" or "admin:settings"
  action: string;         // "read" | "write" | "delete" | "*"
  roles?: string[];       // allow if identity has any of these roles
  scopes?: string[];      // allow if identity has any of these scopes
  result: AccessDecisionResult;
  enabled: boolean;
}

/** Evaluate a single permission against identity context and rules. */
export function evaluateAccess(
  ctx: IdentityContext,
  permission: PermissionDescriptor,
  rules: AccessRule[],
): AccessDecision {
  const now = new Date().toISOString();
  const identity = ctx.identity;

  // Check context expiry
  if (ctx.expiresAt && new Date(ctx.expiresAt).getTime() < Date.now()) {
    return {
      result: 'deny',
      permission,
      identity,
      reason: 'Identity context has expired',
      evaluatedAt: now,
    };
  }

  // Check explicit permissions first
  const permKey = `${permission.resource}:${permission.action}`;
  if (ctx.effectivePermissions.includes(permKey) || ctx.effectivePermissions.includes('*')) {
    return { result: 'allow', permission, identity, reason: 'Explicit permission', evaluatedAt: now };
  }

  // Evaluate rules in order — first match wins
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!matchResource(rule.resource, permission.resource)) continue;
    if (rule.action !== '*' && rule.action !== permission.action) continue;

    // Role match
    if (rule.roles && rule.roles.length > 0) {
      const hasRole = identity.roles?.some((r) => rule.roles!.includes(r));
      if (hasRole) {
        return { result: rule.result, permission, identity, reason: `Rule: ${rule.name}`, evaluatedAt: now };
      }
    }

    // Scope match
    if (rule.scopes && rule.scopes.length > 0) {
      const hasScope = identity.scopes?.some((s) => rule.scopes!.includes(s));
      if (hasScope) {
        return { result: rule.result, permission, identity, reason: `Rule: ${rule.name}`, evaluatedAt: now };
      }
    }

    // No role/scope constraints — rule applies to everyone
    if (!rule.roles?.length && !rule.scopes?.length) {
      return { result: rule.result, permission, identity, reason: `Rule: ${rule.name}`, evaluatedAt: now };
    }
  }

  // Default deny
  return { result: 'deny', permission, identity, reason: 'No matching rule', evaluatedAt: now };
}

/** Check multiple permissions at once. */
export function evaluateAccessBatch(
  ctx: IdentityContext,
  permissions: PermissionDescriptor[],
  rules: AccessRule[],
): AccessDecision[] {
  return permissions.map((p) => evaluateAccess(ctx, p, rules));
}

// ── Helpers ──────────────────────────────────────────────────

function matchResource(pattern: string, resource: string): boolean {
  if (pattern === '*') return true;
  if (pattern === resource) return true;
  // Simple glob: "chat:*" matches "chat:send", "chat:read", etc.
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -1);
    return resource.startsWith(prefix);
  }
  return false;
}
