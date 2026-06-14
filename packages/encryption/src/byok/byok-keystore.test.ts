/**
 * Tests for BYOK/HYOK delegate implementations:
 *   - LocalByokKeystore
 *   - HttpHyokProxyDelegate (createHttpHyokProxyDelegate)
 *   - BreakGlassUnwrapDelegate (createBreakGlassUnwrapDelegate)
 *   - composeDelegates
 *   - loadByokPublicKey (PEM validation)
 *   - fingerprintPublicKey
 *
 * Real-world attack scenarios:
 *   - Injection of non-RSA keys
 *   - Undersized RSA keys (RSA-2048 where 4096 required)
 *   - Malformed PEM / garbage ciphertext
 *   - HYOK proxy returning wrong key size, wrong JSON, HTTP errors
 *   - Break-glass with no grant, expired grant, consumed grant
 *   - composeDelegates fall-through and immediate-bubble-up
 */

import { describe, expect, it, vi } from 'vitest';
import {
  generateKeyPairSync,
  publicEncrypt,
  constants as cryptoConstants,
  randomBytes,
} from 'node:crypto';
import {
  LocalByokKeystore,
  createHttpHyokProxyDelegate,
  createBreakGlassUnwrapDelegate,
  composeDelegates,
  type HttpHyokProxyOptions,
  type BreakGlassGrantStore,
} from './byok-keystore.js';
import {
  loadByokPublicKey,
  fingerprintPublicKey,
  ByokPemKmsProvider,
  type ByokUnwrapDelegate,
} from './byok-pem-provider.js';
import { KmsUnavailableError } from '../errors.js';

