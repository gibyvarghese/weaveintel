/**
 * @weaveintel/encryption — AwsKmsProvider.
 *
 * Wraps tenant KEKs under an AWS KMS Customer Master Key (CMK) using the
 * native KMS Encrypt/Decrypt APIs. Tenant config: `{ keyArn: 'arn:aws:kms:...',
 * region?: 'us-east-1', endpoint?: 'https://kms.us-east-1.amazonaws.com' }`.
 *
 * The AWS SDK (@aws-sdk/client-kms) is loaded lazily so apps that do not use
 * AWS KMS never pay the import cost.
 */

import { AeadError, KmsUnavailableError } from '../errors.js';
import type { KmsProvider, WrappedKey } from '../kms.js';

export interface AwsKmsProviderOptions {
  /** AWS KMS key ARN or alias (alias/your-key). */
  readonly keyArn: string;
  /** AWS region. Falls back to AWS_REGION / AWS_DEFAULT_REGION env vars. */
  readonly region?: string;
  /** Custom KMS endpoint (LocalStack, VPC endpoints). */
  readonly endpoint?: string;
  /**
   * Pre-built `KMSClient` instance (testing / shared client). When omitted,
   * a default client is constructed lazily on first use.
   */
  readonly client?: KmsClientLike;
}

/** Subset of `@aws-sdk/client-kms`'s `KMSClient` we depend on. */
export interface KmsClientLike {
  send(command: unknown): Promise<{ CiphertextBlob?: Uint8Array; Plaintext?: Uint8Array; KeyId?: string }>;
}

interface AwsKmsSdk {
  KMSClient: new (cfg: { region?: string; endpoint?: string }) => KmsClientLike;
  EncryptCommand: new (input: { KeyId: string; Plaintext: Uint8Array; EncryptionContext?: Record<string, string> }) => unknown;
  DecryptCommand: new (input: { CiphertextBlob: Uint8Array; KeyId?: string; EncryptionContext?: Record<string, string> }) => unknown;
}

let cachedSdk: AwsKmsSdk | null = null;

// Indirect specifier bypasses TS2307 so optional-dep packages don't need to be
// installed at typecheck time. The cast is intentional; T is defined locally.
function castSdk<T>(mod: unknown): T { return mod as T; }

async function loadAwsSdk(): Promise<AwsKmsSdk> {
  if (cachedSdk) return cachedSdk;
  try {
    const specifier = '@aws-sdk/client-kms';
    const mod = castSdk<AwsKmsSdk>(await import(specifier));
    cachedSdk = mod;
    return mod;
  } catch (err) {
    throw new KmsUnavailableError(
      "AwsKmsProvider requires '@aws-sdk/client-kms'. Install it: npm i @aws-sdk/client-kms",
      err,
    );
  }
}

export class AwsKmsProvider implements KmsProvider {
  readonly id = 'aws-kms';
  readonly #keyArn: string;
  readonly #region?: string;
  readonly #endpoint?: string;
  #client: KmsClientLike | null;

  constructor(opts: AwsKmsProviderOptions) {
    if (!opts.keyArn || typeof opts.keyArn !== 'string') {
      throw new KmsUnavailableError('AwsKmsProvider requires opts.keyArn');
    }
    this.#keyArn = opts.keyArn;
    if (opts.region !== undefined) this.#region = opts.region;
    if (opts.endpoint !== undefined) this.#endpoint = opts.endpoint;
    this.#client = opts.client ?? null;
  }

  async rootKeyId(_tenantId: string): Promise<string> {
    return this.#keyArn;
  }

  async wrap(rootKeyId: string, plaintextKey: Buffer): Promise<WrappedKey> {
    if (plaintextKey.length !== 32) {
      throw new AeadError(`plaintext key must be 32 bytes, got ${plaintextKey.length}`);
    }
    const client = await this.#getClient();
    const sdk = await loadAwsSdk();
    const cmd = new sdk.EncryptCommand({
      KeyId: rootKeyId,
      Plaintext: new Uint8Array(plaintextKey),
      EncryptionContext: { weaveintel: 'kek-wrap' },
    });
    let result;
    try {
      result = await client.send(cmd);
    } catch (err) {
      throw new KmsUnavailableError(`AWS KMS Encrypt failed: ${(err as Error).message}`, err);
    }
    if (!result.CiphertextBlob) {
      throw new KmsUnavailableError('AWS KMS Encrypt returned no CiphertextBlob');
    }
    return {
      rootKeyId,
      alg: 'KMS-NATIVE',
      ciphertext: Buffer.from(result.CiphertextBlob),
    };
  }

  async unwrap(wrapped: WrappedKey): Promise<Buffer> {
    if (wrapped.alg !== 'KMS-NATIVE') {
      throw new AeadError(`AwsKmsProvider expected alg=KMS-NATIVE, got ${wrapped.alg}`);
    }
    const client = await this.#getClient();
    const sdk = await loadAwsSdk();
    const cmd = new sdk.DecryptCommand({
      CiphertextBlob: new Uint8Array(wrapped.ciphertext),
      KeyId: wrapped.rootKeyId,
      EncryptionContext: { weaveintel: 'kek-wrap' },
    });
    let result;
    try {
      result = await client.send(cmd);
    } catch (err) {
      throw new AeadError(`AWS KMS Decrypt failed: ${(err as Error).message}`, err);
    }
    if (!result.Plaintext) {
      throw new AeadError('AWS KMS Decrypt returned no Plaintext');
    }
    return Buffer.from(result.Plaintext);
  }

  async #getClient(): Promise<KmsClientLike> {
    if (this.#client) return this.#client;
    const sdk = await loadAwsSdk();
    this.#client = new sdk.KMSClient({
      ...(this.#region ? { region: this.#region } : {}),
      ...(this.#endpoint ? { endpoint: this.#endpoint } : {}),
    });
    return this.#client;
  }
}
