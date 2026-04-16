/**
 * @weaveintel/identity — Unit tests
 */
import { describe, it, expect } from 'vitest';
import type { RuntimeIdentity } from '@weaveintel/core';
import {
  createIdentity,
  createIdentityContext,
  systemIdentity,
  agentIdentity,
  createDelegation,
  isDelegationExpired,
  isDelegationAuthorised,
  validateDelegationChain,
  evaluateAccess,
  evaluateAccessBatch,
  DEFAULT_RBAC_POLICY,
  hasPersonaPermission,
  resolvePersonaPermissions,
  extendIdentityWithPersona,
  weaveInMemoryTokenResolver,
} from '../src/index.js';
import type { AccessRule } from '../src/access.js';

// ─── Identity creation ───────────────────────────────────────

describe('createIdentity', () => {
  it('creates identity with required fields', () => {
    const id = createIdentity({ id: 'u1', type: 'user', name: 'Alice', roles: ['admin'], scopes: ['all'] });
    expect(id.id).toBe('u1');
    expect(id.type).toBe('user');
    expect(id.name).toBe('Alice');
    expect(id.roles).toEqual(['admin']);
  });

  it('defaults roles and scopes to empty', () => {
    const id = createIdentity({ id: 'u2', type: 'user' });
    expect(id.roles).toEqual([]);
    expect(id.scopes).toEqual([]);
  });

  it('includes metadata', () => {
    const id = createIdentity({ id: 'u3', type: 'user', metadata: { dept: 'eng' } });
    expect(id.metadata?.['dept']).toBe('eng');
  });
});

describe('systemIdentity', () => {
  it('returns identity with system type', () => {
    const sys = systemIdentity();
    expect(sys.type).toBe('system');
    expect(sys.id).toBe('system');
    expect(sys.name).toBe('System');
    expect(sys.roles).toContain('admin');
  });
});

describe('agentIdentity', () => {
  it('returns identity with agent type', () => {
    const agent = agentIdentity('researcher', 'Researcher Agent');
    expect(agent.type).toBe('agent');
    expect(agent.id).toBe('researcher');
    expect(agent.name).toBe('Researcher Agent');
    expect(agent.roles).toContain('agent');
  });

  it('defaults scopes to chat and tools', () => {
    const agent = agentIdentity('a1', 'Agent');
    expect(agent.scopes).toEqual(['chat', 'tools']);
  });

  it('accepts custom scopes', () => {
    const agent = agentIdentity('a2', 'Agent', ['docs']);
    expect(agent.scopes).toEqual(['docs']);
  });
});

describe('createIdentityContext', () => {
  it('creates context wrapping an identity', () => {
    const identity = createIdentity({ id: 'u1', type: 'user', roles: ['admin'] });
    const ctx = createIdentityContext(identity);
    expect(ctx.identity).toBe(identity);
    expect(ctx.effectivePermissions).toEqual([]);
  });

  it('accepts optional session and permissions', () => {
    const identity = createIdentity({ id: 'u1', type: 'user' });
    const ctx = createIdentityContext(identity, {
      sessionId: 'sess-1',
      permissions: ['chat:read'],
    });
    expect(ctx.sessionId).toBe('sess-1');
    expect(ctx.effectivePermissions).toContain('chat:read');
  });
});

// ─── Delegation ──────────────────────────────────────────────