// ── RSA-4096 test key pair (generated once, shared across tests) ─────────────
// RSA-4096 keygen is slow (~500ms). Vitest runs this once at module load time.
const { privateKey: TEST_PRIV_4096, publicKey: TEST_PUB_4096 } = generateKeyPairSync('rsa', {
  modulusLength: 4096,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const { privateKey: TEST_PRIV_2048, publicKey: TEST_PUB_2048 } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function encryptWith4096(plaintext: Buffer): Buffer {
  const pub = loadByokPublicKey(TEST_PUB_4096 as string);
  return publicEncrypt(
    { key: pub, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    plaintext,
  );
}

const TENANT_ID = 'tenant-test-1';

// ── loadByokPublicKey ────────────────────────────────────────────────────────

describe('loadByokPublicKey — PEM validation', () => {
  it('accepts a valid RSA-4096 SPKI PEM', () => {
    const key = loadByokPublicKey(TEST_PUB_4096 as string);
    expect(key.asymmetricKeyType).toBe('rsa');
    expect(key.asymmetricKeyDetails?.modulusLength).toBe(4096);
  });

  it('rejects RSA-2048 (too small)', () => {
    expect(() => loadByokPublicKey(TEST_PUB_2048 as string)).toThrow(KmsUnavailableError);
    expect(() => loadByokPublicKey(TEST_PUB_2048 as string)).toThrow(/RSA-4096/);
  });

  it('rejects garbage string', () => {
    expect(() => loadByokPublicKey('not a pem')).toThrow(KmsUnavailableError);
  });

  it('rejects EC key', () => {
    const { publicKey: ecPub } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    expect(() => loadByokPublicKey(ecPub)).toThrow(KmsUnavailableError);
    expect(() => loadByokPublicKey(ecPub)).toThrow(/RSA/);
  });

  it('rejects private key PEM (not SPKI)', () => {
    // Private key PEM does not include "BEGIN PUBLIC KEY"
    expect(() => loadByokPublicKey(TEST_PRIV_4096 as string)).toThrow(KmsUnavailableError);
  });

  it('rejects empty string', () => {
    expect(() => loadByokPublicKey('')).toThrow(KmsUnavailableError);
  });
});

// ── fingerprintPublicKey ─────────────────────────────────────────────────────

describe('fingerprintPublicKey', () => {
  it('returns 16-char base64url string', () => {
    const pub = loadByokPublicKey(TEST_PUB_4096 as string);
    const fp = fingerprintPublicKey(pub);
    expect(fp).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });

  it('returns different fingerprints for different keys', () => {
    // RSA-4096 vs RSA-2048 should differ even if 2048 is loaded via the key object
    const pub4096 = loadByokPublicKey(TEST_PUB_4096 as string);
    const fp1 = fingerprintPublicKey(pub4096);
    // Generate a second 4096 key
    const { publicKey: otherPub } = generateKeyPairSync('rsa', {
      modulusLength: 4096,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const pub4096b = loadByokPublicKey(otherPub);
    const fp2 = fingerprintPublicKey(pub4096b);
    expect(fp1).not.toBe(fp2);
  });

  it('is deterministic for the same key', () => {
    const pub = loadByokPublicKey(TEST_PUB_4096 as string);
    expect(fingerprintPublicKey(pub)).toBe(fingerprintPublicKey(pub));
  });
});

// ── LocalByokKeystore ────────────────────────────────────────────────────────

describe('LocalByokKeystore', () => {
  it('decrypts a ciphertext encrypted with the matching public key', async () => {
    const store = new LocalByokKeystore();
    store.add({ tenantId: TENANT_ID, privateKeyPem: TEST_PRIV_4096 as string });

    const plainKey = randomBytes(32);
    const ciphertext = encryptWith4096(plainKey);
    const delegate = store.delegate();
    const decrypted = await delegate({ tenantId: TENANT_ID, rootKeyId: 'test-root', ciphertext });
    expect(decrypted).toEqual(plainKey);
  });

  it('throws KmsUnavailableError for unknown tenant', async () => {
    const store = new LocalByokKeystore();
    const delegate = store.delegate();
    await expect(
      delegate({ tenantId: 'unknown-tenant', rootKeyId: 'root', ciphertext: randomBytes(32) }),
    ).rejects.toThrow(KmsUnavailableError);
    await expect(
      delegate({ tenantId: 'unknown-tenant', rootKeyId: 'root', ciphertext: randomBytes(32) }),
    ).rejects.toThrow(/no private key/i);
  });

  it('rejects a non-RSA private key PEM', () => {
    const { privateKey: ecPriv } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const store = new LocalByokKeystore();
    expect(() => store.add({ tenantId: TENANT_ID, privateKeyPem: ecPriv })).toThrow(KmsUnavailableError);
    expect(() => store.add({ tenantId: TENANT_ID, privateKeyPem: ecPriv })).toThrow(/RSA/);
  });

  it('rejects garbage PEM', () => {
    const store = new LocalByokKeystore();
    expect(() => store.add({ tenantId: TENANT_ID, privateKeyPem: 'not-pem' })).toThrow(KmsUnavailableError);
  });

  it('throws on tampered ciphertext (OAEP padding check)', async () => {
    const store = new LocalByokKeystore();
    store.add({ tenantId: TENANT_ID, privateKeyPem: TEST_PRIV_4096 as string });

    const plainKey = randomBytes(32);
    const ciphertext = encryptWith4096(plainKey);
    // Flip one byte at position 5 to corrupt the ciphertext
    (ciphertext as Buffer).writeUInt8((ciphertext[5]! ^ 0xff) & 0xff, 5);

    const delegate = store.delegate();
    await expect(
      delegate({ tenantId: TENANT_ID, rootKeyId: 'root', ciphertext }),
    ).rejects.toThrow();
  });

  it('removes tenant key correctly', async () => {
    const store = new LocalByokKeystore();
    store.add({ tenantId: TENANT_ID, privateKeyPem: TEST_PRIV_4096 as string });
    expect(store.has(TENANT_ID)).toBe(true);
    store.remove(TENANT_ID);
    expect(store.has(TENANT_ID)).toBe(false);

    const delegate = store.delegate();
    await expect(
      delegate({ tenantId: TENANT_ID, rootKeyId: 'root', ciphertext: randomBytes(32) }),
    ).rejects.toThrow(KmsUnavailableError);
  });

  it('decrypts for the correct tenant but not a different one', async () => {
    const store = new LocalByokKeystore();
    store.add({ tenantId: 'tenant-A', privateKeyPem: TEST_PRIV_4096 as string });
    const delegate = store.delegate();

    const plainKey = randomBytes(32);
    const ciphertext = encryptWith4096(plainKey);

    const decrypted = await delegate({ tenantId: 'tenant-A', rootKeyId: 'root', ciphertext });
    expect(decrypted).toEqual(plainKey);

    await expect(
      delegate({ tenantId: 'tenant-B', rootKeyId: 'root', ciphertext }),
    ).rejects.toThrow(KmsUnavailableError);
  });
});

// ── createHttpHyokProxyDelegate ──────────────────────────────────────────────

describe('createHttpHyokProxyDelegate', () => {
  const ENDPOINT = 'https://customer.example.com/hyok/unwrap';

  function mockFetch(status: number, body: unknown): typeof fetch {
    return vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
      json: async () => body,
    }) as unknown as typeof fetch;
  }

  it('rejects non-HTTPS endpoint', () => {
    expect(() =>
      createHttpHyokProxyDelegate({ endpoint: 'http://insecure.example.com/hyok' }),
    ).toThrow(KmsUnavailableError);
    expect(() =>
      createHttpHyokProxyDelegate({ endpoint: 'http://insecure.example.com/hyok' }),
    ).toThrow(/HTTPS/);
  });

  it('rejects empty endpoint', () => {
    expect(() => createHttpHyokProxyDelegate({ endpoint: '' })).toThrow(KmsUnavailableError);
  });

  it('returns 32-byte key on success', async () => {
    const key = randomBytes(32);
    const delegate = createHttpHyokProxyDelegate({
      endpoint: ENDPOINT,
      fetchImpl: mockFetch(200, { key_b64: key.toString('base64') }),
    });
    const result = await delegate({
      tenantId: TENANT_ID,
      rootKeyId: 'byok-pem:abc123',
      ciphertext: randomBytes(512),
    });
    expect(result).toEqual(key);
  });

  it('throws KmsUnavailableError on HTTP 4xx', async () => {
    const delegate = createHttpHyokProxyDelegate({
      endpoint: ENDPOINT,
      fetchImpl: mockFetch(403, { error: 'Forbidden' }),
    });
    await expect(
      delegate({ tenantId: TENANT_ID, rootKeyId: 'root', ciphertext: randomBytes(32) }),
    ).rejects.toThrow(KmsUnavailableError);
    await expect(
      delegate({ tenantId: TENANT_ID, rootKeyId: 'root', ciphertext: randomBytes(32) }),
    ).rejects.toThrow(/403/);
  });

  it('throws KmsUnavailableError on HTTP 5xx', async () => {
    const delegate = createHttpHyokProxyDelegate({
      endpoint: ENDPOINT,
      fetchImpl: mockFetch(503, 'Service Unavailable'),
    });
    await expect(
      delegate({ tenantId: TENANT_ID, rootKeyId: 'root', ciphertext: randomBytes(32) }),
    ).rejects.toThrow(KmsUnavailableError);
  });

  it('throws KmsUnavailableError when key_b64 is missing from response', async () => {
    const delegate = createHttpHyokProxyDelegate({
      endpoint: ENDPOINT,
      fetchImpl: mockFetch(200, { result: 'ok' }), // missing key_b64
    });
    await expect(
      delegate({ tenantId: TENANT_ID, rootKeyId: 'root', ciphertext: randomBytes(32) }),
    ).rejects.toThrow(KmsUnavailableError);
    await expect(
      delegate({ tenantId: TENANT_ID, rootKeyId: 'root', ciphertext: randomBytes(32) }),
    ).rejects.toThrow(/key_b64/);
  });

  it('throws KmsUnavailableError when returned key is wrong size (< 32 bytes)', async () => {
    const shortKey = randomBytes(16);
    const delegate = createHttpHyokProxyDelegate({
      endpoint: ENDPOINT,
      fetchImpl: mockFetch(200, { key_b64: shortKey.toString('base64') }),
    });
    await expect(
      delegate({ tenantId: TENANT_ID, rootKeyId: 'root', ciphertext: randomBytes(32) }),
    ).rejects.toThrow(KmsUnavailableError);
    await expect(
      delegate({ tenantId: TENANT_ID, rootKeyId: 'root', ciphertext: randomBytes(32) }),
    ).rejects.toThrow(/16-byte/);
  });

  it('throws KmsUnavailableError when returned key is wrong size (> 32 bytes)', async () => {
    const longKey = randomBytes(64);
    const delegate = createHttpHyokProxyDelegate({
      endpoint: ENDPOINT,
      fetchImpl: mockFetch(200, { key_b64: longKey.toString('base64') }),
    });
    await expect(
      delegate({ tenantId: TENANT_ID, rootKeyId: 'root', ciphertext: randomBytes(32) }),
    ).rejects.toThrow(KmsUnavailableError);
  });

  it('sends bearer token in Authorization header', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ key_b64: randomBytes(32).toString('base64') }),
    });
    const delegate = createHttpHyokProxyDelegate({
      endpoint: ENDPOINT,
      bearerToken: 'super-secret-token',
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    await delegate({ tenantId: TENANT_ID, rootKeyId: 'root', ciphertext: randomBytes(32) });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer super-secret-token');
  });

  it('includes ciphertext as base64 in request body', async () => {
    const ciphertext = randomBytes(512);
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ key_b64: randomBytes(32).toString('base64') }),
    });
    const delegate = createHttpHyokProxyDelegate({
      endpoint: ENDPOINT,
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    await delegate({ tenantId: TENANT_ID, rootKeyId: 'root', ciphertext });

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['ciphertext_b64']).toBe(ciphertext.toString('base64'));
    expect(body['tenantId']).toBe(TENANT_ID);
  });
});

