import type { ConfigScope, OverrideLayer, ScopeLevel } from './config.js';

const LEVEL_ORDER: readonly ScopeLevel[] = ['global', 'organization', 'tenant', 'user'];

export interface ConfigResolver {
  addLayer(layer: OverrideLayer): void;
  removeLayer(scope: ConfigScope): void;
  resolve<T = unknown>(key: string, scope: ConfigScope): T | undefined;
  resolveAll(scope: ConfigScope): Map<string, unknown>;
  getEffectiveConfig(scope: ConfigScope): Record<string, unknown>;
}

export function createConfigResolver(): ConfigResolver {
  const layers: OverrideLayer[] = [];

  function getApplicableLayers(scope: ConfigScope): OverrideLayer[] {
    const targetLevel = LEVEL_ORDER.indexOf(scope.level);
    return layers
      .filter(l => {
        const layerLevel = LEVEL_ORDER.indexOf(l.scope.level);
        if (layerLevel > targetLevel) return false;
        if (l.scope.level === scope.level) return l.scope.id === scope.id;
        if (l.scope.level === 'global') return true;
        if (scope.parentId && l.scope.id === scope.parentId) return true;
        return false;
      })
      .sort((a, b) => LEVEL_ORDER.indexOf(a.scope.level) - LEVEL_ORDER.indexOf(b.scope.level));
  }

  return {
    addLayer(layer) {
      const idx = layers.findIndex(l => l.scope.level === layer.scope.level && l.scope.id === layer.scope.id);
      if (idx >= 0) layers[idx] = layer;
      else layers.push(layer);
    },

    removeLayer(scope) {
      const idx = layers.findIndex(l => l.scope.level === scope.level && l.scope.id === scope.id);
      if (idx >= 0) layers.splice(idx, 1);
    },

    resolve<T = unknown>(key: string, scope: ConfigScope): T | undefined {
      const applicable = getApplicableLayers(scope);
      for (let i = applicable.length - 1; i >= 0; i--) {
        const layer = applicable[i]!;
        if (layer.entries.has(key)) return layer.entries.get(key) as T;
      }
      return undefined;
    },

    resolveAll(scope) {
      const merged = new Map<string, unknown>();
      const applicable = getApplicableLayers(scope);
      for (const layer of applicable) {
        for (const [k, v] of layer.entries) merged.set(k, v);
      }
      return merged;
    },

    getEffectiveConfig(scope) {
      const all = this.resolveAll(scope);
      const result: Record<string, unknown> = {};
      for (const [k, v] of all) result[k] = v;
      return result;
    },
  };
}
