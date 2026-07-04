// @weaveintel/plugins — Plugin installer for local/private/public sources

import type { PluginManifest } from './manifest.js';
import type { PluginRegistry, InstalledPlugin } from './registry.js';

export type InstallSource = 'local' | 'private' | 'public';

export interface InstallResult {
  readonly pluginId: string;
  readonly source: InstallSource;
  readonly success: boolean;
  readonly error: string | null;
  readonly plugin: InstalledPlugin | null;
}

export interface PluginInstaller {
  install(manifest: PluginManifest, source: InstallSource): InstallResult;
  installBatch(manifests: readonly PluginManifest[], source: InstallSource): readonly InstallResult[];
  uninstall(pluginId: string): boolean;
}

export function createPluginInstaller(registry: PluginRegistry): PluginInstaller {
  return {
    install(manifest, source) {
      try {
        const plugin = registry.install(manifest);
        return { pluginId: manifest.id, source, success: true, error: null, plugin };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        return { pluginId: manifest.id, source, success: false, error: msg, plugin: null };
      }
    },

    installBatch(manifests, source) {
      return manifests.map((m) => this.install(m, source));
    },

    uninstall(pluginId) {
      return registry.uninstall(pluginId);
    },
  };
}