// ── createBreakGlassUnwrapDelegate ───────────────────────────────────────────

describe('createBreakGlassUnwrapDelegate', () => {
  it('returns plaintext when a valid grant exists', async () => {
    const plainKey = randomBytes(32);
    const store: BreakGlassGrantStore = {
      resolve: async () => plainKey,
    };
    const delegate = createBreakGlassUnwrapDelegate(store);
    const result = await delegate({
      tenantId: TENANT_ID,
      rootKeyId: 'root',
      ciphertext: randomBytes(512),
    });
    expect(result).toEqual(plainKey);
  });

  it('throws KmsUnavailableError when grant is null (no active grant)', async () => {
    const store: BreakGlassGrantStore = {
      resolve: async () => null,
    };
    const delegate = createBreakGlassUnwrapDelegate(store);
    await expect(
      delegate({ tenantId: TENANT_ID, rootKeyId: 'root', ciphertext: randomBytes(32) }),
    ).rejects.toThrow(KmsUnavailableError);
    await expect(
      delegate({ tenantId: TENANT_ID, rootKeyId: 'root', ciphertext: randomBytes(32) }),
    ).rejects.toThrow(/break-glass grant/i);
  });

  it('propagates non-KmsUnavailableError from the grant store', async () => {
    const store: BreakGlassGrantStore = {
      resolve: async () => { throw new Error('DB connection lost'); },
    };
    const delegate = createBreakGlassUnwrapDelegate(store);
    await expect(
      delegate({ tenantId: TENANT_ID, rootKeyId: 'root', ciphertext: randomBytes(32) }),
    ).rejects.toThrow('DB connection lost');
  });
});

