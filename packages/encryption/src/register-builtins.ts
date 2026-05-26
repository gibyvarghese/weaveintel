/**
 * @weaveintel/encryption — built-in KMS provider registrations.
 *
 * Convenience helper that registers the five shipped providers (local, aws-kms,
 * azure-kv, gcp-kms, vault) on a fresh `KmsProviderRegistry`. Apps can call
 * this once at startup and then layer additional custom providers on top.
 *
 * Each factory validates the per-tenant config shape (the `kms_config` JSON
 * blob from the policy table) and constructs a provider instance. Cloud
 * provider SDKs are loaded lazily inside the provider classes themselves —
 * registering a provider does NOT require its SDK to be installed unless
 * a tenant actually selects it.
 */

import { KmsUnavailableError } from './errors.js';
import {
  createKmsProviderRegistry,
  defaultWrapUnwrapHealthCheck,
  type KmsProviderRegistration,
  type KmsProviderRegistry,
} from './provider-registry.js';
import { AwsKmsProvider } from './providers/aws-kms.js';
import { AzureKeyVaultProvider, type AzureWrapAlgorithm } from './providers/azure-kv.js';
import { GcpKmsProvider } from './providers/gcp-kms.js';
import { LocalKmsProvider, loadMasterKeyFromEnv } from './providers/local.js';
import { VaultTransitProvider } from './providers/vault-transit.js';
import { ByokPemKmsProvider, type ByokUnwrapDelegate } from './byok/byok-pem-provider.js';
import { createHttpHyokProxyDelegate } from './byok/byok-keystore.js';

function requireString(config: Record<string, unknown>, key: string, providerId: string): string {
  const v = config[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new KmsUnavailableError(`${providerId} provider requires config.${key} (string)`);
  }
  return v;
}

