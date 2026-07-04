// @weaveintel/plugins — Version compatibility checks

import type { PluginManifest } from './manifest.js';

export interface PluginCompatibilityResult {
  readonly pluginId: string;
  readonly compatible: boolean;
  readonly coreVersionOk: boolean;
  readonly dependenciesMet: readonly string[];
  readonly dependenciesMissing: readonly string[];
  readonly warnings: readonly string[];
}

export function checkCompatibility(
  manifest: PluginManifest,
  coreVersion: string,
  installedPlugins: readonly string[],
): PluginCompatibilityResult {
  const warnings: string[] = [];

  // Simple semver-like comparison (major.minor.patch)
  const coreOk = compareSemver(coreVersion, manifest.minCoreVersion) >= 0
    && (!manifest.maxCoreVersion || compareSemver(coreVersion, manifest.maxCoreVersion) <= 0);

  if (!coreOk) warnings.push(`Core version ${coreVersion} outside range ${manifest.minCoreVersion}–${manifest.maxCoreVersion ?? '*'}`);

  const met: string[] = [];
  const missing: string[] = [];
  for (const dep of manifest.dependencies) {
    if (installedPlugins.includes(dep)) met.push(dep);
    else missing.push(dep);
  }

  if (missing.length > 0) warnings.push(`Missing dependencies: ${missing.join(', ')}`);

  return {
    pluginId: manifest.id,
    compatible: coreOk && missing.length === 0,
    coreVersionOk: coreOk,
    dependenciesMet: met,
    dependenciesMissing: missing,
    warnings,
  };
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}
