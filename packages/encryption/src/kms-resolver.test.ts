import { describe, it, expect, vi } from 'vitest';
import { createCachedKmsResolver } from './kms-resolver.js';
import { KmsUnavailableError } from './errors.js';
import type { KmsProvider } from './kms.js';
import type { KmsProviderRegistry } from './provider-registry.js';
import type { EncryptionStore } from './store.js';
import type { TenantPolicyRecord } from './store.js';

// ── Minimal stubs ──────────────────────────────────────────────

function makeProvider(id = 'local'): KmsProvider {
  return {
    id,
    rootKeyId: vi.fn().mockResolvedValue(`root:${id}`),
    wrap: vi.fn().mockResolvedValue({ alg: 'AES256GCM', iv: 'iv', ciphertext: 'ct', tag: 'tag', rootKeyId: `root:${id}` }),
    unwrap: vi.fn().mockResolvedValue(Buffer.alloc(32)),
  };
}

function makeRegistry(providers: Record<string, KmsProvider> = {}): KmsProviderRegistry {
  return {
    register: vi.fn(),
    has: (id) => id in providers,
    list: () => Object.keys(providers),
    build: vi.fn().mockImplementation(async (id: string) => {
      const p = providers[id];
      if (!p) throw new Error(`no provider: ${id}`);
      return p;
    }),
    healthCheck: vi.fn().mockResolvedValue({ ok: true }),
  };
}

function makeStore(policy: TenantPolicyRecord | null = null): EncryptionStore {
  return {
    getPolicy: vi.fn().mockResolvedValue(policy),
    upsertPolicy: vi.fn(),
    listKeks: vi.fn().mockResolvedValue([]),
    getKekById: vi.fn().mockResolvedValue(null),
    insertKek: vi.fn(),
    updateKekStatus: vi.fn(),
    listDeks: vi.fn().mockResolvedValue([]),
    getDekById: vi.fn().mockResolvedValue(null),
    getMaxDekEpoch: vi.fn().mockResolvedValue(null),
    insertDek: vi.fn(),
    updateDekStatus: vi.fn(),
    listBiks: vi.fn().mockResolvedValue([]),
    insertBik: vi.fn(),
    updateBikStatus: vi.fn(),
    deletePolicy: vi.fn(),
    deleteAllWrappedMaterial: vi.fn().mockResolvedValue({}),
  };
}

function makePolicy(overrides: Partial<TenantPolicyRecord> = {}): TenantPolicyRecord {
  return {
    tenantId: 'tenant-1',
    enabled: true,
    kmsProviderId: 'local',
    kmsConfig: null,
    activeKekId: 'kek-1',
    activeDekId: 'dek-1',
    activeBikId: 'bik-1',
    rotationSchedule: '90d',
    blindIndexEnabled: false,
    fieldPolicy: {},
    shredRequestedAt: null,
    shredCompletedAt: null,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────

describe('createCachedKmsResolver', () => {
  it('resolves the default provider when tenant has no policy', async () => {
    const localProvider = makeProvider('local');
    const registry = makeRegistry({ local: localProvider });
    const store = makeStore(null);
    const resolver = createCachedKmsResolver({ registry, store });
    const provider = await resolver.resolve('tenant-1');
    expect(provider).toBe(localProvider);
  });

  it('resolves the provider specified in tenant policy', async () => {
    const awsProvider = makeProvider('aws-kms');
    const registry = makeRegistry({ 'aws-kms': awsProvider });
    const store = makeStore(makePolicy({ kmsProviderId: 'aws-kms' }));
    const resolver = createCachedKmsResolver({ registry, store });
    const provider = await resolver.resolve('tenant-1');
    expect(provider).toBe(awsProvider);
  });

  it('caches the provider on repeated calls (no rebuild)', async () => {
    const localProvider = makeProvider('local');
    const registry = makeRegistry({ local: localProvider });
    const store = makeStore(makePolicy());
    const resolver = createCachedKmsResolver({ registry, store });
    await resolver.resolve('tenant-1');
    await resolver.resolve('tenant-1');
    expect((registry.build as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('increments size after caching a tenant', async () => {
    const registry = makeRegistry({ local: makeProvider() });
    const store = makeStore(makePolicy());
    const resolver = createCachedKmsResolver({ registry, store });
    expect(resolver.size()).toBe(0);
    await resolver.resolve('tenant-1');
    expect(resolver.size()).toBe(1);
  });

  it('rebuilds after invalidate(tenantId)', async () => {
    const registry = makeRegistry({ local: makeProvider() });
    const store = makeStore(makePolicy());
    const resolver = createCachedKmsResolver({ registry, store });
    await resolver.resolve('tenant-1');
    resolver.invalidate('tenant-1');
    expect(resolver.size()).toBe(0);
    await resolver.resolve('tenant-1');
    expect((registry.build as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it('clears all entries on invalidateAll()', async () => {
    const registry = makeRegistry({ local: makeProvider() });
    const store1 = makeStore(makePolicy({ tenantId: 'tenant-1' }));
    const store2 = makeStore(makePolicy({ tenantId: 'tenant-2' }));
    const resolver1 = createCachedKmsResolver({ registry, store: store1 });
    const resolver2 = createCachedKmsResolver({ registry, store: store2 });
    await resolver1.resolve('tenant-1');
    await resolver2.resolve('tenant-2');
    resolver1.invalidateAll();
    expect(resolver1.size()).toBe(0);
  });

  it('rebuilds when config hash changes (cache key invalidation)', async () => {
    const localProvider = makeProvider('local');
    const registry = makeRegistry({ local: localProvider });
    let callCount = 0;
    const store: EncryptionStore = {
      ...makeStore(),
      getPolicy: vi.fn().mockImplementation(async () => {
        callCount++;
        // First call: empty config; second call: config with a key
        return makePolicy({ kmsConfig: callCount === 1 ? null : { region: 'us-east-1' } });
      }),
    };
    const resolver = createCachedKmsResolver({ registry, store });
    await resolver.resolve('tenant-1');
    await resolver.resolve('tenant-1');
    expect((registry.build as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it('throws KmsUnavailableError for unknown provider', async () => {
    const registry = makeRegistry({ local: makeProvider() });
    const store = makeStore(makePolicy({ kmsProviderId: 'vault' }));
    const resolver = createCachedKmsResolver({ registry, store });
    await expect(resolver.resolve('tenant-1')).rejects.toThrow(KmsUnavailableError);
  });

  it('emits cache hit/miss metrics when a metrics emitter is provided', async () => {
    const registry = makeRegistry({ local: makeProvider() });
    const store = makeStore(makePolicy());
    const records: unknown[] = [];
    const metrics = { record: (e: unknown) => { records.push(e); } };
    const resolver = createCachedKmsResolver({ registry, store, metrics });
    await resolver.resolve('tenant-1'); // miss
    await resolver.resolve('tenant-1'); // hit
    const names = records.map((r) => (r as { name: string }).name);
    expect(names).toContain('encryption.cache.miss');
    expect(names).toContain('encryption.cache.hit');
  });
});
