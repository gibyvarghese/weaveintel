export interface TenantCapability {
  readonly tenantId: string;
  readonly models: readonly string[];
  readonly tools: readonly string[];
  readonly maxConcurrentRuns: number;
  readonly features: readonly string[];
}

export interface TenantCapabilityMap {
  get(tenantId: string): TenantCapability | undefined;
  set(capability: TenantCapability): void;
  delete(tenantId: string): void;
  list(): TenantCapability[];
  isModelAllowed(tenantId: string, model: string): boolean;
  isToolAllowed(tenantId: string, tool: string): boolean;
  getAvailableModels(tenantId: string): readonly string[];
  getAvailableTools(tenantId: string): readonly string[];
}

export function createCapabilityMap(): TenantCapabilityMap {
  const store = new Map<string, TenantCapability>();

  return {
    get(tenantId) { return store.get(tenantId); },
    set(capability) { store.set(capability.tenantId, capability); },
    delete(tenantId) { store.delete(tenantId); },
    list() { return [...store.values()]; },

    isModelAllowed(tenantId, model) {
      const cap = store.get(tenantId);
      return cap ? cap.models.includes(model) : false;
    },

    isToolAllowed(tenantId, tool) {
      const cap = store.get(tenantId);
      return cap ? cap.tools.includes(tool) : false;
    },

    getAvailableModels(tenantId) {
      return store.get(tenantId)?.models ?? [];
    },

    getAvailableTools(tenantId) {
      return store.get(tenantId)?.tools ?? [];
    },
  };
}
