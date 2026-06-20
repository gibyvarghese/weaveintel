/**
 * Phase 6 — `createRuntimeIdentityAdapter` unit tests.
 */

import { describe, it, expect } from 'vitest';
import { weaveRuntime, RuntimeCapabilities, weaveInMemoryPersistence } from '@weaveintel/core';
import { createRuntimeIdentityAdapter } from './runtime-identity-adapter.js';

describe('RuntimeCapabilities.Identity', () => {
  it('is advertised when identity slot is wired into weaveRuntime', () => {
    const slot = createRuntimeIdentityAdapter();
    const rt = weaveRuntime({
      installDefaultTracer: false,
      tlsFloor: false,
      persistence: weaveInMemoryPersistence(),
      identity: slot,
    });
    expect(rt.has(RuntimeCapabilities.Identity)).toBe(true);
  });

  it('is NOT advertised when identity slot is omitted', () => {
    const rt = weaveRuntime({ installDefaultTracer: false, tlsFloor: false });
    expect(rt.has(RuntimeCapabilities.Identity)).toBe(false);
  });
});

describe('createRuntimeIdentityAdapter — structural shape', () => {
  it('exposes resolve, evaluate, validateDelegation', () => {
    const slot = createRuntimeIdentityAdapter();
    expect(typeof slot.resolve).toBe('function');
    expect(typeof slot.evaluate).toBe('function');
    expect(typeof slot.validateDelegation).toBe('function');
  });
});

describe('resolve', () => {
  it('returns an IdentityContext with the provided userId', () => {
    const slot = createRuntimeIdentityAdapter();
    const ctx = slot.resolve('user-123', 'tenant-1');
    expect(ctx.identity.id).toBe('user-123');
    expect(ctx.identity.tenantId).toBe('tenant-1');
  });

  it('defaults to tenant_user role when no roles supplied', () => {
    const slot = createRuntimeIdentityAdapter();
    const ctx = slot.resolve('user-abc', null);
    expect(ctx.identity.roles).toContain('tenant_user');
  });

  it('sets persona when supplied', () => {
    const slot = createRuntimeIdentityAdapter();
    const ctx = slot.resolve('agent-1', null, { roles: ['agent_worker'], persona: 'agent_worker' });
    expect(ctx.identity.persona).toBe('agent_worker');
  });

  it('includes permissions from requested role', () => {
    const slot = createRuntimeIdentityAdapter();
    const ctx = slot.resolve('user-perm', null, { roles: ['tenant_user'] });
    // tenant_user gets chat:* at minimum
    expect(ctx.effectivePermissions.some((p) => p.startsWith('chat:'))).toBe(true);
  });
});

describe('evaluate', () => {
  it('allows access for a permission the identity holds', () => {
    const slot = createRuntimeIdentityAdapter();
    const ctx = slot.resolve('user-chat', null, { roles: ['tenant_user'] });
    const decision = slot.evaluate(ctx, 'chat', 'send');
    expect(decision.result).toBe('allow');
  });

  it('denies access for a resource the identity does not hold', () => {
    const slot = createRuntimeIdentityAdapter();
    const ctx = slot.resolve('user-basic', null, { roles: ['tenant_user'] });
    const decision = slot.evaluate(ctx, 'admin', 'delete-all');
    expect(decision.result).toBe('deny');
  });

  it('platform_admin can access platform:* resources', () => {
    const slot = createRuntimeIdentityAdapter();
    const ctx = slot.resolve('admin-user', null, { roles: ['platform_admin'] });
    const decision = slot.evaluate(ctx, 'platform', 'write');
    expect(decision.result).toBe('allow');
  });
});

describe('validateDelegation', () => {
  const userA = { type: 'user' as const, id: 'user-a', roles: [], scopes: [], metadata: {} };
  const agentB = { type: 'agent' as const, id: 'agent-1', roles: [], scopes: [], metadata: {} };

  it('returns valid: true for a well-formed single-hop delegation', () => {
    const slot = createRuntimeIdentityAdapter();
    const delegation = {
      from: userA,
      to: agentB,
      scopes: ['read'],
      reason: 'test',
      chain: ['user-a'],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const result = slot.validateDelegation(delegation);
    expect(result.valid).toBe(true);
  });

  it('returns { valid: false } for an expired delegation', () => {
    const slot = createRuntimeIdentityAdapter();
    const delegation = {
      from: userA,
      to: agentB,
      scopes: ['read'],
      reason: 'test',
      chain: ['user-b'],
      expiresAt: new Date(Date.now() - 60_000).toISOString(), // already expired
    };
    const result = slot.validateDelegation(delegation);
    expect(result.valid).toBe(false);
  });
});
