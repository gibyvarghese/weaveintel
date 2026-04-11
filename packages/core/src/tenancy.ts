/**
 * @weaveintel/core — Multi-tenancy contracts
 */

// ─── Config Scope ────────────────────────────────────────────

export type ConfigScopeLevel = 'global' | 'tenant' | 'environment' | 'user' | 'agent';

export interface ConfigScope {
  level: ConfigScopeLevel;
  id: string;
  parentId?: string;
  values: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

// ─── Effective Config ────────────────────────────────────────

export interface EffectiveConfig {
  resolved: Record<string, unknown>;
  layers: ConfigScope[];
  resolvedAt: string;
}

// ─── Config Resolver ─────────────────────────────────────────

export interface ConfigResolver {
  resolve(scopes: ConfigScope[]): EffectiveConfig;
  get(key: string, scopes: ConfigScope[]): unknown;
  set(level: ConfigScopeLevel, id: string, key: string, value: unknown): Promise<void>;
}

// ─── Override Layer ──────────────────────────────────────────

export interface OverrideLayer {
  id: string;
  scopeLevel: ConfigScopeLevel;
  scopeId: string;
  overrides: Record<string, unknown>;
  priority: number;
  expiresAt?: string;
}

// ─── Entitlement ─────────────────────────────────────────────

export interface EntitlementPolicy {
  id: string;
  tenantId: string;
  name: string;
  maxTokensPerDay?: number;
  maxRequestsPerDay?: number;
  maxCostPerDay?: number;
  allowedModels?: string[];
  allowedTools?: string[];
  features: Record<string, boolean>;
  createdAt?: string;
}

// ─── Tenant Policy ───────────────────────────────────────────

export interface TenantPolicy {
  id: string;
  tenantId: string;
  name: string;
  routingPolicyId?: string;
  guardrailPipelineId?: string;
  cachePolicyId?: string;
  memoryPolicyId?: string;
  enabled: boolean;
}

// ─── Capability Map ──────────────────────────────────────────

export interface TenantCapabilityMap {
  tenantId: string;
  enabledCapabilities: string[];
  modelAccess: Array<{ modelId: string; providerId: string; allowed: boolean }>;
  toolAccess: Array<{ toolId: string; allowed: boolean }>;
  customLimits?: Record<string, number>;
}
