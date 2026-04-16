/**
 * @weaveintel/identity — Persona-based RBAC helpers
 */

import type { RuntimeIdentity } from '@weaveintel/core';

export interface RbacRoleDefinition {
  id: string;
  description?: string;
  permissions: string[];
}

export interface RbacPersonaDefinition {
  id: string;
  description?: string;
  roles: string[];
}

export interface RbacPolicy {
  roles: Record<string, RbacRoleDefinition>;
  personas: Record<string, RbacPersonaDefinition>;
  defaultUserPersona: string;
  defaultAgentPersona: string;
}

function matchPermission(granted: string, requested: string): boolean {
  if (granted === '*') return true;
  if (granted === requested) return true;
  if (granted.endsWith('*')) {
    const prefix = granted.slice(0, -1);
    return requested.startsWith(prefix);
  }
  return false;
}

export function resolvePersonaPermissions(policy: RbacPolicy, personaId: string): string[] {
  const persona = policy.personas[personaId];
  if (!persona) return [];

  const permissions = new Set<string>();
  for (const roleId of persona.roles) {
    const role = policy.roles[roleId];
    if (!role) continue;
    for (const permission of role.permissions) {
      permissions.add(permission);
    }
  }

  return [...permissions];
}

export function hasPersonaPermission(
  policy: RbacPolicy,
  personaId: string,
  requestedPermission: string,
): boolean {
  const permissions = resolvePersonaPermissions(policy, personaId);
  return permissions.some((permission) => matchPermission(permission, requestedPermission));
}

export function extendIdentityWithPersona(
  identity: RuntimeIdentity,
  policy: RbacPolicy,
  personaId: string,
): RuntimeIdentity {
  const persona = policy.personas[personaId];
  if (!persona) return identity;
  const personaPermissions = resolvePersonaPermissions(policy, personaId);
  const mergedRoles = new Set([...(identity.roles ?? []), ...persona.roles]);
  const mergedScopes = new Set([...(identity.scopes ?? []), ...personaPermissions]);

  return {
    ...identity,
    roles: [...mergedRoles],
    scopes: [...mergedScopes],
    persona: persona.id,
    metadata: {
      ...(identity.metadata ?? {}),
      persona: persona.id,
    },
  };
}

export const DEFAULT_RBAC_POLICY: RbacPolicy = {
  roles: {
    platform_admin: {
      id: 'platform_admin',
      description: 'Full platform control across all tenants and admin surfaces.',
      permissions: ['platform:*', 'tenant:*', 'admin:*', 'chat:*', 'dashboard:*', 'tools:*', 'agents:*', 'credentials:*'],
    },
    tenant_admin: {
      id: 'tenant_admin',
      description: 'Tenant-level administrative control.',
      permissions: ['tenant:*', 'admin:tenant:*', 'chat:*', 'dashboard:*', 'tools:use', 'tools:*', 'agents:*', 'credentials:*'],
    },
    tenant_user: {
      id: 'tenant_user',
      description: 'Standard end-user role with constrained tool access.',
      permissions: ['user:self:*', 'chat:*', 'dashboard:read', 'tools:use', 'tools:basic', 'tools:search', 'tools:time', 'tools:memory', 'credentials:*'],
    },
    agent_worker: {
      id: 'agent_worker',
      description: 'Default agent worker persona for normal tool use.',
      permissions: ['chat:*', 'tools:use', 'tools:basic', 'tools:search', 'tools:time', 'tools:memory'],
    },
    agent_researcher: {
      id: 'agent_researcher',
      description: 'Research agent persona with browser capabilities.',
      permissions: ['chat:*', 'tools:use', 'tools:basic', 'tools:search', 'tools:time', 'tools:memory', 'tools:browser:*'],
    },
    agent_supervisor: {
      id: 'agent_supervisor',
      description: 'Supervisor agent persona with broad orchestration access.',
      permissions: ['chat:*', 'tools:*', 'agents:delegate'],
    },
  },
  personas: {
    platform_admin: {
      id: 'platform_admin',
      description: 'Platform administrator persona.',
      roles: ['platform_admin'],
    },
    tenant_admin: {
      id: 'tenant_admin',
      description: 'Tenant administrator persona.',
      roles: ['tenant_admin'],
    },
    tenant_user: {
      id: 'tenant_user',
      description: 'Default user persona.',
      roles: ['tenant_user'],
    },
    agent_worker: {
      id: 'agent_worker',
      description: 'Default worker persona for agents.',
      roles: ['agent_worker'],
    },
    agent_researcher: {
      id: 'agent_researcher',
      description: 'Research-focused worker persona.',
      roles: ['agent_researcher'],
    },
    agent_supervisor: {
      id: 'agent_supervisor',
      description: 'Supervisor persona for orchestrator agents.',
      roles: ['agent_supervisor'],
    },
  },
  defaultUserPersona: 'tenant_user',
  defaultAgentPersona: 'agent_worker',
};
