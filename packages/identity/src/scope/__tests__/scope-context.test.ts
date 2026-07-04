/**
 * @weaveintel/scope — scope-context.test.ts
 *
 * Tests for ScopeContext factory functions.
 */
import { describe, it, expect } from 'vitest';
import {
  createRootScopeContext,
  deriveScopeContext,
  getScopeDepth,
  getCrossScopeHopCount,
  isScopeContextExpired,
  formatDelegationChain,
  hasPermission,
} from '../scope-context.js';
import { issueCrossScopeToken } from '../scope-token.js';

const SECRET = 'test-secret-do-not-use-in-production';

describe('ScopeContext', () => {
  describe('createRootScopeContext', () => {
    it('creates a root context with correct defaults', () => {
      const ctx = createRootScopeContext('analytics', 'session-1', 'task-1');
      expect(ctx.currentScope).toBe('analytics');
      expect(ctx.sessionId).toBe('session-1');
      expect(ctx.taskId).toBe('task-1');
      expect(ctx.delegationChain).toHaveLength(0);
      expect(ctx.expiresAt).toBeGreaterThan(Date.now());
      // Root scope has wildcard permission for its own scope
      expect(ctx.permissions).toContain('analytics:*');
    });

    it('generates a taskId when not provided', () => {
      const ctx = createRootScopeContext('system', 'session-2');
      expect(ctx.taskId).toBeTruthy();
      expect(typeof ctx.taskId).toBe('string');
    });

    it('respects custom TTL', () => {
      const ttl = 1000; // 1 second
      const before = Date.now();
      const ctx = createRootScopeContext('system', 'session-3', 'task-3', ttl);
      expect(ctx.expiresAt).toBeGreaterThanOrEqual(before + ttl);
    });
  });

  describe('deriveScopeContext', () => {
    it('creates child context with new scope', () => {
      const parent = createRootScopeContext('analytics', 'session-1', 'task-1');
      const token = issueCrossScopeToken('analytics', 'code', parent.taskId, parent.sessionId, ['code:execute'], SECRET);
      const child = deriveScopeContext(parent, token, 'run analysis script');
      expect(child.currentScope).toBe('code');
      expect(child.sessionId).toBe(parent.sessionId);
      expect(child.taskId).toBe(parent.taskId);
    });

    it('extends the delegation chain', () => {
      const parent = createRootScopeContext('analytics', 's', 't');
      const token = issueCrossScopeToken('analytics', 'code', 't', 's', ['code:execute'], SECRET);
      const child = deriveScopeContext(parent, token, 'hop 1');
      expect(child.delegationChain).toHaveLength(1);
      expect(child.delegationChain[0]?.fromScope).toBe('analytics');
      expect(child.delegationChain[0]?.toScope).toBe('code');
      expect(child.delegationChain[0]?.reason).toBe('hop 1');
    });

    it('uses the more restrictive expiry (parent vs token)', () => {
      const parent = createRootScopeContext('analytics', 's', 't', 5000); // expires in 5s
      const token = issueCrossScopeToken('analytics', 'code', 't', 's', ['code:execute'], SECRET, 60_000); // 60s
      const child = deriveScopeContext(parent, token, 'test');
      // child should expire no later than parent
      expect(child.expiresAt).toBeLessThanOrEqual(parent.expiresAt + 10); // +10ms tolerance
    });

    it('grants only the permissions in the token (no permission widening)', () => {
      const parent = createRootScopeContext('analytics', 's', 't');
      // Parent has analytics:* — but token only grants code:execute
      const token = issueCrossScopeToken('analytics', 'code', 't', 's', ['code:execute'], SECRET);
      const child = deriveScopeContext(parent, token, 'test');
      // The child should NOT have analytics:* (it's in the code scope now)
      expect(child.permissions).not.toContain('analytics:*');
      expect(child.permissions).toContain('code:execute');
    });
  });

  describe('getScopeDepth and getCrossScopeHopCount', () => {
    it('returns 0 depth for root context', () => {
      const ctx = createRootScopeContext('system', 's', 't');
      expect(getScopeDepth(ctx)).toBe(0);
      expect(getCrossScopeHopCount(ctx)).toBe(0);
    });

    it('increments depth on each derivation', () => {
      let ctx = createRootScopeContext('analytics', 's', 't');
      const t1 = issueCrossScopeToken('analytics', 'code', 't', 's', [], SECRET);
      ctx = deriveScopeContext(ctx, t1, 'hop 1');
      expect(getScopeDepth(ctx)).toBe(1);
      expect(getCrossScopeHopCount(ctx)).toBe(1);

      const t2 = issueCrossScopeToken('code', 'memory', 't', 's', [], SECRET);
      ctx = deriveScopeContext(ctx, t2, 'hop 2');
      expect(getScopeDepth(ctx)).toBe(2);
      expect(getCrossScopeHopCount(ctx)).toBe(2);
    });
  });

  describe('isScopeContextExpired', () => {
    it('returns false for fresh context', () => {
      const ctx = createRootScopeContext('analytics', 's', 't');
      expect(isScopeContextExpired(ctx)).toBe(false);
    });

    it('returns true for expired context', () => {
      const ctx = createRootScopeContext('analytics', 's', 't', -1);
      expect(isScopeContextExpired(ctx)).toBe(true);
    });
  });

  describe('formatDelegationChain', () => {
    it('returns just scope name for root context', () => {
      const ctx = createRootScopeContext('analytics', 's', 't');
      expect(formatDelegationChain(ctx)).toBe('analytics');
    });

    it('formats chain correctly', () => {
      let ctx = createRootScopeContext('system', 's', 't');
      const t1 = issueCrossScopeToken('system', 'analytics', 't', 's', [], SECRET);
      ctx = deriveScopeContext(ctx, t1, 'route to analytics');
      const t2 = issueCrossScopeToken('analytics', 'code', 't', 's', [], SECRET);
      ctx = deriveScopeContext(ctx, t2, 'run script');
      expect(formatDelegationChain(ctx)).toBe('system→analytics→code');
    });
  });

  describe('hasPermission', () => {
    it('exact permission match', () => {
      const ctx = createRootScopeContext('code', 's', 't');
      // Root context has 'code:*' which covers 'code:execute'
      expect(hasPermission(ctx, 'code:execute')).toBe(true);
    });

    it('wildcard scope:* grants all actions', () => {
      const ctx = createRootScopeContext('analytics', 's', 't');
      expect(hasPermission(ctx, 'analytics:read')).toBe(true);
      expect(hasPermission(ctx, 'analytics:write')).toBe(true);
    });

    it('permission in different scope not granted', () => {
      const ctx = createRootScopeContext('analytics', 's', 't');
      // analytics:* does not grant kaggle:*
      expect(hasPermission(ctx, 'kaggle:read')).toBe(false);
    });
  });
});
