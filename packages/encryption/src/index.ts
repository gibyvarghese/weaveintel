/**
 * @weaveintel/encryption — public barrel.
 */

export * from './errors.js';
export * from './kms.js';
export * from './envelope.js';
export * from './store.js';
export * from './audit.js';
export * from './metrics.js';
export * from './alert-evaluator.js';
export * from './field-policy.js';
export * from './key-manager.js';
export * from './adapter-helpers.js';
export * from './blind-index.js';
export * from './proxy.js';
export * from './rotator.js';
export * from './rewrite-store.js';
export * from './rewrite-scheduler.js';
export * from './purge-scheduler.js';
export * from './provider-registry.js';
export * from './kms-resolver.js';
export * from './register-builtins.js';
export { LocalKmsProvider, loadMasterKeyFromEnv } from './providers/local.js';
export type { LocalKmsProviderOptions, LoadMasterKeyOptions, LoadedMasterKey } from './providers/local.js';
export { AwsKmsProvider } from './providers/aws-kms.js';
export type { AwsKmsProviderOptions, KmsClientLike } from './providers/aws-kms.js';
export { AzureKeyVaultProvider } from './providers/azure-kv.js';
export type {
  AzureKeyVaultProviderOptions,
  AzureCryptoClientLike,
  AzureWrapAlgorithm,
} from './providers/azure-kv.js';
export { GcpKmsProvider } from './providers/gcp-kms.js';
export type { GcpKmsProviderOptions, GcpKmsClientLike } from './providers/gcp-kms.js';
export { VaultTransitProvider } from './providers/vault-transit.js';
export type { VaultTransitProviderOptions } from './providers/vault-transit.js';
export {
  ByokPemKmsProvider,
  fingerprintPublicKey,
  loadByokPublicKey,
  makeLocalUnwrapDelegate,
} from './byok/byok-pem-provider.js';
export type {
  ByokPemKmsProviderOptions,
  ByokRootKeyDescriptor,
  ByokUnwrapDelegate,
  ByokUnwrapRequest,
} from './byok/byok-pem-provider.js';
export {
  LocalByokKeystore,
  createHttpHyokProxyDelegate,
  createBreakGlassUnwrapDelegate,
  composeDelegates,
} from './byok/byok-keystore.js';
export type {
  LocalByokKeystoreEntry,
  HttpHyokProxyOptions,
  BreakGlassGrantStore,
} from './byok/byok-keystore.js';
export {
  approveBreakGlass,
  denyBreakGlass,
  reapExpiredBreakGlass,
  findActiveGrant,
  validateNewBreakGlassRequest,
  MAX_GRANT_WINDOW_MS,
  MIN_GRANT_WINDOW_MS,
  DEFAULT_GRANT_WINDOW_MS,
} from './byok/break-glass.js';
export type {
  BreakGlassRequest,
  BreakGlassStatus,
  BreakGlassTransition,
  ApproveBreakGlassInput,
  ApproveBreakGlassResult,
  DenyBreakGlassInput,
  ValidateNewRequestInput,
} from './byok/break-glass.js';
export {
  buildAuditChain,
  buildAndSignAttestation,
  canonicalize,
  fingerprintEd25519PublicKey,
  generateAttestationSigningKey,
  loadAttestationSigningKey,
  verifyAttestation,
} from './byok/attestation.js';
export type {
  AttestationAuditChainEntry,
  AttestationPayload,
  AttestationSigningKey,
  AuditEventLike,
  BuildAttestationInput,
  SignedAttestation,
  TenantAttestationFieldEntry,
  TenantAttestationKeyState,
  TenantAttestationKmsInfo,
  VerifyAttestationInput,
  VerifyAttestationResult,
} from './byok/attestation.js';
