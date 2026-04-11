/**
 * @weaveintel/core — Plugin system contracts
 */

// ─── Manifest ────────────────────────────────────────────────

export type PluginTrustLevel = 'official' | 'verified' | 'community' | 'private';

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  trustLevel: PluginTrustLevel;
  capabilities: PluginCapability[];
  dependencies?: Record<string, string>;
  minCoreVersion?: string;
  createdAt?: string;
}

export interface PluginCapability {
  type: 'tool' | 'model' | 'connector' | 'guardrail' | 'memory' | 'retrieval' | 'extraction' | 'custom';
  name: string;
  description?: string;
  config?: Record<string, unknown>;
}

// ─── Compatibility ───────────────────────────────────────────

export interface PluginCompatibilityResult {
  compatible: boolean;
  issues: Array<{
    severity: 'error' | 'warning' | 'info';
    message: string;
  }>;
}

// ─── Lifecycle ───────────────────────────────────────────────

export interface PluginLifecycle {
  initialize(config?: Record<string, unknown>): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  healthCheck(): Promise<{ healthy: boolean; message?: string }>;
}

// ─── Installer ───────────────────────────────────────────────

export interface PluginInstaller {
  install(manifest: PluginManifest): Promise<void>;
  uninstall(pluginId: string): Promise<void>;
  list(): Promise<PluginManifest[]>;
  checkCompatibility(manifest: PluginManifest): Promise<PluginCompatibilityResult>;
}