// ── composeDelegates ─────────────────────────────────────────────────────────

describe('composeDelegates', () => {
  const REQ = { tenantId: TENANT_ID, rootKeyId: 'root', ciphertext: randomBytes(32) };

  it('throws if no delegates provided', () => {
    expect(() => composeDelegates([])).toThrow(KmsUnavailableError);
  });

  it('returns result from first succeeding delegate', async () => {
    const key = randomBytes(32);
    const failing: ByokUnwrapDelegate = async () => { throw new KmsUnavailableError('not found'); };
    const succeeding: ByokUnwrapDelegate = async () => key;
    const composed = composeDelegates([failing, succeeding]);
    const result = await composed(REQ);
    expect(result).toEqual(key);
  });

  it('uses first delegate if it succeeds (break-glass hit)', async () => {
    const keyA = randomBytes(32);
    const keyB = randomBytes(32);
    const delegateA: ByokUnwrapDelegate = async () => keyA;
    const delegateB: ByokUnwrapDelegate = async () => keyB;
    const composed = composeDelegates([delegateA, delegateB]);
    const result = await composed(REQ);
    expect(result).toEqual(keyA); // first delegate wins
  });

  it('throws KmsUnavailableError if all delegates fail', async () => {
    const d1: ByokUnwrapDelegate = async () => { throw new KmsUnavailableError('d1 no grant'); };
    const d2: ByokUnwrapDelegate = async () => { throw new KmsUnavailableError('d2 no endpoint'); };
    const composed = composeDelegates([d1, d2]);
    await expect(composed(REQ)).rejects.toThrow(KmsUnavailableError);
  });

  it('bubbles non-KmsUnavailableError immediately without trying remaining delegates', async () => {
    const calledD2 = vi.fn();
    const d1: ByokUnwrapDelegate = async () => { throw new TypeError('unexpected bug'); };
    const d2: ByokUnwrapDelegate = async () => { calledD2(); return randomBytes(32); };
    const composed = composeDelegates([d1, d2]);
    await expect(composed(REQ)).rejects.toThrow(TypeError);
    expect(calledD2).not.toHaveBeenCalled();
  });

  it('works with a single-element list', async () => {
    const key = randomBytes(32);
    const composed = composeDelegates([async () => key]);
    expect(await composed(REQ)).toEqual(key);
  });
});

