import { describe, it, expect } from 'vitest';
import { createArtifactPolicy, validateArtifact, isExpired } from './policy.js';
import type { Artifact } from '@weaveintel/core';

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'art-1',
    name: 'test',
    type: 'text',
    mimeType: 'text/plain',
    data: 'hello',
    sizeBytes: 5,
    version: 1,
    scope: 'session',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─── createArtifactPolicy ─────────────────────────────────────────────────────

describe('createArtifactPolicy', () => {
  it('creates a policy with defaults', () => {
    const p = createArtifactPolicy({ name: 'default' });
    expect(p.maxSizeBytes).toBe(100 * 1024 * 1024);
    expect(p.retentionDays).toBe(90);
    expect(p.requireVersioning).toBe(true);
    expect(p.enabled).toBe(true);
  });

  it('respects explicit options', () => {
    const p = createArtifactPolicy({ name: 'custom', maxSizeBytes: 1024, retentionDays: 7, requireVersioning: false, enabled: false });
    expect(p.maxSizeBytes).toBe(1024);
    expect(p.retentionDays).toBe(7);
    expect(p.requireVersioning).toBe(false);
    expect(p.enabled).toBe(false);
  });

  it('allowedTypes is undefined when not specified (all types allowed)', () => {
    const p = createArtifactPolicy({ name: 'open' });
    expect(p.allowedTypes).toBeUndefined();
  });
});

// ─── validateArtifact ────────────────────────────────────────────────────────

describe('validateArtifact', () => {
  it('passes valid artifact', () => {
    const p = createArtifactPolicy({ name: 'default' });
    const result = validateArtifact(makeArtifact(), p);
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('fails when artifact exceeds maxSizeBytes', () => {
    const p = createArtifactPolicy({ name: 'tiny', maxSizeBytes: 2 });
    const result = validateArtifact(makeArtifact({ sizeBytes: 100 }), p);
    expect(result.valid).toBe(false);
    expect(result.violations[0]).toMatch(/exceeds maximum/i);
  });

  it('fails when type is not in allowedTypes', () => {
    const p = createArtifactPolicy({ name: 'strict', allowedTypes: ['json', 'csv'] });
    const result = validateArtifact(makeArtifact({ type: 'html' }), p);
    expect(result.valid).toBe(false);
    expect(result.violations[0]).toMatch(/not in the allowed types/i);
  });

  it('passes when type is in allowedTypes', () => {
    const p = createArtifactPolicy({ name: 'strict', allowedTypes: ['json', 'csv'] });
    const result = validateArtifact(makeArtifact({ type: 'json', mimeType: 'application/json' }), p);
    expect(result.valid).toBe(true);
  });

  it('skips all checks when policy is disabled', () => {
    const p = createArtifactPolicy({ name: 'disabled', maxSizeBytes: 1, allowedTypes: ['json'], enabled: false });
    const result = validateArtifact(makeArtifact({ sizeBytes: 1_000_000, type: 'html' }), p);
    expect(result.valid).toBe(true);
  });

  it('can accumulate multiple violations', () => {
    const p = createArtifactPolicy({ name: 'multi', maxSizeBytes: 1, allowedTypes: ['json'] });
    const result = validateArtifact(makeArtifact({ sizeBytes: 1_000_000, type: 'html' }), p);
    expect(result.violations.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── isExpired ────────────────────────────────────────────────────────────────

describe('isExpired', () => {
  it('returns false when retentionDays is undefined', () => {
    const p = createArtifactPolicy({ name: 'forever', retentionDays: undefined });
    // override default 90 days
    const noRetentionPolicy = { ...p, retentionDays: undefined };
    expect(isExpired(makeArtifact(), noRetentionPolicy)).toBe(false);
  });

  it('returns false when retentionDays is 0', () => {
    const p = { ...createArtifactPolicy({ name: 'forever' }), retentionDays: 0 };
    expect(isExpired(makeArtifact(), p)).toBe(false);
  });

  it('returns false for a fresh artifact', () => {
    const p = createArtifactPolicy({ name: 'short', retentionDays: 1 });
    const fresh = makeArtifact({ createdAt: new Date().toISOString() });
    expect(isExpired(fresh, p)).toBe(false);
  });

  it('returns true for an artifact past its retention period', () => {
    const p = createArtifactPolicy({ name: 'short', retentionDays: 1 });
    const old = makeArtifact({ createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() });
    expect(isExpired(old, p)).toBe(true);
  });

  it('boundary: exactly at retention edge is not yet expired', () => {
    const p = createArtifactPolicy({ name: 'boundary', retentionDays: 1 });
    // 23h59m ago — should NOT be expired
    const nearBoundary = makeArtifact({ createdAt: new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString() });
    expect(isExpired(nearBoundary, p)).toBe(false);
  });
});
