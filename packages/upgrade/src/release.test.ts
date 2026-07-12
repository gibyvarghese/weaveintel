// SPDX-License-Identifier: MIT
/**
 * Phase-1 acceptance + security tests for release discovery: build → sign → serve → check round-trip, and
 * DISTINCT rejection of a tampered / expired / downgraded / wrong-edition / untrusted-key manifest. Plus
 * the authenticated source's token hygiene (never in an error), schema/injection hardening, and stress.
 */
import { describe, it, expect } from 'vitest';
import { generateAttestationSigningKey } from '@weaveintel/encryption';
import {
  buildManifest, computeIntegrity, verifyIntegrity, lintManifest,
  createEd25519Verifier, createUpdateChecker, parseManifest, manifestBody, signManifest,
  createGitHubReleaseSource, createAuthenticatedGitHubReleaseSource,
  type ManifestBody, type UpgradeManifest, type HttpGetter,
} from './index.js';

const key = generateAttestationSigningKey();
const otherKey = generateAttestationSigningKey();

/** A well-formed manifest body at version `version` for `edition`, with one content change. */
function body(version = '2.0.0', edition = 'community', expiresAt?: string): ManifestBody {
  return {
    manifestVersion: 1, name: '@acme/app', version, channel: 'stable', edition,
    publishedAt: '2026-01-01T00:00:00.000Z',
    ...(expiresAt ? { expiresAt } : {}),
    requires: {}, layers: { packages: [], schema: [], content: [
      { family: 'skills', logicalKey: 'skill-x', remoteHash: 'sha256:abc', releaseNote: 'improved skill-x' },
    ] }, artifacts: [],
  };
}

/** A GitHub-shaped mock HTTP getter serving `manifest` as the release's manifest asset. */
function mockHttp(manifest: UpgradeManifest | null, opts: { assetName?: string; failAssetStatus?: number } = {}): HttpGetter {
  return async (url) => {
    if (url.includes('/releases/latest')) {
      if (!manifest) return { status: 404, text: '' };
      return { status: 200, text: JSON.stringify({ assets: [{ name: opts.assetName ?? 'manifest.json', url: 'https://api.github.com/asset/1', browser_download_url: 'https://dl/manifest.json' }] }) };
    }
    if (opts.failAssetStatus) return { status: opts.failAssetStatus, text: '' };
    return { status: 200, text: JSON.stringify(manifest) };
  };
}

const verifier = createEd25519Verifier([key.publicKey]);
const at = (iso: string) => () => new Date(iso);

describe('@weaveintel/upgrade — manifest schema + integrity', () => {
  it('POSITIVE: a built+signed manifest round-trips through parse', () => {
    const m = buildManifest(body(), key.privateKey);
    expect(parseManifest(JSON.parse(JSON.stringify(m)))).toEqual(m);
  });
  it('NEGATIVE: malformed manifests are rejected at the schema boundary', () => {
    expect(() => parseManifest({})).toThrow();
    expect(() => parseManifest({ ...buildManifest(body(), key.privateKey), version: '' })).toThrow(); // empty version
    const bad = buildManifest(body(), key.privateKey);
    expect(() => parseManifest({ ...bad, artifacts: [{ path: 'x', integrity: 'not-sri', size: 1 }] })).toThrow(); // bad integrity
  });
  it('SECURITY: over-long strings are bounded by the schema (no unbounded input)', () => {
    const huge = 'a'.repeat(5000);
    expect(() => parseManifest({ ...buildManifest(body(), key.privateKey), name: huge })).toThrow();
  });
  it('integrity: compute + verify round-trip; tampered bytes fail', () => {
    const data = Buffer.from('artifact-bytes');
    const sri = computeIntegrity(data);
    expect(sri).toMatch(/^sha512-/);
    expect(verifyIntegrity(data, sri)).toBe(true);
    expect(verifyIntegrity(Buffer.from('tampered'), sri)).toBe(false);
    expect(verifyIntegrity(data, 'garbage')).toBe(false);
  });
});

describe('@weaveintel/upgrade — signing', () => {
  it('POSITIVE: sign → verify succeeds', () => {
    const m = signManifest(body(), key.privateKey);
    expect(verifier.verify(manifestBody(m), m.signature)).toEqual({ ok: true });
  });
  it('NEGATIVE (tamper): changing the body after signing → bad_signature', () => {
    const m = signManifest(body(), key.privateKey);
    const tampered = { ...manifestBody(m), version: '9.9.9' };
    expect(verifier.verify(tampered, m.signature)).toEqual({ ok: false, reason: 'bad_signature' });
  });
  it('NEGATIVE (untrusted key): a manifest signed by a key we do not trust → untrusted_key', () => {
    const m = signManifest(body(), otherKey.privateKey);
    expect(verifier.verify(manifestBody(m), m.signature)).toEqual({ ok: false, reason: 'untrusted_key' });
  });
  it('NEGATIVE: a garbage signature value → bad_signature (never throws)', () => {
    const m = signManifest(body(), key.privateKey);
    expect(verifier.verify(manifestBody(m), { ...m.signature, value: '!!!not-base64!!!' })).toEqual({ ok: false, reason: 'bad_signature' });
  });
});

