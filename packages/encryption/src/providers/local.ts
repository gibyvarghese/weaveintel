/**
 * @weaveintel/encryption — LocalKmsProvider.
 *
 * Wraps tenant KEKs/DEKs under a single 32-byte master key sourced from
 * `WEAVE_ENCRYPTION_MASTER_KEY` (hex or base64). Suitable for single-node /
 * dev / CI use. Cloud providers (Phase 7) plug in via the same KmsProvider
 * interface.
 *
 * Wrap algorithm: AES-256-GCM with random 96-bit IV. We use AES-GCM rather
 * than AES-KW so the implementation works on every Node version without
 * relying on OpenSSL's `aes256-wrap` cipher availability.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AeadError, KmsUnavailableError } from '../errors.js';
import type { KmsProvider, WrappedKey } from '../kms.js';

const ROOT_KEY_ID_DEFAULT = 'local:default';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export interface LocalKmsProviderOptions {
  /** 32-byte master key. Required. */
  readonly masterKey: Buffer;
  /** Root key id reported by `rootKeyId(tenantId)`. Defaults to 'local:default'. */
  readonly rootKeyId?: string;
}

export interface LoadMasterKeyOptions {
  /** Env var name. Default: 'WEAVE_ENCRYPTION_MASTER_KEY'. */
  readonly envVar?: string;
  /** When true and env var missing, generate a random key (DEV ONLY). */
  readonly devGenerateIfMissing?: boolean;
}

export interface LoadedMasterKey {
  readonly key: Buffer;
  readonly source: 'env' | 'dev-generated';
}

/**
 * Load a 32-byte master key from an env var. Accepts hex (64 chars) or base64.
 * Throws KmsUnavailableError if missing AND `devGenerateIfMissing` is false.
 */
export function loadMasterKeyFromEnv(opts: LoadMasterKeyOptions = {}): LoadedMasterKey {
  const envVar = opts.envVar ?? 'WEAVE_ENCRYPTION_MASTER_KEY';
  const raw = process.env[envVar];
  if (raw && raw.length > 0) {
    const buf = decodeKeyMaterial(raw);
    if (buf.length !== 32) {
      throw new KmsUnavailableError(
        `${envVar} must decode to 32 bytes, got ${buf.length}`,
      );
    }
    return { key: buf, source: 'env' };
  }
  if (opts.devGenerateIfMissing) {
    return { key: randomBytes(32), source: 'dev-generated' };
  }
  throw new KmsUnavailableError(
    `${envVar} is not set and devGenerateIfMissing is false. Set a 32-byte hex/base64 master key.`,
  );
}

function decodeKeyMaterial(raw: string): Buffer {
  // Hex if length 64 and only hex chars.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  // Otherwise base64 (allow padding-stripped).
  return Buffer.from(raw, 'base64');
}

export class LocalKmsProvider implements KmsProvider {
  readonly id = 'local';
  readonly #masterKey: Buffer;
  readonly #rootKeyId: string;

  constructor(opts: LocalKmsProviderOptions) {
    if (opts.masterKey.length !== 32) {
      throw new KmsUnavailableError(
        `LocalKmsProvider master key must be 32 bytes, got ${opts.masterKey.length}`,
      );
    }
    this.#masterKey = opts.masterKey;
    this.#rootKeyId = opts.rootKeyId ?? ROOT_KEY_ID_DEFAULT;
  }

  async rootKeyId(_tenantId: string): Promise<string> {
    return this.#rootKeyId;
  }

  async wrap(rootKeyId: string, plaintextKey: Buffer): Promise<WrappedKey> {
    if (plaintextKey.length !== 32) {
      throw new AeadError(`plaintext key must be 32 bytes, got ${plaintextKey.length}`);
    }
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', this.#masterKey, iv, { authTagLength: AUTH_TAG_LENGTH });
    cipher.setAAD(Buffer.from(rootKeyId, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintextKey), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return { rootKeyId, alg: 'AES-GCM', ciphertext: ct, iv, authTag };
  }

  async unwrap(wrapped: WrappedKey): Promise<Buffer> {
    if (wrapped.alg !== 'AES-GCM') {
      throw new AeadError(`LocalKmsProvider expected alg=AES-GCM, got ${wrapped.alg}`);
    }
    if (!wrapped.iv || !wrapped.authTag) {
      throw new AeadError('LocalKmsProvider requires iv and authTag for AES-GCM unwrap');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.#masterKey, wrapped.iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAAD(Buffer.from(wrapped.rootKeyId, 'utf8'));
    decipher.setAuthTag(wrapped.authTag);
    try {
      return Buffer.concat([decipher.update(wrapped.ciphertext), decipher.final()]);
    } catch (err) {
      throw new AeadError('LocalKmsProvider unwrap failed (tampered wrapped key or wrong master key)', err);
    }
  }
}
