/**
 * @weaveintel/encryption — KMS provider registry.
 *
 * Maps provider IDs (`'local' | 'aws-kms' | 'azure-kv' | 'gcp-kms' | 'vault'`)
 * to async factories that build a `KmsProvider` from per-tenant config JSON.
 *
 * Cloud providers lazy-import their SDKs inside their factory so installing
 * the SDK is optional — apps that only use `local` never load AWS/Azure/GCP
 * client libraries.
 */

import { KmsUnavailableError } from './errors.js';
import type { KmsProvider } from './kms.js';

/** Per-tenant KMS provider configuration. Shape is provider-specific. */
export type KmsProviderConfig = Record<string, unknown>;

/** Factory that constructs a KmsProvider from per-tenant config. */
export type KmsProviderFactory = (config: KmsProviderConfig) => Promise<KmsProvider>;

/** Optional health-check signature. Implementations may probe their backend. */
export type KmsHealthCheck = (provider: KmsProvider) => Promise<KmsHealthStatus>;

export interface KmsHealthStatus {
  readonly ok: boolean;
  readonly providerId: string;
  readonly latencyMs?: number;
  readonly error?: string;
  readonly details?: Record<string, unknown>;
}

export interface KmsProviderRegistration {
  readonly id: string;
  readonly factory: KmsProviderFactory;
  readonly healthCheck?: KmsHealthCheck;
}

export interface KmsProviderRegistry {
  register(reg: KmsProviderRegistration): void;
  has(id: string): boolean;
  list(): readonly string[];
  build(id: string, config: KmsProviderConfig): Promise<KmsProvider>;
  healthCheck(id: string, provider: KmsProvider): Promise<KmsHealthStatus>;
}

export function createKmsProviderRegistry(): KmsProviderRegistry {
  const entries = new Map<string, KmsProviderRegistration>();
  return {
    register(reg) {
      entries.set(reg.id, reg);
    },
    has(id) {
      return entries.has(id);
    },
    list() {
      return Array.from(entries.keys());
    },
    async build(id, config) {
      const reg = entries.get(id);
      if (!reg) {
        throw new KmsUnavailableError(
          `Unknown KMS provider id '${id}'. Registered: [${Array.from(entries.keys()).join(', ')}]`,
        );
      }
      return reg.factory(config);
    },
    async healthCheck(id, provider) {
      const reg = entries.get(id);
      if (!reg) {
        return { ok: false, providerId: id, error: `unknown provider '${id}'` };
      }
      if (!reg.healthCheck) {
        return { ok: true, providerId: id, details: { note: 'no health check implemented' } };
      }
      try {
        return await reg.healthCheck(provider);
      } catch (err) {
        return { ok: false, providerId: id, error: (err as Error).message };
      }
    },
  };
}

/** Default health check: tries to wrap+unwrap a 32-byte test key. */
export function defaultWrapUnwrapHealthCheck(testTenantId = 'health-check'): KmsHealthCheck {
  return async (provider) => {
    const start = Date.now();
    try {
      const rootKeyId = await provider.rootKeyId(testTenantId);
      const testKey = Buffer.alloc(32, 0x42);
      const wrapped = await provider.wrap(rootKeyId, testKey);
      const unwrapped = await provider.unwrap(wrapped);
      const ok = unwrapped.equals(testKey);
      return {
        ok,
        providerId: provider.id,
        latencyMs: Date.now() - start,
        ...(ok ? {} : { error: 'wrap/unwrap roundtrip failed (key mismatch)' }),
      };
    } catch (err) {
      return {
        ok: false,
        providerId: provider.id,
        latencyMs: Date.now() - start,
        error: (err as Error).message,
      };
    }
  };
}