// ── ByokPemKmsProvider full round-trip ──────────────────────────────────────

describe('ByokPemKmsProvider round-trip', () => {
  it('wraps with the public key and unwraps via LocalByokKeystore delegate', async () => {
    const store = new LocalByokKeystore();
    store.add({ tenantId: TENANT_ID, privateKeyPem: TEST_PRIV_4096 as string });

    const provider = new ByokPemKmsProvider({
      tenantId: TENANT_ID,
      publicKeyPem: TEST_PUB_4096 as string,
      unwrap: store.delegate(),
    });

    const plain = randomBytes(32);
    const rootKeyId = await provider.rootKeyId(TENANT_ID);
    const wrapped = await provider.wrap(rootKeyId, plain);
    const unwrapped = await provider.unwrap(wrapped);
    expect(unwrapped).toEqual(plain);
  });

  it('fails to unwrap if the private key does not match the public key', async () => {
    // Use TEST_PUB_4096 to wrap, but a DIFFERENT private key to unwrap
    const { privateKey: otherPriv } = generateKeyPairSync('rsa', {
      modulusLength: 4096,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const wrongStore = new LocalByokKeystore();
    wrongStore.add({ tenantId: TENANT_ID, privateKeyPem: otherPriv });

    const provider = new ByokPemKmsProvider({
      tenantId: TENANT_ID,
      publicKeyPem: TEST_PUB_4096 as string,
      unwrap: wrongStore.delegate(),
    });

    const plain = randomBytes(32);
    const rootKeyId = await provider.rootKeyId(TENANT_ID);
    const wrapped = await provider.wrap(rootKeyId, plain);
    await expect(provider.unwrap(wrapped)).rejects.toThrow();
  });

  it('rejects wrap of plaintext that is too large for RSA-OAEP-4096', async () => {
    const store = new LocalByokKeystore();
    store.add({ tenantId: TENANT_ID, privateKeyPem: TEST_PRIV_4096 as string });

    const provider = new ByokPemKmsProvider({
      tenantId: TENANT_ID,
      publicKeyPem: TEST_PUB_4096 as string,
      unwrap: store.delegate(),
    });

    const tooBig = randomBytes(512); // RSA-4096 OAEP-SHA256 max is 446 bytes
    const rootKeyId = await provider.rootKeyId(TENANT_ID);
    await expect(provider.wrap(rootKeyId, tooBig)).rejects.toThrow();
  });
});
