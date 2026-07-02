// SPDX-License-Identifier: MIT
/**
 * Tests for the weaveNotes Phase 4 redaction + publish-policy helpers. Positive
 * (secrets/PII are masked), negative (ordinary prose is untouched — no over-redaction),
 * level semantics (secrets ⊂ pii), and the sensitivity → policy mapping.
 */
import { describe, it, expect } from 'vitest';
import { redactText, publishPolicyForSensitivity } from './redact.js';

describe('redactText — secrets', () => {
  it('masks API keys, JWTs, bearer tokens and private keys at level "secrets"', () => {
    const text = [
      'Use sk-ABCDEF0123456789abcdef as the key.',
      'Authorization: Bearer abcdef0123456789ABCDEF',
      'token eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4',
      '-----BEGIN PRIVATE KEY-----\nMIIBVgIBADAN\n-----END PRIVATE KEY-----',
    ].join('\n');
    const r = redactText(text, 'secrets');
    expect(r.text).not.toContain('sk-ABCDEF0123456789abcdef');
    expect(r.text).toContain('[REDACTED-SECRET]');
    expect(r.text).toContain('Bearer [REDACTED-TOKEN]');
    expect(r.text).toContain('[REDACTED-JWT]');
    expect(r.text).toContain('[REDACTED-PRIVATE-KEY]');
    expect(r.redactions).toBeGreaterThanOrEqual(4);
    expect(r.kinds).toEqual(expect.arrayContaining(['api-key', 'bearer', 'jwt', 'private-key']));
  });

  it('does NOT redact PII at level "secrets" (an email stays)', () => {
    const r = redactText('Email me at alice@example.com about sk-ABCDEF0123456789abcdef', 'secrets');
    expect(r.text).toContain('alice@example.com'); // PII not touched at secrets level
    expect(r.text).toContain('[REDACTED-SECRET]'); // but the key is
  });
});

describe('redactText — pii', () => {
  it('masks emails, phones, SSNs AND secrets at level "pii"', () => {
    const text = 'Contact alice@example.com or +1 (415) 555-2671; SSN 123-45-6789; key sk-ABCDEF0123456789abcdef';
    const r = redactText(text, 'pii');
    expect(r.text).toContain('[REDACTED-EMAIL]');
    expect(r.text).toContain('[REDACTED-PHONE]');
    expect(r.text).toContain('[REDACTED-SSN]');
    expect(r.text).toContain('[REDACTED-SECRET]'); // secrets are a subset of pii
    expect(r.text).not.toContain('alice@example.com');
  });
});

describe('redactText — no over-redaction', () => {
  it('leaves ordinary prose and small numbers untouched', () => {
    const text = 'We met 3 times in 2026 and reviewed 42 documents across 7 teams.';
    const r = redactText(text, 'pii');
    expect(r.text).toBe(text);
    expect(r.redactions).toBe(0);
  });
  it('level "none" returns the text verbatim', () => {
    const text = 'key sk-ABCDEF0123456789abcdef and alice@example.com';
    expect(redactText(text, 'none')).toEqual({ text, redactions: 0, kinds: [] });
  });
});

describe('publishPolicyForSensitivity', () => {
  it('refuses restricted, redacts pii for confidential, secrets for normal', () => {
    expect(publishPolicyForSensitivity('restricted')).toMatchObject({ allowed: false });
    expect(publishPolicyForSensitivity('confidential')).toMatchObject({ allowed: true, redactionLevel: 'pii' });
    expect(publishPolicyForSensitivity('normal')).toMatchObject({ allowed: true, redactionLevel: 'secrets' });
  });
});
