import type { ExecutionContext, PolicyRule, PolicyInput, PolicyEvaluation } from '@weaveintel/core';

export interface TenantEntitlement {
  readonly tenantId: string;
  readonly features: ReadonlySet<string>;
  readonly maxModels?: number;
  readonly maxToolsPerRun?: number;
  readonly allowedModels?: readonly string[];
  readonly deniedModels?: readonly string[];
}

export interface EntitlementStore {
  get(tenantId: string): TenantEntitlement | undefined;
  set(entitlement: TenantEntitlement): void;
  delete(tenantId: string): void;
  list(): TenantEntitlement[];
}

export function createEntitlementStore(): EntitlementStore {
  const store = new Map<string, TenantEntitlement>();
  return {
    get(tenantId) { return store.get(tenantId); },
    set(entitlement) { store.set(entitlement.tenantId, entitlement); },
    delete(tenantId) { store.delete(tenantId); },
    list() { return [...store.values()]; },
  };
}

export function createEntitlementPolicy(store: EntitlementStore): PolicyRule {
  return {
    name: 'tenant-entitlement',
    description: 'Enforces per-tenant feature entitlements',
    async evaluate(ctx: ExecutionContext, input: PolicyInput): Promise<PolicyEvaluation> {
      const tenantId = ctx.tenantId;
      if (!tenantId) return { allowed: true, reason: 'No tenant context', policies: ['tenant-entitlement'] };

      const entitlement = store.get(tenantId);
      if (!entitlement) return { allowed: false, reason: `No entitlements for tenant ${tenantId}`, policies: ['tenant-entitlement'] };

      if (input.action === 'use_feature' && input.resource) {
        if (!entitlement.features.has(input.resource)) {
          return { allowed: false, reason: `Feature "${input.resource}" not entitled for tenant ${tenantId}`, policies: ['tenant-entitlement'] };
        }
      }

      if (input.action === 'use_model' && input.resource) {
        if (entitlement.deniedModels?.includes(input.resource)) {
          return { allowed: false, reason: `Model "${input.resource}" denied for tenant ${tenantId}`, policies: ['tenant-entitlement'] };
        }
        if (entitlement.allowedModels && !entitlement.allowedModels.includes(input.resource)) {
          return { allowed: false, reason: `Model "${input.resource}" not in allowed list for tenant ${tenantId}`, policies: ['tenant-entitlement'] };
        }
      }

      return { allowed: true, reason: 'Entitlement check passed', policies: ['tenant-entitlement'] };
    },
  };
}