function optionalString(config: Record<string, unknown>, key: string): string | undefined {
  const v = config[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

const AZURE_ALGORITHMS = new Set<string>(['RSA-OAEP', 'RSA-OAEP-256', 'RSA1_5', 'A256KW']);

function optionalAzureAlg(config: Record<string, unknown>): AzureWrapAlgorithm | undefined {
  const v = optionalString(config, 'algorithm');
  if (v === undefined) return undefined;
  if (!AZURE_ALGORITHMS.has(v)) {
    throw new KmsUnavailableError(`azure-kv: config.algorithm must be one of ${[...AZURE_ALGORITHMS].join(' | ')}, got '${v}'`);
  }
  return v as AzureWrapAlgorithm;
}

/**
 * Local provider config:
 *   `{ masterKeyB64?: string, masterKeyHex?: string, masterKeyEnv?: string,
 *      rootKeyId?: string, devGenerateIfMissing?: boolean }`
 *
 * Resolution order: explicit base64 -> explicit hex -> env var (default
 * `WEAVE_ENCRYPTION_MASTER_KEY`).
 */
const localRegistration: KmsProviderRegistration = {
  id: 'local',
  factory: async (config) => {
    const b64 = optionalString(config, 'masterKeyB64');
    const hex = optionalString(config, 'masterKeyHex');
    let masterKey: Buffer;
    if (b64) {
      masterKey = Buffer.from(b64, 'base64');
    } else if (hex) {
      masterKey = Buffer.from(hex, 'hex');
    } else {
      const envVar = optionalString(config, 'masterKeyEnv') ?? 'WEAVE_ENCRYPTION_MASTER_KEY';
      const dev = config['devGenerateIfMissing'] === true;
      const loaded = loadMasterKeyFromEnv({ envVar, devGenerateIfMissing: dev });
      masterKey = loaded.key;
    }
    if (masterKey.length !== 32) {
      throw new KmsUnavailableError(
        `local provider master key must be 32 bytes, got ${masterKey.length}`,
      );
    }
    const rootKeyId = optionalString(config, 'rootKeyId');
    return new LocalKmsProvider({ masterKey, ...(rootKeyId ? { rootKeyId } : {}) });
  },
  healthCheck: defaultWrapUnwrapHealthCheck(),
};

/** AWS KMS config: `{ keyArn: string, region?: string, endpoint?: string }`. */
const awsKmsRegistration: KmsProviderRegistration = {
  id: 'aws-kms',
  factory: async (config) => {
    const keyArn = requireString(config, 'keyArn', 'aws-kms');
    const region = optionalString(config, 'region');
    const endpoint = optionalString(config, 'endpoint');
    return new AwsKmsProvider({
      keyArn,
      ...(region ? { region } : {}),
      ...(endpoint ? { endpoint } : {}),
    });
  },
  healthCheck: defaultWrapUnwrapHealthCheck(),
};

/**
 * Azure Key Vault config:
 *   `{ vaultUrl: string, keyName: string, keyVersion?: string,
 *      algorithm?: 'RSA-OAEP' | 'RSA-OAEP-256' | 'RSA1_5' | 'A256KW' }`.
 */
const azureKvRegistration: KmsProviderRegistration = {
  id: 'azure-kv',
  factory: async (config) => {
    const vaultUrl = requireString(config, 'vaultUrl', 'azure-kv');
    const keyName = requireString(config, 'keyName', 'azure-kv');
    const keyVersion = optionalString(config, 'keyVersion');
    const alg = optionalAzureAlg(config);
    return new AzureKeyVaultProvider({
      vaultUrl,
      keyName,
      ...(keyVersion ? { keyVersion } : {}),
      ...(alg ? { algorithm: alg } : {}),
    });
  },
  healthCheck: defaultWrapUnwrapHealthCheck(),
};

/** GCP KMS config: `{ keyName: string, projectId?: string }` (full CryptoKey resource name). */
const gcpKmsRegistration: KmsProviderRegistration = {
  id: 'gcp-kms',
  factory: async (config) => {
    const keyName = requireString(config, 'keyName', 'gcp-kms');
    const projectId = optionalString(config, 'projectId');
    return new GcpKmsProvider({ keyName, ...(projectId ? { projectId } : {}) });
  },
  healthCheck: defaultWrapUnwrapHealthCheck(),
};

/**
 * Vault Transit config:
 *   `{ address: string, keyName: string, mount?: string, token?: string,
 *      tokenEnv?: string, namespace?: string }`.
 *
 * Token defaults to env `VAULT_TOKEN`. Storing a literal `token` in tenant
 * config is supported but discouraged — prefer `tokenEnv`.
 */
const vaultRegistration: KmsProviderRegistration = {
  id: 'vault',
  factory: async (config) => {
    const address = requireString(config, 'address', 'vault');
    const keyName = requireString(config, 'keyName', 'vault');
    const mount = optionalString(config, 'mount');
    const token = optionalString(config, 'token');
    const tokenEnv = optionalString(config, 'tokenEnv');
    const namespace = optionalString(config, 'namespace');
    return new VaultTransitProvider({
      address,
      keyName,
      ...(mount ? { mount } : {}),
      ...(token ? { token } : {}),
      ...(tokenEnv ? { tokenEnv } : {}),
      ...(namespace ? { namespace } : {}),
    });
  },
  healthCheck: defaultWrapUnwrapHealthCheck(),
};

/**
 * BYOK / HYOK provider config:
 *   `{ tenantId: string,
 *      publicKeyPem: string,
 *      mode?: 'byok' | 'hyok',
 *      hyokEndpoint?: string,
 *      hyokBearerToken?: string,
 *      hyokTimeoutMs?: number,
 *      privateKeyPemForLocalDev?: string }`
 *
 * When `hyokEndpoint` is set, the provider uses an HTTPS proxy delegate
 * (live customer round-trip per unwrap). When `privateKeyPemForLocalDev`
 * is set, a local in-memory unwrap delegate is wired (DEV ONLY — never
 * use in production). At least one of the two must be supplied; hosts that
 * need a different delegate (HSM bridge, signed-nonce challenge, break-glass
 * cache) should construct `ByokPemKmsProvider` directly with their custom
 * `ByokUnwrapDelegate`.
 */
const byokRegistration: KmsProviderRegistration = {
  id: 'byok-pem',
  factory: async (config) => {
    const tenantId = requireString(config, 'tenantId', 'byok-pem');
    const publicKeyPem = requireString(config, 'publicKeyPem', 'byok-pem');
    const mode = (optionalString(config, 'mode') ?? 'byok') as 'byok' | 'hyok';
    const hyokEndpoint = optionalString(config, 'hyokEndpoint');
    const hyokBearerToken = optionalString(config, 'hyokBearerToken');
    const hyokTimeoutMs = typeof config['hyokTimeoutMs'] === 'number' ? config['hyokTimeoutMs'] : undefined;
    const localPrivPem = optionalString(config, 'privateKeyPemForLocalDev');
    let unwrap: ByokUnwrapDelegate;
    if (hyokEndpoint) {
      unwrap = createHttpHyokProxyDelegate({
        endpoint: hyokEndpoint,
        ...(hyokBearerToken ? { bearerToken: hyokBearerToken } : {}),
        ...(hyokTimeoutMs ? { timeoutMs: hyokTimeoutMs } : {}),
      });
    } else if (localPrivPem) {
      const { makeLocalUnwrapDelegate } = await import('./byok/byok-pem-provider.js');
      unwrap = makeLocalUnwrapDelegate(localPrivPem);
    } else {
      throw new KmsUnavailableError(
        "byok-pem provider requires either 'hyokEndpoint' (production) or 'privateKeyPemForLocalDev' (dev). For custom delegates (HSM, break-glass cache), instantiate ByokPemKmsProvider directly.",
      );
    }
    return new ByokPemKmsProvider({ tenantId, publicKeyPem, unwrap, mode });
  },
  healthCheck: defaultWrapUnwrapHealthCheck(),
};

/**
 * Register the five built-in providers on `registry`. Returns the same
 * registry for fluent chaining.
 */
export function registerBuiltinKmsProviders(registry: KmsProviderRegistry): KmsProviderRegistry {
  registry.register(localRegistration);
  registry.register(awsKmsRegistration);
  registry.register(azureKvRegistration);
  registry.register(gcpKmsRegistration);
  registry.register(vaultRegistration);
  registry.register(byokRegistration);
  return registry;
}

/**
 * Convenience: build a fresh registry and register all built-ins on it.
 *
 * ```ts
 * const registry = createBuiltinKmsRegistry();
 * registry.register({ id: 'my-custom', factory: ..., healthCheck: ... });
 * ```
 */
export function createBuiltinKmsRegistry(): KmsProviderRegistry {
  return registerBuiltinKmsProviders(createKmsProviderRegistry());
}

export const BUILTIN_KMS_PROVIDER_IDS = ['local', 'aws-kms', 'azure-kv', 'gcp-kms', 'vault', 'byok-pem'] as const;
export type BuiltinKmsProviderId = (typeof BUILTIN_KMS_PROVIDER_IDS)[number];
