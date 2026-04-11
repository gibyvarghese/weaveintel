// @weaveintel/plugins — Public API
export {
  type PluginTrustLevel,
  type PluginCapability,
  type PluginManifest,
  createPluginManifest,
  validateManifest,
} from './manifest.js';

export {
  type PluginState,
  type InstalledPlugin,
  type PluginSearchOptions,
  type PluginRegistry,
  createPluginRegistry,
} from './registry.js';

export {
  type LifecyclePhase,
  type LifecycleHook,
  type PluginLifecycle,
  createPluginLifecycle,
} from './lifecycle.js';

export {
  type PluginCompatibilityResult,
  checkCompatibility,
} from './compatibility.js';

export {
  type InstallSource,
  type InstallResult,
  type PluginInstaller,
  createPluginInstaller,
} from './installer.js';
