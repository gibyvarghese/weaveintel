/**
 * @weaveintel/encryption — AzureKeyVaultProvider.
 *
 * Wraps tenant KEKs under an Azure Key Vault key using the Wrap/Unwrap
 * operations. Tenant config: `{ vaultUrl: 'https://my-vault.vault.azure.net',
 * keyName: 'tenant-kek', keyVersion?: '...', algorithm?: 'RSA-OAEP-256' }`.
 *
 * Authentication uses `@azure/identity`'s DefaultAzureCredential (env vars,
 * managed identity, az CLI, etc.). Both SDKs lazy-load.
 */

import { AeadError, KmsUnavailableError } from '../errors.js';
import type { KmsProvider, WrappedKey } from '../kms.js';

export type AzureWrapAlgorithm = 'RSA-OAEP' | 'RSA-OAEP-256' | 'RSA1_5' | 'A256KW';

export interface AzureKeyVaultProviderOptions {
  /** Vault URL (e.g. 'https://my-vault.vault.azure.net'). */
  readonly vaultUrl: string;
  /** Key name in the vault. */
  readonly keyName: string;
  /** Specific key version. Defaults to latest. */
  readonly keyVersion?: string;
  /** Wrap algorithm. Default: 'RSA-OAEP-256'. */
  readonly algorithm?: AzureWrapAlgorithm;
  /** Pre-built CryptographyClient (testing). */
  readonly cryptoClient?: AzureCryptoClientLike;
}

export interface AzureCryptoClientLike {
  wrapKey(algorithm: string, key: Uint8Array): Promise<{ result: Uint8Array; algorithm?: string; keyID?: string }>;
  unwrapKey(algorithm: string, encryptedKey: Uint8Array): Promise<{ result: Uint8Array }>;
}

interface AzureKeyVaultSdk {
  KeyClient: new (vaultUrl: string, credential: unknown) => { getKey(name: string, opts?: { version?: string }): Promise<{ id?: string; key?: { kid?: string } }> };
  CryptographyClient: new (keyId: string, credential: unknown) => AzureCryptoClientLike;
}

interface AzureIdentitySdk {
  DefaultAzureCredential: new () => unknown;
}

let cachedKeysSdk: AzureKeyVaultSdk | null = null;
let cachedIdentitySdk: AzureIdentitySdk | null = null;

async function loadAzureSdks(): Promise<{ keys: AzureKeyVaultSdk; identity: AzureIdentitySdk }> {
  if (cachedKeysSdk && cachedIdentitySdk) {
    return { keys: cachedKeysSdk, identity: cachedIdentitySdk };
  }
  try {
    // Indirect specifiers bypass TS2307 so apps that don't use Azure KV don't need the SDK installed at typecheck time.
    const keysSpecifier = '@azure/keyvault-keys';
    const identitySpecifier = '@azure/identity';
    const keys = (await import(keysSpecifier)) as unknown as AzureKeyVaultSdk;
    const identity = (await import(identitySpecifier)) as unknown as AzureIdentitySdk;
    cachedKeysSdk = keys;
    cachedIdentitySdk = identity;
    return { keys, identity };
  } catch (err) {
    throw new KmsUnavailableError(
      "AzureKeyVaultProvider requires '@azure/keyvault-keys' and '@azure/identity'. Install: npm i @azure/keyvault-keys @azure/identity",
      err,
    );
  }
}

export class AzureKeyVaultProvider implements KmsProvider {
  readonly id = 'azure-kv';
  readonly #vaultUrl: string;
  readonly #keyName: string;
  readonly #keyVersion?: string;
  readonly #algorithm: AzureWrapAlgorithm;
  #cryptoClient: AzureCryptoClientLike | null;
  #resolvedKeyId: string | null = null;

  constructor(opts: AzureKeyVaultProviderOptions) {
    if (!opts.vaultUrl) throw new KmsUnavailableError('AzureKeyVaultProvider requires opts.vaultUrl');
    if (!opts.keyName) throw new KmsUnavailableError('AzureKeyVaultProvider requires opts.keyName');
    this.#vaultUrl = opts.vaultUrl;
    this.#keyName = opts.keyName;
    if (opts.keyVersion !== undefined) this.#keyVersion = opts.keyVersion;
    this.#algorithm = opts.algorithm ?? 'RSA-OAEP-256';
    this.#cryptoClient = opts.cryptoClient ?? null;
  }

