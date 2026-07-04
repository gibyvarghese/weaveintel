/**
 * @weaveintel/scope — scope-token.test.ts
 *
 * Tests for CrossScopeToken issuance and validation.
 *
 * Test categories:
 *   Positive  — valid token creation and validation
 *   Negative  — expired, wrong binding, malformed tokens
 *   Security  — signature tampering, scope widening, token replay
 */
import { describe, it, expect } from 'vitest';
import {
  issueCrossScopeToken,
  validateCrossScopeToken,
  isCrossScopeTokenExpired,
  describeCrossScopeToken,
} from '../scope-token.js';
import { InvalidScopeTokenError } from '../errors.js';

const SECRET = 'test-secret-do-not-use-in-production';
const FROM = 'analytics';
const TO = 'code';
const TASK_ID = 'task-abc';
const SESSION_ID = 'session-xyz';
const PERMS = ['code:execute', 'code:read'];

describe('CrossScopeToken', () => {
  // ── Positive tests ──────────────────────────────────────────────────────────

  describe('positive — valid token lifecycle', () => {
    it('issues a token with expected fields', () => {
      const token = issueCrossScopeToken(FROM, TO, TASK_ID, SESSION_ID, PERMS, SECRET);
      expect(token.fromScope).toBe(FROM);
      expect(token.toScope).toBe(TO);
      expect(token.taskId).toBe(TASK_ID);
      expect(token.sessionId).toBe(SESSION_ID);
      expect(token.permissions).toEqual(PERMS);
      expect(token.id).toMatch(/^[0-9a-f-]{36}$/);  // UUID v4
      expect(token.signature).toBeTruthy();
      expect(token.issuedAt).toBeLessThanOrEqual(Date.now());
      expect(token.expiresAt).toBeGreaterThan(Date.now());
    });

    it('validates a freshly issued token successfully', () => {
      const token = issueCrossScopeToken(FROM, TO, TASK_ID, SESSION_ID, PERMS, SECRET);
      expect(() => validateCrossScopeToken(token, SECRET, TASK_ID, SESSION_ID)).not.toThrow();
    });

    it('isCrossScopeTokenExpired returns false for a fresh token', () => {
      const token = issueCrossScopeToken(FROM, TO, TASK_ID, SESSION_ID, PERMS, SECRET);
      expect(isCrossScopeTokenExpired(token)).toBe(false);
    });

    it('isCrossScopeTokenExpired returns true for an already-expired token', () => {
      const token = issueCrossScopeToken(FROM, TO, TASK_ID, SESSION_ID, PERMS, SECRET, -1);
      expect(isCrossScopeTokenExpired(token)).toBe(true);
    });

    it('different secrets produce different signatures', () => {
      const t1 = issueCrossScopeToken(FROM, TO, TASK_ID, SESSION_ID, PERMS, 'secret-a');
      const t2 = issueCrossScopeToken(FROM, TO, TASK_ID, SESSION_ID, PERMS, 'secret-b');
      expect(t1.signature).not.toBe(t2.signature);
    });

    it('describeCrossScopeToken returns a human-readable string', () => {
      const token = issueCrossScopeToken(FROM, TO, TASK_ID, SESSION_ID, PERMS, SECRET);
      const desc = describeCrossScopeToken(token);
      expect(desc).toContain('analytics→code');
      expect(desc).toContain('code:execute');
      // Should NOT contain the full signature (security)
      expect(desc).not.toContain(token.signature);
    });

    it('custom TTL is respected', () => {
      const ttl = 5 * 60 * 1000; // 5 minutes
      const before = Date.now();
      const token = issueCrossScopeToken(FROM, TO, TASK_ID, SESSION_ID, PERMS, SECRET, ttl);
      const after = Date.now();
      expect(token.expiresAt).toBeGreaterThanOrEqual(before + ttl);
      expect(token.expiresAt).toBeLessThanOrEqual(after + ttl + 100);
    });
  });

  // ── Negative tests ──────────────────────────────────────────────────────────

  describe('negative — invalid tokens', () => {
    it('throws InvalidScopeTokenError when token has expired', () => {
      const token = issueCrossScopeToken(FROM, TO, TASK_ID, SESSION_ID, PERMS, SECRET, -1);
      expect(() =>
        validateCrossScopeToken(token, SECRET, TASK_ID, SESSION_ID),
      ).toThrow(InvalidScopeTokenError);
    });

    it('throws when taskId does not match', () => {
      const token = issueCrossScopeToken(FROM, TO, TASK_ID, SESSION_ID, PERMS, SECRET);
      expect(() =>
        validateCrossScopeToken(token, SECRET, 'wrong-task', SESSION_ID),
      ).toThrow(InvalidScopeTokenError);
    });

    it('throws when sessionId does not match', () => {
      const token = issueCrossScopeToken(FROM, TO, TASK_ID, SESSION_ID, PERMS, SECRET);
      expect(() =>
        validateCrossScopeToken(token, SECRET, TASK_ID, 'wrong-session'),
      ).toThrow(InvalidScopeTokenError);
    });

    it('throws when validating with a different secret', () => {
      const token = issueCrossScopeToken(FROM, TO, TASK_ID, SESSION_ID, PERMS, SECRET);
      expect(() =>
        validateCrossScopeToken(token, 'wrong-secret', TASK_ID, SESSION_ID),
      ).toThrow(InvalidScopeTokenError);
    });
  });

  // ── Security tests ──────────────────────────────────────────────────────────

  describe('security — tampering resistance', () => {
    it('rejects a token with a tampered fromScope', () => {
      const token = issueCrossScopeToken(FROM, TO, TASK_ID, SESSION_ID, PERMS, SECRET);
      const tampered = { ...token, fromScope: 'kaggle' };
      expect(() =>
        validateCrossScopeToken(tampered, SECRET, TASK_ID, SESSION_ID),
      ).toThrow(InvalidScopeTokenError);
    });

    it('rejects a token with a tampered toScope', () => {
      const token = issueCrossScopeToken(FROM, TO, TASK_ID, SESSION_ID, PERMS, SECRET);
      const tampered = { ...token, toScope: 'system' };  // privilege escalation attempt
      expect(() =>
        validateCrossScopeToken(tampered, SECRET, TASK_ID, SESSION_ID),
      ).toThrow(InvalidScopeTokenError);
    });

    it('rejects a token with tampered permissions (scope widening attempt)', () => {
      const token = issueCrossScopeToken(FROM, TO, TASK_ID, SESSION_ID, ['code:read'], SECRET);
      // Attacker tries to add 'code:execute' permission without a new signature
      const tampered = { ...token, permissions: ['code:read', 'code:execute', 'system:*'] };
      expect(() =>
        validateCrossScopeToken(tampered, SECRET, TASK_ID, SESSION_ID),
      ).toThrow(InvalidScopeTokenError);
    });

    it('rejects a token with tampered expiresAt (time extension attack)', () => {
      const token = issueCrossScopeToken(FROM, TO, TASK_ID, SESSION_ID, PERMS, SECRET);
      const tampered = { ...token, expiresAt: token.expiresAt + 1_000_000_000 };
      expect(() =>
        validateCrossScopeToken(tampered, SECRET, TASK_ID, SESSION_ID),
      ).toThrow(InvalidScopeTokenError);
    });

    it('rejects a token with a cleared/empty signature', () => {
      const token = issueCrossScopeToken(FROM, TO, TASK_ID, SESSION_ID, PERMS, SECRET);
      const tampered = { ...token, signature: '' };
      expect(() =>
        validateCrossScopeToken(tampered, SECRET, TASK_ID, SESSION_ID),
      ).toThrow(InvalidScopeTokenError);
    });

    it('two different token IDs for same params produce valid but distinct tokens', () => {
      const t1 = issueCrossScopeToken(FROM, TO, TASK_ID, SESSION_ID, PERMS, SECRET);
      const t2 = issueCrossScopeToken(FROM, TO, TASK_ID, SESSION_ID, PERMS, SECRET);
      expect(t1.id).not.toBe(t2.id);
      expect(t1.signature).not.toBe(t2.signature);
      // Both should still validate
      expect(() => validateCrossScopeToken(t1, SECRET, TASK_ID, SESSION_ID)).not.toThrow();
      expect(() => validateCrossScopeToken(t2, SECRET, TASK_ID, SESSION_ID)).not.toThrow();
    });
  });
});
