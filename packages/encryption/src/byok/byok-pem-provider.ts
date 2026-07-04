/**
 * @weaveintel/encryption — BYOK / HYOK KmsProvider.
 *
 * Wraps tenant KEK material with the customer's RSA-4096 public key (RSA-OAEP,
 * SHA-256). The customer holds the private key in their HSM / KMS / proxy and
 * authorises every unwrap via a pluggable `ByokUnwrapDelegate`.
 *
 * Two operating modes ship out of the box, both expressed via the delegate:
 *
 *   1. **BYOK (offline / dev / break-glass cache)**
 *      - Customer hands over the public key only.
 *      - Operator pre-stages a small batch of unwrapped DEKs through a
 *        break-glass grant (Phase 10) so background jobs can run without
 *        round-tripping the customer.
 *
 *   2. **HYOK (live customer round-trip)**
 *      - Customer runs an HTTPS unwrap proxy.
 *      - Every unwrap is a round-trip — weaveintel never holds the
 *        unwrapping key, only the in-flight DEK material.
 *
 * Reusability invariant: this file imports only `node:crypto` + sibling files
 * inside `@weaveintel/encryption`. No host-specific deps. Other apps can use
 * it by registering the provider on their own `KmsProviderRegistry`.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  privateDecrypt,
  publicEncrypt,
  constants as cryptoConstants,
  type KeyObject,
} from 'node:crypto';
import { KmsUnavailableError } from '../errors.js';
import type { KmsProvider, WrappedKey } from '../kms.js';

/**
 * Pluggable unwrap delegate. Receives the wrapped ciphertext and the
 * `rootKeyId` (== fingerprint of the customer's public key). Returns the
 * 32-byte plaintext key.
 *
 * Implementations:
 *   - `LocalByokKeystore` — holds private key in-memory (dev/test only).
 *   - `HttpHyokProxyDelegate` — POSTs ciphertext to a customer endpoint.
 *   - Any callable: hardware HSM bridge, signed-nonce protocol, etc.
 */
export type ByokUnwrapDelegate = (request: ByokUnwrapRequest) => Promise<Buffer>;

export interface ByokUnwrapRequest {
  readonly tenantId: string;
  readonly rootKeyId: string;
  readonly ciphertext: Buffer;
  /**
   * Optional context the host wants the customer to log (audit-only). The
   * delegate must not rely on this for security decisions — it is *not*
   * authenticated end-to-end.
   */
  readonly context?: Record<string, unknown>;
}

export interface ByokPemKmsProviderOptions {
  /** Tenant id (provider is tenant-scoped). */
  readonly tenantId: string;
  /** Customer-supplied RSA-4096 public key in PEM (SPKI). */
  readonly publicKeyPem: string;
  /** Unwrap delegate (BYOK keystore, HYOK proxy, or custom). Required. */
  readonly unwrap: ByokUnwrapDelegate;
  /**
   * Override the deterministic fingerprint used as `rootKeyId`. Defaults to
   * `byok-pem:<sha256-of-spki-der-base64url-12chars>` so rotating the public
   * key produces a fresh root id without colliding.
   */
  readonly rootKeyIdOverride?: string;
  /**
   * Mode label baked into audit / attestation records. Functional behaviour
   * is identical in both modes — the delegate decides where the unwrap
   * happens.
   */
  readonly mode?: 'byok' | 'hyok';
}

export interface ByokRootKeyDescriptor {
  readonly id: string;
  readonly mode: 'byok' | 'hyok';
  readonly publicKeyFingerprint: string;
}

const RSA_KEY_BITS_REQUIRED = 4096;

/**
 * Compute SHA-256 fingerprint of the SPKI DER for stable root-key ids.
 * Returned as base64url, truncated to first 16 chars (96 bits — collision
 * resistant for our scale, short enough for log lines).
 */
export function fingerprintPublicKey(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('base64url').slice(0, 16);
}

/**
 * Validate that a PEM string is a usable RSA-4096 SPKI public key. Throws
 * `KmsUnavailableError` with a user-actionable message on any defect.
 */
export function loadByokPublicKey(pem: string): KeyObject {
  if (typeof pem !== 'string' || !pem.includes('-----BEGIN PUBLIC KEY-----')) {
    throw new KmsUnavailableError(
      'BYOK public key must be PEM-encoded SPKI starting with -----BEGIN PUBLIC KEY-----',
    );
  }
  let key: KeyObject;
  try {
    key = createPublicKey({ key: pem, format: 'pem' });
  } catch (err) {
    throw new KmsUnavailableError(`BYOK public key parse failed: ${(err as Error).message}`);
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new KmsUnavailableError(
      `BYOK public key must be RSA, got ${key.asymmetricKeyType ?? 'unknown'}`,
    );
  }
  const bits = (key.asymmetricKeyDetails?.modulusLength as number | undefined) ?? 0;
  if (bits < RSA_KEY_BITS_REQUIRED) {
    throw new KmsUnavailableError(
      `BYOK public key must be at least RSA-${RSA_KEY_BITS_REQUIRED}, got RSA-${bits}`,
    );
  }
  return key;
}