describe('Delegation', () => {
  const alice = createIdentity({ id: 'alice', type: 'user', name: 'Alice', roles: ['admin'], scopes: ['all'] });
  const bob = createIdentity({ id: 'bob', type: 'user', name: 'Bob', roles: ['user'], scopes: ['chat'] });

  it('creates a delegation', () => {
    const d = createDelegation(alice, bob, ['chat:send'], 'task handoff');
    expect(d.from).toBe(alice);
    expect(d.to).toBe(bob);
    expect(d.scopes).toContain('chat:send');
    expect(d.reason).toBe('task handoff');
    expect(d.chain).toContain('alice');
  });

  it('detects expired delegation', () => {
    const d = createDelegation(alice, bob, ['chat:send'], 'expired', {
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(isDelegationExpired(d)).toBe(true);
  });

  it('detects valid (non-expired) delegation', () => {
    const d = createDelegation(alice, bob, ['chat:send'], 'valid', {
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(isDelegationExpired(d)).toBe(false);
  });

  it('delegation without expiresAt never expires', () => {
    const d = createDelegation(alice, bob, ['chat:send'], 'forever');
    expect(isDelegationExpired(d)).toBe(false);
  });

  it('checks scope authorisation', () => {
    const d = createDelegation(alice, bob, ['chat:send', 'chat:read'], 'test');
    expect(isDelegationAuthorised(d, 'chat:send')).toBe(true);
    expect(isDelegationAuthorised(d, 'admin:delete')).toBe(false);
  });

  it('wildcard scope authorises everything', () => {
    const d = createDelegation(alice, bob, ['*'], 'superuser');
    expect(isDelegationAuthorised(d, 'anything')).toBe(true);
  });

  it('validates a healthy delegation chain', () => {
    const d = createDelegation(alice, bob, ['chat:send'], 'ok');
    const result = validateDelegationChain(d);
    expect(result.valid).toBe(true);
  });

  it('detects circular delegation', () => {
    // Manually build a chain where to.id is already in chain
    const d = createDelegation(alice, bob, ['chat:send'], 'loop', {
      chain: ['bob'],
    });
    // chain will be ['bob', 'alice'], and to.id = 'bob' is in chain
    const result = validateDelegationChain(d);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Circular');
  });

  it('detects expired delegation in chain validation', () => {
    const d = createDelegation(alice, bob, ['chat:send'], 'expired', {
      expiresAt: new Date(Date.now() - 5000).toISOString(),
    });
    const result = validateDelegationChain(d);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('expired');
  });
});

// ─── Access control ──────────────────────────────────────────

describe('evaluateAccess', () => {
  const adminRule: AccessRule = {
    id: 'r1', name: 'admin-all', resource: '*', action: '*',
    roles: ['admin'], scopes: ['*'], result: 'allow', enabled: true,
  };
  const denyRule: AccessRule = {
    id: 'r2', name: 'deny-user-admin', resource: 'admin:*', action: '*',
    roles: ['user'], scopes: ['*'], result: 'deny', enabled: true,
  };
  const chatRule: AccessRule = {
    id: 'r3', name: 'user-chat', resource: 'chat:*', action: 'read',
    roles: ['user'], scopes: ['chat'], result: 'allow', enabled: true,
  };

  function ctx(roles: string[], scopes: string[], perms: string[] = []): ReturnType<typeof createIdentityContext> {
    const id = createIdentity({ id: 'u', type: 'user', roles, scopes });
    return createIdentityContext(id, { permissions: perms });
  }

  it('allows admin access to everything', () => {
    const decision = evaluateAccess(ctx(['admin'], ['*']), { resource: 'anything', action: 'delete' }, [adminRule]);
    expect(decision.result).toBe('allow');
  });

  it('denies user access to admin panel', () => {
    const decision = evaluateAccess(ctx(['user'], ['chat']), { resource: 'admin:settings', action: 'read' }, [denyRule, chatRule]);
    expect(decision.result).toBe('deny');
  });

  it('allows user chat access', () => {
    const decision = evaluateAccess(ctx(['user'], ['chat']), { resource: 'chat:messages', action: 'read' }, [chatRule]);
    expect(decision.result).toBe('allow');
  });

  it('defaults to deny when no rules match', () => {
    const decision = evaluateAccess(ctx(['user'], []), { resource: 'anything', action: 'read' }, []);
    expect(decision.result).toBe('deny');
  });

  it('honours explicit permissions in context', () => {
    const decision = evaluateAccess(
      ctx([], [], ['secret:read']),
      { resource: 'secret', action: 'read' },
      [],
    );
    expect(decision.result).toBe('allow');
  });

  it('skips disabled rules', () => {
    const disabled: AccessRule = { ...adminRule, enabled: false };
    const decision = evaluateAccess(ctx(['admin'], ['*']), { resource: 'foo', action: 'read' }, [disabled]);
    expect(decision.result).toBe('deny');
  });
});

describe('evaluateAccessBatch', () => {
  const rule: AccessRule = {
    id: 'r1', name: 'user-chat', resource: 'chat:*', action: '*',
    roles: ['user'], scopes: ['*'], result: 'allow', enabled: true,
  };

  it('evaluates multiple permissions', () => {
    const id = createIdentity({ id: 'u', type: 'user', roles: ['user'], scopes: ['all'] });
    const ctx = createIdentityContext(id);
    const results = evaluateAccessBatch(ctx, [
      { resource: 'chat:send', action: 'write' },
      { resource: 'admin:users', action: 'read' },
    ], [rule]);
    expect(results).toHaveLength(2);
    expect(results[0]!.result).toBe('allow');
    expect(results[1]!.result).toBe('deny');
  });
});

// ─── Token resolver ──────────────────────────────────────────

describe('weaveInMemoryTokenResolver', () => {
  const scope = { id: 'scope-1', name: 'api', allowedIdentities: ['u1', '*'] };
  const user: RuntimeIdentity = { type: 'user', id: 'u1', roles: ['user'], scopes: [] };

  it('returns null when no token stored', async () => {
    const resolver = weaveInMemoryTokenResolver();
    const token = await resolver.resolve(scope, user);
    expect(token).toBeNull();
  });

  it('returns null for non-allowed identity', async () => {
    const resolver = weaveInMemoryTokenResolver();
    const restricted = { id: 'scope-2', name: 'admin', allowedIdentities: ['admin-only'] };
    const token = await resolver.resolve(restricted, user);
    expect(token).toBeNull();
  });

  it('revokes without error', async () => {
    const resolver = weaveInMemoryTokenResolver();
    await expect(resolver.revoke(scope, user)).resolves.toBeUndefined();
  });
});

// ─── Persona RBAC ───────────────────────────────────────────

describe('persona RBAC', () => {
  it('allows platform admin platform and admin privileges', () => {
    expect(hasPersonaPermission(DEFAULT_RBAC_POLICY, 'platform_admin', 'admin:platform:write')).toBe(true);
    expect(hasPersonaPermission(DEFAULT_RBAC_POLICY, 'platform_admin', 'tools:browser:use')).toBe(true);
  });

  it('allows tenant admin tenant admin actions but denies platform admin actions', () => {
    expect(hasPersonaPermission(DEFAULT_RBAC_POLICY, 'tenant_admin', 'admin:tenant:write')).toBe(true);
    expect(hasPersonaPermission(DEFAULT_RBAC_POLICY, 'tenant_admin', 'admin:platform:write')).toBe(false);
  });

  it('allows tenant user basic tools but denies browser and admin actions', () => {
    expect(hasPersonaPermission(DEFAULT_RBAC_POLICY, 'tenant_user', 'tools:search')).toBe(true);
    expect(hasPersonaPermission(DEFAULT_RBAC_POLICY, 'tenant_user', 'tools:browser:use')).toBe(false);
    expect(hasPersonaPermission(DEFAULT_RBAC_POLICY, 'tenant_user', 'admin:tenant:write')).toBe(false);
  });

  it('allows agent researcher browser permissions', () => {
    expect(hasPersonaPermission(DEFAULT_RBAC_POLICY, 'agent_researcher', 'tools:browser:use')).toBe(true);
  });

  it('defaults to deny for unknown persona', () => {
    expect(resolvePersonaPermissions(DEFAULT_RBAC_POLICY, 'unknown_persona')).toEqual([]);
    expect(hasPersonaPermission(DEFAULT_RBAC_POLICY, 'unknown_persona', 'chat:read')).toBe(false);
    expect(hasPersonaPermission(DEFAULT_RBAC_POLICY, 'unknown_persona', 'tools:browser:use')).toBe(false);
  });

  it('extends identity with persona roles and permissions', () => {
    const base = createIdentity({ id: 'u-rbac', type: 'user', roles: ['custom-role'], scopes: ['custom:scope'] });
    const extended = extendIdentityWithPersona(base, DEFAULT_RBAC_POLICY, 'tenant_admin');
    expect(extended.persona).toBe('tenant_admin');
    expect(extended.roles).toContain('tenant_admin');
    expect(extended.roles).toContain('custom-role');
    expect(extended.scopes).toContain('admin:tenant:*');
    expect(extended.scopes).toContain('custom:scope');
  });
});