describe('@weaveintel/upgrade — update checker (distinct rejections)', () => {
  const checker = (m: UpgradeManifest | null, o: { edition?: string; current?: string; now?: () => Date } = {}) =>
    createUpdateChecker({ source: createGitHubReleaseSource({ repo: 'acme/app', http: mockHttp(m) }), verifier, edition: o.edition ?? 'community', currentVersion: o.current ?? '1.0.0', now: o.now });

  it('ROUND-TRIP: a valid, newer, same-edition manifest → update_available', async () => {
    const m = buildManifest(body('2.0.0'), key.privateKey);
    expect((await checker(m).check()).status).toBe('update_available');
  });
  it('up_to_date when the release equals our floor', async () => {
    const m = buildManifest(body('1.0.0'), key.privateKey);
    expect((await checker(m, { current: '1.0.0' }).check()).status).toBe('up_to_date');
  });
  it('DOWNGRADE: an older validly-signed manifest → rejected downgrade', async () => {
    const m = buildManifest(body('0.9.0'), key.privateKey);
    const r = await checker(m, { current: '1.0.0' }).check();
    expect(r).toMatchObject({ status: 'rejected', reason: 'downgrade' });
  });
  it('EXPIRED: past expiresAt → rejected expired', async () => {
    const m = buildManifest(body('2.0.0', 'community', '2026-02-01T00:00:00.000Z'), key.privateKey);
    const r = await checker(m, { now: at('2026-03-01T00:00:00.000Z') }).check();
    expect(r).toMatchObject({ status: 'rejected', reason: 'expired' });
  });
  it('EDITION MISMATCH: a release for another edition → rejected edition_mismatch', async () => {
    const m = buildManifest(body('2.0.0', 'enterprise'), key.privateKey);
    const r = await checker(m, { edition: 'community' }).check();
    expect(r).toMatchObject({ status: 'rejected', reason: 'edition_mismatch' });
  });
  it('TAMPERED: a modified manifest → rejected bad_signature', async () => {
    const m = buildManifest(body('2.0.0'), key.privateKey);
    const tampered = { ...m, version: '3.0.0' }; // body changed, signature no longer matches
    const r = await checker(tampered).check();
    expect(r).toMatchObject({ status: 'rejected', reason: 'bad_signature' });
  });
  it('UNTRUSTED KEY: signed by an untrusted key → rejected untrusted_key', async () => {
    const m = buildManifest(body('2.0.0'), otherKey.privateKey);
    const r = await checker(m).check();
    expect(r).toMatchObject({ status: 'rejected', reason: 'untrusted_key' });
  });
  it('none when the source has no release', async () => {
    expect((await checker(null).check()).status).toBe('none');
  });
  it('signature is checked BEFORE edition/version — a tampered wrong-edition manifest reports bad_signature', async () => {
    const m = buildManifest(body('2.0.0', 'enterprise'), key.privateKey);
    const tampered = { ...m, edition: 'community' }; // try to sneak past edition by editing it
    const r = await checker(tampered, { edition: 'community' }).check();
    expect(r).toMatchObject({ status: 'rejected', reason: 'bad_signature' }); // edit broke the signature
  });
});

describe('@weaveintel/upgrade — release sources', () => {
  it('a release with no manifest asset → null', async () => {
    const m = buildManifest(body(), key.privateKey);
    const src = createGitHubReleaseSource({ repo: 'acme/app', http: mockHttp(m, { assetName: 'other.json' }) });
    expect(await src.latest()).toBeNull();
  });
  it('AUTHENTICATED: injects the token but NEVER leaks it in an error', async () => {
    const SECRET = 'ghp_SUPERSECRET_TOKEN_123';
    let sawAuth = false;
    const http: HttpGetter = async (url, headers) => {
      if (headers?.['Authorization']?.includes(SECRET)) sawAuth = true;
      if (url.includes('/releases/latest')) return { status: 200, text: JSON.stringify({ assets: [{ name: 'manifest.json', url: 'https://api/asset', browser_download_url: 'https://dl/m' }] }) };
      return { status: 500, text: '' }; // force an error on the asset download
    };
    const src = createAuthenticatedGitHubReleaseSource({ repo: 'acme/app', http, tokenProvider: async () => SECRET });
    let msg = '';
    try { await src.latest(); } catch (e) { msg = (e as Error).message; }
    expect(sawAuth).toBe(true);            // the token WAS sent (auth works)
    expect(msg).toContain('HTTP 500');     // the error surfaces the status
    expect(msg).not.toContain(SECRET);     // …but NEVER the token
  });
});

describe('@weaveintel/upgrade — publisher lint', () => {
  it('POSITIVE: a well-formed manifest passes', () => {
    expect(lintManifest(body()).ok).toBe(true);
  });
  it('NEGATIVE: whitespace release note, duplicate content, expiry-before-publish, non-semver version', () => {
    const b = body();
    b.layers.content = [
      { family: 'skills', logicalKey: 'a', remoteHash: 'h', releaseNote: '   ' },
      { family: 'skills', logicalKey: 'a', remoteHash: 'h', releaseNote: 'dup' },
    ];
    const r = lintManifest(b);
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['empty_release_note', 'duplicate_content']));

    const bad = { ...body('not-semver'), expiresAt: '2025-01-01T00:00:00.000Z' };
    const codes = lintManifest(bad).issues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['version_not_semver', 'expiry_before_publish']));
  });
});

describe('@weaveintel/upgrade — stress', () => {
  it('checks a 5,000-entry content manifest without error', async () => {
    const big = body('2.0.0');
    big.layers.content = Array.from({ length: 5000 }, (_, i) => ({ family: 'skills', logicalKey: `k${i}`, remoteHash: `sha256:${i}`, releaseNote: `note ${i}` }));
    const m = buildManifest(big, key.privateKey);
    const c = createUpdateChecker({ source: createGitHubReleaseSource({ repo: 'a/b', http: mockHttp(m) }), verifier, edition: 'community', currentVersion: '1.0.0' });
    const r = await c.check();
    expect(r.status).toBe('update_available');
    if (r.status === 'update_available') expect(r.manifest.layers.content.length).toBe(5000);
  });
});
