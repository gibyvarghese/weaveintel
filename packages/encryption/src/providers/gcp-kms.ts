/**
 * @weaveintel/encryption — GcpKmsProvider.
 *
 * Wraps tenant KEKs under a Google Cloud KMS CryptoKey using the symmetric
 * encrypt/decrypt API. Tenant config:
 * `{ keyName: 'projects/.../locations/.../keyRings/.../cryptoKeys/...' }`.
 *
 * The GCP SDK (@google-cloud/kms) is loaded lazily so apps that do not use
 * GCP KMS never pay the import cost.
 */

import { AeadError, KmsUnavailableError } from '../errors.js';
import type { KmsProvider, WrappedKey } from '../kms.js';

export interface GcpKmsProviderOptions {
  /** Fully-qualified CryptoKey resource name. */
  readonly keyName: string;
  /**
   * Pre-built `KeyManagementServiceClient`. When omitted, a default client is
   * constructed lazily on first use using Application Default Credentials.
   */
  readonly client?: GcpKmsClientLike;
  /** Project id used for additional authenticated data binding. */
  readonly projectId?: string;
}

/** Subset of GCP `KeyManagementServiceClient` we depend on. */
export interface GcpKmsClientLike {
  encrypt(req: {
    name: string;
    plaintext: Uint8Array;
    additionalAuthenticatedData?: Uint8Array;
  }): Promise<[{ ciphertext?: Uint8Array | string; name?: string }]>;
  decrypt(req: {
    name: string;
    ciphertext: Uint8Array;
    additionalAuthenticatedData?: Uint8Array;
  }): Promise<[{ plaintext?: Uint8Array | string }]>;
}

interface GcpKmsSdk {
  KeyManagementServiceClient: new (cfg?: { projectId?: string }) => GcpKmsClientLike;
}

let cachedSdk: GcpKmsSdk | null = null;

async function loadGcpSdk(): Promise<GcpKmsSdk> {
  if (cachedSdk) return cachedSdk;
  try {
    const specifier = '@google-cloud/kms';
    const mod = (await import(specifier)) as unknown as GcpKmsSdk;
    cachedSdk = mod;
    return mod;
  } catch (err) {
    throw new KmsUnavailableError(
      "GcpKmsProvider requires '@google-cloud/kms'. Install it: npm i @google-cloud/kms",
      err,
    );
  }
}

function toBuffer(value: Uint8Array | string | undefined): Buffer | null {
  if (value === undefined) return null;
  if (typeof value === 'string') return Buffer.from(value, 'base64');
  return Buffer.from(value);
}

export class GcpKmsProvider implements KmsProvider {
  readonly id = 'gcp-kms';
  readonly #keyName: string;
  readonly #aad: Buffer;
  #client: GcpKmsClientLike | null;

  constructor(opts: GcpKmsProviderOptions) {
    if (!opts.keyName || typeof opts.keyName !== 'string') {
      throw new KmsUnavailableError('GcpKmsProvider requires opts.keyName');
    }
    this.#keyName = opts.keyName;
    this.#aad = Buffer.from('weaveintel:kek-wrap');
    this.#client = opts.client ?? null;
  }

  async rootKeyId(_tenantId: string): Promise<string> {
    return this.#keyName;
  }

  async wrap(rootKeyId: string, plaintextKey: Buffer): Promise<WrappedKey> {
    if (plaintextKey.length !== 32) {
      throw new AeadError(`plaintext key must be 32 bytes, got ${plaintextKey.length}`);
    }
    const client = await this.#getClient();
    let result;
    try {
      [result] = await client.encrypt({
        name: rootKeyId,
        plaintext: new Uint8Array(plaintextKey),
        additionalAuthenticatedData: new Uint8Array(this.#aad),
      });
    } catch (err) {
      throw new KmsUnavailableError(`GCP KMS encrypt failed: ${(err as Error).message}`, err);
    }
    const ct = toBuffer(result?.ciphertext);
    if (!ct) throw new KmsUnavailableError('GCP KMS encrypt returned no ciphertext');
    return {
      rootKeyId,
      alg: 'KMS-NATIVE',
      ciphertext: ct,
    };
  }

  async unwrap(wrapped: WrappedKey): Promise<Buffer> {
    if (wrapped.alg !== 'KMS-NATIVE') {
      throw new AeadError(`GcpKmsProvider expected alg=KMS-NATIVE, got ${wrapped.alg}`);
    }
    const client = await this.#getClient();
    let result;
    try {
      [result] = await client.decrypt({
        name: wrapped.rootKeyId,
        ciphertext: new Uint8Array(wrapped.ciphertext),
        additionalAuthenticatedData: new Uint8Array(this.#aad),
      });
    } catch (err) {
      throw new AeadError(`GCP KMS decrypt failed: ${(err as Error).message}`, err);
    }
    const pt = toBuffer(result?.plaintext);
    if (!pt) throw new AeadError('GCP KMS decrypt returned no plaintext');
    return pt;
  }

  async #getClient(): Promise<GcpKmsClientLike> {
    if (this.#client) return this.#client;
    const sdk = await loadGcpSdk();
    this.#client = new sdk.KeyManagementServiceClient();
    return this.#client;
  }
}
