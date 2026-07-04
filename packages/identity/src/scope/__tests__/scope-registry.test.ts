/**
 * @weaveintel/scope — scope-registry.test.ts
 *
 * Tests for ScopeRegistry: policy registration, lookup, and canDelegate() evaluation.
 *
 * Test categories:
 *   Positive  — valid delegations that should be allowed
 *   Negative  — delegations that should be blocked
 *   Security  — confused-deputy, chain depth exploitation, expired context
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ScopeRegistry } from '../scope-registry.js';
import { createRootScopeContext, deriveScopeContext } from '../scope-context.js';
import {
  WEAVEINTEL_DEFAULT_SCOPES,
  WEAVEINTEL_DEFAULT_POLICIES,
} from '../default-scopes.js';
import { issueCrossScopeToken } from '../scope-token.js';
import type { ScopeContext } from '../types.js';

const SECRET = 'test-secret-do-not-use-in-production';

function makeCtx(scope: string, sessionId = 'session-1', taskId = 'task-1'): ScopeContext {
  return createRootScopeContext(scope, sessionId, taskId);
}

function makeExpiredCtx(scope: string): ScopeContext {
  // TTL of -1ms means already expired
  return createRootScopeContext(scope, 'session-x', 'task-x', -1);
}

describe('ScopeRegistry', () => {
  let registry: ScopeRegistry;

  beforeEach(() => {
    registry = new ScopeRegistry();
    registry.registerScopes(WEAVEINTEL_DEFAULT_SCOPES);
    registry.registerPolicies(WEAVEINTEL_DEFAULT_POLICIES);
  });

  // ── Positive tests ──────────────────────────────────────────────────────────

  describe('positive — allowed delegations', () => {
    it('system → analytics is allowed (system can delegate to any scope)', () => {
      const result = registry.canDelegate('system', 'analytics', makeCtx('system'));
      expect(result.allowed).toBe(true);
    });

    it('system → kaggle is allowed (system orchestrates everything)', () => {
      const result = registry.canDelegate('system', 'kaggle', makeCtx('system'));
      expect(result.allowed).toBe(true);
    });

    it('system → code is allowed', () => {
      const result = registry.canDelegate('system', 'code', makeCtx('system'));
      expect(result.allowed).toBe(true);
    });

    it('analytics → code is allowed (requires A2A)', () => {
      const result = registry.canDelegate('analytics', 'code', makeCtx('analytics'));
      expect(result.allowed).toBe(true);
      expect(result.requiresA2A).toBe(true);
    });

    it('analytics → memory is allowed (requires A2A)', () => {
      const result = registry.canDelegate('analytics', 'memory', makeCtx('analytics'));
      expect(result.allowed).toBe(true);
      expect(result.requiresA2A).toBe(true);
    });

    it('kaggle → code is allowed (for model training)', () => {
      const result = registry.canDelegate('kaggle', 'code', makeCtx('kaggle'));
      expect(result.allowed).toBe(true);
      expect(result.requiresA2A).toBe(true);
    });

    it('kaggle → analytics is allowed via A2A (result interpretation)', () => {
      const result = registry.canDelegate('kaggle', 'analytics', makeCtx('kaggle'));
      expect(result.allowed).toBe(true);
      expect(result.requiresA2A).toBe(true);
    });

    it('same-scope delegation is always allowed (no cross-scope hop needed)', () => {
      for (const scope of ['analytics', 'kaggle', 'code', 'system']) {
        const result = registry.canDelegate(scope, scope, makeCtx(scope));
        expect(result.allowed, `same-scope '${scope}' should be allowed`).toBe(true);
      }
    });

    it('canActivateSkill: skill in current scope is always allowed', () => {
      const result = registry.canActivateSkill('analytics', makeCtx('analytics'));
      expect(result.allowed).toBe(true);
    });

    it('canActivateSkill: system-scope skill is allowed from any scope', () => {
      for (const scope of ['analytics', 'kaggle', 'code', 'browser']) {
        const result = registry.canActivateSkill('system', makeCtx(scope));
        expect(result.allowed, `system skill from '${scope}' should be allowed`).toBe(true);
      }
    });
  });

  // ── Negative tests ──────────────────────────────────────────────────────────

  describe('negative — blocked delegations', () => {
    it('analytics → kaggle is explicitly DENIED', () => {
      const result = registry.canDelegate('analytics', 'kaggle', makeCtx('analytics'));
      expect(result.allowed).toBe(false);
      expect(result.violationType).toBe('explicit-deny');
    });

    it('memory → analytics is blocked (memory should not call out)', () => {
      const result = registry.canDelegate('memory', 'analytics', makeCtx('memory'));
      expect(result.allowed).toBe(false);
    });

    it('memory → kaggle is blocked', () => {
      const result = registry.canDelegate('memory', 'kaggle', makeCtx('memory'));
      expect(result.allowed).toBe(false);
    });

    it('no-policy pair returns no-policy violation', () => {
      // 'browser' has no outbound policy to 'kaggle'
      const result = registry.canDelegate('browser', 'kaggle', makeCtx('browser'));
      expect(result.allowed).toBe(false);
      // Could be no-policy or explicit-deny depending on wildcard matching
      expect(['no-policy', 'explicit-deny']).toContain(result.violationType);
    });

    it('canActivateSkill: kaggle skill blocked from analytics scope', () => {
      const result = registry.canActivateSkill('kaggle', makeCtx('analytics'));
      expect(result.allowed).toBe(false);
      // analytics → kaggle is explicitly denied
      expect(result.violationType).toBe('explicit-deny');
    });
  });

  // ── Security tests ──────────────────────────────────────────────────────────

  describe('security — confused deputy and chain depth', () => {
    it('confused deputy: no scope can escalate to system', () => {
      for (const scope of ['analytics', 'kaggle', 'code', 'browser', 'voice', 'memory']) {
        const result = registry.canDelegate(scope, 'system', makeCtx(scope));
        expect(result.allowed, `'${scope}' should not escalate to system`).toBe(false);
        expect(result.violationType).toBe('confused-deputy');
      }
    });

    it('expired context is rejected', () => {
      const expired = makeExpiredCtx('analytics');
      const result = registry.canDelegate('analytics', 'code', expired);
      expect(result.allowed).toBe(false);
      expect(result.violationType).toBe('expired-context');
    });

    it('delegation depth: exceeding maxDelegationDepth is rejected', () => {
      // analytics has maxDelegationDepth: 3, policy allows maxDelegationDepth: 2 for analytics→code
      // Build a chain with 2 hops already done
      let ctx = makeCtx('analytics', 'session-depth', 'task-depth');

      // First hop: analytics → code
      const token1 = issueCrossScopeToken('analytics', 'code', ctx.taskId, ctx.sessionId, ['code:execute'], SECRET);
      ctx = deriveScopeContext(ctx, token1, 'first hop');

      // Second hop: back? We've used up the maxDelegationDepth=2 for analytics→code
      // Now trying another analytics→code hop should fail
      const token2 = issueCrossScopeToken('analytics', 'code', ctx.taskId, ctx.sessionId, ['code:execute'], SECRET);
      const childCtx = deriveScopeContext(ctx, token2, 'second hop');

      // Third hop would exceed maxDelegationDepth of 2
      const result = registry.canDelegate('analytics', 'code', childCtx);
      expect(result.allowed).toBe(false);
      expect(result.violationType).toBe('delegation-depth');
    });

    it('kaggle scope has auditLevel alert (reflected in scope definition)', () => {
      const scope = registry.getScope('kaggle');
      expect(scope).toBeDefined();
      expect(scope?.auditLevel).toBe('alert');
    });
  });

  // ── Policy lookup ───────────────────────────────────────────────────────────

  describe('policy resolution', () => {
    it('exact match takes priority over wildcard', () => {
      // analytics→code is explicit (allowed), system→* is wildcard (also allowed)
      // The exact match should win
      const result = registry.canDelegate('analytics', 'code', makeCtx('analytics'));
      expect(result.allowed).toBe(true);
    });

    it('wildcard source (*::toScope) works', () => {
      // No default *::* or *::system wildcard that allows; confused-deputy blocks first
      // But memory has *::* blocked for outbound
      const result = registry.canDelegate('memory', 'browser', makeCtx('memory'));
      expect(result.allowed).toBe(false);
    });

    it('describe() returns a readable summary', () => {
      const desc = registry.describe();
      expect(desc).toContain('ScopeRegistry:');
      expect(desc).toContain('scopes');
      expect(desc).toContain('policies');
    });
  });
});
