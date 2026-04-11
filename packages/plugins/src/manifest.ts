// @weaveintel/plugins — Plugin manifest metadata

export type PluginTrustLevel = 'official' | 'verified' | 'community' | 'private';

export interface PluginCapability {
  readonly type: 'tool' | 'model' | 'memory' | 'middleware' | 'guardrail' | 'retriever';
  readonly name: string;
  readonly description: string;
}

export interface PluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly author: string;
  readonly license: string;
  readonly homepage: string;
  readonly trust: PluginTrustLevel;
  readonly capabilities: readonly PluginCapability[];
  readonly minCoreVersion: string;
  readonly maxCoreVersion: string | null;
  readonly dependencies: readonly string[];
  readonly tags: readonly string[];
}

export function createPluginManifest(
  fields: Omit<PluginManifest, 'capabilities' | 'dependencies' | 'tags'> & {
    capabilities?: PluginCapability[];
    dependencies?: string[];
    tags?: string[];
  },
): PluginManifest {
  return {
    ...fields,
    capabilities: fields.capabilities ?? [],
    dependencies: fields.dependencies ?? [],
    tags: fields.tags ?? [],
  };
}

export function validateManifest(manifest: PluginManifest): string[] {
  const errors: string[] = [];
  if (!manifest.id) errors.push('Plugin id is required');
  if (!manifest.name) errors.push('Plugin name is required');
  if (!manifest.version) errors.push('Plugin version is required');
  if (!manifest.author) errors.push('Plugin author is required');
  if (!manifest.minCoreVersion) errors.push('minCoreVersion is required');
  return errors;
}
