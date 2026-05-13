/**
 * @weaveintel/encryption — KMS provider contract.
 *
 * KMS providers wrap and unwrap raw 32-byte symmetric keys (KEKs) under a
 * provider-managed root key. The application never sees the root key
 * material. Built-in `local` provider keeps the root key in memory loaded
 * from an environment variable; cloud providers (AWS KMS, GCP KMS, Azure
 * Key Vault, Vault) plug in via the same interface in Phase 7.
 */

export interface WrappedKey {
  /** Root key id used to wrap. Provider-specific. */
  readonly rootKeyId: string;
  /** Wrap algorithm. AES-GCM is used by the local provider. */
  readonly alg: 'AES-KW' | 'AES-GCM' | 'KMS-NATIVE';
  /** Wrapped key bytes (raw; callers serialize as base64 for storage). */
  readonly ciphertext: Buffer;
  /** Initialization vector (when alg = 'AES-GCM'). */
  readonly iv?: Buffer;
  /** Authentication tag (when alg = 'AES-GCM'). */
  readonly authTag?: Buffer;
}

export interface KmsProvider {
  /** Provider id, e.g. 'local' | 'aws-kms' | 'gcp-kms' | 'azure-kv' | 'vault'. */
  readonly id: string;
  /** Resolve (or create) the active root key id for a tenant. */
  rootKeyId(tenantId: string): Promise<string>;
  /** Wrap a 32-byte plaintext key under the root key. */
  wrap(rootKeyId: string, plaintextKey: Buffer): Promise<WrappedKey>;
  /** Unwrap a previously-wrapped key. */
  unwrap(wrapped: WrappedKey): Promise<Buffer>;
  /** Optional KMS-side root rotation. Returns the new root key id. */
  rotateRoot?(currentRootKeyId: string): Promise<string>;
}

/** JSON-safe encoding used by EncryptionStore impls. */
export interface SerializedWrappedKey {
  rootKeyId: string;
  alg: 'AES-KW' | 'AES-GCM' | 'KMS-NATIVE';
  ciphertext: string; // base64
  iv?: string; // base64
  authTag?: string; // base64
}

export function serializeWrappedKey(w: WrappedKey): SerializedWrappedKey {
  const out: SerializedWrappedKey = {
    rootKeyId: w.rootKeyId,
    alg: w.alg,
    ciphertext: w.ciphertext.toString('base64'),
  };
  if (w.iv) out.iv = w.iv.toString('base64');
  if (w.authTag) out.authTag = w.authTag.toString('base64');
  return out;
}

export function deserializeWrappedKey(s: SerializedWrappedKey): WrappedKey {
  const w: WrappedKey = {
    rootKeyId: s.rootKeyId,
    alg: s.alg,
    ciphertext: Buffer.from(s.ciphertext, 'base64'),
    ...(s.iv ? { iv: Buffer.from(s.iv, 'base64') } : {}),
    ...(s.authTag ? { authTag: Buffer.from(s.authTag, 'base64') } : {}),
  };
  return w;
}