  async rootKeyId(_tenantId: string): Promise<string> {
    if (this.#resolvedKeyId) return this.#resolvedKeyId;
    if (this.#cryptoClient) {
      // Test path: caller injected client without a real key id.
      this.#resolvedKeyId = `${this.#vaultUrl}/keys/${this.#keyName}${this.#keyVersion ? '/' + this.#keyVersion : ''}`;
      return this.#resolvedKeyId;
    }
    const { keys, identity } = await loadAzureSdks();
    const cred = new identity.DefaultAzureCredential();
    const keyClient = new keys.KeyClient(this.#vaultUrl, cred);
    let keyId: string;
    try {
      const key = await keyClient.getKey(this.#keyName, this.#keyVersion ? { version: this.#keyVersion } : undefined);
      keyId = key.id ?? key.key?.kid ?? '';
      if (!keyId) throw new Error('Key has no id');
    } catch (err) {
      throw new KmsUnavailableError(`Azure Key Vault getKey failed: ${(err as Error).message}`, err);
    }
    this.#resolvedKeyId = keyId;
    this.#cryptoClient = new keys.CryptographyClient(keyId, cred);
    return keyId;
  }

  async wrap(rootKeyId: string, plaintextKey: Buffer): Promise<WrappedKey> {
    if (plaintextKey.length !== 32) {
      throw new AeadError(`plaintext key must be 32 bytes, got ${plaintextKey.length}`);
    }
    const client = await this.#getCryptoClient(rootKeyId);
    let res;
    try {
      res = await client.wrapKey(this.#algorithm, new Uint8Array(plaintextKey));
    } catch (err) {
      throw new KmsUnavailableError(`Azure KV wrapKey failed: ${(err as Error).message}`, err);
    }
    // The wrap algorithm is encoded as a query suffix on rootKeyId so unwrap can recover it without
    // requiring the WrappedKey union to grow per-provider variants.
    const taggedRootKeyId = encodeAlgorithmInRootKeyId(rootKeyId, this.#algorithm);
    return {
      rootKeyId: taggedRootKeyId,
      alg: 'KMS-NATIVE',
      ciphertext: Buffer.from(res.result),
    };
  }

  async unwrap(wrapped: WrappedKey): Promise<Buffer> {
    if (wrapped.alg !== 'KMS-NATIVE') {
      throw new AeadError(`AzureKeyVaultProvider expected alg=KMS-NATIVE, got ${wrapped.alg}`);
    }
    const { keyId, algorithm } = decodeAlgorithmFromRootKeyId(wrapped.rootKeyId, this.#algorithm);
    const client = await this.#getCryptoClient(keyId);
    let res;
    try {
      res = await client.unwrapKey(algorithm, new Uint8Array(wrapped.ciphertext));
    } catch (err) {
      throw new AeadError(`Azure KV unwrapKey failed: ${(err as Error).message}`, err);
    }
    return Buffer.from(res.result);
  }

  async #getCryptoClient(_keyId: string): Promise<AzureCryptoClientLike> {
    if (this.#cryptoClient) return this.#cryptoClient;
    // Force resolution which builds the client.
    await this.rootKeyId('init');
    if (!this.#cryptoClient) throw new KmsUnavailableError('Azure KV crypto client not initialized');
    return this.#cryptoClient;
  }
}

function encodeAlgorithmInRootKeyId(keyId: string, algorithm: string): string {
  if (keyId.includes('?alg=')) return keyId;
  return `${keyId}?alg=${algorithm}`;
}

function decodeAlgorithmFromRootKeyId(
  taggedKeyId: string,
  fallbackAlgorithm: string,
): { keyId: string; algorithm: string } {
  const idx = taggedKeyId.indexOf('?alg=');
  if (idx < 0) return { keyId: taggedKeyId, algorithm: fallbackAlgorithm };
  return { keyId: taggedKeyId.slice(0, idx), algorithm: taggedKeyId.slice(idx + 5) };
}
