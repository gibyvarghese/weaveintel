export type ScopeLevel = 'global' | 'organization' | 'tenant' | 'user';

export interface ConfigScope {
  readonly level: ScopeLevel;
  readonly id: string;
  readonly parentId?: string;
}

export interface ConfigEntry {
  readonly key: string;
  readonly value: unknown;
  readonly scope: ConfigScope;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface OverrideLayer {
  readonly scope: ConfigScope;
  readonly entries: ReadonlyMap<string, unknown>;
}

export function createOverrideLayer(scope: ConfigScope, entries: Record<string, unknown>): OverrideLayer {
  return {
    scope,
    entries: new Map(Object.entries(entries)),
  };
}

export function createGlobalScope(): ConfigScope {
  return { level: 'global', id: 'global' };
}

export function createTenantScope(tenantId: string, orgId?: string): ConfigScope {
  return { level: 'tenant', id: tenantId, parentId: orgId };
}

export function createUserScope(userId: string, tenantId: string): ConfigScope {
  return { level: 'user', id: userId, parentId: tenantId };
}
