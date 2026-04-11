/**
 * @weaveintel/core — Identity & access contracts
 */

// ─── Runtime Identity ────────────────────────────────────────

export interface RuntimeIdentity {
  type: 'user' | 'agent' | 'service' | 'system';
  id: string;
  name?: string;
  tenantId?: string;
  roles?: string[];
  scopes?: string[];
  metadata?: Record<string, unknown>;
}

// ─── Identity Context ────────────────────────────────────────

export interface IdentityContext {
  identity: RuntimeIdentity;
  sessionId?: string;
  delegatedFrom?: RuntimeIdentity;
  effectivePermissions: string[];
  expiresAt?: string;
}

// ─── Delegation ──────────────────────────────────────────────

export interface DelegationContext {
  from: RuntimeIdentity;
  to: RuntimeIdentity;
  scopes: string[];
  reason: string;
  chain: string[];
  expiresAt?: string;
}

// ─── Access Control ──────────────────────────────────────────

export type AccessDecisionResult = 'allow' | 'deny' | 'challenge';

export interface PermissionDescriptor {
  resource: string;
  action: string;
  conditions?: Record<string, unknown>;
}

export interface AccessDecision {
  result: AccessDecisionResult;
  permission: PermissionDescriptor;
  identity: RuntimeIdentity;
  reason?: string;
  evaluatedAt: string;
}

// ─── Secrets ─────────────────────────────────────────────────

export interface SecretScope {
  id: string;
  name: string;
  tenantId?: string;
  environment?: string;
  allowedIdentities: string[];
}

export interface AccessTokenResolver {
  resolve(scope: SecretScope, identity: RuntimeIdentity): Promise<string | null>;
  revoke(scope: SecretScope, identity: RuntimeIdentity): Promise<void>;
}
