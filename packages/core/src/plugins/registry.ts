// @weaveintel/plugins — Plugin registry: install, discover, validate

import type { PluginManifest, PluginTrustLevel } from './manifest.js';

export type PluginState = 'installed' | 'active' | 'disabled' | 'error';

export interface InstalledPlugin {
  readonly manifest: PluginManifest;
  readonly state: PluginState;
  readonly installedAt: number;
  readonly activatedAt: number | null;
  readonly error: string | null;
}

export interface PluginSearchOptions {
  readonly query?: string;
  readonly trust?: PluginTrustLevel;
  readonly capability?: string;
  readonly tag?: string;
}

export interface PluginRegistry {
  install(manifest: PluginManifest): InstalledPlugin;
  uninstall(pluginId: string): boolean;
  get(pluginId: string): InstalledPlugin | undefined;
  list(options?: PluginSearchOptions): readonly InstalledPlugin[];
  activate(pluginId: string): InstalledPlugin | undefined;
  deactivate(pluginId: string): InstalledPlugin | undefined;
  isActive(pluginId: string): boolean;
}

export function createPluginRegistry(): PluginRegistry {
  const plugins = new Map<string, InstalledPlugin>();

  function update(id: string, patch: Partial<InstalledPlugin>): InstalledPlugin | undefined {
    const existing = plugins.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...patch } as InstalledPlugin;
    plugins.set(id, updated);
    return updated;
  }

  return {
    install(manifest) {
      const plugin: InstalledPlugin = { manifest, state: 'installed', installedAt: Date.now(), activatedAt: null, error: null };
      plugins.set(manifest.id, plugin);
      return plugin;
    },

    uninstall(pluginId) { return plugins.delete(pluginId); },

    get(pluginId) { return plugins.get(pluginId); },

    list(options = {}) {
      let results = Array.from(plugins.values());
      if (options.query) {
        const q = options.query.toLowerCase();
        results = results.filter((p) =>
          p.manifest.name.toLowerCase().includes(q) || p.manifest.description.toLowerCase().includes(q),
        );
      }
      if (options.trust) results = results.filter((p) => p.manifest.trust === options.trust);
      if (options.capability) {
        const cap = options.capability;
        results = results.filter((p) => p.manifest.capabilities.some((c) => c.type === cap));
      }
      if (options.tag) {
        const tag = options.tag;
        results = results.filter((p) => p.manifest.tags.includes(tag));
      }
      return results;
    },

    activate(pluginId) { return update(pluginId, { state: 'active', activatedAt: Date.now() }); },
    deactivate(pluginId) { return update(pluginId, { state: 'disabled' }); },
    isActive(pluginId) { return plugins.get(pluginId)?.state === 'active'; },
  };
}