/**
 * KmsProvider implementation backed by a customer-held private key.
 *
 * - `wrap` runs locally with `RSA-OAEP / SHA-256` against the public key.
 * - `unwrap` invokes the configured delegate. If the delegate throws or
 *   returns a non-32-byte buffer, we wrap the failure in `KmsUnavailableError`
 *   so callers experience a consistent error shape.
 * - `rotateRoot` is intentionally not implemented — rotation requires a new
 *   public key registration via the host's BYOK admin surface.
 */
export class ByokPemKmsProvider implements KmsProvider {
  readonly id = 'byok-pem';
  readonly #tenantId: string;
  readonly #publicKey: KeyObject;
  readonly #rootKeyId: string;
  readonly #fingerprint: string;
  readonly #unwrap: ByokUnwrapDelegate;
  readonly #mode: 'byok' | 'hyok';

  constructor(opts: ByokPemKmsProviderOptions) {
    if (!opts.tenantId) throw new KmsUnavailableError('ByokPemKmsProvider requires tenantId');
    if (typeof opts.unwrap !== 'function') {
      throw new KmsUnavailableError('ByokPemKmsProvider requires unwrap delegate');
    }
    this.#tenantId = opts.tenantId;
    this.#publicKey = loadByokPublicKey(opts.publicKeyPem);
    this.#fingerprint = fingerprintPublicKey(this.#publicKey);
    this.#rootKeyId = opts.rootKeyIdOverride ?? `byok-pem:${this.#fingerprint}`;
    this.#unwrap = opts.unwrap;
    this.#mode = opts.mode ?? 'byok';
  }

  describe(): ByokRootKeyDescriptor {
    return { id: this.#rootKeyId, mode: this.#mode, publicKeyFingerprint: this.#fingerprint };
  }

  async rootKeyId(tenantId: string): Promise<string> {
    if (tenantId !== this.#tenantId) {
      throw new KmsUnavailableError(
        `ByokPemKmsProvider is tenant-scoped to '${this.#tenantId}', refused tenant '${tenantId}'`,
      );
    }
    return this.#rootKeyId;
  }

  async wrap(rootKeyId: string, plaintextKey: Buffer): Promise<WrappedKey> {
    if (plaintextKey.length !== 32) {
      throw new KmsUnavailableError(
        `BYOK wrap requires 32-byte plaintext key, got ${plaintextKey.length}`,
      );
    }
    if (rootKeyId !== this.#rootKeyId) {
      throw new KmsUnavailableError(
        `BYOK wrap rootKeyId mismatch: provider=${this.#rootKeyId} got=${rootKeyId}`,
      );
    }
    const ciphertext = publicEncrypt(
      {
        key: this.#publicKey,
        padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      plaintextKey,
    );
    return { rootKeyId, alg: 'KMS-NATIVE', ciphertext };
  }

  async unwrap(wrapped: WrappedKey): Promise<Buffer> {
    if (wrapped.alg !== 'KMS-NATIVE') {
      throw new KmsUnavailableError(`BYOK unwrap expects alg=KMS-NATIVE, got ${wrapped.alg}`);
    }
    if (wrapped.rootKeyId !== this.#rootKeyId) {
      throw new KmsUnavailableError(
        `BYOK unwrap rootKeyId mismatch: provider=${this.#rootKeyId} wrapped=${wrapped.rootKeyId}`,
      );
    }
    let plaintext: Buffer;
    try {
      plaintext = await this.#unwrap({
        tenantId: this.#tenantId,
        rootKeyId: this.#rootKeyId,
        ciphertext: wrapped.ciphertext,
        context: { mode: this.#mode, fingerprint: this.#fingerprint },
      });
    } catch (err) {
      throw new KmsUnavailableError(
        `BYOK unwrap delegate failed (${this.#mode}): ${(err as Error).message}`,
      );
    }
    if (!Buffer.isBuffer(plaintext) || plaintext.length !== 32) {
      throw new KmsUnavailableError(
        `BYOK unwrap delegate returned ${Buffer.isBuffer(plaintext) ? `${plaintext.length}-byte buffer` : typeof plaintext}, expected 32-byte Buffer`,
      );
    }
    return plaintext;
  }
}

/**
 * Convenience: build a delegate that locally decrypts using a private key in
 * memory. Suitable for tests and for the `LocalByokKeystore` adapter that
 * loads the private key from a developer-only env var. NEVER use for prod.
 */
export function makeLocalUnwrapDelegate(privateKeyPem: string): ByokUnwrapDelegate {
  let priv: KeyObject;
  try {
    priv = createPrivateKey({ key: privateKeyPem, format: 'pem' });
  } catch (err) {
    throw new KmsUnavailableError(`BYOK local private key parse failed: ${(err as Error).message}`);
  }
  if (priv.asymmetricKeyType !== 'rsa') {
    throw new KmsUnavailableError(
      `BYOK local private key must be RSA, got ${priv.asymmetricKeyType ?? 'unknown'}`,
    );
  }
  return async ({ ciphertext }) => {
    return privateDecrypt(
      { key: priv, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      ciphertext,
    );
  };
}
