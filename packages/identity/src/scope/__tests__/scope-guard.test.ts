/**
 * @weaveintel/scope — scope-guard.test.ts
 *
 * Tests for ScopeGuard: the main enforcement layer.
 *
 * Test categories:
 *   Positive  — valid operations that should pass
 *   Negative  — operations that should be blocked
 *   Security  — confused deputy, scope escalation, audit callback
 *   Stress    — rapid consecutive checks, large delegation chains
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScopeGuard } from '../scope-guard.js';
import { ScopeRegistry } from '../scope-registry.js';
import { createRootScopeContext, deriveScopeContext } from '../scope-context.js';
import {
  WEAVEINTEL_DEFAULT_SCOPES,
  WEAVEINTEL_DEFAULT_POLICIES,
} from '../default-scopes.js';
import { ScopeViolationError } from '../errors.js';
import { issueCrossScopeToken } from '../scope-token.js';
import type { ScopeContext } from '../types.js';

const SECRET = 'test-secret-do-not-use-in-production';

function makeRegistry(): ScopeRegistry {
  const r = new ScopeRegistry();
  r.registerScopes(WEAVEINTEL_DEFAULT_SCOPES);
  r.registerPolicies(WEAVEINTEL_DEFAULT_POLICIES);
  return r;
}

function makeCtx(scope: string): ScopeContext {
  return createRootScopeContext(scope, 'sess-1', 'task-1');
}

describe('ScopeGuard', () => {
  let registry: ScopeRegistry;
  let guard: ScopeGuard;

  beforeEach(() => {
    registry = makeRegistry();
    guard = new ScopeGuard(registry, { enforce: true, tokenSecret: SECRET });
  });

  // ── Positive: skill activation ──────────────────────────────────────────────

  describe('positive — checkSkillActivation', () => {
    it('allows analytics skill from analytics context', () => {
      const result = guard.checkSkillActivation('analytics', makeCtx('analytics'), 'data-pipeline');
      expect(result.allowed).toBe(true);
    });

    it('allows system skill from any context (system = shared utility)', () => {
      const scopes = ['analytics', 'kaggle', 'code', 'browser'];
      for (const scope of scopes) {
        const result = guard.checkSkillActivation('system', makeCtx(scope), 'supervisor-orchestration');
        expect(result.allowed, `system skill should be accessible from '${scope}'`).toBe(true);
      }
    });

    it('allows code skill from code context', () => {
      const result = guard.checkSkillActivation('code', makeCtx('code'), 'code-execution');
      expect(result.allowed).toBe(true);
    });
  });

  // ── Negative: skill activation blocked ─────────────────────────────────────

  describe('negative — checkSkillActivation blocked', () => {
    it('blocks kaggle skill from analytics context', () => {
      const result = guard.checkSkillActivation('kaggle', makeCtx('analytics'), 'kaggle-competition');
      expect(result.allowed).toBe(false);
      expect(result.violationType).toBe('explicit-deny');
    });

    it('blocks memory skill from memory context calling analytics', () => {
      // memory scope cannot call out to analytics
      const result = guard.checkSkillActivation('analytics', makeCtx('memory'), 'data-pipeline');
      expect(result.allowed).toBe(false);
    });
  });

  // ── Positive: A2A delegation ────────────────────────────────────────────────

  describe('positive — checkA2ADelegation', () => {
    it('analytics → code: allowed with requiresA2A', () => {
      const result = guard.checkA2ADelegation('analytics', 'code', makeCtx('analytics'));
      expect(result.allowed).toBe(true);
      expect(result.requiresA2A).toBe(true);
    });

    it('system → kaggle: allowed without requiring A2A (supervisor authority)', () => {
      const result = guard.checkA2ADelegation('system', 'kaggle', makeCtx('system'));
      expect(result.allowed).toBe(true);
      expect(result.requiresA2A).toBe(false);  // system delegates directly
    });

    it('kaggle → analytics: allowed via A2A (result interpretation)', () => {
      const result = guard.checkA2ADelegation('kaggle', 'analytics', makeCtx('kaggle'));
      expect(result.allowed).toBe(true);
      expect(result.requiresA2A).toBe(true);
    });
  });

  // ── Negative: A2A delegation blocked ───────────────────────────────────────

  describe('negative — checkA2ADelegation blocked', () => {
    it('analytics → kaggle: blocked (the core isolation boundary)', () => {
      const result = guard.checkA2ADelegation('analytics', 'kaggle', makeCtx('analytics'));
      expect(result.allowed).toBe(false);
      expect(result.violationType).toBe('explicit-deny');
    });

    it('returns reason string for blocked delegation', () => {
      const result = guard.checkA2ADelegation('analytics', 'kaggle', makeCtx('analytics'));
      expect(result.allowed).toBe(false);
      expect(result.reason).toBeTruthy();
      expect(typeof result.reason).toBe('string');
    });
  });

  // ── Token issuance ──────────────────────────────────────────────────────────

  describe('token issuance', () => {
    it('issues a valid CrossScopeToken for an allowed delegation', () => {
      const ctx = makeCtx('analytics');
      const token = guard.issueDelegationToken('analytics', 'code', ctx, ['code:execute']);
      expect(token.fromScope).toBe('analytics');
      expect(token.toScope).toBe('code');
      expect(token.taskId).toBe(ctx.taskId);
      expect(token.sessionId).toBe(ctx.sessionId);
      expect(token.permissions).toContain('code:execute');
    });

    it('issued token can be used to derive a child context', () => {
      const ctx = makeCtx('analytics');
      const token = guard.issueDelegationToken('analytics', 'code', ctx, ['code:execute']);
      const childCtx = deriveScopeContext(ctx, token, 'run analysis script');
      expect(childCtx.currentScope).toBe('code');
      expect(childCtx.delegationChain).toHaveLength(1);
      expect(childCtx.delegationChain[0]?.fromScope).toBe('analytics');
      expect(childCtx.delegationChain[0]?.toScope).toBe('code');
    });
  });

  // ── Tool invocation ─────────────────────────────────────────────────────────

  describe('checkToolInvocation', () => {
    it('allows tool with no scope restriction from any context', () => {
      const result = guard.checkToolInvocation('datetime', [], makeCtx('analytics'));
      expect(result.allowed).toBe(true);
    });

    it('allows tool when current scope is in allowed list', () => {
      const result = guard.checkToolInvocation('python_exec', ['code'], makeCtx('code'));
      expect(result.allowed).toBe(true);
    });

    it('blocks tool when current scope is not in allowed list', () => {
      const result = guard.checkToolInvocation('python_exec', ['code'], makeCtx('analytics'));
      expect(result.allowed).toBe(false);
      expect(result.violationType).toBe('scope-boundary');
    });

    it('allows tool with wildcard scope', () => {
      const result = guard.checkToolInvocation('search_web', ['*'], makeCtx('analytics'));
      expect(result.allowed).toBe(true);
    });
  });

  // ── Audit callback ──────────────────────────────────────────────────────────

  describe('audit callback (onCheck)', () => {
    it('calls onCheck after every skill activation check', () => {
      const onCheck = vi.fn();
      const g = new ScopeGuard(registry, { enforce: true, tokenSecret: SECRET, onCheck });
      g.checkSkillActivation('analytics', makeCtx('analytics'), 'data-pipeline');
      expect(onCheck).toHaveBeenCalledTimes(1);
      expect(onCheck.mock.calls[0]?.[0].checkType).toBe('skill');
    });

    it('calls onCheck with violation details when blocked', () => {
      const onCheck = vi.fn();
      const g = new ScopeGuard(registry, { enforce: true, tokenSecret: SECRET, onCheck });
      g.checkSkillActivation('kaggle', makeCtx('analytics'), 'kaggle-competition');
      expect(onCheck).toHaveBeenCalledTimes(1);
      const event = onCheck.mock.calls[0]?.[0];
      expect(event.result.allowed).toBe(false);
      expect(event.fromScope).toBe('analytics');
      expect(event.toScope).toBe('kaggle');
    });

    it('does not throw when onCheck is async', async () => {
      const onCheck = vi.fn().mockResolvedValue(undefined);
      const g = new ScopeGuard(registry, { enforce: true, tokenSecret: SECRET, onCheck });
      expect(() => g.checkSkillActivation('analytics', makeCtx('analytics'))).not.toThrow();
    });
  });

  // ── Audit-only mode ─────────────────────────────────────────────────────────

  describe('audit-only mode (enforce=false)', () => {
    it('returns allowed=true even for blocked delegations', () => {
      const auditGuard = new ScopeGuard(registry, { enforce: false, tokenSecret: SECRET });
      const result = auditGuard.checkA2ADelegation('analytics', 'kaggle', makeCtx('analytics'));
      // audit-only: allowed=true, but the reason contains [audit-only]
      expect(result.allowed).toBe(true);
      expect(result.reason).toContain('[audit-only]');
    });

    it('still reports violationType in audit-only mode', () => {
      const auditGuard = new ScopeGuard(registry, { enforce: false, tokenSecret: SECRET });
      const result = auditGuard.checkSkillActivation('kaggle', makeCtx('analytics'));
      expect(result.allowed).toBe(true);
      expect(result.violationType).toBe('explicit-deny');
    });
  });

  // ── Security: ScopeViolationError usage ────────────────────────────────────

  describe('security — ScopeViolationError', () => {
    it('ScopeViolationError carries the full check result', () => {
      const result = guard.checkA2ADelegation('analytics', 'kaggle', makeCtx('analytics'));
      const error = new ScopeViolationError(result.reason!, result);
      expect(error.name).toBe('ScopeViolationError');
      expect(error.checkResult.allowed).toBe(false);
      expect(error.checkResult.violationType).toBe('explicit-deny');
      expect(error.message).toBeTruthy();
    });
  });

  // ── Stress: rapid consecutive checks ───────────────────────────────────────

  describe('stress — rapid consecutive checks', () => {
    it('handles 10,000 skill activation checks without degradation', () => {
      const ctx = makeCtx('analytics');
      const start = Date.now();
      for (let i = 0; i < 10_000; i++) {
        guard.checkSkillActivation('analytics', ctx, 'data-pipeline');
      }
      const elapsed = Date.now() - start;
      // 10k checks should complete in well under 1 second
      expect(elapsed).toBeLessThan(1000);
    });

    it('handles concurrent delegation check + token issuance', () => {
      const ctx = makeCtx('analytics');
      const results = Array.from({ length: 100 }, () => {
        const r = guard.checkA2ADelegation('analytics', 'code', ctx);
        if (r.allowed && r.requiresA2A) {
          return guard.issueDelegationToken('analytics', 'code', ctx, ['code:execute']);
        }
        return null;
      });
      expect(results.every((r) => r !== null)).toBe(true);
      // All tokens should be unique (different IDs)
      const ids = results.map((r) => r?.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(100);
    });

    it('handles deep delegation chains without crashing', () => {
      // Build a long chain of kaggle→code delegations (kaggle allows up to 3 cross-scope hops)
      let ctx = makeCtx('kaggle');
      for (let i = 0; i < 3; i++) {
        const checkResult = guard.checkA2ADelegation('kaggle', 'code', ctx);
        if (!checkResult.allowed) break;
        const token = issueCrossScopeToken('kaggle', 'code', ctx.taskId, ctx.sessionId, ['code:execute'], SECRET);
        ctx = deriveScopeContext(ctx, token, `hop ${i + 1}`);
      }
      // At depth 3, further hops should be blocked
      const final = guard.checkA2ADelegation('kaggle', 'code', ctx);
      expect(final.allowed).toBe(false);
      expect(final.violationType).toBe('delegation-depth');
    });
  });
});
