/**
 * @weaveintel/encryption — cached per-tenant KMS resolver.
 *
 * Builds a `KmsResolver` from a `KmsProviderRegistry` and an `EncryptionStore`.
 * For each tenant the resolver:
 *   1. Reads `tenant_encryption_policy.kms_provider_id` + `kms_config`.
 *   2. Calls `registry.build(id, config)` to construct the provider.
 *   3. Caches the instance keyed by `(tenantId, providerId, hashedConfig)` so
 *      a config change naturally invalidates the cache.
 *
 * `invalidate(tenantId)` exists for explicit cache busting from admin code
 * (e.g. after upserting a new policy).
 */

import { createHash } from 'node:crypto';
import { KmsUnavailableError } from './errors.js';
import type { KmsProvider } from './kms.js';
import type { KmsResolver } from './key-manager.js';
import type { MetricsEmitter } from './metrics.js';
import type { KmsProviderRegistry } from './provider-registry.js';
import type { EncryptionStore } from './store.js';

export interface CachedKmsResolverOptions {
  readonly registry: KmsProviderRegistry;
  readonly store: EncryptionStore;
  readonly defaultProviderId?: string;
  readonly defaultConfig?: Record<string, unknown>;
  /**
   * Phase 9 — fire-and-forget metrics sink. Used to record cache hit/miss
   * for `(tenantId, providerId)` pairs so the dashboard can spot resolver
   * thrash. Optional; defaults to no-op.
   */
  readonly metrics?: MetricsEmitter;
}

export interface CachedKmsResolver {
  readonly resolve: KmsResolver;
  invalidate(tenantId: string): void;
  invalidateAll(): void;
  /** Inspect cache (debug/tests). */
  size(): number;
}

interface CacheEntry {
  readonly key: string;
  readonly provider: KmsProvider;
}

function hashConfig(config: Record<string, unknown> | null | undefined): string {
  if (!config || Object.keys(config).length === 0) return '0';
  // Deterministic JSON: sort keys recursively so two equal configs hash equal.
  const sorted = JSON.stringify(config, Object.keys(config).sort());
  return createHash('sha256').update(sorted).digest('hex').slice(0, 16);
}

export function createCachedKmsResolver(opts: CachedKmsResolverOptions): CachedKmsResolver {
  const cache = new Map<string, CacheEntry>();
  const defaultProviderId = opts.defaultProviderId ?? 'local';
  const defaultConfig = opts.defaultConfig ?? {};

  const resolve: KmsResolver = async (tenantId: string): Promise<KmsProvider> => {
    const policy = await opts.store.getPolicy(tenantId);
    const providerId = policy?.kmsProviderId ?? defaultProviderId;
    const config = policy?.kmsConfig ?? defaultConfig;
    if (!opts.registry.has(providerId)) {
      throw new KmsUnavailableError(
        `tenant ${tenantId} requested unknown KMS provider '${providerId}'. ` +
          `Registered: [${opts.registry.list().join(', ')}]`,
      );
    }
    const cacheKey = `${providerId}:${hashConfig(config)}`;
    const existing = cache.get(tenantId);
    if (existing && existing.key === cacheKey) {
      opts.metrics?.record({
        name: 'encryption.cache.hit',
        kind: 'counter',
        value: 1,
        labels: { tenantId, cache: 'kms', provider: providerId },
        at: Date.now(),
      });
      return existing.provider;
    }
    opts.metrics?.record({
      name: 'encryption.cache.miss',
      kind: 'counter',
      value: 1,
      labels: { tenantId, cache: 'kms', provider: providerId },
      at: Date.now(),
    });
    const provider = await opts.registry.build(providerId, config);
    cache.set(tenantId, { key: cacheKey, provider });
    return provider;
  };

  return {
    resolve,
    invalidate(tenantId) {
      cache.delete(tenantId);
    },
    invalidateAll() {
      cache.clear();
    },
    size() {
      return cache.size;
    },
  };
}
