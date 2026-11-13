// SPDX-License-Identifier: MIT
/**
 * Scope-to-tool: a tool is listed and callable only under the scopes the caller's token carries.
 */
import { describe, expect, it } from 'vitest';
import {
  bearerChallenge,
  assertScopeToken,
  missingScopes,
  insufficientScopeChallenge,
} from './scopes.js';

describe('missingScopes', () => {
  it('lists every required scope the token lacks, in the order required', () => {
    expect(missingScopes(['itsm.read', 'itsm.write'], ['itsm.read'])).toEqual(['itsm.write']);
    expect(missingScopes(['a', 'b'], [])).toEqual(['a', 'b']);
  });
  it('is empty when every required scope is granted', () => {
    expect(missingScopes(['itsm.read'], ['profile', 'itsm.read'])).toEqual([]);
  });
  it('an empty requirement is met by any authenticated caller', () => {
    expect(missingScopes([], [])).toEqual([]);
  });
  it('matches whole scope tokens only (no prefix or case folding)', () => {
    expect(missingScopes(['itsm.write'], ['itsm'])).toEqual(['itsm.write']);
    expect(missingScopes(['itsm.write'], ['ITSM.WRITE'])).toEqual(['itsm.write']);
    expect(missingScopes(['itsm.write'], ['itsm.write.extra'])).toEqual(['itsm.write']);
  });
});

describe('assertScopeToken', () => {
  it('accepts RFC 6749 scope tokens', () => {
    expect(() => assertScopeToken('itsm.write')).not.toThrow();
    expect(() => assertScopeToken('crm:read/all')).not.toThrow();
  });
  it('refuses empty strings, spaces, quotes and backslashes (they would break the challenge header)', () => {
    for (const bad of ['', 'a b', 'a"b', 'a\\b', 'a\nb', 'é'])
      expect(() => assertScopeToken(bad)).toThrow();
  });
});

describe('bearerChallenge', () => {
  it('writes RFC 6750 parameters, quoted', () => {
    expect(
      bearerChallenge({
        error: 'insufficient_scope',
        scope: ['a', 'b'],
        resourceMetadata: 'https://h.example/.well-known/oauth-protected-resource/mcp',
        description: 'needs b',
      }),
    ).toBe(
      'Bearer error="insufficient_scope", scope="a b", resource_metadata="https://h.example/.well-known/oauth-protected-resource/mcp", error_description="needs b"',
    );
  });
  it('a bare challenge carries only resource_metadata', () => {
    expect(bearerChallenge({ resourceMetadata: 'https://h.example/m' })).toBe(
      'Bearer resource_metadata="https://h.example/m"',
    );
    expect(bearerChallenge({})).toBe('Bearer');
  });
  it('strips characters that would end the quoted value or the header', () => {
    const h = bearerChallenge({ description: 'say "hi"\r\nSet-Cookie: x=1 \\ end' });
    expect(h).not.toMatch(/[\r\n]/);
    expect(h).toBe('Bearer error_description="say hiSet-Cookie: x=1  end"');
  });
});

describe('insufficientScopeChallenge', () => {
  it('answers 403 and asks for what the token had plus what the tool needs', () => {
    const c = insufficientScopeChallenge({
      required: ['itsm.write'],
      granted: ['profile', 'itsm.read'],
      resourceMetadataUrl: 'https://h.example/m',
    });
    expect(c.status).toBe(403);
    expect(c.missing).toEqual(['itsm.write']);
    expect(c.wwwAuthenticate).toContain('error="insufficient_scope"');
    // Re-authorising with only the missing scope would lose the scopes the client already had.
    expect(c.wwwAuthenticate).toContain('scope="profile itsm.read itsm.write"');
    expect(c.wwwAuthenticate).toContain('resource_metadata="https://h.example/m"');
  });
});
