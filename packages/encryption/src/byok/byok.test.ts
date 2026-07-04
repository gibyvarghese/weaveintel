/**
 * @weaveintel/encryption — BYOK / HYOK / break-glass / attestation tests.
 */

import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  ByokPemKmsProvider,
  fingerprintPublicKey,
  loadByokPublicKey,
  makeLocalUnwrapDelegate,
  LocalByokKeystore,
  createHttpHyokProxyDelegate,
  composeDelegates,
  createBreakGlassUnwrapDelegate,
  approveBreakGlass,
  denyBreakGlass,
  reapExpiredBreakGlass,
  findActiveGrant,
  validateNewBreakGlassRequest,
  buildAuditChain,
  buildAndSignAttestation,
  canonicalize,
  generateAttestationSigningKey,
  verifyAttestation,
  type BreakGlassRequest,
} from '../index.js';
import { KmsUnavailableError } from '../errors.js';

function makeRsaPair(bits = 4096) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: bits });
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  };
}

describe('ByokPemKmsProvider', () => {
  const { publicPem, privatePem } = makeRsaPair();

  it('rejects RSA keys < 4096', () => {
    const small = makeRsaPair(2048);
    expect(() => loadByokPublicKey(small.publicPem)).toThrow(/at least RSA-4096/);
  });

  it('rejects malformed PEM', () => {
    expect(() => loadByokPublicKey('not a pem')).toThrow(/SPKI/);
  });

  it('round-trips wrap/unwrap with local delegate', async () => {
    const provider = new ByokPemKmsProvider({
      tenantId: 't1',
      publicKeyPem: publicPem,
      unwrap: makeLocalUnwrapDelegate(privatePem),
    });
    const root = await provider.rootKeyId('t1');
    expect(root).toMatch(/^byok-pem:/);
    const dek = Buffer.alloc(32, 0x77);
    const wrapped = await provider.wrap(root, dek);
    expect(wrapped.alg).toBe('KMS-NATIVE');
    const out = await provider.unwrap(wrapped);
    expect(out.equals(dek)).toBe(true);
  });

  it('fingerprint is deterministic across loads of the same key', () => {
    const a = loadByokPublicKey(publicPem);
    const b = loadByokPublicKey(publicPem);
    expect(fingerprintPublicKey(a)).toBe(fingerprintPublicKey(b));
  });

  it('rejects cross-tenant rootKeyId requests', async () => {
    const provider = new ByokPemKmsProvider({
      tenantId: 't1',
      publicKeyPem: publicPem,
      unwrap: makeLocalUnwrapDelegate(privatePem),
    });
    await expect(provider.rootKeyId('other')).rejects.toThrow(/tenant-scoped/);
  });

  it('wraps require 32-byte input', async () => {
    const provider = new ByokPemKmsProvider({
      tenantId: 't1',
      publicKeyPem: publicPem,
      unwrap: makeLocalUnwrapDelegate(privatePem),
    });
    const root = await provider.rootKeyId('t1');
    await expect(provider.wrap(root, Buffer.alloc(16))).rejects.toThrow(/32-byte/);
  });

  it('describe() returns deterministic descriptor', () => {
    const provider = new ByokPemKmsProvider({
      tenantId: 't1',
      publicKeyPem: publicPem,
      unwrap: makeLocalUnwrapDelegate(privatePem),
      mode: 'hyok',
    });
    const d = provider.describe();
    expect(d.mode).toBe('hyok');
    expect(d.publicKeyFingerprint).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('surfaces delegate failures as KmsUnavailableError', async () => {
    const provider = new ByokPemKmsProvider({
      tenantId: 't1',
      publicKeyPem: publicPem,
      unwrap: async () => {
        throw new Error('hsm unavailable');
      },
    });
    const root = await provider.rootKeyId('t1');
    const w = await provider.wrap(root, Buffer.alloc(32, 1));
    await expect(provider.unwrap(w)).rejects.toThrow(/hsm unavailable/);
  });

  it('rejects delegates returning wrong-length buffers', async () => {
    const provider = new ByokPemKmsProvider({
      tenantId: 't1',
      publicKeyPem: publicPem,
      unwrap: async () => Buffer.alloc(16),
    });
    const root = await provider.rootKeyId('t1');
    const w = await provider.wrap(root, Buffer.alloc(32, 1));
    await expect(provider.unwrap(w)).rejects.toThrow(/expected 32-byte/);
  });
});

describe('LocalByokKeystore', () => {
  it('add/has/remove + delegate decrypts', async () => {
    const { publicPem, privatePem } = makeRsaPair();
    const ks = new LocalByokKeystore();
    ks.add({ tenantId: 't1', privateKeyPem: privatePem });
    expect(ks.has('t1')).toBe(true);
    const provider = new ByokPemKmsProvider({
      tenantId: 't1',
      publicKeyPem: publicPem,
      unwrap: ks.delegate(),
    });
    const root = await provider.rootKeyId('t1');
    const k = Buffer.alloc(32, 9);
    const w = await provider.wrap(root, k);
    expect((await provider.unwrap(w)).equals(k)).toBe(true);
    ks.remove('t1');
    await expect(provider.unwrap(w)).rejects.toThrow(/no private key/);
  });
});

describe('createHttpHyokProxyDelegate', () => {
  it('rejects non-HTTPS endpoints', () => {
    expect(() => createHttpHyokProxyDelegate({ endpoint: 'http://example.com' })).toThrow(/HTTPS/);
  });

  it('round-trips through a stub fetch', async () => {
    const { publicPem, privatePem } = makeRsaPair();
    const localUnwrap = makeLocalUnwrapDelegate(privatePem);
    const stubFetch = (async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string) as { ciphertext_b64: string };
      const plain = await localUnwrap({
        tenantId: 't',
        rootKeyId: 'r',
        ciphertext: Buffer.from(body.ciphertext_b64, 'base64'),
      });
      return new Response(JSON.stringify({ key_b64: plain.toString('base64') }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const delegate = createHttpHyokProxyDelegate({
      endpoint: 'https://hyok.test/unwrap',
      fetchImpl: stubFetch,
    });
    const provider = new ByokPemKmsProvider({
      tenantId: 't',
      publicKeyPem: publicPem,
      unwrap: delegate,
      mode: 'hyok',
    });
    const root = await provider.rootKeyId('t');
    const w = await provider.wrap(root, Buffer.alloc(32, 5));
    const out = await provider.unwrap(w);
    expect(out.equals(Buffer.alloc(32, 5))).toBe(true);
  });

  it('surfaces non-200 responses', async () => {
    const stubFetch = (async () => new Response('rate-limited', { status: 429 })) as typeof fetch;
    const delegate = createHttpHyokProxyDelegate({
      endpoint: 'https://hyok.test/unwrap',
      fetchImpl: stubFetch,
    });
    await expect(
      delegate({ tenantId: 't', rootKeyId: 'r', ciphertext: Buffer.alloc(4) }),
    ).rejects.toThrow(/429/);
  });
});

describe('composeDelegates', () => {
  it('falls through KmsUnavailableError to next delegate', async () => {
    const a = async () => {
      throw new KmsUnavailableError('not me');
    };
    const b = async () => Buffer.alloc(32, 1);
    const out = await composeDelegates([a, b])({
      tenantId: 't', rootKeyId: 'r', ciphertext: Buffer.alloc(4),
    });
    expect(out.length).toBe(32);
  });

  it('throws non-KmsUnavailableError immediately', async () => {
    const a = async () => {
      throw new Error('boom');
    };
    const b = async () => Buffer.alloc(32);
    await expect(
      composeDelegates([a, b])({ tenantId: 't', rootKeyId: 'r', ciphertext: Buffer.alloc(4) }),
    ).rejects.toThrow(/boom/);
  });
});

describe('break-glass evaluator', () => {
  const baseReq = (over: Partial<BreakGlassRequest> = {}): BreakGlassRequest => ({
    id: 'r1',
    tenantId: 't1',
    requestedBy: 'op@x',
    reason: 'rotation cron failed',
    status: 'pending',
    customerApprover: null,
    approvedAt: null,
    expiresAt: Date.now() + 60_000,
    consumeCount: 0,
    createdAt: Date.now(),
    ...over,
  });

  it('validateNewBreakGlassRequest enforces inputs', () => {
    expect(() => validateNewBreakGlassRequest({ tenantId: '', requestedBy: 'a', reason: 'long enough' })).toThrow();
    expect(() => validateNewBreakGlassRequest({ tenantId: 't', requestedBy: 'a', reason: 'short' })).toThrow();
    const r = validateNewBreakGlassRequest({ tenantId: 't', requestedBy: 'a', reason: 'long enough reason' });
    expect(r.windowMs).toBeGreaterThan(0);
    expect(r.expiresAt).toBeGreaterThan(Date.now());
  });

  it('approve requires different principal', () => {
    const req = baseReq({ requestedBy: 'a@x' });
    expect(() => approveBreakGlass({ request: req, customerApprover: 'a@x' })).toThrow(/dual approval/);
  });

  it('approve flips status to approved with capped window', () => {
    const req = baseReq();
    const out = approveBreakGlass({
      request: req,
      customerApprover: 'cust@x',
      windowMs: 999_999_999_999,
    });
    expect(out.approved.status).toBe('approved');
    expect(out.approved.expiresAt - (out.approved.approvedAt ?? 0)).toBeLessThanOrEqual(24 * 3600 * 1000);
    expect(out.transition.from).toBe('pending');
    expect(out.transition.to).toBe('approved');
  });

  it('deny flips status', () => {
    const out = denyBreakGlass({ request: baseReq(), deniedBy: 'cust@x', note: 'no thanks' });
    expect(out.denied.status).toBe('denied');
    expect(out.transition.reason).toContain('no thanks');
  });

  it('reapExpired emits transitions for stale requests', () => {
    const stale = baseReq({ expiresAt: Date.now() - 10, status: 'approved' });
    const fresh = baseReq({ id: 'r2', expiresAt: Date.now() + 100_000, status: 'approved' });
    const ts = reapExpiredBreakGlass([stale, fresh]);
    expect(ts).toHaveLength(1);
    expect(ts[0]!.id).toBe('r1');
    expect(ts[0]!.to).toBe('expired');
  });

  it('findActiveGrant returns approved + non-expired', () => {
    const reqs = [
      baseReq({ id: 'a', status: 'pending' }),
      baseReq({ id: 'b', status: 'approved', expiresAt: Date.now() + 60_000 }),
      baseReq({ id: 'c', status: 'approved', expiresAt: Date.now() - 1 }),
    ];
    const found = findActiveGrant({ requests: reqs, tenantId: 't1' });
    expect(found?.id).toBe('b');
  });
});

describe('createBreakGlassUnwrapDelegate', () => {
  it('throws when no grant resolves', async () => {
    const d = createBreakGlassUnwrapDelegate({ resolve: async () => null });
    await expect(d({ tenantId: 't', rootKeyId: 'r', ciphertext: Buffer.alloc(1) })).rejects.toThrow(
      /No active break-glass grant/,
    );
  });

  it('returns the grant payload when present', async () => {
    const d = createBreakGlassUnwrapDelegate({
      resolve: async () => Buffer.alloc(32, 2),
    });
    const out = await d({ tenantId: 't', rootKeyId: 'r', ciphertext: Buffer.alloc(1) });
    expect(out.length).toBe(32);
  });
});

describe('attestation', () => {
  it('canonicalize sorts keys deterministically', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalize([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  it('buildAuditChain hashes events deterministically', () => {
    const events = [
      { id: '1', eventKind: 'kek_create', createdAt: 1, details: null },
      { id: '2', eventKind: 'dek_rotate', createdAt: 2, details: { tenant: 't' } },
    ];
    const a = buildAuditChain(events);
    const b = buildAuditChain(events);
    expect(a.tip).toBe(b.tip);
    const c = buildAuditChain([...events, { id: '3', eventKind: 'shred', createdAt: 3, details: null }]);
    expect(c.tip).not.toBe(a.tip);
  });

  it('buildAndSignAttestation + verifyAttestation round-trip', () => {
    const signing = generateAttestationSigningKey();
    const att = buildAndSignAttestation({
      tenantId: 't1',
      host: 'geneweave',
      fields: [{ table: 'messages', column: 'content', required: true, classification: 'sensitive' }],
      kms: { providerId: 'byok-pem', publicKeyFingerprint: 'abc' },
      keyState: {
        activeKekId: 'kek_1',
        activeDekId: 'dek_1',
        activeBikId: null,
        lastRotationAt: 1_000_000,
        retainedDekCount: 1,
        retainedBikCount: 0,
      },
      auditEvents: [
        { id: '1', eventKind: 'kek_create', createdAt: 1, details: null },
      ],
      signingKey: signing,
    });
    expect(att.signatureAlg).toBe('Ed25519');
    const pubPem = signing.publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const v = verifyAttestation({ attestation: att, publicKeyPem: pubPem });
    expect(v.ok).toBe(true);
  });

  it('verifyAttestation rejects tampered payload', () => {
    const signing = generateAttestationSigningKey();
    const att = buildAndSignAttestation({
      tenantId: 't1',
      host: 'geneweave',
      fields: [],
      kms: { providerId: 'local' },
      keyState: { activeKekId: null, activeDekId: null, activeBikId: null, lastRotationAt: null, retainedDekCount: 0, retainedBikCount: 0 },
      auditEvents: [],
      signingKey: signing,
    });
    const tampered = {
      ...att,
      payload: { ...att.payload, tenantId: 'attacker' },
    };
    const pubPem = signing.publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const v = verifyAttestation({ attestation: tampered, publicKeyPem: pubPem });
    expect(v.ok).toBe(false);
  });

  it('verifyAttestation detects wrong public key', () => {
    const a = generateAttestationSigningKey();
    const b = generateAttestationSigningKey();
    const att = buildAndSignAttestation({
      tenantId: 't',
      host: 'h',
      fields: [],
      kms: { providerId: 'local' },
      keyState: { activeKekId: null, activeDekId: null, activeBikId: null, lastRotationAt: null, retainedDekCount: 0, retainedBikCount: 0 },
      auditEvents: [],
      signingKey: a,
    });
    const wrongPub = b.publicKey.export({ type: 'spki', format: 'pem' }) as string;
    const v = verifyAttestation({ attestation: att, publicKeyPem: wrongPub });
    expect(v.ok).toBe(false);
    expect(v.signingKeyFingerprintOk).toBe(false);
  });
});
